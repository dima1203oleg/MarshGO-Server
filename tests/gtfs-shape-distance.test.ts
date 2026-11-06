// SYNTHETIC FIXTURES ONLY — every feed below is a small in-memory CSV built for this file.
// No values here come from a live provider; do not cite them as production evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findGtfsItinerariesWithStats, measureGtfsTripRidingMeters, parseGtfsTimetable } from '../server/journey/gtfsTimetable';
import type { GtfsTimetableFeed } from '../server/journey/gtfsTimetable';

const csv = (rows: string[]) => new TextEncoder().encode(rows.join('\n'));

// Independent oracle for the expected metres: the same haversine the engine documents
// (mean earth radius 6 371 000 m), implemented here from the WGS-84 sphere definition so
// a change in either the engine or this test fails loudly instead of agreeing silently.
const haversineMeters = (a: [number, number], b: [number, number]): number => {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};

function shapeDistanceFeed(): GtfsTimetableFeed {
  const files: Record<string, Uint8Array> = {
    'agency.txt': csv(['agency_id,agency_name,agency_url,agency_timezone', 'a,Shape Test,https://example.test,Europe/Kyiv']),
    'routes.txt': csv(['route_id,agency_id,route_short_name,route_long_name,route_type', 'r,a,7,Shape test line,3']),
    'stops.txt': csv([
      'stop_id,stop_name,stop_lat,stop_lon',
      's1,Straight start,49.8400,24.0200',
      's2,Straight end,49.8400,24.0300',
      'l1,Corner start,49.8400,24.0500',
      'l2,Corner bend,49.8500,24.0500',
      'l3,Corner end,49.8500,24.0600',
    ]),
    'trips.txt': csv([
      'route_id,service_id,trip_id,trip_headsign,shape_id',
      'r,weekday,t-straight,Straight end,shape-straight',
      'r,weekday,t-l,Bend run,shape-l',
      'r,weekday,t-noshape,Straight end,',
      'r,weekday,t-farshape,Straight end,shape-far',
    ]),
    'stop_times.txt': csv([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      't-straight,08:00:00,08:00:00,s1,1,0,0',
      't-straight,08:10:00,08:10:00,s2,2,0,0',
      't-l,08:00:00,08:00:00,l1,1,0,0',
      't-l,08:05:00,08:05:00,l2,2,0,0',
      't-l,08:10:00,08:10:00,l3,3,0,0',
      't-noshape,08:30:00,08:30:00,s1,1,0,0',
      't-noshape,08:40:00,08:40:00,s2,2,0,0',
      't-farshape,09:00:00,09:00:00,s1,1,0,0',
      't-farshape,09:10:00,09:10:00,s2,2,0,0',
    ]),
    'calendar.txt': csv([
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
      'weekday,1,0,0,0,0,0,0,20261001,20261031',
    ]),
    'shapes.txt': csv([
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
      // Straight east-west polyline; the two stops sit exactly on its endpoints.
      'shape-straight,49.8400,24.0200,1',
      'shape-straight,49.8400,24.0300,2',
      // L-shape: north leg then east leg, stops exactly on the three vertices.
      'shape-l,49.8400,24.0500,1',
      'shape-l,49.8500,24.0500,2',
      'shape-l,49.8500,24.0600,3',
      // Shape placed ~6.7 km away from the s1/s2 stops it would be matched against.
      'shape-far,49.9000,24.0200,1',
      'shape-far,49.9000,24.0300,2',
    ]),
  };
  return parseGtfsTimetable(files);
}

test('a two-stop leg on a straight shape measures the expected metres', () => {
  const feed = shapeDistanceFeed();
  const expected = haversineMeters([24.0200, 49.8400], [24.0300, 49.8400]);
  const measured = measureGtfsTripRidingMeters(feed, 't-straight', 0, 1);
  assert.ok(measured !== null);
  assert.ok(Math.abs(measured - Math.ceil(expected)) <= 1,
    `measured ${measured} m must equal the oracle ${Math.ceil(expected)} m within rounding`);
});

test('an L-shaped polyline sums along the path and exceeds the straight-line distance', () => {
  const feed = shapeDistanceFeed();
  const legNorth = haversineMeters([24.0500, 49.8400], [24.0500, 49.8500]);
  const legEast = haversineMeters([24.0500, 49.8500], [24.0600, 49.8500]);
  const straightLine = haversineMeters([24.0500, 49.8400], [24.0600, 49.8500]);
  const measured = measureGtfsTripRidingMeters(feed, 't-l', 0, 2);
  assert.ok(measured !== null);
  assert.ok(Math.abs(measured - Math.ceil(legNorth + legEast)) <= 1,
    `measured ${measured} m must follow both legs of the polyline`);
  assert.ok(measured > straightLine,
    'the path length must be greater than the origin-destination straight line');
});

test('a trip without a shape measures null instead of inventing a distance', () => {
  const feed = shapeDistanceFeed();
  assert.equal(measureGtfsTripRidingMeters(feed, 't-noshape', 0, 1), null);
});

test('a stop that does not project onto the trip shape measures null', () => {
  const feed = shapeDistanceFeed();
  // shape-far sits kilometres away from s1/s2; the 600 m snap budget must refuse it
  // rather than reporting a bogus projected distance.
  assert.equal(measureGtfsTripRidingMeters(feed, 't-farshape', 0, 1), null);
});

test('routed itineraries carry the shape-measured riding distance on each segment', () => {
  const feed = shapeDistanceFeed();
  const result = findGtfsItinerariesWithStats(feed, {
    providerId: 'p1', providerName: 'Shape Test',
    origin: [24.0200, 49.8400], destination: [24.0300, 49.8400],
    earliestDeparture: new Date('2026-10-12T04:55:00Z'),
    latestDeparture: new Date('2026-10-12T06:30:00Z'),
    now: new Date('2026-10-08T00:00:00Z'),
    limit: 10, maximumTransfers: 0,
  });
  const segments = result.itineraries.flatMap((itinerary) => itinerary.segments);
  assert.ok(segments.length > 0, 'the straight and no-shape trips both cover this stop pair');
  const measured = segments.filter((segment) => segment.tripId === 't-straight' || segment.tripId === 't-farshape');
  assert.ok(measured.length > 0);
  for (const segment of measured) {
    if (segment.tripId === 't-straight') {
      assert.equal(segment.shapeDistanceMeters, Math.ceil(haversineMeters([24.0200, 49.8400], [24.0300, 49.8400])),
        'a shaped trip must expose the projected path length');
    } else {
      assert.equal(segment.shapeDistanceMeters, undefined,
        'a trip whose shape does not project must stay distance-unknown, not estimated');
    }
  }
  for (const segment of segments.filter((entry) => entry.tripId === 't-noshape')) {
    assert.equal(segment.shapeDistanceMeters, undefined,
      'a trip without a shape must not gain a fabricated distance');
  }
});
