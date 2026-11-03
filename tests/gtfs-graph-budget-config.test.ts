import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARD_MAX_GTFS_GRAPH_SEGMENTS,
  HARD_MAX_GTFS_GRAPH_SEGMENTS_PER_ROUTE,
  HARD_MAX_GTFS_QUEUED_SEARCH_WORK,
  findGtfsItinerariesWithStats,
  mergeGtfsTimetables,
  parseGtfsTimetable,
  resolveGtfsGraphBudgetLimits,
} from '../server/journey/gtfsTimetable';
import { buildGtfsSearchGroups, searchGtfsGroup } from '../server/journey/gtfsSearchWorkerCore';

const STOP_TIMES = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type']
  // Three trips x three stops gives nine stop-pair segments, so any cap below nine is one the
  // search can actually hit and must disclose.
  .concat(['t1', 't2', 't3'].flatMap((trip, tripIndex) => [0, 1, 2].map((stopIndex) => {
    const minutes = 500 + tripIndex * 30 + stopIndex * 20;
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
    const stop = ['origin', 'mid', 'destination'][stopIndex];
    return `${trip},${time},${time},${stop},${stopIndex + 1},0,0`;
  }))).join('\n');

function budgetFeed() {
  const encode = (value: string) => new TextEncoder().encode(value);
  return parseGtfsTimetable({
    'agency.txt': encode('agency_id,agency_name,agency_url,agency_timezone\na,Budget Test,https://example.test,Europe/Kyiv'),
    'routes.txt': encode('route_id,agency_id,route_short_name,route_long_name,route_type\nr,a,7,Budget bus,3'),
    'stops.txt': encode('stop_id,stop_name,stop_lat,stop_lon\norigin,Origin,49.8400,24.0200\nmid,Mid,49.8450,24.0250\ndestination,Destination,49.8500,24.0300'),
    'trips.txt': encode('route_id,service_id,trip_id,trip_headsign,direction_id\nr,weekday,t1,Destination,0\nr,weekday,t2,Destination,0\nr,weekday,t3,Destination,0'),
    'stop_times.txt': encode(STOP_TIMES),
    'calendar.txt': encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,1,1,1,1,0,0,20261001,20261031'),
  });
}

const searchInput = {
  providerId: 'budget-provider', providerName: 'Budget Test', now: new Date('2026-10-12T04:55:00Z'),
  origin: [24.0201, 49.8401] as [number, number], destination: [24.0301, 49.8501] as [number, number],
  earliestDeparture: new Date('2026-10-12T05:00:00Z'), latestDeparture: new Date('2026-10-12T06:00:00Z'),
  maximumJourneySeconds: 7200, maximumTransfers: 0, maximumWaitSeconds: 3600, limit: 20,
  maximumAccessWalkingMeters: 300, maximumEgressWalkingMeters: 300, maximumTransferWalkingMeters: 0,
  allowedModes: ['BUS'] as const,
};

test('an unset graph budget keeps every shipped default and sends no override', () => {
  assert.deepEqual(resolveGtfsGraphBudgetLimits({}), {});
  assert.deepEqual(resolveGtfsGraphBudgetLimits({
    MARSHGO_GTFS_GRAPH_MAX_SEGMENTS: '   ', MARSHGO_GTFS_MAX_QUEUED_SEARCH_WORK: '',
  }), {});
});

test('a raised graph budget is honored above the compile-time default up to the measured ceiling', () => {
  assert.deepEqual(resolveGtfsGraphBudgetLimits({
    MARSHGO_GTFS_GRAPH_MAX_SEGMENTS: '140000',
    MARSHGO_GTFS_GRAPH_MAX_SEGMENTS_PER_ROUTE: '9000',
    MARSHGO_GTFS_MAX_QUEUED_SEARCH_WORK: '40000',
  }), { totalSegments: 140_000, segmentsPerRoute: 9_000, maxQueuedSearchWork: 40_000 });

  // Retention, not correctness, scales with these caps, so an oversized request is clamped rather
  // than trusted: one runaway value must not be able to OOM the API for every passenger.
  assert.deepEqual(resolveGtfsGraphBudgetLimits({
    MARSHGO_GTFS_GRAPH_MAX_SEGMENTS: '999999999',
    MARSHGO_GTFS_GRAPH_MAX_SEGMENTS_PER_ROUTE: '999999999',
    MARSHGO_GTFS_MAX_QUEUED_SEARCH_WORK: '999999999',
  }), {
    totalSegments: HARD_MAX_GTFS_GRAPH_SEGMENTS,
    segmentsPerRoute: HARD_MAX_GTFS_GRAPH_SEGMENTS_PER_ROUTE,
    maxQueuedSearchWork: HARD_MAX_GTFS_QUEUED_SEARCH_WORK,
  });
});

