import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGtfsTimetable, findGtfsItinerariesWithStats } from '../server/journey/gtfsTimetable';
import { gtfsRealtimeTripUpdateKey } from '../server/journey/gtfsRealtime';

test('calendar exceptions, realtime cancellation/delay, and minimum transfers agree with the exact oracle', () => {
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': new TextEncoder().encode('route_id,agency_id,route_short_name,route_long_name,route_type\nbus,a,7,City bus,3\nrail,a,R,Regional train,2'),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'start,Start,49.8400,24.0200',
      'hub,Transfer hub,49.8450,24.0250',
      'finish,Finish,49.8500,24.0300',
    ].join('\n')),
    'trips.txt': new TextEncoder().encode([
      'route_id,service_id,trip_id,trip_headsign',
      'bus,weekday,canceled-bus,Transfer hub',
      'bus,added,added-bus,Transfer hub',
      'bus,removed,removed-bus,Transfer hub',
      'bus,weekday,too-late-bus,Transfer hub',
      'rail,weekday,rail-trip,Finish',
    ].join('\n')),
    'stop_times.txt': new TextEncoder().encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      'canceled-bus,08:00:00,08:00:00,start,1,0,0',
      'canceled-bus,08:20:00,08:20:00,hub,2,0,0',
      'added-bus,08:00:00,08:00:00,start,1,0,0',
      'added-bus,08:25:00,08:25:00,hub,2,0,0',
      'removed-bus,08:00:00,08:00:00,start,1,0,0',
      'removed-bus,08:20:00,08:20:00,hub,2,0,0',
      'too-late-bus,08:00:00,08:00:00,start,1,0,0',
      'too-late-bus,08:32:00,08:32:00,hub,2,0,0',
      'rail-trip,08:40:00,08:40:00,hub,1,0,0',
      'rail-trip,09:00:00,09:00:00,finish,2,0,0',
    ].join('\n')),
    'calendar.txt': new TextEncoder().encode([
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
      'weekday,1,0,0,0,0,0,0,20261001,20261031',
      'added,0,0,0,0,0,0,0,20261001,20261031',
      'removed,1,0,0,0,0,0,0,20261001,20261031',
    ].join('\n')),
    'calendar_dates.txt': new TextEncoder().encode([
      'service_id,date,exception_type',
      'added,20261012,1',
      'removed,20261012,2',
    ].join('\n')),
    'transfers.txt': new TextEncoder().encode('from_stop_id,to_stop_id,transfer_type,min_transfer_time\nhub,hub,2,900'),
  };
  const timetable = parseGtfsTimetable(files);
  const updateAt = new Date('2026-10-12T04:00:00Z');
  timetable.realtimeTripUpdates = new Map([
    [gtfsRealtimeTripUpdateKey('canceled-bus', '20261012'), {
      tripId: 'canceled-bus', startDate: '20261012', relationship: 'CANCELED', stops: [],
      updatedAt: updateAt, feedTimestamp: updateAt,
    }],
    [gtfsRealtimeTripUpdateKey('rail-trip', '20261012'), {
      tripId: 'rail-trip', startDate: '20261012', relationship: 'SCHEDULED', updatedAt: updateAt, feedTimestamp: updateAt,
      stops: [
        { stopSequence: 1, relationship: 'SCHEDULED', departure: { delaySeconds: 300 } },
        { stopSequence: 2, relationship: 'SCHEDULED', arrival: { delaySeconds: 300 } },
      ],
    }],
  ]);

  const result = findGtfsItinerariesWithStats(timetable, {
    providerId: 'test', providerName: 'Test', origin: [24.0200, 49.8400], destination: [24.0300, 49.8500],
    earliestDeparture: new Date('2026-10-12T04:55:00Z'), latestDeparture: new Date('2026-10-12T05:12:00Z'),
    now: new Date('2026-10-12T04:00:00Z'), maximumAccessWalkingMeters: 100,
    maximumEgressWalkingMeters: 100, maximumTransferWalkingMeters: 100, maximumTransfers: 1,
  });
  const actual = result.itineraries.filter((journey) => journey.segments.length === 2)
    .map((journey) => journey.segments.map((segment) => segment.tripId).join('>'));

  assert.deepEqual(actual, ['added-bus>rail-trip'],
    'only date-added service with a feasible realtime-adjusted minimum transfer is returned');
  assert.equal(result.itineraries[0]?.segments[0]?.serviceDate, '20261012');
  assert.equal(result.itineraries[0]?.segments[1]?.departureAt.toISOString(), '2026-10-12T05:45:00.000Z',
    'the downstream leg boards at the realtime-adjusted departure');
  assert.ok(Math.abs((result.itineraries[0]?.arrivalAt.getTime() ?? 0) - Date.parse('2026-10-12T06:05:00.000Z')) <= 15_000,
    'arrival follows the realtime delay within the service-time conversion tolerance');
  assert.equal(result.searchTruncated, false, 'the oracle fixture is below all search bounds');
});
