import { ukraineCatalog, ukraineCatalogWave2, ukraineCatalogWave3, kyivOpenDataCatalog } from '../server/mobility/ukraineCatalog';
import { testProviderConnection } from '../server/mobility/connection';
import { testGbfsConnection } from '../server/mobility/gbfs';
import { fetchJson } from '../server/mobility/safeFetch';
import { cachedGtfsTimetable, findGtfsItinerariesWithStats, mergeGtfsTimetables } from '../server/journey/gtfsTimetable';
import { parseTransportFeedSmokeScope, selectTransportFeedSmokeEntries } from './transport-feed-smoke-scope';
import { isGtfsServiceActiveOnDate, selectUpcomingSmokeServiceWindow } from './transport-feed-smoke-window';
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
  const oblastLatestDeparture = new Date(earliestDeparture.getTime() + 24 * 60 * 60 * 1000);
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
      latestDeparture: oblastLatestDeparture,
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
    oblastRailCoverageScope: {
      areaCells: 27,
      queriedRegionalCenters: regionalRailCities.length,
      kyivHubRows: 2,
      queryWindow: [earliestDeparture.toISOString(), oblastLatestDeparture.toISOString()],
    },
    oblastRailConnections,
  };
}

async function buildUkraineIntermodalRouteAcceptance(entries: typeof catalog) {
  const byUrl = new Map(entries.map((entry) => [entry.feedUrl, entry]));
  const railUrl = 'https://jbb.ghsq.de/gtfs/ua-ukrzaliznytsya.gtfs.zip';
  const cityFeeds = [
    { id: 'odesa', url: 'https://files.mobilitydatabase.org/mdb-2946/latest.zip', city: 'Одеса' },
    { id: 'lviv', url: 'https://track.ua-gis.com/gtfs/lviv/static.zip', city: 'Львів' },
    { id: 'kyiv', url: 'https://jbb.ghsq.de/gtfs/ua-kyiv.gtfs.zip', city: 'Київ' },
    { id: 'uzhhorod', url: 'https://track.ua-gis.com/gtfs/uzhhorod/static.zip', city: 'Ужгород' },
    { id: 'stryi', url: 'https://track.ua-gis.com/gtfs/stryi/static.zip', city: 'Стрий' },
  ];
  const feeds = new Map<string, Awaited<ReturnType<typeof cachedGtfsTimetable>>>();
  const railEntry = byUrl.get(railUrl);
  if (!railEntry) throw new Error('Ukraine intermodal route acceptance is missing the national rail feed');
  const cityEntries = cityFeeds.map(({ id, url }) => {
    const entry = byUrl.get(url);
    if (!entry) throw new Error(`Ukraine intermodal route acceptance is missing the ${id} GTFS feed`);
    return entry;
  });
  for (const entry of [railEntry, ...cityEntries]) {
    feeds.set(entry.feedUrl, await cachedGtfsTimetable(`intermodal-${entry.sourceRef}`, entry.feedUrl));
  }

  const cases = [
    { id: 'odesa-to-lviv', origin: [30.7233, 46.4825] as [number, number], destination: [24.0297, 49.8397] as [number, number], cities: ['odesa', 'lviv'], maximumJourneySeconds: 16 * 60 * 60, compareRailOnly: true, stationPins: null },
    { id: 'kyiv-to-odesa', origin: [30.5234, 50.4501] as [number, number], destination: [30.7233, 46.4825] as [number, number], cities: ['kyiv', 'odesa'], maximumJourneySeconds: 14 * 60 * 60, compareRailOnly: true, stationPins: null },
    { id: 'lviv-to-uzhhorod', origin: [24.0297, 49.8397] as [number, number], destination: [22.3000, 48.6208] as [number, number], cities: ['lviv', 'uzhhorod'], maximumJourneySeconds: 12 * 60 * 60, compareRailOnly: true, stationPins: null },
    { id: 'kyiv-to-lviv-station-pins', origin: [30.4897, 50.4408] as [number, number], destination: [23.9937, 49.8408] as [number, number], cities: ['kyiv', 'lviv'], maximumJourneySeconds: 16 * 60 * 60, compareRailOnly: true, stationPins: ['Київ-Пасажирський', 'Львів-Головний'] as const },
    { id: 'odesa-to-lviv-station-pins', origin: [0, 0] as [number, number], destination: [0, 0] as [number, number], cities: ['odesa', 'lviv'], maximumJourneySeconds: 16 * 60 * 60, compareRailOnly: true, stationPins: ['Одеса-Головна', 'Львів-Головний'] as const },
    { id: 'kyiv-to-odesa-station-pins', origin: [0, 0] as [number, number], destination: [0, 0] as [number, number], cities: ['kyiv', 'odesa'], maximumJourneySeconds: 14 * 60 * 60, compareRailOnly: true, stationPins: ['Київ-Пасажирський', 'Одеса-Головна'] as const },
    { id: 'lviv-to-uzhhorod-station-pins', origin: [0, 0] as [number, number], destination: [0, 0] as [number, number], cities: ['lviv', 'uzhhorod'], maximumJourneySeconds: 12 * 60 * 60, compareRailOnly: true, stationPins: ['Львів-Головний', 'Ужгород'] as const },
    { id: 'stryi-shaped-bus-trip-control', origin: [0, 0] as [number, number], destination: [0, 0] as [number, number], cities: ['stryi'], maximumJourneySeconds: 6 * 60 * 60, compareRailOnly: false, stationPins: null, probeDirectTripFrom: 'stryi' },
  ];
  const outputs = [];
  for (const routeCase of cases) {
    const sources = [
      ...routeCase.cities.map((id) => {
        const city = cityFeeds.find((candidate) => candidate.id === id)!;
        const entry = byUrl.get(city.url)!;
        return { providerId: `intermodal-${id}`, providerName: entry.name, providerCity: city.city, feed: feeds.get(city.url)!,
          feedUrl: entry.feedUrl, license: entry.license ?? null, sourceRef: entry.sourceRef };
      }),
      { providerId: 'intermodal-ukraine-rail', providerName: railEntry.name, providerCity: railEntry.city, feed: feeds.get(railUrl)!,
        feedUrl: railEntry.feedUrl, license: railEntry.license ?? null, sourceRef: railEntry.sourceRef },
    ];
    const merged = mergeGtfsTimetables(sources);
    if (!merged) throw new Error(`Unable to merge scheduled feeds for ${routeCase.id}`);
    const railFeed = feeds.get(railUrl)!;
    const stationStop = (name: string) => {
      const normalized = name.trim().toLocaleLowerCase('uk-UA');
      return [...railFeed.stops.values()].find((stop) => stop.name.trim().toLocaleLowerCase('uk-UA') === normalized
        && (railFeed.stopTimesByStop.get(stop.id) ?? []).some(({ tripId }) => {
          const trip = railFeed.trips.get(tripId);
          const transportType = trip && railFeed.routes.get(trip.routeId)?.transportType;
          return transportType === 'train' || transportType === 'suburban_train' || transportType === 'city_train';
        })) ?? null;
    };
    const pinnedOrigin = routeCase.stationPins ? stationStop(routeCase.stationPins[0]) : null;
    const pinnedDestination = routeCase.stationPins ? stationStop(routeCase.stationPins[1]) : null;
    if (routeCase.stationPins && (!pinnedOrigin || !pinnedDestination)) {
      outputs.push({ id: routeCase.id, status: 'RAIL_STATION_PIN_NOT_FOUND', stationPins: routeCase.stationPins,
        resolved: [pinnedOrigin?.name ?? null, pinnedDestination?.name ?? null],
        limitations: ['Station pins must resolve to exact GTFS stops served by a rail trip.'] });
      continue;
    }
    const origin: [number, number] = pinnedOrigin ? [pinnedOrigin.lon, pinnedOrigin.lat] : routeCase.origin;
    const destination: [number, number] = pinnedDestination ? [pinnedDestination.lon, pinnedDestination.lat] : routeCase.destination;
    const directTripSource = 'probeDirectTripFrom' in routeCase ? routeCase.probeDirectTripFrom : null;
    const { earliestDeparture, latestDeparture, serviceDate } = selectUpcomingSmokeServiceWindow(merged, new Date(), {
      localHour: 8, windowMinutes: directTripSource ? 12 * 60 : 3 * 60, minimumLeadMinutes: 120, horizonDays: 14,
    });
    const directTripFeed = directTripSource ? feeds.get(cityFeeds.find((city) => city.id === directTripSource)!.url)! : null;
    const directTripCandidate = directTripFeed ? [...directTripFeed.trips.entries()].flatMap(([tripId, trip]) => {
      if (!isGtfsServiceActiveOnDate(directTripFeed, trip.serviceId, serviceDate)) return [];
      const route = directTripFeed.routes.get(trip.routeId);
      const shapePointCount = trip.shapeId ? directTripFeed.shapes?.get(trip.shapeId)?.length ?? 0 : 0;
      const stopTimes = directTripFeed.stopTimes.get(tripId) ?? [];
      const firstStopTime = stopTimes[0];
      const lastStopTime = stopTimes.at(-1);
      const firstStop = firstStopTime ? directTripFeed.stops.get(firstStopTime.stopId) : undefined;
      const lastStop = lastStopTime ? directTripFeed.stops.get(lastStopTime.stopId) : undefined;
      const durationSeconds = firstStopTime && lastStopTime ? lastStopTime.arrivalSeconds - firstStopTime.departureSeconds : 0;
      if (route?.transportType !== 'bus' || shapePointCount < 2 || !firstStopTime || !lastStopTime
        || !firstStop || !lastStop || stopTimes.length < 2 || firstStopTime.departureSeconds < 8 * 60 * 60
        || firstStopTime.departureSeconds >= 20 * 60 * 60 || durationSeconds < 1 || durationSeconds > 6 * 60 * 60) return [];
      return [{ tripId, routeId: trip.routeId, routeName: route.name, departureSeconds: firstStopTime.departureSeconds,
        durationSeconds, shapePointCount, originStop: firstStop, destinationStop: lastStop }];
    }).sort((left, right) => left.departureSeconds - right.departureSeconds || left.tripId.localeCompare(right.tripId))[0] ?? null : null;
    if (directTripSource && !directTripCandidate) {
      outputs.push({ id: routeCase.id, status: 'NO_ACTIVE_SHAPED_TRIP', serviceDate,
        limitations: ['No upcoming active Stryi bus trip with ordered stops and a shape was available inside the sampled service window.'] });
      continue;
    }
    const queryOrigin: [number, number] = directTripCandidate
      ? [directTripCandidate.originStop.lon, directTripCandidate.originStop.lat] : origin;
    const queryDestination: [number, number] = directTripCandidate
      ? [directTripCandidate.destinationStop.lon, directTripCandidate.destinationStop.lat] : destination;
    const searchInput = {
      providerId: 'ukraine-intermodal-smoke', providerName: 'MARSHGO merged municipal + national GTFS acceptance', providerCity: 'Україна',
      origin: queryOrigin, destination: queryDestination, earliestDeparture, latestDeparture,
      maximumJourneySeconds: routeCase.maximumJourneySeconds, maximumWaitSeconds: 3 * 60 * 60,
      maximumTransfers: directTripCandidate ? 0 : 2,
      maximumAccessWalkingMeters: directTripCandidate ? 100 : 900,
      maximumEgressWalkingMeters: directTripCandidate ? 100 : 1_000,
      maximumTransferWalkingMeters: 400,
      maximumStopDistanceMeters: directTripCandidate ? 100 : 1_000,
      limit: RAIL_ROUTE_SMOKE_RESULT_LIMIT,
      allowedTransportTypes: directTripCandidate ? ['bus'] : ['bus', 'tram', 'trolleybus', 'train'],
    } as const;
    const { result: search, diagnostics } = findWithSearchDiagnostics(() => findGtfsItinerariesWithStats(merged, searchInput));
    const railOnlyControl = routeCase.compareRailOnly
      ? findWithSearchDiagnostics(() => findGtfsItinerariesWithStats(merged, {
        ...searchInput, providerName: 'National rail only control', maximumTransfers: 0,
        allowedTransportTypes: ['train'],
      }))
      : null;
    const multiProvider = search.itineraries.filter((journey) => journey.segments.some((segment) => segment.providerId === 'intermodal-ukraine-rail')
      && journey.segments.some((segment) => segment.providerId !== 'intermodal-ukraine-rail'));
    const directFeedRouteFound = directTripCandidate ? search.itineraries.some((journey) => journey.segments.some((segment) =>
      segment.providerId === `intermodal-${directTripSource}`)) : false;
    const tripShape = (tripId: string) => {
      const trip = merged.trips.get(tripId);
      const points = trip?.shapeId ? merged.shapes?.get(trip.shapeId)?.length ?? 0 : 0;
      return { tripId, shapePointCount: points, shapePresent: points >= 2 };
    };
    const serialized = search.itineraries.map((journey) => ({
      ...serializeSmokeJourney(journey),
      providerChain: journey.segments.map((segment) => ({ providerId: segment.providerId, providerName: segment.providerName, city: segment.providerCity ?? null })),
      legs: journey.segments.map((segment) => ({
        providerId: segment.providerId, providerName: segment.providerName, mode: segment.transportType,
        routeName: segment.routeName, from: segment.originStop.name, to: segment.destinationStop.name,
        departureAt: segment.departureAt, arrivalAt: segment.arrivalAt, ...tripShape(segment.tripId),
      })),
      transferWalkingMeters: journey.transferWalkingMeters,
      transferWalkingSeconds: journey.transferWalkingSeconds,
      transferWalkStreetGeometryVerified: false,
      endpointWalkStreetGeometryVerified: false,
    }));
    outputs.push({
      id: routeCase.id,
      acceptanceKind: directTripCandidate ? 'LOCAL_SHAPED_SCHEDULED_ROUTE_CONTROL' : 'CROSS_PROVIDER_ROUTE_CHAIN',
      status: directFeedRouteFound ? 'SOURCE_ROUTE_FOUND' : multiProvider.length ? 'MULTI_PROVIDER_CHAIN_FOUND' : search.itineraries.length ? 'SCHEDULED_ROUTES_FOUND_NO_MULTI_PROVIDER_CHAIN' : 'NO_ROUTE_IN_QUERY_WINDOW',
      serviceDate, queryWindow: [earliestDeparture.toISOString(), latestDeparture.toISOString()],
      origin: queryOrigin, destination: queryDestination,
      ...(directTripCandidate ? { directTripControl: {
        providerId: `intermodal-${directTripSource}`, tripId: directTripCandidate.tripId, routeId: directTripCandidate.routeId,
        routeName: directTripCandidate.routeName, departureSecondsAfterServiceDayStart: directTripCandidate.departureSeconds,
        durationSeconds: directTripCandidate.durationSeconds, shapePointCount: directTripCandidate.shapePointCount,
        originStop: directTripCandidate.originStop.name, destinationStop: directTripCandidate.destinationStop.name,
        providerRouteReturned: directFeedRouteFound,
      } } : {}),
      ...(routeCase.stationPins ? { stationPins: { requested: routeCase.stationPins, resolved: [pinnedOrigin?.name, pinnedDestination?.name] } } : {}),
      feedFingerprints: sources.map((source) => ({ providerId: source.providerId, providerName: source.providerName, providerCity: source.providerCity,
        feedUrl: source.feedUrl, license: source.license, sourceRef: source.sourceRef,
        staticFeedSha256: source.feed.staticFeedSha256 ?? null, stops: source.feed.stops.size, routes: source.feed.routes.size, trips: source.feed.trips.size })),
      count: search.itineraries.length, multiProviderChainCount: multiProvider.length,
      allReturnedLegsHaveShapes: search.itineraries.length > 0 && search.itineraries.every((journey) => journey.segments.every((segment) => tripShape(segment.tripId).shapePresent)),
      searchTruncated: search.searchTruncated, resultLimitReached: search.resultLimitReached, truncation: search.truncation,
      plannerDiagnostics: diagnostics, examples: serialized.slice(0, 5),
      ...(railOnlyControl ? { railOnlyControl: {
        count: railOnlyControl.result.itineraries.length,
        searchTruncated: railOnlyControl.result.searchTruncated,
        resultLimitReached: railOnlyControl.result.resultLimitReached,
        allReturnedLegsHaveShapes: railOnlyControl.result.itineraries.length > 0 && railOnlyControl.result.itineraries.every((journey) => journey.segments.every((segment) => tripShape(segment.tripId).shapePresent)),
        plannerDiagnostics: railOnlyControl.diagnostics,
        examples: railOnlyControl.result.itineraries.slice(0, 3).map(serializeSmokeJourney),
      } } : {}),
      limitations: ['Scheduled timetable only; no live positions or fares implied.', 'Initial/last-mile and transfer walking are lower-bound distances; street-network geometry has not been verified.', 'Selected corridors plus one feed-derived Stryi bus control do not establish area-wide or Ukraine-wide coverage.'],
    });
  }
  return { provider: 'Current municipal GTFS + national ODbL rail GTFS merged by the production timetable merger', cases: outputs };
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
    : scope === 'ukraine-rail-route' || scope === 'ukraine-intermodal-route' ? [] : selectedEntries;
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

  if (scope === 'ukraine-intermodal-route') {
    const routePlanner = await buildUkraineIntermodalRouteAcceptance(selectedEntries);
    console.log(JSON.stringify({
      checkedAt: new Date().toISOString(),
      summary: {
        scope, catalogRows: catalog.length, selectedSources: selectedEntries.length, providerSourcesProbed: 0,
        note: 'Read-only dated multi-provider GTFS routing with the production feed merger; a found sample is corridor evidence only, never nationwide coverage.',
      },
      catalog: [], routePlanner, supplementary: [],
    }, null, 2));
    if (routePlanner.cases.some((routeCase) => {
      const routeFound = routeCase.status === 'SOURCE_ROUTE_FOUND' || routeCase.status === 'MULTI_PROVIDER_CHAIN_FOUND';
      return !routeFound || routeCase.searchTruncated || routeCase.resultLimitReached || !routeCase.allReturnedLegsHaveShapes;
    })) process.exitCode = 1;
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
