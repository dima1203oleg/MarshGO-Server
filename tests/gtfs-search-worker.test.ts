import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GtfsSearchWorkerClient } from '../server/journey/gtfsSearchWorkerClient';
import { findGtfsItinerariesWithStats, findGtfsStopArrivals, mergeGtfsTimetables, parseGtfsTimetable } from '../server/journey/gtfsTimetable';
import { buildGtfsSearchGroups, GtfsSearchGroupCache, searchGtfsGroup, selectGtfsStopArrivals, selectGtfsTripMetadata } from '../server/journey/gtfsSearchWorkerCore';

function fixtureFeed() {
  const encode = (value: string) => new TextEncoder().encode(value);
  return parseGtfsTimetable({
    'agency.txt': encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': encode('route_id,agency_id,route_short_name,route_long_name,route_type\nr,a,7,Test bus,3'),
    'stops.txt': encode('stop_id,stop_name,stop_lat,stop_lon\norigin,Origin,49.8400,24.0200\ndestination,Destination,49.8500,24.0300'),
    'trips.txt': encode('route_id,service_id,trip_id,trip_headsign,direction_id\nr,weekday,t1,Destination,0'),
    // Leave enough scheduled time for the short walk from the query point to
    // the origin stop; departures before the passenger can reach the stop
    // must correctly be excluded by the planner.
    'stop_times.txt': encode('trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nt1,08:20:00,08:20:00,origin,1,0,0\nt1,09:00:00,09:00:00,destination,2,0,0'),
    'calendar.txt': encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
  });
}

const fixtureNow = new Date('2026-10-12T04:55:00Z');
const fixtureSearch = {
  providerId: 'not-used', providerName: 'not-used', origin: [24.0201, 49.8401] as [number, number],
  destination: [24.0301, 49.8501] as [number, number],
  earliestDeparture: new Date('2026-10-12T05:00:00Z'), latestDeparture: new Date('2026-10-12T06:00:00Z'),
  maximumJourneySeconds: 7200, maximumTransfers: 0, maximumWaitSeconds: 3600,
  maximumAccessWalkingMeters: 300, maximumEgressWalkingMeters: 300, maximumTransferWalkingMeters: 0,
  allowedModes: ['BUS'] as const,
};

test('GTFS search worker starts and returns an empty snapshot without configured feeds', async () => {
  const client = new GtfsSearchWorkerClient();
  const departure = new Date(Date.now() + 60_000);
  try {
    const result = await client.search({
      providerId: 'test', providerName: 'test', origin: [24, 49], destination: [24.1, 49.1],
      earliestDeparture: departure, latestDeparture: new Date(departure.getTime() + 60_000), limit: 5,
      maximumTransfers: 0, maximumWaitSeconds: 60, allowedModes: ['BUS'],
    }, []);
    assert.deepEqual(result.descriptors, []);
    assert.deepEqual(result.searches, []);
    assert.deepEqual(result.errors, []);
    const diagnostics = await client.diagnostics();
    assert.ok(diagnostics.rssBytes > 0);
    assert.ok(diagnostics.heapUsedBytes > 0);
    assert.deepEqual(diagnostics.feedCache, { entries: 0, estimatedBytes: 0 });
    assert.equal(diagnostics.groupCacheEntries, 0);
  } finally {
    await client.close();
  }
});

