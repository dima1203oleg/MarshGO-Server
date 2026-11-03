import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_ACCESS_WALKING_METERS,
  DEFAULT_MAX_EGRESS_WALKING_METERS,
  MAX_PREFERENCE_WALKING_RADIUS_METERS,
  effectiveWalkingReachMeters,
  findGtfsItinerariesWithStats,
  parseGtfsTimetable,
  summarizeGtfsWalkReach,
} from '../server/journey/gtfsTimetable';
import { getJourneySearchPartialReasons } from '../server/journey/search';
import { buildSearchCompleteness } from '../server/journey/searchCompleteness';

/**
 * One bus pair with the destination stop ~1.3 km from a pin placed outside the default
 * egress radius — the live Lviv defect shape, as a synthetic fixture, not feed evidence.
 */
function feed() {
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': new TextEncoder().encode('route_id,agency_id,route_short_name,route_long_name,route_type\nr,a,7,Test bus,3'),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'origin,Origin stop,49.8400,24.0200',
      'destination,Destination stop,49.8500,24.0300',
    ].join('\n')),
    'trips.txt': new TextEncoder().encode('route_id,service_id,trip_id,trip_headsign\nr,weekday,t1,Destination stop'),
    'stop_times.txt': new TextEncoder().encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      't1,08:00:00,08:00:00,origin,1,0,0',
      't1,08:40:00,08:40:00,destination,2,0,0',
    ].join('\n')),
    'calendar.txt': new TextEncoder().encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
  };
  return parseGtfsTimetable(files);
}

const ORIGIN_POINT: [number, number] = [24.0201, 49.8401];
// 0.012° of latitude is ~1335 m of the destination stop: outside the 1000 m egress default.
const MISSED_DESTINATION_POINT: [number, number] = [24.0300, 49.8620];
// ~2449 m: outside even the capped preference expansion.
const UNREACHABLE_DESTINATION_POINT: [number, number] = [24.0300, 49.8720];

/** Mirrors how server/index.ts threads the preference into the worker search arguments. */
const searchInput = (destination: [number, number], maxWalkingMeters?: number) => ({
  providerId: 'p1', providerName: 'Test Transit', origin: ORIGIN_POINT, destination,
  earliestDeparture: new Date('2026-10-12T04:55:00Z'), latestDeparture: new Date('2026-10-12T05:30:00Z'),
  now: new Date('2026-10-08T00:00:00Z'), maximumTransfers: 0,
  maximumAccessWalkingMeters: effectiveWalkingReachMeters(DEFAULT_MAX_ACCESS_WALKING_METERS, maxWalkingMeters),
  maximumEgressWalkingMeters: effectiveWalkingReachMeters(DEFAULT_MAX_EGRESS_WALKING_METERS, maxWalkingMeters),
});

test('a walking preference beyond the default radius unlocks a stop the baseline search misses', () => {
  const baseline = findGtfsItinerariesWithStats(feed(), searchInput(MISSED_DESTINATION_POINT));
  assert.equal(baseline.itineraries.length, 0, 'the default 1000 m egress must not reach a 1.3 km stop');
  const unlocked = findGtfsItinerariesWithStats(feed(), searchInput(MISSED_DESTINATION_POINT, 1500));
  assert.ok(unlocked.itineraries.length >= 1,
    'maxWalkingMeters 1500 must widen the egress radius to 1500 and find the itinerary');
  assert.equal(effectiveWalkingReachMeters(DEFAULT_MAX_EGRESS_WALKING_METERS, 1500), 1500);
  assert.equal(effectiveWalkingReachMeters(DEFAULT_MAX_EGRESS_WALKING_METERS, undefined), DEFAULT_MAX_EGRESS_WALKING_METERS,
    'without the preference the configured radii stay untouched');
});

test('the zero-reach result carries measured per-side nearest stop distances', () => {
  const blocked = findGtfsItinerariesWithStats(feed(), searchInput(MISSED_DESTINATION_POINT));
  assert.ok(blocked.walkReach, 'a searched result must carry the measured walk reach');
  assert.equal(blocked.walkReach.originStopsFound, true);
  assert.equal(blocked.walkReach.destinationStopsFound, false);
  assert.ok(blocked.walkReach.nearestOriginStopMeters !== null
    && blocked.walkReach.nearestOriginStopMeters < 20, 'the origin side sits at its own stop');
  assert.ok(blocked.walkReach.nearestDestinationStopMeters !== null
    && blocked.walkReach.nearestDestinationStopMeters > 1250
    && blocked.walkReach.nearestDestinationStopMeters < 1420,
  `expected ~1335 m, measured ${blocked.walkReach.nearestDestinationStopMeters}`);
});

