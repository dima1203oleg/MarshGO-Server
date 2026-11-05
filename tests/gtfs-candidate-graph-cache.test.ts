import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearGtfsCandidateGraphCache,
  findGtfsItinerariesWithStats,
  getGtfsCandidateGraphCacheStats,
  gtfsFeedContentFingerprint,
  parseGtfsTimetable,
  type GtfsItinerarySearchResult,
  type GtfsTimetableFeed,
} from '../server/journey/gtfsTimetable';

const FILES = {
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv',
  'routes.txt': [
    'route_id,agency_id,route_short_name,route_long_name,route_type',
    'r1,a,1,Regional west,3',
    'r2,a,2,Regional east,3',
    'r3,a,3,Direct express,3',
  ].join('\n'),
  'stops.txt': [
    'stop_id,stop_name,stop_lat,stop_lon,zone_id',
    'stop-a,Origin,49.8400,24.0000,zone-a',
    'stop-b,Midpoint,49.7000,23.9500,zone-b',
    'stop-c,Hub,49.5000,23.9000,zone-c',
    'stop-d,Outer,49.3000,23.8600,zone-d',
    'stop-e,Destination,49.2600,23.8500,zone-e',
  ].join('\n'),
  'trips.txt': [
    'route_id,service_id,trip_id,trip_headsign,shape_id',
    'r1,daily,t1,Regional west,S1',
    'r2,daily,t2,Regional east,S2',
    'r3,daily,t3,Direct express,S3',
  ].join('\n'),
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
    't1,08:00:00,08:00:00,stop-a,1,0,0',
    't1,08:20:00,08:20:00,stop-b,2,0,0',
    't1,08:40:00,08:40:00,stop-c,3,0,0',
    't2,09:10:00,09:10:00,stop-c,1,0,0',
    't2,09:40:00,09:40:00,stop-d,2,0,0',
    't2,10:05:00,10:05:00,stop-e,3,0,0',
    't3,08:10:00,08:10:00,stop-a,1,0,0',
    't3,09:15:00,09:15:00,stop-e,2,0,0',
  ].join('\n'),
  'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ndaily,1,1,1,1,1,1,1,20260101,20261231',
  'shapes.txt': [
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    'S1,49.8400,24.0000,1',
    'S1,49.7000,23.9500,2',
    'S1,49.5000,23.9000,3',
    'S2,49.5000,23.9000,1',
    'S2,49.3000,23.8600,2',
    'S2,49.2600,23.8500,3',
    'S3,49.8400,24.0000,1',
    'S3,49.5500,23.9200,2',
    'S3,49.2600,23.8500,3',
  ].join('\n'),
};

const FETCHED_AT = new Date('2026-11-05T00:00:00Z');

function encodeFiles(files: Record<string, string>): Record<string, Uint8Array> {
  const encoder = new TextEncoder();
  return Object.fromEntries(Object.entries(files).map(([name, body]) => [name, encoder.encode(body)]));
}

function createFeed(fetchedAt = FETCHED_AT): GtfsTimetableFeed {
  return parseGtfsTimetable(encodeFiles(FILES), fetchedAt, 'Europe/Kyiv');
}

/** One real Lviv-region shaped intercity query: 65 km along the corridor. */
function searchInput(overrides: Partial<Parameters<typeof findGtfsItinerariesWithStats>[1]> = {}) {
  return {
    providerId: 'p1',
    providerName: 'Test Transit',
    origin: [24.0000, 49.8400] as [number, number],
    destination: [23.8500, 49.2600] as [number, number],
    earliestDeparture: new Date('2026-11-06T06:00:00Z'),
    latestDeparture: new Date('2026-11-06T07:00:00Z'),
    now: new Date('2026-11-01T00:00:00Z'),
    maximumTransfers: 1,
    limit: 10,
    ...overrides,
  };
}

function serialise(result: GtfsItinerarySearchResult): string {
  return JSON.stringify({
    itineraries: result.itineraries,
    searchTruncated: result.searchTruncated,
    resultLimitReached: result.resultLimitReached,
    candidateGraphTruncated: result.candidateGraphTruncated,
    truncation: result.truncation,
  });
}

