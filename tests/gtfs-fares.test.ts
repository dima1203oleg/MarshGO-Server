import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGtfsItineraryFare, parseGtfsFares, scaleGtfsFareForPassengers, type GtfsFareLeg } from '../server/journey/gtfsFares';
import { findGtfsItineraries, mergeGtfsTimetables, parseGtfsTimetable, type GtfsTimetableFeed } from '../server/journey/gtfsTimetable';

const encode = (value: string) => new TextEncoder().encode(value);

function fareLeg(routeId: string, departure: string, arrival: string, overrides: Partial<GtfsFareLeg> = {}): GtfsFareLeg {
  return {
    providerId: 'feed', routeId, departureAt: new Date(departure), arrivalAt: new Date(arrival),
    traveledZoneIds: [], ...overrides,
  };
}

test('prices a multi-leg itinerary with one ticket when the GTFS transfer limit permits it', () => {
  const fares = parseGtfsFares({
    'agency.txt': encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'fare_attributes.txt': encode('fare_id,price,currency_type,payment_method,transfers,transfer_duration\none,42.00,UAH,0,1,7200'),
    'fare_rules.txt': encode('fare_id,route_id\none,bus\none,rail'),
  });
  const result = calculateGtfsItineraryFare(fares, [
    fareLeg('bus', '2026-10-12T05:00:00Z', '2026-10-12T05:20:00Z'),
    fareLeg('rail', '2026-10-12T05:35:00Z', '2026-10-12T06:10:00Z'),
  ]);
  assert.ok(result);
  assert.equal(result.priceMinor, 4200);
  assert.deepEqual(result.allocations.map((part) => [part.priceMinor, part.includedByPreviousFare]), [[4200, false], [0, true]]);
});

test('chooses two single-ride fares when a transfer ticket is more expensive', () => {
  const fares = parseGtfsFares({
    'agency.txt': encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'fare_attributes.txt': encode('fare_id,price,currency_type,payment_method,transfers\nbundle,5.00,UAH,0,1\nsingle,2.00,UAH,0,0'),
    'fare_rules.txt': encode('fare_id,route_id\nbundle,bus\nbundle,rail\nsingle,bus\nsingle,rail'),
  });
  const result = calculateGtfsItineraryFare(fares, [
    fareLeg('bus', '2026-10-12T05:00:00Z', '2026-10-12T05:20:00Z'),
    fareLeg('rail', '2026-10-12T05:35:00Z', '2026-10-12T06:10:00Z'),
  ]);
  assert.equal(result?.priceMinor, 400);
  assert.deepEqual(result?.allocations.map((part) => part.priceMinor), [200, 200]);
});

test('scales a known itinerary fare and each segment allocation by passenger count', () => {
  const fare = {
    priceMinor: 4200, currency: 'UAH', source: 'gtfs-v1' as const,
    allocations: [
      { priceMinor: 4200, currency: 'UAH', fareProductId: 'through', includedByPreviousFare: false },
      { priceMinor: 0, currency: 'UAH', fareProductId: 'through', includedByPreviousFare: true },
    ],
  };
  const scaled = scaleGtfsFareForPassengers(fare, 3);
  assert.equal(scaled?.priceMinor, 12_600);
  assert.deepEqual(scaled?.allocations.map((part) => part.priceMinor), [12_600, 0]);
  assert.equal(scaleGtfsFareForPassengers(fare, 0), null);
});

