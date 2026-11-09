import { ukraineCatalog, ukraineCatalogWave2, ukraineCatalogWave3, kyivOpenDataCatalog } from '../server/mobility/ukraineCatalog';
import { testProviderConnection } from '../server/mobility/connection';
import { testGbfsConnection } from '../server/mobility/gbfs';
import { fetchJson } from '../server/mobility/safeFetch';
import { cachedGtfsTimetable, findGtfsItinerariesWithStats } from '../server/journey/gtfsTimetable';
import { parseTransportFeedSmokeScope, selectTransportFeedSmokeEntries } from './transport-feed-smoke-scope';
import { selectUpcomingSmokeServiceWindow } from './transport-feed-smoke-window';

/**
 * Read-only acceptance probe for all Ukrainian transport sources recorded in
 * the repository (Base + Wave 2 + Wave 3). It never changes provider configuration or writes to a DB.
 */
const CONCURRENCY = 2;
const catalog = [...ukraineCatalog, ...ukraineCatalogWave2, ...ukraineCatalogWave3, ...kyivOpenDataCatalog];

/** Capture the planner's existing bounded-search diagnostics without mixing them into JSON stdout. */
function findWithSearchDiagnostics<T>(find: () => T): { result: T; diagnostics: unknown[] } {
  const previousDebug = process.env.MARSHGO_GTFS_SEARCH_DEBUG;
  const previousInfo = console.info;
  const diagnostics: unknown[] = [];
  process.env.MARSHGO_GTFS_SEARCH_DEBUG = '1';
  console.info = (...args: Parameters<typeof console.info>) => {
    const message = args[0];
    if (typeof message === 'string') {
      try {
        const value = JSON.parse(message) as { event?: unknown };
        if (value?.event === 'gtfs.search.debug') {
          diagnostics.push(value);
          return;
        }
      } catch {
        // Preserve any non-JSON application diagnostics in the normal log.
      }
    }
    previousInfo(...args);
  };
  try {
    return { result: find(), diagnostics };
  } finally {
    console.info = previousInfo;
    if (previousDebug === undefined) delete process.env.MARSHGO_GTFS_SEARCH_DEBUG;
    else process.env.MARSHGO_GTFS_SEARCH_DEBUG = previousDebug;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      result[index] = await worker(items[index]!);
    }
  }));
  return result;
}

async function probe(entry: typeof catalog[number]) {
  if (entry.access !== 'open') {
    return { name: entry.name, city: entry.city, sourceType: entry.sourceType, state: 'SKIPPED', reason: entry.access };
  }
  const report = await testProviderConnection({ id: entry.sourceRef, name: entry.name, source_type: entry.sourceType, feed_url: entry.feedUrl });
  return {
    name: entry.name,
    city: entry.city,
    sourceType: entry.sourceType,
    state: report.health.toUpperCase(),
    counts: report.counts,
    bbox: report.bbox,
    responseMs: report.responseMs,
    checks: report.checks,
    ...(report.error ? { error: report.error } : {}),
  };
}

