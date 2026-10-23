import test from 'node:test';
import assert from 'node:assert/strict';
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

  const realtime = { feedTimestamp: fixtureNow, fresh: true, updates: new Map() };
  const liveConfigured = selectGtfsStopArrivals(feed, realtime, 'origin', fixtureNow, 10);
  assert.deepEqual(liveConfigured.arrivals, findGtfsStopArrivals({ ...feed, realtimeTripUpdates: realtime.updates }, 'origin', { now: fixtureNow, limit: 10 }));
  assert.equal(liveConfigured.realtimeStatus, 'AVAILABLE');
  assert.equal(liveConfigured.realtimeUpdatedAt, fixtureNow);
});
