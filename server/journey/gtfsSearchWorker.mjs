import { parentPort } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

if (!parentPort) throw new Error('GTFS search worker requires a parent port');

const [{ cachedGtfsTimetable, mergeGtfsTimetables }, { cachedGtfsRealtimeTripUpdates },
  { cachedKyivMetroTimetable }, { GtfsSearchGroupCache, buildGtfsSearchGroups, searchGtfsGroup, selectGtfsTripMetadata, selectGtfsStopArrivals }] = await Promise.all([
  tsImport('./gtfsTimetable.ts', import.meta.url),
  tsImport('./gtfsRealtime.ts', import.meta.url),
  tsImport('../mobility/kyivMetroTimetable.ts', import.meta.url),
  tsImport('./gtfsSearchWorkerCore.ts', import.meta.url),
]);

// A group retains parsed feed maps for follow-up searches within the same API
// request. Keep that memory bounded and discard snapshots after short-term use.
const groups = new GtfsSearchGroupCache(8, 5 * 60_000);
let activeSearchId = null;

async function buildGroups(providers, metro) {
  const loaded = await Promise.allSettled(providers.map(async (provider) => {
    const feed = await cachedGtfsTimetable(provider.id, provider.feedUrl);
    let realtime = null;
    let realtimeError = null;
    if (provider.realtimeUrl) {
      try {
        realtime = await cachedGtfsRealtimeTripUpdates(provider.id, provider.realtimeUrl);
        if (!realtime.fresh) realtimeError = realtime.reason ?? 'дані неповні';
      } catch { realtimeError = 'оновлення тимчасово недоступні'; }
    }
    return { providerId: provider.id, providerName: provider.name, providerCity: provider.city, feed,
      ...(realtime?.fresh ? { realtime } : {}), ...(realtimeError ? { realtimeError } : {}) };
  }));
  const sources = [];
  const errors = [];
  loaded.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      sources.push(result.value);
      if (result.value.realtimeError) errors.push({ providerId: result.value.providerId, name: result.value.providerName, kind: 'realtime', detail: result.value.realtimeError });
    }
    else errors.push({ providerId: providers[index]?.id, name: providers[index]?.name ?? 'GTFS', kind: 'schedule' });
  });
  if (metro) {
    try {
      const feed = await cachedKyivMetroTimetable(metro);
      sources.push({ providerId: metro.routeSource.id, providerName: 'Київ — метро (офіційний інтервальний розклад)', providerCity: metro.routeSource.city, feed });
    } catch {
      errors.push({ providerId: metro.routeSource.id, name: 'Київське метро', kind: 'schedule' });
    }
  }
  const built = buildGtfsSearchGroups(sources, String(activeSearchId));
  for (const [id, group] of built.groups) groups.set(id, group);
  return { descriptors: built.descriptors, errors };
}

parentPort.on('message', async (message) => {
  const { id, type } = message;
  try {
    if (type === 'search') {
      activeSearchId = id;
      const { descriptors, errors } = await buildGroups(message.providers, message.metro);
      const result = [];
      for (const descriptor of descriptors) {
        const group = groups.get(descriptor.id);
        const search = searchGtfsGroup(group, message.input);
        result.push({ groupId: descriptor.id, ...search });
        delete group.feed;
      }
      parentPort.postMessage({ id, ok: true, value: { descriptors, errors, searches: result } });
      return;
    }
    if (type === 'search-group') {
      const group = groups.get(message.groupId);
      if (!group) throw new Error('GTFS search snapshot expired');
      const feed = mergeGtfsTimetables(group.sources);
      if (!feed) throw new Error('GTFS search snapshot is unavailable');
      const value = searchGtfsGroup({ ...group, feed }, message.input);
      parentPort.postMessage({ id, ok: true, value });
      return;
    }
    if (type === 'stop-arrivals') {
      const provider = message.provider;
      const feed = await cachedGtfsTimetable(provider.id, provider.feedUrl);
      let realtime = null;
      if (provider.realtimeUrl) {
        try {
          realtime = await cachedGtfsRealtimeTripUpdates(provider.id, provider.realtimeUrl);
        } catch { realtime = { fresh: false, reason: 'TEMPORARILY_UNAVAILABLE', updates: new Map() }; }
      }
      const result = selectGtfsStopArrivals(feed, realtime, message.stopId, message.now, message.limit);
      if (realtime?.reason === 'TEMPORARILY_UNAVAILABLE') result.realtimeStatus = 'TEMPORARILY_UNAVAILABLE';
      parentPort.postMessage({ id, ok: true, value: result });
      return;
    }
    if (type === 'trip-metadata') {
      const feed = await cachedGtfsTimetable(message.provider.id, message.provider.feedUrl);
      parentPort.postMessage({ id, ok: true, value: selectGtfsTripMetadata(feed, message.tripIds) });
      return;
    }
    throw new Error('Unsupported GTFS worker request');
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'GTFS worker failed' });
  }
});

parentPort.postMessage({ type: 'ready' });