test('test-only GTFS URL loads the checked-in fixture through the worker and composes bus to tram', async () => {
  const fixtureDirectory = fileURLToPath(new URL('./fixtures/gtfs-http/', import.meta.url));
  const client = new GtfsSearchWorkerClient(fixtureDirectory);
  const departure = new Date();
  departure.setUTCDate(departure.getUTCDate() + 1);
  while (departure.getUTCDay() === 0 || departure.getUTCDay() === 6) {
    departure.setUTCDate(departure.getUTCDate() + 1);
  }
  departure.setUTCHours(4, 0, 0, 0);
  try {
    const result = await client.search({
      providerId: 'fixture-provider', providerName: 'fixture',
      origin: [24.0029933, 49.8681678], destination: [24.057585, 49.794117],
      now: new Date(departure.getTime() - 5 * 60_000),
      earliestDeparture: departure, latestDeparture: new Date(departure.getTime() + 4 * 60 * 60_000), limit: 20,
      maximumJourneySeconds: 4 * 60 * 60, maximumTransfers: 2, maximumWaitSeconds: 45 * 60,
      minimumTransferBufferSeconds: 5 * 60, maximumAccessWalkingMeters: 300,
      maximumEgressWalkingMeters: 300, maximumTransferWalkingMeters: 400,
      allowedModes: ['BUS', 'TRAM'], allowedTransportTypes: ['bus', 'tram'],
    }, [{ id: 'fixture-provider', name: 'Fixture Lviv', city: 'Львів', feedUrl: 'https://gtfs-api-fixture.invalid/lviv.zip' }]);
    assert.deepEqual(result.errors, []);
    const composed = result.searches.flatMap((search) => search.itineraries)
      .find((itinerary) => itinerary.segments.some((segment) => segment.transportType === 'bus')
        && itinerary.segments.some((segment) => segment.transportType === 'tram'));
    assert.ok(composed, 'the worker and planner compose scheduled bus and tram legs from the local fixture');
    assert.deepEqual(composed.segments.map((segment) => segment.transportType), ['bus', 'tram']);
    assert.ok(composed.segments.every((segment) => (segment.routeGeometry?.length ?? 0) >= 2));
  } finally {
    await client.close();
  }
});

test('GTFS fixture allowlist loads multi-timezone fixtures and respects Europe/Kyiv vs America/New_York schedule instants', async () => {
  const fixtureDirectory = fileURLToPath(new URL('./fixtures/gtfs-http/', import.meta.url));
  const client = new GtfsSearchWorkerClient(fixtureDirectory);
  const lvivProvider = {
    id: 'fixture-lviv',
    name: 'Fixture Lviv',
    city: 'Львів',
    feedUrl: 'https://gtfs-api-fixture.invalid/lviv.zip',
  };
  const nyProvider = {
    id: 'fixture-ny',
    name: 'Fixture New York',
    city: 'New York',
    feedUrl: 'https://gtfs-api-fixture.invalid/newyork.zip',
  };
  try {
    const searchResult = await client.search({
      providerId: 'multi-tz-search',
      providerName: 'multi-tz',
      origin: [24.0029933, 49.8681678],
      destination: [24.057585, 49.794117],
      now: new Date('2026-10-15T04:00:00.000Z'),
      earliestDeparture: new Date('2026-10-15T04:30:00.000Z'),
      latestDeparture: new Date('2026-10-15T14:00:00.000Z'),
      limit: 10,
      maximumJourneySeconds: 4 * 3600,
      maximumTransfers: 1,
      maximumWaitSeconds: 3600,
      allowedModes: ['BUS'],
    }, [lvivProvider, nyProvider]);

    assert.deepEqual(searchResult.errors, []);
    assert.equal(searchResult.descriptors.length, 2);

    const timezones = new Set(searchResult.descriptors.map((d) => d.timezone));
    assert.ok(timezones.has('Europe/Kyiv'), 'descriptors contain Europe/Kyiv search group');
    assert.ok(timezones.has('America/New_York'), 'descriptors contain America/New_York search group');

    // Both feeds publish departure 08:00:00 on weekday service.
    // In Europe/Kyiv (UTC+3 in October), 08:00:00 corresponds to 05:00:00Z.
    // In America/New_York (UTC-4 in October), 08:00:00 corresponds to 12:00:00Z.
    const lvivArrivals = await client.stopArrivals(lvivProvider, 'origin', new Date('2026-10-15T04:00:00.000Z'), 5);
    const nyArrivals = await client.stopArrivals(nyProvider, 'ny-origin', new Date('2026-10-15T11:00:00.000Z'), 5);

    assert.ok(lvivArrivals.arrivals.length > 0, 'Lviv fixture returns stop arrivals');
    assert.ok(nyArrivals.arrivals.length > 0, 'New York fixture returns stop arrivals');

    const lvivDepartureInstant = lvivArrivals.arrivals[0].scheduledArrivalAt.toISOString();
    const nyDepartureInstant = nyArrivals.arrivals[0].scheduledArrivalAt.toISOString();

    assert.equal(lvivDepartureInstant, '2026-10-15T05:00:00.000Z', '08:00:00 local in Europe/Kyiv maps to 05:00:00Z');
    assert.equal(nyDepartureInstant, '2026-10-15T12:00:00.000Z', '08:00:00 local in America/New_York maps to 12:00:00Z');

    // Reject unallowlisted URLs even when pointing to .invalid
    await assert.rejects(
      client.stopArrivals({
        id: 'other',
        name: 'Other',
        city: 'Other',
        feedUrl: 'https://gtfs-api-fixture.invalid/other.zip',
      }, 'origin', new Date('2026-10-15T04:00:00.000Z'), 1),
      /Unrecognized GTFS test fixture URL/,
    );
  } finally {
    await client.close();
  }
});