async function main() {
  const scope = parseTransportFeedSmokeScope(process.argv.slice(2));
  const selectedEntries = selectTransportFeedSmokeEntries(catalog, scope);
  // The static feed is parsed below by the planner. In the focused Lviv scope, only
  // probe the realtime endpoint here to avoid downloading/parsing the static archive twice.
  const providerProbeEntries = scope === 'lviv-route'
    ? selectedEntries.filter((entry) => entry.sourceType === 'gtfs_rt')
    : selectedEntries;
  const results = await mapLimit(providerProbeEntries, scope === 'lviv-route' ? 1 : CONCURRENCY, probe);

  const lvivStaticFeed = selectTransportFeedSmokeEntries(catalog, 'lviv-route')[0];
  if (!lvivStaticFeed) throw new Error('Lviv static GTFS source is missing from the catalog');
  const lvivFeed = await cachedGtfsTimetable('live-lviv-route-smoke', lvivStaticFeed.feedUrl);
  const { earliestDeparture, latestDeparture, serviceDate } = selectUpcomingSmokeServiceWindow(lvivFeed);
  const lvivRouteCases = [
    { id: 'center-to-main-station', origin: [24.0297, 49.8397] as [number, number], destination: [23.9893, 49.8397] as [number, number] },
    { id: 'north-to-sykhiv', origin: [24.0029933, 49.8681678] as [number, number], destination: [24.057585, 49.794117] as [number, number] },
  ];
  const routePlanner = {
    provider: 'Львівавтодор GTFS → MARSHGO GTFS timetable planner',
    feed: { stops: lvivFeed.stops.size, routes: lvivFeed.routes.size, trips: lvivFeed.trips.size, timezone: lvivFeed.timezone },
    serviceDate,
    queryWindow: [earliestDeparture.toISOString(), latestDeparture.toISOString()],
    cases: lvivRouteCases.map((routeCase) => {
      const { result: search, diagnostics } = findWithSearchDiagnostics(() => findGtfsItinerariesWithStats(lvivFeed, {
        providerId: 'live-lviv-route-smoke',
        providerName: 'Львівавтодор GTFS',
        providerCity: 'Львів',
        origin: routeCase.origin,
        destination: routeCase.destination,
        earliestDeparture,
        latestDeparture,
        maximumJourneySeconds: 3 * 60 * 60,
        maximumWaitSeconds: 3 * 60 * 60,
        maximumTransfers: 2,
        maximumStopDistanceMeters: 1800,
        limit: 10,
        allowedTransportTypes: ['bus', 'tram', 'trolleybus'],
      }));
      return {
        id: routeCase.id,
        status: search.itineraries.length ? 'ROUTES_FOUND' : 'NO_ROUTE_IN_QUERY_WINDOW',
        count: search.itineraries.length,
        searchTruncated: search.searchTruncated,
        resultLimitReached: search.resultLimitReached,
        truncation: search.truncation,
        plannerDiagnostics: diagnostics,
        examples: search.itineraries.slice(0, 2).map((journey) => ({
          modes: journey.segments.map((segment) => segment.transportType),
          routes: journey.segments.map((segment) => segment.routeName),
          orderedStops: journey.segments.map((segment) => [segment.originStop.name, segment.destinationStop.name]),
          departureAt: journey.departureAt.toISOString(),
          arrivalAt: journey.arrivalAt.toISOString(),
        })),
      };
    }),
  };

  const supplementary = scope === 'lviv-route' ? [] : await Promise.all([
    (async () => {
      try {
        const { data } = await fetchJson('https://api.citybik.es/v2/networks');
        const networks = Array.isArray(data)
          ? data
          : data && typeof data === 'object' && Array.isArray((data as { networks?: unknown }).networks)
            ? (data as { networks: unknown[] }).networks
            : [];
        const ukrainian = networks.filter((value) => {
          if (!value || typeof value !== 'object') return false;
          const network = value as { location?: { country?: unknown; city?: unknown } };
          return network.location?.country === 'UA' || /ukrain|україн|kyiv|lviv|odesa|dnipro/i.test(String(network.location?.city ?? ''));
        }).length;
        return { provider: 'CityBikes discovery', state: 'PROBED', networks: networks.length, ukrainianNetworks: ukrainian, role: 'catalog-only' };
      } catch (error) {
        return { provider: 'CityBikes discovery', state: 'OFFLINE', error: error instanceof Error ? error.message : 'request failed' };
      }
    })(),
    (async () => {
      const report = await testGbfsConnection('zelectra-smoke', 'https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs');
      return { provider: 'Zelectra GBFS candidate', state: report.health.toUpperCase(), counts: report.counts, bbox: report.bbox, checks: report.checks, role: 'nearby inventory candidate; route/booking rules unverified' };
    })(),
    (async () => {
      const report = await testGbfsConnection('nextbike-lv-smoke', 'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_lv/gbfs.json');
      return { provider: 'Nextbike nextbike_lv candidate', state: report.health.toUpperCase(), counts: report.counts, bbox: report.bbox, checks: report.checks, role: 'coverage candidate; city assignment must be checked against coordinates' };
    })(),
    (async () => {
      const report = await testGbfsConnection('nextbike-vin-smoke', 'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_vin/gbfs.json');
      return { provider: 'Nextbike nextbike_vin candidate', state: report.health.toUpperCase(), counts: report.counts, bbox: report.bbox, checks: report.checks, role: 'candidate URL probe; not an enabled Ukrainian source' };
    })(),
  ]);

  const checkedResults = results.filter((row) => row.state !== 'SKIPPED');
  const skippedResults = results.filter((row) => row.state === 'SKIPPED');
  const summary = {
    scope,
    catalogRows: catalog.length,
    selectedSources: selectedEntries.length,
    providerSourcesProbed: checkedResults.length,
    checked: checkedResults.length,
    skipped: skippedResults.length,
    healthy: checkedResults.filter((row) => row.state === 'HEALTHY').length,
    degraded: checkedResults.filter((row) => row.state === 'DEGRADED').length,
    offline: checkedResults.filter((row) => row.state === 'OFFLINE').length,
    note: 'Read-only probe; HEALTHY means feed health only, not commercial permission, route-search integration, price, availability or booking.',
  };
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), summary, catalog: results, routePlanner, supplementary }, null, 2));
  if (scope === 'lviv-route' && !routePlanner.cases.some((routeCase) =>
    routeCase.count > 0 && !routeCase.searchTruncated)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`Transport feed smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
