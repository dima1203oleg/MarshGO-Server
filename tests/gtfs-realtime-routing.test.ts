import test from 'node:test';
import assert from 'node:assert/strict';
import bindings from 'gtfs-realtime-bindings';
import { findGtfsItinerariesWithStats, findGtfsStopArrivals, mergeGtfsTimetables, parseGtfsTimetable } from '../server/journey/gtfsTimetable';
import { gtfsRealtimeTripUpdateKey, parseGtfsRealtimeTripUpdates } from '../server/journey/gtfsRealtime';

const { transit_realtime } = bindings;
const localTripDate = '20261012';
const now = new Date('2026-10-12T04:55:00Z');

function realtimeBytes(options: { timestamp?: number; updateTimestamp?: number; incrementality?: number; relationship?: number; arrivalDelay?: number; stopSequence?: number; startDate?: string } = {}) {
  return transit_realtime.FeedMessage.encode({
    header: {
      gtfsRealtimeVersion: '2.0',
      timestamp: options.timestamp ?? Math.floor(now.getTime() / 1000),
      ...(options.incrementality !== undefined ? { incrementality: options.incrementality } : {}),
    },
    entity: [{ id: 'trip-update-1', tripUpdate: {
      trip: { tripId: 't1', routeId: 'r', startDate: options.startDate ?? localTripDate,
        ...(options.relationship !== undefined ? { scheduleRelationship: options.relationship } : {}) },
      ...(options.updateTimestamp !== undefined ? { timestamp: options.updateTimestamp } : {}),
      stopTimeUpdate: [{ stopSequence: options.stopSequence ?? 1, arrival: { delay: options.arrivalDelay ?? 900 }, departure: { delay: options.arrivalDelay ?? 900 } }],
    } }],
  }).finish();
}

function timetable() {
  const encode = (value: string) => new TextEncoder().encode(value);
  return parseGtfsTimetable({
    'agency.txt': encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': encode('route_id,agency_id,route_short_name,route_long_name,route_type\nr,a,7,City bus,3'),
    'stops.txt': encode('stop_id,stop_name,stop_lat,stop_lon\norigin,Origin,49.8400,24.0200\ndestination,Destination,49.8500,24.0300'),
    'trips.txt': encode('route_id,service_id,trip_id,trip_headsign\nr,weekday,t1,Destination'),
    'stop_times.txt': encode('trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nt1,08:00:00,08:00:00,origin,1,0,0\nt1,08:40:00,08:40:00,destination,2,0,0'),
    'calendar.txt': encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
  });
}

function transferTimetable() {
  const encode = (value: string) => new TextEncoder().encode(value);
  return parseGtfsTimetable({
    'agency.txt': encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': encode('route_id,agency_id,route_short_name,route_long_name,route_type\nr,a,7,City bus,3'),
    'stops.txt': encode('stop_id,stop_name,stop_lat,stop_lon\norigin,Origin,49.8400,24.0200\nhub,Transfer,49.8600,24.0400\ndestination,Destination,49.8700,24.0500'),
    'trips.txt': encode('route_id,service_id,trip_id,trip_headsign\nr,weekday,t1,Transfer\nr,weekday,t2,Destination'),
    'stop_times.txt': encode('trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\nt1,08:00:00,08:00:00,origin,1,0,0\nt1,08:20:00,08:20:00,hub,2,0,0\nt2,08:32:00,08:32:00,hub,1,0,0\nt2,08:55:00,08:55:00,destination,2,0,0'),
    'calendar.txt': encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
  });
}

function search(feed: ReturnType<typeof timetable>, realtime?: ReturnType<typeof parseGtfsRealtimeTripUpdates>) {
  const merged = mergeGtfsTimetables([{ providerId: 'lviv', providerName: 'Львівавтодор', providerCity: 'Львів', feed, realtime }]);
  assert.ok(merged);
  return findGtfsItinerariesWithStats(merged, {
    providerId: 'lviv', providerName: 'Львівавтодор', origin: [24.0201, 49.8401], destination: [24.0301, 49.8501],
    earliestDeparture: new Date('2026-10-12T05:10:00Z'), latestDeparture: new Date('2026-10-12T06:00:00Z'),
    now, maximumAccessWalkingMeters: 300, maximumEgressWalkingMeters: 300, maximumTransferWalkingMeters: 0,
    maximumTransfers: 0,
  });
}