test('an identical repeat reuses the candidate graph and returns byte-identical itineraries', () => {
  clearGtfsCandidateGraphCache();
  const feed = createFeed();
  const first = findGtfsItinerariesWithStats(feed, searchInput());
  assert.ok(first.itineraries.length > 0, 'fixture must produce at least one itinerary');
  assert.equal(first.itineraries.some((itinerary) => itinerary.transfers > 0), true,
    'fixture must exercise a transfer chain so the graph, not just one direct line, is covered');
  assert.equal(getGtfsCandidateGraphCacheStats().misses, 1);
  assert.equal(getGtfsCandidateGraphCacheStats().entries, 1);

  // A second identical search: new Date objects, different `now` (the graph does
  // not depend on it), same corridor, window and feeds.
  const second = findGtfsItinerariesWithStats(feed, searchInput({ now: new Date('2026-11-01T00:05:00Z') }));
  const stats = getGtfsCandidateGraphCacheStats();
  assert.equal(stats.hits, 1, 'the second identical search must be served from the cached graph');
  assert.equal(stats.misses, 1);
  assert.equal(serialise(second), serialise(first),
    'a cache hit must reproduce the exact itineraries, truncation flags and geometry of the rebuilt graph');

  // The shape-index WeakMap is rebuilt on a hit; without it the map geometry and
  // the stop list of every returned segment would silently disappear.
  const direct = first.itineraries.find((itinerary) => itinerary.transfers === 0);
  assert.ok(direct, 'fixture must keep the direct line');
  const segment = direct.segments[0];
  assert.ok(segment?.routeGeometry && segment.routeGeometry.length >= 3,
    'the cached graph must still resolve route geometry through the rebuilt shape index');
  assert.ok(segment.stops && segment.stops.length >= 2, 'the cached graph must still resolve the ordered stop calls');
  assert.deepEqual(segment.traveledZoneIds, ['zone-a', 'zone-e']);
});

test('the cache key covers the query window, the time window bounds and the feed version', () => {
  clearGtfsCandidateGraphCache();
  const feed = createFeed();
  findGtfsItinerariesWithStats(feed, searchInput());
  assert.equal(getGtfsCandidateGraphCacheStats().entries, 1);

  // A different departure window selects different trip instances, so it must
  // rebuild instead of reusing the previous graph.
  findGtfsItinerariesWithStats(feed, searchInput({ earliestDeparture: new Date('2026-11-06T06:30:00Z') }));
  assert.equal(getGtfsCandidateGraphCacheStats().hits, 0);
  assert.equal(getGtfsCandidateGraphCacheStats().misses, 2);

  // Re-merging the same source bytes yields a new feed object with the same
  // content version, which must still hit.
  const reparsed = createFeed(new Date(FETCHED_AT.getTime()));
  assert.equal(gtfsFeedContentFingerprint(reparsed), gtfsFeedContentFingerprint(feed),
    'an unchanged feed must keep the same content fingerprint');
  findGtfsItinerariesWithStats(reparsed, searchInput());
  assert.equal(getGtfsCandidateGraphCacheStats().hits, 1, 'an unchanged re-parsed feed must reuse the graph');

  // A schedule edit keeps every id and can keep the fetch stamp (two fixtures
  // parsed in the same millisecond, or a provider republishing a corrected
  // timetable), so the content version - not the stamp - must invalidate it.
  const edited = parseGtfsTimetable(encodeFiles({ ...FILES,
    'stop_times.txt': FILES['stop_times.txt'].replace('t3,09:15:00', 't3,09:05:00') }), FETCHED_AT, 'Europe/Kyiv');
  assert.notEqual(gtfsFeedContentFingerprint(edited), gtfsFeedContentFingerprint(feed),
    'a stop_times edit alone must change the content version');
  findGtfsItinerariesWithStats(edited, searchInput());
  assert.equal(getGtfsCandidateGraphCacheStats().hits, 1,
    'a same-stamp schedule edit must rebuild instead of reusing the old graph');

  // A re-published feed (new fetch stamp) must never be served from the old graph.
  const refreshed = createFeed(new Date(FETCHED_AT.getTime() + 6 * 60 * 60_000));
  assert.notEqual(gtfsFeedContentFingerprint(refreshed), gtfsFeedContentFingerprint(feed));
  findGtfsItinerariesWithStats(refreshed, searchInput());
  assert.equal(getGtfsCandidateGraphCacheStats().hits, 1);

  // A newer realtime snapshot changes predicted times, so it must rebuild too.
  const realtime = (updatedAt: Date): GtfsTimetableFeed => ({
    ...refreshed,
    realtimeTripUpdates: new Map([['t1', {
      tripId: 't1', routeId: 'r1', startDate: '20261106', relationship: 'SCHEDULED' as const, stops: [],
      updatedAt, feedTimestamp: updatedAt,
    }]]),
  });
  const firstSnapshot = realtime(new Date('2026-11-06T05:55:00Z'));
  const firstResult = findGtfsItinerariesWithStats(firstSnapshot, searchInput());
  const hitsBefore = getGtfsCandidateGraphCacheStats().hits;
  assert.equal(hitsBefore, 1);
  const secondResult = findGtfsItinerariesWithStats(realtime(new Date('2026-11-06T06:05:00Z')), searchInput());
  assert.equal(getGtfsCandidateGraphCacheStats().hits, hitsBefore,
    'a new realtime snapshot must not reuse the graph keyed on the previous predictions');
  assert.equal(serialise(secondResult), serialise(firstResult),
    'the fixture realtime overlay is empty, so rebuilding must not change the journeys');
});

