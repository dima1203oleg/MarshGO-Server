import assert from 'node:assert/strict';
import test from 'node:test';
import { findDirectGtfsJourneys, parseGtfsTimetable } from '../server/journey/gtfsTimetable';

const enc = new TextEncoder();

/**
 * Real Dozor.tech feeds (e.g. Біла Церква) publish stop_times without
 * departure_time for pass-through stops and without arrival_time for terminals.
 * The feed in the fixture below reproduces that shape: 6 193 of 6 866 live rows
 * have an empty departure_time.
 */
function partialTimeFeed() {
  return parseGtfsTimetable({
    'agency.txt': enc.encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': enc.encode('route_id,agency_id,route_short_name,route_long_name,route_type\nr,a,7,Test,3'),
    'stops.txt': enc.encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'origin,Origin stop,49.8400,24.0200',
      'middle,Middle stop,49.8450,24.0250',
      'alight,Alight stop,49.8500,24.0300',
      'ghost,Ghost stop,49.8510,24.0310',
    ].join('\n')),
    'trips.txt': enc.encode('route_id,service_id,trip_id,trip_headsign\nr,weekday,t1,Central station'),
    'stop_times.txt': enc.encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      't1,,08:00:00,origin,1,0,0',
      't1,08:20:00,,middle,2,0,0',
      't1,08:40:00,,alight,3,0,0',
      't1,,,ghost,4,0,0',
    ].join('\n')),
    'calendar.txt': enc.encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
  });
}

const window = () => ({
  providerId: 'p1', providerName: 'Test Transit',
  origin: [24.0201, 49.8401] as [number, number], destination: [24.0301, 49.8501] as [number, number],
  earliestDeparture: new Date('2026-10-12T04:55:00Z'), latestDeparture: new Date('2026-10-12T05:30:00Z'),
  now: new Date('2026-10-08T00:00:00Z'),
});

test('keeps stop calls that publish only one of arrival_time / departure_time', () => {
  const stopTimes = partialTimeFeed().stopTimes.get('t1');
  assert.deepEqual(stopTimes?.map((call) => call.stopId), ['origin', 'middle', 'alight'],
    'a stop with a single published time is still a scheduled stop; only rows with no time at all are unusable');
});

test('a partially timed trip lists every traveled stop on the leg', () => {
  const journey = findDirectGtfsJourneys(partialTimeFeed(), window())[0];
  assert.equal(journey?.originStop.name, 'Origin stop');
  assert.equal(journey?.destinationStop.name, 'Alight stop');
  assert.deepEqual(journey?.stops?.map((stop) => [stop.name, stop.arrivalAt, stop.departureAt]), [
    ['Origin stop', '2026-10-12T05:00:00.000Z', '2026-10-12T05:00:00.000Z'],
    ['Middle stop', '2026-10-12T05:20:00.000Z', '2026-10-12T05:20:00.000Z'],
    ['Alight stop', '2026-10-12T05:40:00.000Z', '2026-10-12T05:40:00.000Z'],
  ], 'the missing side of a time point mirrors the published one instead of inventing a dwell');
});

test('passengers can board and alight at stops whose departure_time is omitted', () => {
  const feed = partialTimeFeed();
  const fromMiddle = { ...window(), origin: [24.0251, 49.8451] as [number, number] };
  const journeys = findDirectGtfsJourneys(feed, fromMiddle);
  const boarded = journeys.find((journey) => journey.originStop.name === 'Middle stop');
  assert.ok(boarded, `boarding a stop with no published departure_time must be possible; got ${journeys.map((journey) => `${journey.originStop.name}->${journey.destinationStop.name}`).join(', ') || 'none'}`);
  assert.equal(boarded?.departureAt.toISOString(), '2026-10-12T05:20:00.000Z');
  assert.equal(boarded?.arrivalAt.toISOString(), '2026-10-12T05:40:00.000Z');
});
