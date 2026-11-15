import { ukraineCatalog, ukraineCatalogWave2, ukraineCatalogWave3, kyivOpenDataCatalog } from '../server/mobility/ukraineCatalog';
import { testProviderConnection } from '../server/mobility/connection';
import { testGbfsConnection } from '../server/mobility/gbfs';
import { fetchJson } from '../server/mobility/safeFetch';
import { cachedGtfsTimetable, findGtfsItinerariesWithStats } from '../server/journey/gtfsTimetable';
import type { GtfsGraphBudgetLimits, GtfsItinerary } from '../server/journey/gtfsTimetable';
import { parseTransportFeedSmokeScope, selectTransportFeedSmokeEntries } from './transport-feed-smoke-scope';
import { selectUpcomingSmokeServiceWindow } from './transport-feed-smoke-window';
import { serializeSmokeJourney, summarizeSmokeItineraries, withOptionalSourceFingerprint } from './transport-feed-smoke-summary';

/**
 * Read-only acceptance probe for all Ukrainian transport sources recorded in
 * the repository (Base + Wave 2 + Wave 3). It never changes provider configuration or writes to a DB.
 */
const CONCURRENCY = 2;
const ROUTE_SMOKE_RESULT_LIMIT = 10;
const RAIL_ROUTE_SMOKE_RESULT_LIMIT = 20;
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

async function buildUkraineRailRouteAcceptance(entry: typeof catalog[number]) {
  const providerId = 'ukraine-uz-odbl-rail-smoke';
  const feed = await cachedGtfsTimetable(providerId, entry.feedUrl);
  const { earliestDeparture, latestDeparture, serviceDate } = selectUpcomingSmokeServiceWindow(feed, new Date(), {
    localHour: 8,
    windowMinutes: 12 * 60,
    minimumLeadMinutes: 120,
    horizonDays: 14,
  });
  const routeCase = {
    id: 'kyiv-to-lviv',
    origin: [30.4897, 50.4408] as [number, number],
    destination: [23.9937, 49.8408] as [number, number],
  };
  const { result: search, diagnostics } = findWithSearchDiagnostics(() => findGtfsItinerariesWithStats(feed, {
    providerId,
    providerName: entry.name,
    providerCity: entry.city,
    origin: routeCase.origin,
    destination: routeCase.destination,
    earliestDeparture,
    latestDeparture,
    maximumJourneySeconds: 16 * 60 * 60,
    maximumWaitSeconds: 4 * 60 * 60,
    maximumTransfers: 0,
    maximumStopDistanceMeters: 2500,
    limit: RAIL_ROUTE_SMOKE_RESULT_LIMIT,
    allowedTransportTypes: ['train'],
  }));
  const journeys = search.itineraries.map(serializeSmokeJourney);
  const geometryEvidence = search.itineraries.map((journey) => journey.segments.map((segment) => {
    const shapeId = feed.trips.get(segment.tripId)?.shapeId;
    const shapePoints = shapeId ? feed.shapes?.get(shapeId) : undefined;
    return {
      tripId: segment.tripId,
      routeId: segment.routeId,
      shapeId: shapeId ?? null,
      shapePointCount: shapePoints?.length ?? 0,
      confirmedShape: (shapePoints?.length ?? 0) >= 2,
    };
  }));
  const geometryConfirmed = geometryEvidence.length > 0 && geometryEvidence.every((chain) => chain.every((item) => item.confirmedShape));
  return {
    provider: entry.name,
    source: { feedUrl: entry.feedUrl, sourceRef: entry.sourceRef, access: entry.access, license: entry.license ?? null,
      updateFrequency: entry.updateFrequency ?? null, coverage: entry.coverage },
    feed: withOptionalSourceFingerprint({
      stops: feed.stops.size,
      routes: feed.routes.size,
      trips: feed.trips.size,
      shapes: feed.shapes?.size ?? 0,
      timezone: feed.timezone,
    }, 'staticFeedSha256', feed.staticFeedSha256),
    serviceDate,
    queryWindow: [earliestDeparture.toISOString(), latestDeparture.toISOString()],
    cases: [{
      id: routeCase.id,
      origin: { label: 'Київ-Пасажирський, station-area pin', coordinates: routeCase.origin },
      destination: { label: 'Львів, station-area pin', coordinates: routeCase.destination },
      status: journeys.length ? 'ROUTES_FOUND' : 'NO_ROUTE_IN_QUERY_WINDOW',
      count: journeys.length,
      ...summarizeSmokeItineraries(search.itineraries),
      resultLimit: RAIL_ROUTE_SMOKE_RESULT_LIMIT,
      searchTruncated: search.searchTruncated,
      resultLimitReached: search.resultLimitReached,
      truncation: search.truncation,
      confirmedShapeGeometry: geometryConfirmed,
      geometryEvidence: geometryEvidence.slice(0, 5),
      plannerDiagnostics: diagnostics,
      examples: journeys.slice(0, 5),
      itineraries: journeys,
    }],
  };
}