test('the candidate graph cache is bounded and can be disabled without changing results', () => {
  clearGtfsCandidateGraphCache();
  const feed = createFeed();
  for (const offsetMinutes of [0, 10, 20]) {
    findGtfsItinerariesWithStats(feed, searchInput({
      earliestDeparture: new Date(Date.UTC(2026, 10, 6, 6, offsetMinutes)),
      latestDeparture: new Date(Date.UTC(2026, 10, 6, 7, offsetMinutes)),
    }));
  }
  const bounded = getGtfsCandidateGraphCacheStats();
  assert.equal(bounded.misses, 3);
  assert.equal(bounded.entries, 2, 'the cache must evict the oldest graph instead of growing per request');
  assert.ok(bounded.estimatedBytes > 0 && bounded.estimatedBytes <= 64 * 1024 * 1024,
    'the cache must stay under its byte ceiling');

  const previous = process.env.MARSHGO_GTFS_GRAPH_CACHE;
  process.env.MARSHGO_GTFS_GRAPH_CACHE = '0';
  try {
    const before = getGtfsCandidateGraphCacheStats();
    const disabledResult = findGtfsItinerariesWithStats(feed, searchInput());
    const after = getGtfsCandidateGraphCacheStats();
    assert.deepEqual(after, before, 'a disabled cache must neither read nor write');
    delete process.env.MARSHGO_GTFS_GRAPH_CACHE;
    // The base window was evicted above, so the first enabled search rebuilds
    // and stores the graph; the repeat is the one that must hit.
    const rebuiltResult = findGtfsItinerariesWithStats(feed, searchInput());
    assert.equal(serialise(rebuiltResult), serialise(disabledResult),
      'reusing the graph must not change the journeys the search returns');
    const hitsBeforeRepeat = getGtfsCandidateGraphCacheStats().hits;
    const repeatedResult = findGtfsItinerariesWithStats(feed, searchInput());
    assert.equal(getGtfsCandidateGraphCacheStats().hits, hitsBeforeRepeat + 1);
    assert.equal(serialise(repeatedResult), serialise(disabledResult));
  } finally {
    if (previous === undefined) delete process.env.MARSHGO_GTFS_GRAPH_CACHE;
    else process.env.MARSHGO_GTFS_GRAPH_CACHE = previous;
  }
});
