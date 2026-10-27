import test from 'node:test';
import assert from 'node:assert/strict';
import { findGtfsItinerariesWithStats, parseGtfsTimetable, sampleGtfsTripChainCandidates } from '../server/journey/gtfsTimetable';

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

test('bounded three-variant trip-chain sample preserves fastest, cheapest, and least-walking witnesses', () => {
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
  assert.equal(result.truncation.candidateSampling, true,
    'fixture must exercise a bounded candidate sampler for this to be a meaningful regression');
  // The production cap admits one distinct winner for each key routing objective
  // while keeping the number of alternatives for this scheduled vehicle chain bounded.
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
    'the bounded three-slot trip-chain sample must preserve all three distinct objective witnesses');
});
