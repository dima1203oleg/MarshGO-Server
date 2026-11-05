import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGtfsRealtimeOverlay,
  clearGtfsCandidateGraphCache,
  findGtfsItinerariesWithStats,
  getGtfsCandidateGraphCacheStats,
  gtfsFeedContentFingerprint,
  parseGtfsTimetable,
  type GtfsDirectJourney,
  type GtfsItinerarySearchResult,
  type GtfsTimetableFeed,
} from '../server/journey/gtfsTimetable';
import type { GtfsRealtimeStopUpdate, GtfsRealtimeTripUpdate } from '../server/journey/gtfsRealtime';

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
const SERVICE_DATE = '20261106';

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

/**
 * Key order is not part of the contract: a re-overlaid segment can carry the
 * same values with a different insertion order than a rebuilt one, so compare
 * the canonical form and let value equality decide.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function serialise(result: GtfsItinerarySearchResult): string {
  return JSON.stringify(canonical({
    itineraries: result.itineraries,
    searchTruncated: result.searchTruncated,
    resultLimitReached: result.resultLimitReached,
    candidateGraphTruncated: result.candidateGraphTruncated,
    truncation: result.truncation,
  }));
}

function scheduleUpdate(tripId: string, stops: GtfsRealtimeStopUpdate[], updatedAt = new Date('2026-11-06T05:55:00Z')): GtfsRealtimeTripUpdate {
  return { tripId, startDate: SERVICE_DATE, relationship: 'SCHEDULED', stops, updatedAt, feedTimestamp: updatedAt };
}

/** Attach a realtime snapshot without touching the structural feed content. */
function withRealtime(feed: GtfsTimetableFeed, updates: GtfsRealtimeTripUpdate[]): GtfsTimetableFeed {
  return { ...feed, realtimeTripUpdates: new Map(updates.map((update) => [`${update.tripId}\u0000${update.startDate}`, update])) };
}

function realtimeTimes(delaySeconds: number, stopSequence: number): GtfsRealtimeStopUpdate {
  return {
    stopSequence,
    relationship: 'SCHEDULED',
    arrival: { delaySeconds },
    departure: { delaySeconds },
  };
}

/**
 * Collect the planner's opt-in debug payload so the tests can assert the
 * diagnostics a live deployment reads, not just the returned journeys.
 */
function captureSearchDebug(run: () => void): Array<Record<string, unknown>> {
  const previous = process.env.MARSHGO_GTFS_SEARCH_DEBUG;
  process.env.MARSHGO_GTFS_SEARCH_DEBUG = '1';
  const original = console.info;
  const records: Array<Record<string, unknown>> = [];
  console.info = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first !== 'string') return;
    try {
      const parsed = JSON.parse(first) as Record<string, unknown>;
      if (parsed.event === 'gtfs.search.debug') records.push(parsed);
    } catch {
      // Non-JSON diagnostics are not part of this contract.
    }
  };
  try {
    run();
  } finally {
    console.info = original;
    if (previous === undefined) delete process.env.MARSHGO_GTFS_SEARCH_DEBUG;
    else process.env.MARSHGO_GTFS_SEARCH_DEBUG = previous;
  }
  return records;
}

function rankedPayloads(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const ranked = records.filter((record) => record.stage === 'itineraries-ranked');
  assert.ok(ranked.length > 0, 'a search must emit an itineraries-ranked payload');
  return ranked;
}

function onlyRankedPayload(records: Array<Record<string, unknown>>): Record<string, unknown> {
  const ranked = rankedPayloads(records);
  assert.equal(ranked.length, 1, 'one search must emit exactly one itineraries-ranked payload');
  return ranked[0]!;
}

function withCacheDisabled(run: () => void): void {
  const previous = process.env.MARSHGO_GTFS_GRAPH_CACHE;
  process.env.MARSHGO_GTFS_GRAPH_CACHE = '0';
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.MARSHGO_GTFS_GRAPH_CACHE;
    else process.env.MARSHGO_GTFS_GRAPH_CACHE = previous;
  }
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
});