async function probe(entry: typeof catalog[number]) {
  if (entry.access !== 'open') {
    return { name: entry.name, city: entry.city, sourceType: entry.sourceType, state: 'SKIPPED', reason: entry.access };
  }
  const report = await testProviderConnection({ id: entry.sourceRef, name: entry.name, source_type: entry.sourceType, feed_url: entry.feedUrl });
  return withOptionalSourceFingerprint({
    name: entry.name,
    city: entry.city,
    sourceType: entry.sourceType,
    state: report.health.toUpperCase(),
    counts: report.counts,
    bbox: report.bbox,
    responseMs: report.responseMs,
    checks: report.checks,
    ...(report.error ? { error: report.error } : {}),
  }, 'sourceVersion', report.sourceVersion);
}

async function main() {
  const scope = parseTransportFeedSmokeScope(process.argv.slice(2));
  const selectedEntries = selectTransportFeedSmokeEntries(catalog, scope);
  // The static feed is parsed below by the planner. In the focused Lviv scope, only
  // probe the realtime endpoint here to avoid downloading/parsing the static archive twice.
  const providerProbeEntries = scope === 'lviv-route' || scope === 'lviv-budget-diagnostic'
    ? selectedEntries.filter((entry) => entry.sourceType === 'gtfs_rt')
    : scope === 'ukraine-rail-route' ? [] : selectedEntries;
  const results = await mapLimit(providerProbeEntries, scope === 'lviv-route' || scope === 'lviv-budget-diagnostic' ? 1 : CONCURRENCY, probe);

  if (scope === 'ukraine-rail-route') {
    const railFeed = selectedEntries[0];
    if (!railFeed) throw new Error('Ukraine rail GTFS source is missing from the catalog');
    const routePlanner = await buildUkraineRailRouteAcceptance(railFeed);
    console.log(JSON.stringify({
      checkedAt: new Date().toISOString(),
      summary: {
        scope,
        catalogRows: catalog.length,
        selectedSources: selectedEntries.length,
        providerSourcesProbed: 0,
        note: 'Read-only dated GTFS planner acceptance. ODbL aggregate schedule is not an official operator feed; shapes must be present for geometry confirmation.',
      },
      catalog: [],
      routePlanner,
      supplementary: [],
    }, null, 2));
    const routeCase = routePlanner.cases[0]!;
    if (routeCase.count === 0 || routeCase.searchTruncated || routeCase.resultLimitReached || !routeCase.confirmedShapeGeometry) {
      process.exitCode = 1;
    }
    return;
  }

  const lvivStaticFeed = selectTransportFeedSmokeEntries(catalog, 'lviv-route')[0];
  if (!lvivStaticFeed) throw new Error('Lviv static GTFS source is missing from the catalog');
  const lvivFeed = await cachedGtfsTimetable('live-lviv-route-smoke', lvivStaticFeed.feedUrl);
  const { earliestDeparture, latestDeparture, serviceDate } = selectUpcomingSmokeServiceWindow(lvivFeed);
  const lvivRouteCases = [
    { id: 'center-to-main-station', origin: [24.0297, 49.8397] as [number, number], destination: [23.9893, 49.8397] as [number, number] },
    { id: 'north-to-sykhiv', origin: [24.0029933, 49.8681678] as [number, number], destination: [24.057585, 49.794117] as [number, number] },
  ];
  const createLvivSearchInput = (routeCase: typeof lvivRouteCases[number]) => ({
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
    limit: ROUTE_SMOKE_RESULT_LIMIT,
    allowedTransportTypes: ['bus', 'tram', 'trolleybus'] as const,
  });
  const runLvivSearch = (routeCase: typeof lvivRouteCases[number], graphLimits: GtfsGraphBudgetLimits = {}) =>
    findWithSearchDiagnostics(() => findGtfsItinerariesWithStats(lvivFeed, createLvivSearchInput(routeCase), graphLimits));
  const standardRuns = lvivRouteCases.map((routeCase) => runLvivSearch(routeCase));
  const itinerarySignature = (itinerary: GtfsItinerary) => itinerary.segments.map((segment) =>
    `${segment.transportType}:${segment.routeId}:${segment.tripId}:${segment.originStop.id}>${segment.destinationStop.id}`).join('|');
  const budgetDiagnostic = scope === 'lviv-budget-diagnostic' ? {
    mode: 'diagnostic-only bounded cap sweeps; does not alter API graph, endpoint-selection, candidate-pool, or response-page defaults',
    expandedGraphLimits: { totalSegments: 250_000, segmentsPerRoute: 30_000 },
    expandedStopSelectionLimits: { maxStopsPerSide: 112, maxStopsPerRoutePattern: 16 },
    expandedCandidatePool: { maxSearchResults: ROUTE_SMOKE_RESULT_LIMIT * 50, responsePageLimit: ROUTE_SMOKE_RESULT_LIMIT },
    stressCandidatePool: { maxSearchResults: ROUTE_SMOKE_RESULT_LIMIT * 100, responsePageLimit: ROUTE_SMOKE_RESULT_LIMIT },
    expandedObjectiveLookahead: { maxObjectiveReservoirSearchSteps: 200_000, candidatePoolLimit: ROUTE_SMOKE_RESULT_LIMIT * 25 },
    cases: lvivRouteCases.map((routeCase, index) => {
      const baseline = standardRuns[index]!;
      const graphOnly = runLvivSearch(routeCase, { totalSegments: 250_000, segmentsPerRoute: 30_000 });
      const stopOnly = runLvivSearch(routeCase, { maxStopsPerSide: 112, maxStopsPerRoutePattern: 16 });
      const candidatePoolOnly = runLvivSearch(routeCase, { maxSearchResults: ROUTE_SMOKE_RESULT_LIMIT * 50 });
      const stressCandidatePoolOnly = runLvivSearch(routeCase, { maxSearchResults: ROUTE_SMOKE_RESULT_LIMIT * 100 });
      const expandedObjectiveLookaheadOnly = runLvivSearch(routeCase, { maxObjectiveReservoirSearchSteps: 200_000 });
      const graphAndStops = runLvivSearch(routeCase, {
        totalSegments: 250_000, segmentsPerRoute: 30_000,
        maxStopsPerSide: 112, maxStopsPerRoutePattern: 16,
      });
      const baselineSignatures = baseline.result.itineraries.map(itinerarySignature);
      const summarizeVariant = (variant: typeof baseline) => {
        const signatures = variant.result.itineraries.map(itinerarySignature);
        const baselineSet = new Set(baselineSignatures);
        const variantSet = new Set(signatures);
        return {
          count: variant.result.itineraries.length,
          searchTruncated: variant.result.searchTruncated,
          resultLimitReached: variant.result.resultLimitReached,
          signatures,
          introducedSignatures: signatures.filter((signature) => !baselineSet.has(signature)),
          removedSignatures: baselineSignatures.filter((signature) => !variantSet.has(signature)),
          introducedItineraries: variant.result.itineraries
            .filter((itinerary) => !baselineSet.has(itinerarySignature(itinerary))).map(serializeSmokeJourney),
          removedItineraries: baseline.result.itineraries
            .filter((itinerary) => !variantSet.has(itinerarySignature(itinerary))).map(serializeSmokeJourney),
          plannerDiagnostics: variant.diagnostics,
        };
      };
      const graphOnlySummary = summarizeVariant(graphOnly);
      return {
        id: routeCase.id,
        baseline: summarizeVariant(baseline),
        // Preserve the existing report field for tooling that consumes prior diagnostic artifacts.
        expanded: graphOnlySummary,
        graphOnly: graphOnlySummary,
        stopSelectionOnly: summarizeVariant(stopOnly),
        candidatePoolOnly: summarizeVariant(candidatePoolOnly),
        stressCandidatePoolOnly: summarizeVariant(stressCandidatePoolOnly),
        expandedObjectiveLookaheadOnly: summarizeVariant(expandedObjectiveLookaheadOnly),
        graphAndStopSelection: summarizeVariant(graphAndStops),
      };
    }),
  } : undefined;
  const routePlanner = {
    provider: 'Львівавтодор GTFS → MARSHGO GTFS timetable planner',
    feed: withOptionalSourceFingerprint({
      stops: lvivFeed.stops.size,
      routes: lvivFeed.routes.size,
      trips: lvivFeed.trips.size,
      timezone: lvivFeed.timezone,
    }, 'staticFeedSha256', lvivFeed.staticFeedSha256),
    serviceDate,
    queryWindow: [earliestDeparture.toISOString(), latestDeparture.toISOString()],
    cases: lvivRouteCases.map((routeCase, index) => {
      const { result: search, diagnostics } = standardRuns[index]!;
      const itineraryEvidence = search.itineraries.map(serializeSmokeJourney);
      return {
        id: routeCase.id,
        status: search.itineraries.length ? 'ROUTES_FOUND' : 'NO_ROUTE_IN_QUERY_WINDOW',
        count: search.itineraries.length,
        ...summarizeSmokeItineraries(search.itineraries),
        resultLimit: ROUTE_SMOKE_RESULT_LIMIT,
        searchTruncated: search.searchTruncated,
        resultLimitReached: search.resultLimitReached,
        truncation: search.truncation,
        plannerDiagnostics: diagnostics,
        examples: itineraryEvidence.slice(0, 2),
        itineraries: itineraryEvidence,
      };
    }),
    ...(budgetDiagnostic ? { budgetDiagnostic } : {}),
  };

  const supplementary = scope !== 'all' ? [] : await Promise.all([
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
