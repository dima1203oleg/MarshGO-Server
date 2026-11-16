import { ukraineCatalog, ukraineCatalogWave2, ukraineCatalogWave3, kyivOpenDataCatalog } from '../server/mobility/ukraineCatalog';
import { testProviderConnection } from '../server/mobility/connection';
import { testGbfsConnection } from '../server/mobility/gbfs';
import { fetchJson } from '../server/mobility/safeFetch';
import { cachedGtfsTimetable, findGtfsItinerariesWithStats } from '../server/journey/gtfsTimetable';
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
  const cityStation = (pattern: RegExp) => [...feed.stops.values()]
    .filter((stop) => pattern.test(stop.name.normalize('NFKC')))
    .map((stop) => ({
      stop,
      stationNamePriority: /пасажир|вокзал|головн|station/i.test(stop.name) ? 1 : 0,
      scheduledCalls: feed.stopTimesByStop.get(stop.id)?.length ?? 0,
    }))
    .sort((left, right) => right.stationNamePriority - left.stationNamePriority
      || right.scheduledCalls - left.scheduledCalls
      || left.stop.name.localeCompare(right.stop.name)
      || left.stop.id.localeCompare(right.stop.id))[0]?.stop ?? null;
  const kharkivStation = cityStation(/харків|харков|kharkiv/i);
  const uzhhorodStation = cityStation(/ужгород|uzhhorod/i);
  const routeCases = [
    {
      id: 'kyiv-to-lviv',
      origin: [30.4897, 50.4408] as [number, number],
      destination: [23.9937, 49.8408] as [number, number],
      originLabel: 'Київ-Пасажирський, station-area pin',
      destinationLabel: 'Львів-Головний, station-area pin',
      maximumJourneySeconds: 16 * 60 * 60,
      maximumWaitSeconds: 4 * 60 * 60,
      maximumTransfers: 0,
      maximumStopDistanceMeters: 2500,
    },
    {
      id: 'kharkiv-to-uzhhorod',
      origin: kharkivStation ? [kharkivStation.lon, kharkivStation.lat] as [number, number] : null,
      destination: uzhhorodStation ? [uzhhorodStation.lon, uzhhorodStation.lat] as [number, number] : null,
      originLabel: kharkivStation?.name ?? 'Харків-Пасажирський',
      destinationLabel: uzhhorodStation?.name ?? 'Ужгород',
      maximumJourneySeconds: 36 * 60 * 60,
      maximumWaitSeconds: 8 * 60 * 60,
      maximumTransfers: 2,
      maximumStopDistanceMeters: 1000,
    },
  ];
  const regionalRailCities = [
    { id: 'vinnytsia', pattern: /вінниця|винница|vinnitsa|vinnytsia/i },
    { id: 'lutsk', pattern: /луцьк|луцк|lutsk/i },
    { id: 'dnipro', pattern: /дніпро|днепр|dnipro/i },
    { id: 'zhytomyr', pattern: /житомир|zhytomyr/i },
    { id: 'uzhhorod', pattern: /ужгород|uzhhorod/i },
    { id: 'zaporizhzhia', pattern: /запоріжжя|запорожье|zaporizhzhia/i },
    { id: 'ivano-frankivsk', pattern: /івано-франківськ|ивано-франковск|ivano-frankivsk/i },
    { id: 'kropyvnytskyi', pattern: /кропивницький|кировоград|kropyvnytskyi/i },
    { id: 'luhansk', pattern: /луганськ|луганск|luhansk/i },
    { id: 'lviv', pattern: /львів|львов|lviv/i },
    { id: 'mykolaiv', pattern: /миколаїв|николаев|mykolaiv/i },
    { id: 'odesa', pattern: /одеса|одесса|odesa/i },
    { id: 'poltava', pattern: /полтава|poltava/i },
    { id: 'rivne', pattern: /рівне|ровно|rivne/i },
    { id: 'sumy', pattern: /суми|sumy/i },
    { id: 'ternopil', pattern: /тернопіль|тернополь|ternopil/i },
    { id: 'kharkiv', pattern: /харків|харьков|kharkiv/i },
    { id: 'kherson', pattern: /херсон|kherson/i },
    { id: 'khmelnytskyi', pattern: /хмельницький|хмельницкий|khmelnytskyi/i },
    { id: 'cherkasy', pattern: /черкаси|черкассы|cherkasy/i },
    { id: 'chernivtsi', pattern: /чернівці|черновцы|chernivtsi/i },
    { id: 'chernihiv', pattern: /чернігів|чернигов|chernihiv/i },
    { id: 'donetsk', pattern: /донецьк|донецк|donetsk/i },
    { id: 'simferopol', pattern: /сімферополь|симферополь|simferopol/i },
    { id: 'sevastopol', pattern: /севастополь|sevastopol/i },
  ] as const;
  const kyivHub = cityStation(/київ-пасажирський|киев-пассажирский|kyiv passenger/i);
  const oblastRailConnections = [
    {
      oblastCenter: 'kyiv-city',
      status: kyivHub ? 'HUB_USED_AS_DESTINATION' : 'KYIV_HUB_NOT_FOUND_IN_FEED',
      hubStop: kyivHub ? { id: kyivHub.id, name: kyivHub.name, coordinates: [kyivHub.lon, kyivHub.lat] } : null,
    },
    {
      oblastCenter: 'kyiv-oblast',
      status: 'ADMINISTRATIVE_CENTER_SHARES_KYIV_HUB_ANCHOR',
      hubStop: kyivHub ? { id: kyivHub.id, name: kyivHub.name, coordinates: [kyivHub.lon, kyivHub.lat] } : null,
    },
  ] as Array<Record<string, unknown>>;
  for (const city of regionalRailCities) {
    const origin = cityStation(city.pattern);
    if (!origin || !kyivHub) {
      oblastRailConnections.push({
        oblastCenter: city.id,
        status: !origin ? 'STATION_NOT_FOUND_IN_FEED' : 'KYIV_HUB_NOT_FOUND_IN_FEED',
        originStop: origin ? { id: origin.id, name: origin.name, coordinates: [origin.lon, origin.lat] } : null,
      });
      continue;
    }
    const { result: search, diagnostics } = findWithSearchDiagnostics(() => findGtfsItinerariesWithStats(feed, {
      providerId,
      providerName: entry.name,
      providerCity: entry.city,
      origin: [origin.lon, origin.lat],
      destination: [kyivHub.lon, kyivHub.lat],
      earliestDeparture,
      latestDeparture,
      maximumJourneySeconds: 36 * 60 * 60,
      maximumWaitSeconds: 8 * 60 * 60,
      maximumTransfers: 2,
      maximumStopDistanceMeters: 1000,
      limit: RAIL_ROUTE_SMOKE_RESULT_LIMIT,
      allowedTransportTypes: ['train'],
    }));
    const hasShapes = search.itineraries.length > 0 && search.itineraries.every((journey) => journey.segments.every((segment) => {
      const shapeId = feed.trips.get(segment.tripId)?.shapeId;
      return (shapeId ? feed.shapes?.get(shapeId)?.length ?? 0 : 0) >= 2;
    }));
    const example = search.itineraries[0];
    oblastRailConnections.push({
      oblastCenter: city.id,
      status: search.itineraries.length ? 'ROUTES_FOUND_IN_QUERY_WINDOW' : 'NO_ROUTE_IN_QUERY_WINDOW',
      originStop: { id: origin.id, name: origin.name, coordinates: [origin.lon, origin.lat] },
      destinationStop: { id: kyivHub.id, name: kyivHub.name, coordinates: [kyivHub.lon, kyivHub.lat] },
      count: search.itineraries.length,
      ...summarizeSmokeItineraries(search.itineraries),
      searchTruncated: search.searchTruncated,
      resultLimitReached: search.resultLimitReached,
      allReturnedLegsHaveShapes: hasShapes,
      sample: example ? {
        departureAt: example.departureAt,
        arrivalAt: example.arrivalAt,
        transfers: example.transfers,
        legs: example.segments.map((segment) => {
          const shapeId = feed.trips.get(segment.tripId)?.shapeId;
          const pointCount = shapeId ? feed.shapes?.get(shapeId)?.length ?? 0 : 0;
          return {
            routeName: segment.routeName,
            tripId: segment.tripId,
            from: segment.originStop.name,
            to: segment.destinationStop.name,
            shapePointCount: pointCount,
            confirmedShape: pointCount >= 2,
          };
        }),
      } : null,
      plannerDiagnostics: diagnostics,
    });
  }
  const cases = routeCases.map((routeCase) => {
    if (!routeCase.origin || !routeCase.destination) {
      return {
        id: routeCase.id,
        origin: { label: routeCase.originLabel, coordinates: routeCase.origin },
        destination: { label: routeCase.destinationLabel, coordinates: routeCase.destination },
        status: 'STATION_NOT_FOUND_IN_FEED',
        count: 0,
        maximumLegCount: 0,
        multiLegCount: 0,
        searchTruncated: null,
        resultLimitReached: null,
        confirmedShapeGeometry: false,
        examples: [],
        itineraries: [],
      };
    }
    const { result: search, diagnostics } = findWithSearchDiagnostics(() => findGtfsItinerariesWithStats(feed, {
      providerId,
      providerName: entry.name,
      providerCity: entry.city,
      origin: routeCase.origin,
      destination: routeCase.destination,
      earliestDeparture,
      latestDeparture,
      maximumJourneySeconds: routeCase.maximumJourneySeconds,
      maximumWaitSeconds: routeCase.maximumWaitSeconds,
      maximumTransfers: routeCase.maximumTransfers,
      maximumStopDistanceMeters: routeCase.maximumStopDistanceMeters,
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
      id: routeCase.id,
      origin: { label: routeCase.originLabel, coordinates: routeCase.origin },
      destination: { label: routeCase.destinationLabel, coordinates: routeCase.destination },
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
    };
  });
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
    cases,
    oblastRailCoverageScope: { areaCells: 27, queriedRegionalCenters: regionalRailCities.length, kyivHubRows: 2 },
    oblastRailConnections,
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
  const providerProbeEntries = scope === 'lviv-route'
    ? selectedEntries.filter((entry) => entry.sourceType === 'gtfs_rt')
    : scope === 'ukraine-rail-route' ? [] : selectedEntries;
  const results = await mapLimit(providerProbeEntries, scope === 'lviv-route' ? 1 : CONCURRENCY, probe);

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
    if (routePlanner.cases.some((routeCase) => routeCase.count === 0 || routeCase.searchTruncated
      || routeCase.resultLimitReached || !routeCase.confirmedShapeGeometry)) {
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
        limit: ROUTE_SMOKE_RESULT_LIMIT,
        allowedTransportTypes: ['bus', 'tram', 'trolleybus'],
      }));
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