test('matches zone-based origin and destination rules and rejects expired transfer tickets', () => {
  const fares = parseGtfsFares({
    'agency.txt': encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'fare_attributes.txt': encode('fare_id,price,currency_type,payment_method,transfers,transfer_duration\nzone,18.50,UAH,0,1,900'),
    'fare_rules.txt': encode('fare_id,origin_id,destination_id\nzone,z1,z3'),
  });
  const first = fareLeg('bus', '2026-10-12T05:00:00Z', '2026-10-12T05:02:00Z', {
    originZoneId: 'z1', destinationZoneId: 'z2', traveledZoneIds: ['z1', 'z2'],
  });
  const second = fareLeg('tram', '2026-10-12T05:05:00Z', '2026-10-12T05:08:00Z', {
    originZoneId: 'z2', destinationZoneId: 'z3', traveledZoneIds: ['z2', 'z3'],
  });
  assert.equal(calculateGtfsItineraryFare(fares, [first, second])?.priceMinor, 1850);
  assert.equal(calculateGtfsItineraryFare(fares, [first, {
    ...second, departureAt: new Date('2026-10-12T05:40:00Z'), arrivalAt: new Date('2026-10-12T05:43:00Z'),
  }]), null);
  assert.equal(calculateGtfsItineraryFare(fares, [first, { ...second, destinationZoneId: 'z4' }]), null);
});

test('keeps unknown fares unknown and does not interpret GTFS Fares v2 as free rides', () => {
  assert.equal(calculateGtfsItineraryFare(parseGtfsFares({}), [fareLeg('bus', '2026-10-12T05:00:00Z', '2026-10-12T05:20:00Z')]), null);
  const fares = parseGtfsFares({
    'fare_products.txt': encode('fare_product_id,fare_product_name,amount,currency\np,Single,2.00,UAH'),
    'fare_attributes.txt': encode('fare_id,price,currency_type,payment_method,transfers\none,2.00,UAH,0,0'),
  });
  assert.equal(fares.faresV2Present, true);
  assert.equal(calculateGtfsItineraryFare(fares, [fareLeg('bus', '2026-10-12T05:00:00Z', '2026-10-12T05:20:00Z')]), null);
});

test('feed fares survive provider namespacing and price the composed scheduled itinerary', () => {
  const files: Record<string, Uint8Array> = {
    'agency.txt': encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': encode('route_id,agency_id,route_short_name,route_long_name,route_type\nbus,a,7,City bus,3\nrail,a,IC 743,Train,2'),
    'stops.txt': encode('stop_id,stop_name,stop_lat,stop_lon\nstart,Start,49.8400,24.0200\nhub,Transfer hub,49.8450,24.0250\nfinish,Finish,49.8500,24.0300'),
    'trips.txt': encode('route_id,service_id,trip_id,trip_headsign\nbus,weekday,b1,Transfer hub\nrail,weekday,r1,Finish'),
    'stop_times.txt': encode('trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nb1,08:00:00,08:00:00,start,1,0,0\nb1,08:20:00,08:20:00,hub,2,0,0\nr1,08:35:00,08:35:00,hub,1,0,0\nr1,09:00:00,09:00:00,finish,2,0,0'),
    'calendar.txt': encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
    'fare_attributes.txt': encode('fare_id,price,currency_type,payment_method,transfers,transfer_duration\nthrough,42.00,UAH,0,1,7200'),
    'fare_rules.txt': encode('fare_id,route_id\nthrough,bus\nthrough,rail'),
  };
  const feed: GtfsTimetableFeed = parseGtfsTimetable(files);
  const merged = mergeGtfsTimetables([{ providerId: 'feed', providerName: 'Feed', providerCity: 'Test', feed }]);
  assert.ok(merged);
  const [itinerary] = findGtfsItineraries(merged, {
    providerId: 'feed', providerName: 'Feed', origin: [24.0200, 49.8400], destination: [24.0300, 49.8500],
    earliestDeparture: new Date('2026-10-12T04:55:00Z'), latestDeparture: new Date('2026-10-12T05:30:00Z'),
    now: new Date('2026-10-12T04:50:00Z'), maximumAccessWalkingMeters: 300, maximumEgressWalkingMeters: 300,
    maximumTransferWalkingMeters: 0, maximumTransfers: 1,
  });
  assert.ok(itinerary);
  assert.equal(itinerary.fare?.priceMinor, 4200);
  assert.equal(itinerary.fare?.currency, 'UAH');
});
