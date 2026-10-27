import test from 'node:test';
import assert from 'node:assert/strict';
import { findGtfsItinerariesWithStats, parseGtfsTimetable, rankGtfsItinerariesForCandidateSampling, sampleGtfsTripChainCandidates, selectGtfsResponseItineraries } from '../server/journey/gtfsTimetable';

function createFeedTest() {
  const encode = (text: string) => new TextEncoder().encode(text);
  const files: Record<string, Uint8Array> = {
    'agency.txt': encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': encode('route_id,agency_id,route_short_name,route_long_name,route_type\nr1,a,1,Line 1,3'),
    'stops.txt': encode([
      'stop_id,stop_name,stop_lat,stop_lon,zone_id',
      'stop-b,Origin Exact,49.8400,24.0200,zone-b',
      'stop-a,Origin Offset,49.8412,24.0200,zone-a',
      'stop-c,Dest Exact,49.8500,24.0300,zone-c',
      'stop-d,Dest Offset,49.8512,24.0300,zone-d',
    ].join('\n')),
    'trips.txt': encode('route_id,service_id,trip_id,trip_headsign\nr1,weekday,t1,Outbound'),
    'stop_times.txt': encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      't1,08:00:00,08:00:00,stop-b,1,0,0',
      't1,08:15:00,08:15:00,stop-a,2,0,0',
      't1,08:30:00,08:30:00,stop-c,3,0,0',
      't1,08:50:00,08:50:00,stop-d,4,0,0',
    ].join('\n')),
    'calendar.txt': encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
    'fare_attributes.txt': encode([
      'fare_id,price,currency_type,payment_method,transfers',
      'fare-fast,10.00,UAH,0,0',
      'fare-cheap,1.00,UAH,0,0',
      'fare-mid,5.00,UAH,0,0',
    ].join('\n')),
    'fare_rules.txt': encode([
      'fare_id,origin_id,destination_id',
      'fare-fast,zone-a,zone-c',
      'fare-cheap,zone-b,zone-d',
      'fare-mid,zone-b,zone-c',
    ].join('\n')),
  };
  return parseGtfsTimetable(files);
}

test('objective reservoir preserves fastest, cheapest, and least-walking witnesses within the trip-chain bound', () => {
  const timetable = createFeedTest();

  // Search from exact stop-b to exact stop-c coordinates:
  // - stop-a -> stop-c: fastest variant (~15m transit, 10.00 UAH, ~133m access walk)
  // - stop-b -> stop-d: cheapest variant (~50m transit, 1.00 UAH, ~133m egress walk)
  // - stop-b -> stop-c: global least-walking witness (30m transit, 5.00 UAH, 0m walk)
  const result = findGtfsItinerariesWithStats(timetable, {
    providerId: 'p1',
    providerName: 'Test Transit',
    origin: [24.0200, 49.8400],
    destination: [24.0300, 49.8500],
    earliestDeparture: new Date('2026-10-12T04:55:00Z'),
    latestDeparture: new Date('2026-10-12T05:30:00Z'),
    now: new Date('2026-10-08T00:00:00Z'),
    maximumAccessWalkingMeters: 500,
    maximumEgressWalkingMeters: 500,
    maximumTransfers: 0,
    limit: 5,
  });
  // Verify that the fastest and cheapest variants are present
  const fastest = result.itineraries.find((itinerary) =>
    itinerary.segments[0]?.originStop.id === 'stop-a' && itinerary.segments[0]?.destinationStop.id === 'stop-c');
  const cheapest = result.itineraries.find((itinerary) =>
    itinerary.segments[0]?.originStop.id === 'stop-b' && itinerary.segments[0]?.destinationStop.id === 'stop-d');

  assert.ok(fastest, 'fastest variant (stop-a -> stop-c) must be retained');
  assert.ok(cheapest, 'cheapest variant (stop-b -> stop-d) must be retained');
  assert.ok(result.itineraries.length <= 4,
    'the production trip-chain bound must keep alternatives for this scheduled vehicle chain bounded');
  // The bounded production sample admits distinct witnesses for key objectives.
  const leastWalking = result.itineraries.find((itinerary) => itinerary.walkingMeters === 0);
  assert.ok(
    leastWalking,
    'global least-walking witness (0m walking) must be preserved in returned candidates via the objective reservoir',
  );
  assert.equal(leastWalking.segments[0]?.originStop.id, 'stop-b');
  assert.equal(leastWalking.segments[0]?.destinationStop.id, 'stop-c');
  const retainedSegment = leastWalking.segments[0];
  assert.ok(retainedSegment);
  assert.deepEqual(retainedSegment.stops?.map((stop) => stop.id), ['stop-b', 'stop-a', 'stop-c'],
    'the reservoir-retained itinerary must keep its exact ordered GTFS stop calls');
  assert.equal(retainedSegment.routeGeometry, undefined,
    'without a supplied GTFS shape, the router must not invent route geometry');
  const boundedSample = sampleGtfsTripChainCandidates([fastest, cheapest, leastWalking], 3);
  assert.deepEqual(new Set(boundedSample.map((itinerary) => itinerary.id)),
    new Set([fastest.id, cheapest.id, leastWalking.id]),
    'the explicit three-slot sample must preserve distinct objective witnesses');
});