test('a re-fetched realtime snapshot with the same predictions keeps the structural graph', () => {
  clearGtfsCandidateGraphCache();
  const feed = createFeed();
  // Same overlay content, different snapshot metadata: a later `updatedAt`,
  // `feedTimestamp` and one extra zero-delay update (a different map size).
  const firstSnapshot = withRealtime(feed, [
    scheduleUpdate('t1', [realtimeTimes(0, 1), realtimeTimes(0, 2), realtimeTimes(0, 3)]),
    scheduleUpdate('t3', [realtimeTimes(0, 1), realtimeTimes(0, 2)]),
  ]);
  const secondSnapshot = withRealtime(feed, [
    scheduleUpdate('t1', [realtimeTimes(0, 1), realtimeTimes(0, 2), realtimeTimes(0, 3)],
      new Date('2026-11-06T06:05:00Z')),
    scheduleUpdate('t3', [realtimeTimes(0, 1), realtimeTimes(0, 2)],
      new Date('2026-11-06T06:05:00Z')),
    scheduleUpdate('t2', [realtimeTimes(0, 1), realtimeTimes(0, 2), realtimeTimes(0, 3)],
      new Date('2026-11-06T06:05:00Z')),
  ]);
  assert.equal(firstSnapshot.realtimeTripUpdates?.size, 2);
  assert.equal(secondSnapshot.realtimeTripUpdates?.size, 3);
  assert.equal(gtfsFeedContentFingerprint(firstSnapshot), gtfsFeedContentFingerprint(secondSnapshot),
    'the structural feed version must not depend on the realtime snapshot');

  const records = captureSearchDebug(() => {
    const first = findGtfsItinerariesWithStats(firstSnapshot, searchInput());
    assert.ok(first.itineraries.length > 0, 'fixture must produce at least one itinerary');
    assert.equal(getGtfsCandidateGraphCacheStats().misses, 1);

    const second = findGtfsItinerariesWithStats(secondSnapshot, searchInput({ now: new Date('2026-11-01T00:05:00Z') }));
    assert.equal(getGtfsCandidateGraphCacheStats().hits, 1,
      'a re-fetched snapshot with the same predictions must reuse the structural graph');
    assert.equal(serialise(second), serialise(first),
      're-applying an identical overlay must not change any journey');
  });
  const payload = rankedPayloads(records).at(-1)!;
  assert.equal(payload.candidateGraphStructuralHit, 1, 'the diagnostic must report the structural hit');
  assert.equal(payload.candidateGraphCacheHit, 1, 'candidateGraphCacheHit keeps its structural meaning');
  const overlays = JSON.parse(String(payload.candidateGraphRealtimeOverlay)) as Record<string, number>;
  assert.equal(overlays.cancellations, 0);
  assert.equal(overlays.skips, 0);
  assert.equal(overlays.delays, 0, 'zero-delay updates must not report applied delays');
});

test('realtime delays are re-applied to a reused graph exactly as a rebuild applies them', () => {
  clearGtfsCandidateGraphCache();
  const feed = createFeed();
  const baseline = findGtfsItinerariesWithStats(feed, searchInput());
  assert.equal(getGtfsCandidateGraphCacheStats().misses, 1);
  const baselineDirect = baseline.itineraries.find((itinerary) =>
    itinerary.segments.some((segment) => segment.tripId === 't3'));
  assert.ok(baselineDirect, 'fixture must keep the direct express');

  // t3 leaves 08:10 local; ten minutes of delay must move both its departure
  // and its arrival on the reused graph.
  const delayed = withRealtime(feed, [scheduleUpdate('t3', [realtimeTimes(600, 1), realtimeTimes(600, 2)])]);
  let cached: GtfsItinerarySearchResult | undefined;
  const records = captureSearchDebug(() => {
    cached = findGtfsItinerariesWithStats(delayed, searchInput());
    assert.equal(getGtfsCandidateGraphCacheStats().hits, 1, 'a changed overlay must still reuse the structural graph');
  });
  withCacheDisabled(() => {
    const rebuilt = findGtfsItinerariesWithStats(delayed, searchInput());
    assert.equal(serialise(cached!), serialise(rebuilt),
      'the overlay on a reused graph must equal a graph rebuilt with the same snapshot');
    assert.notEqual(serialise(rebuilt), serialise(baseline),
      'the fixture must actually change with the delay, or the comparison proves nothing');
  });
  const payload = onlyRankedPayload(records);
  const overlays = JSON.parse(String(payload.candidateGraphRealtimeOverlay)) as Record<string, number>;
  assert.ok(overlays.delays > 0, 'the diagnostic must report the delayed segments');
});

