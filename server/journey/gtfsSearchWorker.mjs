import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import v8 from 'node:v8';
import { tsImport } from 'tsx/esm/api';

if (!parentPort) throw new Error('GTFS search worker requires a parent port');

const [{ cachedGtfsTimetable, mergeGtfsTimetables, getCachedGtfsTimetableStats, parseGtfsTimetable }, { cachedGtfsRealtimeTripUpdates },
  { cachedKyivMetroTimetable }, { GtfsSearchGroupCache, buildGtfsSearchGroups, searchGtfsGroup, selectGtfsTripMetadata, selectGtfsStopArrivals }] = await Promise.all([
  tsImport('./gtfsTimetable.ts', import.meta.url),
  tsImport('./gtfsRealtime.ts', import.meta.url),
  tsImport('../mobility/kyivMetroTimetable.ts', import.meta.url),
  tsImport('./gtfsSearchWorkerCore.ts', import.meta.url),
]);

// An opt-in, exact-URL test seam lets API integration tests exercise the real
// worker/parser/planner without a public feed or any relaxation of safeFetch.
// Production never receives the directory, and no other URL can use the seam.
const GTFS_TEST_FIXTURE_URLS = new Map([
  ['https://gtfs-api-fixture.invalid/lviv.zip', ''],
  ['https://gtfs-api-fixture.invalid/direct-only.zip', 'direct-only'],
]);
const GTFS_TEST_FILES = ['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'shapes.txt'];
const testFixtureDirectory = typeof workerData?.testFixtureDirectory === 'string'
  ? workerData.testFixtureDirectory : undefined;
const testFixtureFeedCache = new Map();

async function loadProviderTimetable(provider) {
  const startedAt = Date.now();
  const feed = await loadProviderTimetableUncached(provider);
  debugStage('provider-feed-loaded', { provider: provider.id, ms: Date.now() - startedAt });
  return feed;
}

async function loadProviderTimetableUncached(provider) {
  const fixtureSubdirectory = GTFS_TEST_FIXTURE_URLS.get(provider.feedUrl);
  if (testFixtureDirectory && fixtureSubdirectory !== undefined) {
    const cacheKey = `${provider.id}\u0000${provider.feedUrl}`;
    const cached = testFixtureFeedCache.get(cacheKey);
    if (cached) {
      debugStage('test-fixture-feed-cache-hit', { provider: provider.id });
      return cached;
    }
    const pending = Promise.all(GTFS_TEST_FILES.map(async (name) => [name,
      new Uint8Array(await readFile(join(testFixtureDirectory, fixtureSubdirectory, name)))
    ])).then((entries) => parseGtfsTimetable(Object.fromEntries(entries)));
    testFixtureFeedCache.set(cacheKey, pending);
    try { return await pending; }
    catch (error) { testFixtureFeedCache.delete(cacheKey); throw error; }
  }
  const isUkraineProvider = provider.country === 'UA' || /львів|київ|дніпро|одеса|харків|хмельницький|ужгород|буча|червоноград|україна/i.test(provider.city || provider.name);
  return cachedGtfsTimetable(provider.id, provider.feedUrl, Date.now(), isUkraineProvider ? 'Europe/Kyiv' : undefined);
}

// A group retains parsed feed maps for follow-up searches within the same API
// request. Keep that memory bounded and discard snapshots after short-term use.
const groups = new GtfsSearchGroupCache(8, 5 * 60_000);
let activeSearchId = null;

// Feed loading and the provider merge run before the planner's own timer starts,
// so they need a separate opt-in stage timer to become observable.
const searchDebugEnabled = process.env.MARSHGO_GTFS_SEARCH_DEBUG === '1';
let workerStartedAt = Date.now();
const debugStage = (stage, details = {}) => {
  if (searchDebugEnabled) {
    console.info(JSON.stringify({ event: 'gtfs.worker.debug', stage, elapsedMs: Date.now() - workerStartedAt, ...details }));
  }
};

async function buildGroups(providers, metro, searchInput) {
  const loaded = await Promise.allSettled(providers.map(async (provider) => {
    const feed = await loadProviderTimetable(provider);
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
  debugStage('feeds-loaded', { providers: providers.length, rejected: loaded.filter((result) => result.status === 'rejected').length, feedCache: getCachedGtfsTimetableStats() });
  loaded.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      sources.push(result.value);
      if (result.value.realtimeError) errors.push({ providerId: result.value.providerId, name: result.value.providerName, kind: 'realtime', detail: result.value.realtimeError });
    }
    else {
      errors.push({ providerId: providers[index]?.id, name: providers[index]?.name ?? 'GTFS', kind: 'schedule', detail: String(result.reason?.message ?? result.reason) });
    }
  });
  if (metro) {
    try {
      const feed = await cachedKyivMetroTimetable(metro);
      sources.push({ providerId: metro.routeSource.id, providerName: 'Київ — метро (офіційний інтервальний розклад)', providerCity: metro.routeSource.city, feed });
    } catch {
      errors.push({ providerId: metro.routeSource.id, name: 'Київське метро', kind: 'schedule' });
    }
  }
  const built = buildGtfsSearchGroups(sources, String(activeSearchId), searchInput ? {
    origin: searchInput.origin, destination: searchInput.destination,
  } : undefined);
  debugStage('groups-built', { sources: sources.length, groups: built.groups.length, errors: errors.length });
  for (const [id, group] of built.groups) groups.set(id, group);
  return { descriptors: built.descriptors, errors };
}

parentPort.on('message', async (message) => {
  const { id, type } = message;
  workerStartedAt = Date.now();
  try {
    if (type === 'diagnostics') {
      if (message.collectGarbage && typeof globalThis.gc === 'function') globalThis.gc();
      const memory = globalThis.process.memoryUsage();
      parentPort.postMessage({ id, ok: true, value: {
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
        // The isolate's own ceiling — `rssBytes` above is process-wide and includes the API isolate.
        heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
        feedCache: getCachedGtfsTimetableStats(), groupCacheEntries: groups.size,
      } });
      return;
    }
    if (type === 'search') {
      activeSearchId = id;
      const { descriptors, errors } = await buildGroups(message.providers, message.metro, message.input);
      const result = [];
      for (const descriptor of descriptors) {
        const group = groups.get(descriptor.id);
        const search = searchGtfsGroup(group, message.input);
        result.push({ groupId: descriptor.id, ...search });
        delete group.feed;
      }
      debugStage('groups-searched', { groups: descriptors.length, itineraries: result.reduce((n, r) => n + r.itineraries.length, 0), truncated: result.filter((r) => r.searchTruncated).length });
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
      const feed = await loadProviderTimetable(provider);
      let realtime = null;
      if (provider.realtimeUrl) {
        try {
          realtime = await cachedGtfsRealtimeTripUpdates(provider.id, provider.realtimeUrl);
        } catch { realtime = { fresh: false, reason: 'TEMPORARILY_UNAVAILABLE', updates: new Map() }; }
      }
      const result = selectGtfsStopArrivals(feed, realtime, message.stopId, message.now, message.limit, {
        ...(message.routeId ? { routeId: message.routeId } : {}), ...(message.headsign ? { headsign: message.headsign } : {}),
      });
      if (realtime?.reason === 'TEMPORARILY_UNAVAILABLE') result.realtimeStatus = 'TEMPORARILY_UNAVAILABLE';
      parentPort.postMessage({ id, ok: true, value: result });
      return;
    }
    if (type === 'trip-metadata') {
      const feed = await loadProviderTimetable(message.provider);
      parentPort.postMessage({ id, ok: true, value: selectGtfsTripMetadata(feed, message.tripIds) });
      return;
    }
    throw new Error('Unsupported GTFS worker request');
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'GTFS worker failed' });
  }
});

parentPort.postMessage({ type: 'ready' });