test('accepts only trip updates no older than 90s from a timestamped full snapshot', () => {
  const parsed = parseGtfsRealtimeTripUpdates(realtimeBytes(), now);
  assert.equal(parsed.fresh, true);
  assert.equal(parsed.updates.get(gtfsRealtimeTripUpdateKey('t1', '2026-10-12'))?.stops[0]?.arrival?.delaySeconds, 900);

  const atFreshnessBoundary = parseGtfsRealtimeTripUpdates(realtimeBytes({
    timestamp: Math.floor((now.getTime() - 90_000) / 1000),
  }), now);
  assert.equal(atFreshnessBoundary.fresh, true);
  assert.equal(atFreshnessBoundary.updates.size, 1);

  const staleTimestamp = new Date(now.getTime() - 91_000);
  const stale = parseGtfsRealtimeTripUpdates(realtimeBytes({ timestamp: Math.floor(staleTimestamp.getTime() / 1000) }), now);
  assert.equal(stale.reason, 'STALE');
  assert.equal(stale.feedTimestamp.toISOString(), staleTimestamp.toISOString(), 'retain the source time so the API can explain why it fell back to schedule data');
  assert.equal(stale.updates.size, 0);

  const staleEntity = parseGtfsRealtimeTripUpdates(realtimeBytes({
    updateTimestamp: Math.floor((now.getTime() - 91_000) / 1000),
  }), now);
  assert.equal(staleEntity.fresh, true, 'the snapshot can be fresh while an individual TripUpdate is stale');
  assert.equal(staleEntity.updates.size, 0);

  const differential = parseGtfsRealtimeTripUpdates(realtimeBytes({
    incrementality: transit_realtime.FeedHeader.Incrementality.DIFFERENTIAL,
  }), now);
  assert.equal(differential.reason, 'DIFFERENTIAL_UNSUPPORTED');
  assert.equal(differential.updates.size, 0);
});

test('a fresh delay moves timetable departure and arrival and marks the result predicted', () => {
  const feed = timetable();
  const realtime = parseGtfsRealtimeTripUpdates(realtimeBytes(), now);
  const result = search(feed, realtime);
  const segment = result.itineraries[0]?.segments[0];

  assert.ok(segment);
  assert.equal(segment.departureAt.toISOString(), '2026-10-12T05:15:00.000Z');
  assert.equal(segment.arrivalAt.toISOString(), '2026-10-12T05:55:00.000Z');
  assert.equal(segment.scheduledDepartureAt.toISOString(), '2026-10-12T05:00:00.000Z');
  assert.equal(segment.scheduledArrivalAt.toISOString(), '2026-10-12T05:40:00.000Z');
  assert.equal(segment.realtimeUpdatedAt?.toISOString(), now.toISOString());
  assert.equal(segment.stops?.[0]?.departureAt, '2026-10-12T05:15:00.000Z');
});

test('stop-arrival response uses a matching fresh trip update and preserves schedule separately', () => {
  const feed = timetable();
  const realtime = parseGtfsRealtimeTripUpdates(realtimeBytes({ stopSequence: 2, arrivalDelay: 600 }), now);
  const predicted = findGtfsStopArrivals({ ...feed, realtimeTripUpdates: realtime.updates }, 'destination', {
    now: new Date('2026-10-12T05:20:00Z'),
  });
  assert.equal(predicted.length, 1);
  assert.equal(predicted[0].scheduledArrivalAt.toISOString(), '2026-10-12T05:40:00.000Z');
  assert.equal(predicted[0].predictedArrivalAt.toISOString(), '2026-10-12T05:50:00.000Z');
  assert.equal(predicted[0].source, 'TRIP_UPDATE');
  assert.equal(predicted[0].confidence, 'HIGH');
  assert.equal(predicted[0].realtimeUpdatedAt?.toISOString(), now.toISOString());
});

test('a canceled trip from the matching service date is not returned', () => {
  const feed = timetable();
  const realtime = parseGtfsRealtimeTripUpdates(realtimeBytes({
    relationship: transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED,
  }), now);
  const result = search(feed, realtime);
  assert.equal(result.itineraries.length, 0);
});

test('a TripUpdate for another service date cannot alter today’s departure', () => {
  const feed = timetable();
  const realtime = parseGtfsRealtimeTripUpdates(realtimeBytes({ startDate: '20261013' }), now);
  assert.equal(search(feed, realtime).itineraries.length, 0);
});

test('delay updates are applied before transfer feasibility is evaluated', () => {
  const feed = transferTimetable();
  const realtime = parseGtfsRealtimeTripUpdates(realtimeBytes({ stopSequence: 2, arrivalDelay: 600 }), now);
  const merged = mergeGtfsTimetables([{ providerId: 'lviv', providerName: 'Львівавтодор', providerCity: 'Львів', feed, realtime }]);
  assert.ok(merged);
  const result = findGtfsItinerariesWithStats(merged, {
    providerId: 'lviv', providerName: 'Львівавтодор', origin: [24.0201, 49.8401], destination: [24.0501, 49.8701],
    earliestDeparture: new Date('2026-10-12T04:55:00Z'), latestDeparture: new Date('2026-10-12T05:10:00Z'),
    now, maximumAccessWalkingMeters: 300, maximumEgressWalkingMeters: 300, maximumTransferWalkingMeters: 0,
    maximumTransfers: 1,
  });

  assert.equal(result.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === 'lviv:t1')
    && itinerary.segments.some((segment) => segment.tripId === 'lviv:t2')), false,
  '08:30 arrival cannot connect to an 08:32 departure when the required transfer buffer is 3 minutes');
});

test('provider namespacing keeps realtime updates attached to their own feed trip', () => {
  const feed = timetable();
  const realtime = parseGtfsRealtimeTripUpdates(realtimeBytes(), now);
  const merged = mergeGtfsTimetables([{ providerId: 'lviv:transit', providerName: 'Львівавтодор', providerCity: 'Львів', feed, realtime }]);
  assert.ok(merged);
  assert.equal(merged.realtimeTripUpdates?.get(gtfsRealtimeTripUpdateKey('lviv%3Atransit:t1', localTripDate))?.tripId, 'lviv%3Atransit:t1');
});