test('a cancelled trip in realtime is absent from a reused graph', () => {
  clearGtfsCandidateGraphCache();
  const feed = createFeed();
  const baseline = findGtfsItinerariesWithStats(feed, searchInput());
  assert.ok(baseline.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === 't3')),
    'fixture must expose t3 before the cancellation');

  const cancelled = withRealtime(feed, [{
    tripId: 't3', startDate: SERVICE_DATE, relationship: 'CANCELED', stops: [],
    updatedAt: new Date('2026-11-06T06:05:00Z'), feedTimestamp: new Date('2026-11-06T06:05:00Z'),
  }]);
  let cachedCancelled: GtfsItinerarySearchResult | undefined;
  const records = captureSearchDebug(() => {
    cachedCancelled = findGtfsItinerariesWithStats(cancelled, searchInput());
    assert.equal(getGtfsCandidateGraphCacheStats().hits, 1, 'the cancellation must not invalidate the structural graph');
    assert.equal(cachedCancelled.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === 't3')), false,
      'a cancelled trip must not survive on the cached path');
  });
  withCacheDisabled(() => {
    assert.equal(serialise(cachedCancelled!), serialise(findGtfsItinerariesWithStats(cancelled, searchInput())),
      'the cached cancellation must equal the rebuilt one');
  });
  const overlays = JSON.parse(String(onlyRankedPayload(records).candidateGraphRealtimeOverlay)) as Record<string, number>;
  assert.ok(overlays.cancellations > 0, 'the diagnostic must report the cancelled segments');
});

test('a realtime outage after a structural hit falls back to the published schedule', () => {
  clearGtfsCandidateGraphCache();
  const feed = createFeed();
  // The graph is first built while a delay feed is live, so the retained candidates
  // carry realtime instants. The cached copy must not carry them.
  const delayed = withRealtime(feed, [scheduleUpdate('t3', [realtimeTimes(600, 1), realtimeTimes(600, 2)])]);
  const withDelays = findGtfsItinerariesWithStats(delayed, searchInput());
  assert.equal(getGtfsCandidateGraphCacheStats().misses, 1, 'the first search must populate the structural graph');
  assert.ok(withDelays.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === 't3')),
    'fixture must keep the direct express under the delay');

  // The feed drops out completely while the structural graph is still cached: the
  // overlay has no update to re-time with, so only a schedule-only cache is honest.
  let afterOutage: GtfsItinerarySearchResult | undefined;
  const records = captureSearchDebug(() => {
    afterOutage = findGtfsItinerariesWithStats(feed, searchInput());
    assert.equal(getGtfsCandidateGraphCacheStats().hits, 1, 'an outage must not invalidate the structural graph');
  });
  withCacheDisabled(() => {
    assert.equal(serialise(afterOutage!), serialise(findGtfsItinerariesWithStats(feed, searchInput())),
      'a graph cached under a live feed must serve the same journeys as a rebuild after the outage');
  });
  const express = afterOutage!.itineraries.find((itinerary) => itinerary.segments.some((segment) => segment.tripId === 't3'));
  assert.ok(express, 'the express must still be offered after the outage');
  const expressSegment = express.segments.find((segment) => segment.tripId === 't3')!;
  assert.equal(expressSegment.departureAt.getTime(), expressSegment.scheduledDepartureAt.getTime(),
    'a lost realtime snapshot must not keep advertising an unconfirmed delay');
  assert.equal(onlyRankedPayload(records).candidateGraphStructuralHit, 1);
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

  const records: Array<Record<string, unknown>> = [];
  const before = getGtfsCandidateGraphCacheStats();
  let disabledResult: GtfsItinerarySearchResult | undefined;
  withCacheDisabled(() => {
    records.push(...captureSearchDebug(() => {
      disabledResult = findGtfsItinerariesWithStats(feed, searchInput());
    }));
  });
  assert.deepEqual(getGtfsCandidateGraphCacheStats(), before, 'a disabled cache must neither read nor write');
  assert.equal(onlyRankedPayload(records).candidateGraphStructuralHit, 0,
    'a disabled cache must not report a structural hit');

  // The base window was evicted above, so the first enabled search rebuilds
  // and stores the graph; the repeat is the one that must hit.
  const rebuiltResult = findGtfsItinerariesWithStats(feed, searchInput());
  assert.equal(serialise(rebuiltResult), serialise(disabledResult!),
    'reusing the graph must not change the journeys the search returns');
  const hitsBeforeRepeat = getGtfsCandidateGraphCacheStats().hits;
  const repeatedResult = findGtfsItinerariesWithStats(feed, searchInput());
  assert.equal(getGtfsCandidateGraphCacheStats().hits, hitsBeforeRepeat + 1);
  assert.equal(serialise(repeatedResult), serialise(disabledResult!));
});