test('GTFS worker applies a hard bound to active plus queued requests', async () => {
  const client = new GtfsSearchWorkerClient();
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 9 }, () => client.diagnostics()));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 8);
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]?.reason), /capacity is temporarily full/);
  } finally {
    await client.close();
  }
});

test('worker search groups preserve feed-scoped routes and match the direct timetable search result', () => {
  const source = { providerId: 'lviv-provider', providerName: 'Lviv Transit', providerCity: 'Львів', feed: fixtureFeed() };
  const built = buildGtfsSearchGroups([source], 'unit-search');
  const descriptor = built.descriptors[0];
  assert.ok(descriptor);
  assert.deepEqual(descriptor.routeTypes, ['bus']);
  assert.equal(descriptor.hasMetro, false);
  const group = built.groups.get(descriptor.id);
  assert.ok(group);
  const directFeed = mergeGtfsTimetables([source]);
  assert.ok(directFeed);
  const expected = findGtfsItinerariesWithStats(directFeed, {
    ...fixtureSearch, providerId: source.providerId, providerName: source.providerName, now: fixtureNow,
  });
  const actual = searchGtfsGroup(group, { ...fixtureSearch, now: fixtureNow });
  assert.deepEqual(actual, expected);
  assert.equal(actual.itineraries.length, 1);
  assert.equal(actual.itineraries[0]?.segments[0]?.providerId, source.providerId);
});

test('worker search-group cache bounds retained feeds with LRU eviction and TTL expiry', () => {
  const cache = new GtfsSearchGroupCache(2, 100);
  const group = { sources: [], feed: fixtureFeed() };
  cache.set('a', group, 0);
  cache.set('b', group, 0);
  assert.equal(cache.get('a', 10), group);
  cache.set('c', group, 20);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('b', 21), undefined);
  assert.equal(cache.get('a', 99), group);
  assert.equal(cache.get('a', 100), undefined);
  assert.equal(cache.get('c', 119), group);
  assert.equal(cache.get('c', 120), undefined);
  assert.equal(cache.size, 0);
});

test('worker trip metadata keeps exact route direction and provider feed stop sequence', () => {
  const feed = fixtureFeed();
  assert.deepEqual(selectGtfsTripMetadata(feed, ['t1', 'missing', 't1']), {
    trips: [['t1', { routeId: 'r', directionId: '0' }]],
    stopTimes: [['t1', [
      { stopId: 'origin', sourceStopId: 'origin', sequence: 1 },
      { stopId: 'destination', sourceStopId: 'destination', sequence: 2 },
    ]]],
  });
});

test('worker stop-arrival projection matches schedule and fresh realtime status contracts', () => {
  const feed = fixtureFeed();
  const scheduleOnly = selectGtfsStopArrivals(feed, null, 'origin', fixtureNow, 10);
  assert.deepEqual(scheduleOnly.arrivals, findGtfsStopArrivals(feed, 'origin', { now: fixtureNow, limit: 10 }));
  assert.equal(scheduleOnly.stopKnown, true);
  assert.equal(scheduleOnly.realtimeStatus, 'NOT_CONFIGURED');
  assert.deepEqual(selectGtfsStopArrivals(feed, null, 'origin', fixtureNow, 10, { routeId: 'r', headsign: 'Destination' }).arrivals,
    findGtfsStopArrivals(feed, 'origin', { now: fixtureNow, limit: 10, routeId: 'r', headsign: 'Destination' }));

  const realtime = { feedTimestamp: fixtureNow, fresh: true, updates: new Map() };
  const liveConfigured = selectGtfsStopArrivals(feed, realtime, 'origin', fixtureNow, 10);
  assert.deepEqual(liveConfigured.arrivals, findGtfsStopArrivals({ ...feed, realtimeTripUpdates: realtime.updates }, 'origin', { now: fixtureNow, limit: 10 }));
  assert.equal(liveConfigured.realtimeStatus, 'AVAILABLE');
  assert.equal(liveConfigured.realtimeUpdatedAt, fixtureNow);
  assert.equal(liveConfigured.realtimeFeedTimestamp, fixtureNow);
});
