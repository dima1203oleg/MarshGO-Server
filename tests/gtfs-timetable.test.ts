import test from 'node:test';
import assert from 'node:assert/strict';
import { findDirectGtfsJourneys, findGtfsItineraries, parseGtfsTimetable } from '../server/journey/gtfsTimetable';

function feed(overrides: { monday?: string; exceptionDate?: string; exceptionType?: string; pickup?: string; dropoff?: string; departure?: string; arrival?: string; routeType?: string; routeName?: string } = {}) {
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode(['agency_id,agency_name,agency_url,agency_timezone', 'a,Test,https://example.test,Europe/Kyiv'].join('\n')),
    'routes.txt': new TextEncoder().encode(['route_id,agency_id,route_short_name,route_long_name,route_type', `r,a,7,${overrides.routeName ?? 'Test bus'},${overrides.routeType ?? '3'}`].join('\n')),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'origin,Origin stop,49.8400,24.0200',
      'destination,Destination stop,49.8500,24.0300',
    ].join('\n')),
    'trips.txt': new TextEncoder().encode('route_id,service_id,trip_id,trip_headsign\nr,weekday,t1,Central station'),
    'stop_times.txt': new TextEncoder().encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      `t1,${overrides.departure ?? '08:00:00'},${overrides.departure ?? '08:00:00'},origin,1,${overrides.pickup ?? '0'},0`,
      `t1,${overrides.arrival ?? '08:40:00'},${overrides.arrival ?? '08:40:00'},destination,2,0,${overrides.dropoff ?? '0'}`,
    ].join('\n')),
    'calendar.txt': new TextEncoder().encode(`service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,${overrides.monday ?? '1'},0,0,0,0,0,0,20261001,20261031`),
  };
  if (overrides.exceptionDate) files['calendar_dates.txt'] = new TextEncoder().encode(`service_id,date,exception_type\nweekday,${overrides.exceptionDate},${overrides.exceptionType ?? '1'}`);
  return parseGtfsTimetable(files);
}

function connectingFeed() {
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': new TextEncoder().encode('route_id,agency_id,route_short_name,route_long_name,route_type\nbus,a,7,City bus,3\nrail,a,IC 743,Train,2'),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'start,Start,49.8400,24.0200',
      'hub,Transfer hub,49.8450,24.0250',
      'finish,Finish,49.8500,24.0300',
    ].join('\n')),
    'trips.txt': new TextEncoder().encode('route_id,service_id,trip_id,trip_headsign\nbus,weekday,b1,Transfer hub\nrail,weekday,r1,Finish'),
    'stop_times.txt': new TextEncoder().encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      'b1,08:00:00,08:00:00,start,1,0,0',
      'b1,08:20:00,08:20:00,hub,2,0,0',
      'r1,08:35:00,08:35:00,hub,1,0,0',
      'r1,09:00:00,09:00:00,finish,2,0,0',
    ].join('\n')),
    'calendar.txt': new TextEncoder().encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
  };
  return parseGtfsTimetable(files);
}

const request = (earliest: string, latest: string) => ({
  providerId: 'p1', providerName: 'Test Transit', origin: [24.0201, 49.8401] as [number, number], destination: [24.0301, 49.8501] as [number, number],
  earliestDeparture: new Date(earliest), latestDeparture: new Date(latest), now: new Date('2026-10-08T00:00:00Z'),
});

test('finds a scheduled direct bus, preserves route/stops, and converts agency local time to UTC', () => {
  const journeys = findDirectGtfsJourneys(feed(), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'));
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].mode, 'BUS');
  assert.equal(journeys[0].routeName, '7');
  assert.equal(journeys[0].headsign, 'Central station');
  assert.equal(journeys[0].originStop.name, 'Origin stop');
  assert.equal(journeys[0].departureAt.toISOString(), '2026-10-12T05:00:00.000Z');
  assert.equal(journeys[0].arrivalAt.toISOString(), '2026-10-12T05:40:00.000Z');
});