/** Hand-built segment for the overlay unit test: t1 boards stop-a 08:00 and reaches stop-c 08:40 local. */
function directSegment(overrides: Partial<GtfsDirectJourney> = {}): GtfsDirectJourney {
  const scheduledDepartureAt = new Date('2026-11-06T06:00:00Z');
  const scheduledArrivalAt = new Date('2026-11-06T06:40:00Z');
  return {
    providerId: 'p1',
    providerName: 'Test Transit',
    mode: 'BUS',
    routeId: 'r1',
    routeName: 'Regional west',
    headsign: 'Regional west',
    tripId: 't1',
    originStop: { id: 'stop-a', name: 'Origin', coordinates: [24.0000, 49.8400] },
    destinationStop: { id: 'stop-c', name: 'Hub', coordinates: [23.9000, 49.5000] },
    originTransferNodeIds: ['stop-a'],
    destinationTransferNodeIds: ['stop-c'],
    transportType: 'bus',
    scheduleSemantics: 'published_departures',
    serviceDate: SERVICE_DATE,
    scheduledDepartureAt,
    scheduledArrivalAt,
    departureAt: scheduledDepartureAt,
    arrivalAt: scheduledArrivalAt,
    sourceFreshAt: FETCHED_AT,
    distanceToOriginStopMeters: 0,
    distanceFromDestinationStopMeters: 0,
    traveledZoneIds: ['zone-a', 'zone-c'],
    ...overrides,
  };
}

const SHAPE_INDEX = [{ fromIndex: 0, toIndex: 2, serviceDate: SERVICE_DATE }];

test('the realtime overlay drops skips, shifts times, enforces the window and is idempotent', () => {
  const feed = createFeed();
  const segment = directSegment();
  const bounds = { earliestDeparture: new Date('2026-11-06T06:00:00Z'), journeyEnd: new Date('2026-11-07T06:00:00Z') };

  // A skipped boarding stop removes the segment; an untouched trip keeps it.
  const skipped = withRealtime(feed, [scheduleUpdate('t1', [{ stopSequence: 1, relationship: 'SKIPPED' }])]);
  const skipResult = applyGtfsRealtimeOverlay(skipped, [segment], SHAPE_INDEX, bounds);
  assert.equal(skipResult.segments.length, 0);
  assert.equal(skipResult.counts.skips, 1);
  assert.equal(skipResult.counts.delays, 0);
  assert.equal(skipResult.counts.cancellations, 0);
  assert.deepEqual(applyGtfsRealtimeOverlay(feed, [segment], SHAPE_INDEX, bounds).segments, [segment],
    'a feed without a snapshot must return the segment untouched');

  // A delay moves the effective times and keeps the scheduled ones intact.
  const delayed = withRealtime(feed, [scheduleUpdate('t1', [realtimeTimes(1800, 1), realtimeTimes(1800, 2)])]);
  const delayResult = applyGtfsRealtimeOverlay(delayed, [segment], SHAPE_INDEX, bounds);
  assert.equal(delayResult.segments.length, 1);
  assert.equal(delayResult.counts.delays, 1);
  assert.equal(delayResult.segments[0]!.departureAt.toISOString(), '2026-11-06T06:30:00.000Z');
  assert.equal(delayResult.segments[0]!.arrivalAt.toISOString(), '2026-11-06T07:10:00.000Z');
  assert.equal(delayResult.segments[0]!.scheduledDepartureAt.toISOString(), '2026-11-06T06:00:00.000Z');
  assert.equal(delayResult.segments[0]!.realtimeUpdatedAt?.toISOString(), '2026-11-06T05:55:00.000Z');
  assert.equal(segment.departureAt.toISOString(), '2026-11-06T06:00:00.000Z',
    'overlaying must not mutate the input segment');

  // The same overlay applied twice is stable: one implementation, no drift.
  const twice = applyGtfsRealtimeOverlay(delayed, delayResult.segments, delayResult.shapeIndexes, bounds);
  assert.deepEqual(twice.segments, delayResult.segments);
  assert.equal(twice.counts.delays, 1);

  // A delay that pushes the arrival past the journey window drops the segment.
  const narrow = { earliestDeparture: bounds.earliestDeparture, journeyEnd: new Date('2026-11-06T06:20:00Z') };
  const windowed = applyGtfsRealtimeOverlay(delayed, [segment], SHAPE_INDEX, narrow);
  assert.equal(windowed.segments.length, 0);
  assert.equal(windowed.counts.outOfWindow, 1);

  // A cancelled relationship removes every segment of the instance.
  const cancelled = withRealtime(feed, [{
    tripId: 't1', startDate: SERVICE_DATE, relationship: 'CANCELED', stops: [],
    updatedAt: new Date('2026-11-06T05:55:00Z'), feedTimestamp: new Date('2026-11-06T05:55:00Z'),
  }]);
  const cancelResult = applyGtfsRealtimeOverlay(cancelled, [segment], SHAPE_INDEX, bounds);
  assert.equal(cancelResult.segments.length, 0);
  assert.equal(cancelResult.counts.cancellations, 1);
});