test('an unusable graph budget falls back to the shipped default instead of being reinterpreted', () => {
  for (const rawValue of ['abc', '0', '-4', '250.5', '1e309', 'Infinity', 'NaN']) {
    assert.deepEqual(resolveGtfsGraphBudgetLimits({ MARSHGO_GTFS_GRAPH_MAX_SEGMENTS: rawValue }),
      { totalSegments: 100_000 }, `"${rawValue}" must not silently change the retention cap`);
    assert.deepEqual(resolveGtfsGraphBudgetLimits({ MARSHGO_GTFS_GRAPH_MAX_SEGMENTS_PER_ROUTE: rawValue }),
      { segmentsPerRoute: 5_000 }, `"${rawValue}" must not silently change the per-route cap`);
    assert.deepEqual(resolveGtfsGraphBudgetLimits({ MARSHGO_GTFS_MAX_QUEUED_SEARCH_WORK: rawValue }),
      { maxQueuedSearchWork: 10_000 }, `"${rawValue}" must not silently change the search frontier`);
  }
  // Exponential notation names a real budget, which parseInt would have read as 3.
  assert.deepEqual(resolveGtfsGraphBudgetLimits({ MARSHGO_GTFS_GRAPH_MAX_SEGMENTS: '3e5' }), { totalSegments: 300_000 });
});

test('the planner accepts budgets above the old compile-time default and still rejects impossible ones', () => {
  const feed = budgetFeed();
  assert.doesNotThrow(() => findGtfsItinerariesWithStats(feed, searchInput, {
    totalSegments: 120_000, segmentsPerRoute: 6_000, maxQueuedSearchWork: 50_000,
  }));
  // A zero frontier stays legal: callers use it to prove the search discloses the work it drops.
  assert.doesNotThrow(() => findGtfsItinerariesWithStats(feed, searchInput, { maxQueuedSearchWork: 0 }));
  assert.throws(() => findGtfsItinerariesWithStats(feed, searchInput,
    { totalSegments: HARD_MAX_GTFS_GRAPH_SEGMENTS + 1 }), /bounds are invalid/);
  assert.throws(() => findGtfsItinerariesWithStats(feed, searchInput,
    { segmentsPerRoute: HARD_MAX_GTFS_GRAPH_SEGMENTS_PER_ROUTE + 1 }), /bounds are invalid/);
  assert.throws(() => findGtfsItinerariesWithStats(feed, searchInput,
    { maxQueuedSearchWork: HARD_MAX_GTFS_QUEUED_SEARCH_WORK + 1 }), /bounds are invalid/);
  assert.throws(() => findGtfsItinerariesWithStats(feed, searchInput, { maxQueuedSearchWork: -1 }), /bounds are invalid/);
});

test('the worker search honors the graph limits resolved from the environment', () => {
  const source = { providerId: 'budget-provider', providerName: 'Budget Test', providerCity: 'Львів', feed: budgetFeed() };
  const built = buildGtfsSearchGroups([source], 'budget-search');
  const group = built.groups.get(built.descriptors[0]!.id);
  assert.ok(group, 'the fixture provider forms one searchable group');

  const complete = searchGtfsGroup(group, searchInput, resolveGtfsGraphBudgetLimits({}));
  assert.equal(complete.candidateGraphTruncated, false, 'the shipped default retains this corridor whole');
  assert.ok(complete.itineraries.length > 0, 'the fixture yields at least one scheduled journey');

  // The caps that cut the live Lviv search were unreachable from outside the process; tightening
  // them here has to change what the same search returns, proving the environment is not inert.
  const starved = searchGtfsGroup(group, searchInput, resolveGtfsGraphBudgetLimits({
    MARSHGO_GTFS_GRAPH_MAX_SEGMENTS: '1', MARSHGO_GTFS_GRAPH_MAX_SEGMENTS_PER_ROUTE: '1',
  }));
  assert.equal(starved.candidateGraphTruncated, true, 'an operator-tightened graph cap reaches the planner');
  assert.equal(starved.searchTruncated, true, 'a starved graph is disclosed as truncated, never as a complete search');
  assert.deepEqual(starved, findGtfsItinerariesWithStats(mergeGtfsTimetables([source])!, searchInput,
    { totalSegments: 1, segmentsPerRoute: 1 }), 'the worker forwards the resolved limits untouched');
});