test('uses calendar date exceptions before weekly service and excludes removed service', () => {
  const added = findDirectGtfsJourneys(feed({ monday: '0', exceptionDate: '20261012' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'));
  const removed = findDirectGtfsJourneys(feed({ exceptionDate: '20261012', exceptionType: '2' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'));
  assert.equal(added.length, 1);
  assert.equal(removed.length, 0);
});

test('honors GTFS pickup/drop-off restrictions and only searches nearby stops', () => {
  assert.equal(findDirectGtfsJourneys(feed({ pickup: '1' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z')).length, 0);
  assert.equal(findDirectGtfsJourneys(feed({ pickup: '2' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z')).length, 0);
  assert.equal(findDirectGtfsJourneys(feed({ dropoff: '1' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z')).length, 0);
  assert.equal(findDirectGtfsJourneys(feed({ dropoff: '3' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z')).length, 0);
  const farAway = request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z');
  farAway.origin = [25, 50];
  assert.equal(findDirectGtfsJourneys(feed(), farAway).length, 0);
});

test('finds service after midnight when GTFS uses a 24-hour stop time', () => {
  const journeys = findDirectGtfsJourneys(feed({ departure: '24:15:00', arrival: '24:55:00' }), request('2026-10-12T21:10:00Z', '2026-10-12T21:30:00Z'));
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].departureAt.toISOString(), '2026-10-12T21:15:00.000Z');
  assert.equal(journeys[0].arrivalAt.toISOString(), '2026-10-12T21:55:00.000Z');
});

test('normalizes GTFS rail and ferry journeys into supported journey modes', () => {
  const interval = request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z');
  assert.equal(findDirectGtfsJourneys(feed({ routeType: '2' }), interval)[0]?.mode, 'RAIL');
  assert.equal(findDirectGtfsJourneys(feed({ routeType: '4' }), interval)[0]?.mode, 'FERRY');
});

test('recognizes city train and funicular routes and respects selected route subtypes', () => {
  const interval = request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z');
  const cityTrain = findGtfsItineraries(feed({ routeType: '2', routeName: 'Київська міська електричка' }), {
    ...interval, allowedModes: ['RAIL'], allowedTransportTypes: ['city_train'], maximumStopDistanceMeters: 2000,
  });
  const suburbanTrain = findGtfsItineraries(feed({ routeType: '109' }), {
    ...interval, allowedModes: ['RAIL'], allowedTransportTypes: ['city_train'], maximumStopDistanceMeters: 2000,
  });
  const funicular = findGtfsItineraries(feed({ routeType: '3', routeName: 'Фунікулер Поділ — Верхня станція' }), {
    ...interval, allowedModes: ['FUNICULAR'], allowedTransportTypes: ['funicular'], maximumStopDistanceMeters: 2000,
  });
  const minibus = findGtfsItineraries(feed({ routeType: '3', routeName: 'Маршрутка № 5' }), {
    ...interval, allowedModes: ['MINIBUS'], allowedTransportTypes: ['marshrutka'], maximumStopDistanceMeters: 2000,
  });
  const intercityBus = findGtfsItineraries(feed({ routeType: '3', routeName: 'Міжміський автобус' }), {
    ...interval, allowedModes: ['BUS'], allowedTransportTypes: ['intercity_bus'], maximumStopDistanceMeters: 2000,
  });
  assert.equal(cityTrain[0]?.segments[0]?.transportType, 'city_train');
  assert.equal(suburbanTrain.length, 0);
  assert.equal(funicular[0]?.segments[0]?.mode, 'FUNICULAR');
  assert.equal(minibus[0]?.segments[0]?.mode, 'MINIBUS');
  assert.equal(intercityBus[0]?.segments[0]?.transportType, 'intercity_bus');
});

test('composes a time-feasible bus-to-rail itinerary at the same canonical stop', () => {
  const results = findGtfsItineraries(connectingFeed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300,
    maximumTransfers: 1,
    minimumTransferBufferSeconds: 600,
  });

  assert.equal(results.length, 1);
  assert.deepEqual(results[0].segments.map((segment) => segment.mode), ['BUS', 'RAIL']);
  assert.deepEqual(results[0].segments.map((segment) => [segment.originStop.id, segment.destinationStop.id]), [['start', 'hub'], ['hub', 'finish']]);
  assert.equal(results[0].transfers, 1);
  assert.ok(results[0].walkingMeters > 0);
  assert.equal(results[0].durationSeconds, Math.ceil((results[0].arrivalAt.getTime() - results[0].departureAt.getTime()) / 1000));
  assert.ok(results[0].departureAt.getTime() >= Date.parse('2026-10-12T04:55:00Z'));
  assert.equal(results[0].departureAt.getTime(), results[0].segments[0].departureAt.getTime()
    - Math.ceil(results[0].segments[0].distanceToOriginStopMeters / 1.25) * 1000);
  assert.ok(results[0].arrivalAt.getTime() > results[0].segments.at(-1)!.arrivalAt.getTime());
});

test('does not invent a feasible transfer when the configured buffer is missed', () => {
  const transit = connectingFeed();
  const rail = transit.stopTimes.get('r1')!;
  rail[0].arrivalSeconds = 8 * 3600 + 25 * 60;
  rail[0].departureSeconds = 8 * 3600 + 25 * 60;
  const results = findGtfsItineraries(transit, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300,
    maximumTransfers: 1,
    minimumTransferBufferSeconds: 600,
  });
  assert.equal(results.length, 0);
});

test('rejects feeds without a timezone and validates query bounds', () => {
  assert.throws(() => parseGtfsTimetable({ 'agency.txt': new TextEncoder().encode('agency_name\nTransit') }), /agency_timezone/);
  assert.throws(() => findDirectGtfsJourneys(feed(), { ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumStopDistanceMeters: 50 }), /between 100 and 10000/);
});