test('four-slot trip-chain sample retains FASTEST, CHEAPEST, BALANCED, and least-walking winners', () => {
  const timetable = createFeedTest();
  const base = findGtfsItinerariesWithStats(timetable, {
    providerId: 'p1', providerName: 'Test Transit',
    origin: [24.0200, 49.8400], destination: [24.0300, 49.8500],
    earliestDeparture: new Date('2026-10-12T04:55:00Z'),
    latestDeparture: new Date('2026-10-12T05:30:00Z'),
    now: new Date('2026-10-08T00:00:00Z'),
    maximumAccessWalkingMeters: 500, maximumEgressWalkingMeters: 500,
    maximumTransfers: 0, limit: 5,
  }).itineraries[0];
  assert.ok(base);
  const fastest = { ...base, id: 'fastest', durationSeconds: 1_800, walkingMeters: 800,
    transfers: 1, fare: { priceMinor: 2_000, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };
  const cheapest = { ...base, id: 'cheapest', durationSeconds: 5_000, walkingMeters: 800,
    transfers: 1, fare: { priceMinor: 100, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };
  const balanced = { ...base, id: 'balanced', durationSeconds: 3_000, walkingMeters: 300,
    transfers: 0, fare: { priceMinor: 900, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };
  const leastWalking = { ...base, id: 'least-walking', durationSeconds: 4_000, walkingMeters: 0,
    transfers: 0, fare: { priceMinor: 500, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };
  const decoys = Array.from({ length: 28 }, (_, index) => ({
    ...base,
    id: `decoy-${String(index).padStart(2, '0')}`,
    durationSeconds: 3_500 + index * 10,
    walkingMeters: 350 + index,
    transfers: 1,
    fare: { priceMinor: 950 + index * 5, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
  }));
  const candidates = [fastest, cheapest, balanced, leastWalking, ...decoys];
  assert.equal(rankGtfsItinerariesForCandidateSampling(candidates)[0]?.id, balanced.id,
    'the shared scorer must recognize the intended BALANCED witness');

  const expectedWitnesses = new Set([fastest.id, cheapest.id, balanced.id, leastWalking.id]);
  const assertWitnessesSurvive = (ordered: typeof candidates, orderLabel: string) => {
    const sample = sampleGtfsTripChainCandidates(ordered, 4);
    assert.deepEqual(new Set(sample.map((candidate) => candidate.id)), expectedWitnesses,
      `the four-slot cap must preserve all four distinct objective witnesses (${orderLabel})`);
  };
  for (let offset = 0; offset < candidates.length; offset++) {
    assertWitnessesSurvive([...candidates.slice(offset), ...candidates.slice(0, offset)], `cyclic ${offset}`);
  }
  let seed = 0x4d47524f;
  for (let iteration = 0; iteration < 64; iteration++) {
    const shuffled = [...candidates];
    for (let index = shuffled.length - 1; index > 0; index--) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      const swapIndex = seed % (index + 1);
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
    }
    assertWitnessesSurvive(shuffled, `seeded shuffle ${iteration}`);
  }
});

test('response selection reserves a page slot for a missing longer chain without dropping objective winners', () => {
  const base = findGtfsItinerariesWithStats(createFeedTest(), {
    providerId: 'p1', providerName: 'Test Transit',
    origin: [24.0200, 49.8400], destination: [24.0300, 49.8500],
    earliestDeparture: new Date('2026-10-12T04:55:00Z'), latestDeparture: new Date('2026-10-12T05:30:00Z'),
    now: new Date('2026-10-08T00:00:00Z'), maximumAccessWalkingMeters: 500,
    maximumEgressWalkingMeters: 500, maximumTransfers: 0, limit: 5,
  }).itineraries[0];
  assert.ok(base?.segments[0]);
  const directCandidates = Array.from({ length: 100 }, (_, index) => ({
    ...base,
    id: `direct-${String(index).padStart(3, '0')}`,
    segments: [base.segments[0]!],
    arrivalAt: new Date(base.arrivalAt.getTime() + index * 60_000),
    durationSeconds: 1_000 + index,
    walkingMeters: index,
    fare: { priceMinor: 1_000 + index, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
  }));
  const longerChain = {
    ...base,
    id: 'three-leg-chain',
    segments: [base.segments[0]!, base.segments[0]!, base.segments[0]!],
    arrivalAt: new Date(base.arrivalAt.getTime() + 200 * 60_000),
    durationSeconds: 20_000,
    transfers: 2,
    fare: { priceMinor: 2_000, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
  };
  const rankedResults = [...directCandidates, longerChain];
  const byDuration = [...rankedResults].sort((a, b) => a.durationSeconds - b.durationSeconds);
  const byFare = [...rankedResults].sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor);
  const byTransfers = [...rankedResults].sort((a, b) => a.transfers - b.transfers);
  const byWalking = [...rankedResults].sort((a, b) => a.walkingMeters - b.walkingMeters);
  const balanced = [...rankedResults].sort((a, b) => a.id.localeCompare(b.id));
  const selected = selectGtfsResponseItineraries(
    rankedResults, [byDuration, byFare, byTransfers, byWalking, balanced], 100,
  );

  assert.equal(selected.length, 100, 'response size remains bounded');
  assert.ok(selected.some((itinerary) => itinerary.id === longerChain.id),
    'a feasible longer-chain candidate is not hidden by a page of direct routes');
  const selectedTripChains = new Set(selected.map((itinerary) => itinerary.segments.map((segment) =>
    `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>')));
  assert.equal(selectedTripChains.size, 2,
  'the reserved slot adds a trip chain while retaining the page’s original chain');
  for (const winner of [byDuration[0], byFare[0], balanced[0]]) {
    assert.ok(selected.some((itinerary) => itinerary.id === winner?.id),
      `existing objective witness ${winner?.id} remains in the response`);
  }
  assert.deepEqual(selectGtfsResponseItineraries(
    [...rankedResults].reverse(), [byDuration, byFare, byTransfers, byWalking, balanced], 100,
  ).map((itinerary) => itinerary.id), selected.map((itinerary) => itinerary.id),
  'page selection is deterministic regardless of candidate insertion order');
});