test('a pathologically large walking preference is capped and never shrinks a wider base radius', () => {
  assert.equal(effectiveWalkingReachMeters(DEFAULT_MAX_ACCESS_WALKING_METERS, 50_000), MAX_PREFERENCE_WALKING_RADIUS_METERS);
  assert.equal(effectiveWalkingReachMeters(5_000, 1_500), 5_000, 'intercity radii may not be narrowed by a short preference');
  const blocked = findGtfsItinerariesWithStats(feed(), searchInput(UNREACHABLE_DESTINATION_POINT, 50_000));
  assert.equal(blocked.itineraries.length, 0, 'the 2 km cap must not reach a stop at ~2.4 km');
  assert.ok(blocked.walkReach && blocked.walkReach.nearestDestinationStopMeters !== null
    && blocked.walkReach.nearestDestinationStopMeters > MAX_PREFERENCE_WALKING_RADIUS_METERS);
});

test('the walk-reach summary is present exactly in the zero-reach case and never without measurement', () => {
  const blocked = findGtfsItinerariesWithStats(feed(), searchInput(MISSED_DESTINATION_POINT));
  const summary = summarizeGtfsWalkReach([blocked]);
  assert.ok(summary && summary.blocked);
  assert.ok(summary.nearestDestinationStopMeters !== null && summary.nearestDestinationStopMeters > 1250);
  assert.equal(summarizeGtfsWalkReach([findGtfsItinerariesWithStats(feed(), searchInput(MISSED_DESTINATION_POINT, 1500))])?.blocked, false);
  assert.equal(summarizeGtfsWalkReach([]), null, 'no searched group proves nothing');
  // A synthesized empty fallback carries no measurement, so the summary must stay silent.
  assert.equal(summarizeGtfsWalkReach([blocked, { itineraries: [] } as never]), null);
});

test('the disclosure surfaces as a partial reason and completeness nearest-stop fields', () => {
  const complete = {
    candidateGenerationTruncated: false, providerErrorCount: 0,
    unsupportedPreferenceCount: 0, scheduledCandidatesNeedWalkingRouting: false,
  };
  assert.deepEqual(getJourneySearchPartialReasons(complete), []);
  assert.deepEqual(getJourneySearchPartialReasons({ ...complete, noStopWithinWalkingDistance: true }),
    ['no_stop_within_walking_distance']);
  const baseCompleteness = {
    providersQueried: 1, providersFailed: 0, routeTypesInCorridor: ['bus'],
    candidatesGenerated: 0, candidatesValidated: 0, candidatesDeduplicated: 0,
    resultsReturned: 0, searchTruncated: false,
  };
  assert.equal('nearestOriginStopMeters' in buildSearchCompleteness(baseCompleteness), false,
    'reachable searches must not carry the disclosure');
  const disclosed = buildSearchCompleteness({ ...baseCompleteness,
    walkingReach: { nearestOriginStopMeters: 13, nearestDestinationStopMeters: 1335 } });
  assert.equal(disclosed.nearestOriginStopMeters, 13);
  assert.equal(disclosed.nearestDestinationStopMeters, 1335);
});

test('the reach summary names only the side every searched group missed', () => {
  const missedDestination = (nearestDestinationStopMeters: number) => ({
    walkReach: { originStopsFound: true, destinationStopsFound: false, nearestOriginStopMeters: 93, nearestDestinationStopMeters },
  });
  const summary = summarizeGtfsWalkReach([missedDestination(1243), missedDestination(1500)]);
  assert.ok(summary?.blocked, 'every group missed the destination side');
  assert.equal(summary?.nearestDestinationStopMeters, 1243, 'the nearest missed stop is the distance a passenger can act on');
  // A live Lviv search named an origin 93 m from its own stop inside a "no stop nearby" message.
  assert.equal(summary?.nearestOriginStopMeters, null, 'a side every group reached must not be named');

  // Different feeds missing different sides prove nothing about either side being out of reach.
  const split = summarizeGtfsWalkReach([
    { walkReach: { originStopsFound: false, destinationStopsFound: true, nearestOriginStopMeters: 2400, nearestDestinationStopMeters: 40 } },
    { walkReach: { originStopsFound: true, destinationStopsFound: false, nearestOriginStopMeters: 40, nearestDestinationStopMeters: 2400 } },
  ]);
  assert.equal(split?.blocked, false, 'no single side is missed by every group');
  assert.equal(split?.nearestOriginStopMeters, null);
  assert.equal(split?.nearestDestinationStopMeters, null);
});
