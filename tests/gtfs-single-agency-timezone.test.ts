import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8 } from 'fflate';
import { summarizeGtfs } from '../server/mobility/gtfs';

const files = (agency: string, stopLons: number[]): Record<string, Uint8Array> => ({
  'agency.txt': strToU8(agency),
  'stops.txt': strToU8(['stop_id,stop_name,stop_lat,stop_lon',
    ...stopLons.map((lon, i) => `s${i},Stop ${i},50.62,${lon}`)].join('\n')),
  'routes.txt': strToU8('route_id,agency_id,route_short_name,route_long_name,route_type\nr1,,1,Route 1,3'),
  'trips.txt': strToU8('route_id,service_id,trip_id\nt1,d1,trip1'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\ntrip1,08:00:00,08:00:00,s0,1'),
  'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nd1,1,1,1,1,1,1,1,20260101,20261231'),
});

test('empty agency.txt is accepted when every stop is inside Ukraine (single-agency GTFS spec case)', () => {
  const summary = summarizeGtfs(files('agency_id,agency_name,agency_url,agency_timezone\n', [26.25, 26.21]));
  assert.equal(summary.agencies, 0);
  assert.equal(summary.hasValidTimezone, true);
});

test('empty agency.txt with a foreign stop is still rejected', () => {
  const summary = summarizeGtfs(files('agency_id,agency_name,agency_url,agency_timezone\n', [26.25, 21.01]));
  assert.equal(summary.hasValidTimezone, false);
});

test('declared agency_timezone rows keep their original validation', () => {
  const valid = summarizeGtfs(files('agency_id,agency_name,agency_url,agency_timezone\na1,Carrier,https://example.org,Europe/Kyiv\n', [26.25]));
  assert.equal(valid.hasValidTimezone, true);
  const invalid = summarizeGtfs(files('agency_id,agency_name,agency_url,agency_timezone\na1,Carrier,https://example.org,Not/AZone\n', [26.25]));
  assert.equal(invalid.hasValidTimezone, false);
});
