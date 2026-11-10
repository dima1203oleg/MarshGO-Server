import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findGtfsItinerariesWithStats,
  parseGtfsTimetable,
} from '../server/journey/gtfsTimetable';
import { resolveDirectOnlyWalkingPolicy, searchWalkingReachUntilFeasible } from '../server/journey/directOnlyWalkingPolicy';

function directOnlyFeed() {
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': new TextEncoder().encode([
      'route_id,agency_id,route_short_name,route_long_name,route_type',
      'near-origin,a,A,Near origin service,3',
      'near-destination,a,B,Near destination service,3',
      'direct,a,C,Expanded direct service,3',
    ].join('\n')),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'origin-near,Origin near,49.8400,24.0000',
      'origin-terminal,Origin terminal,49.8400,24.0030',
      'destination-approach,Destination approach,49.8620,24.0010',
      'destination-near,Destination near,49.8620,24.0020',
      'origin-expanded,Origin expanded,49.8400,24.0160',
    ].join('\n')),
    'trips.txt': new TextEncoder().encode([
      'route_id,service_id,trip_id,trip_headsign',
      'near-origin,weekday,near-origin-trip,Origin terminal',
      'near-destination,weekday,near-destination-trip,Destination near',
      'direct,weekday,direct-trip,Destination near',
    ].join('\n')),
    'stop_times.txt': new TextEncoder().encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
      'near-origin-trip,08:00:00,08:00:00,origin-near,1',
      'near-origin-trip,08:10:00,08:10:00,origin-terminal,2',
      'near-destination-trip,08:15:00,08:15:00,destination-approach,1',
      'near-destination-trip,08:25:00,08:25:00,destination-near,2',
      'direct-trip,08:25:00,08:25:00,origin-expanded,1',
      'direct-trip,08:50:00,08:50:00,destination-near,2',
    ].join('\n')),
    'calendar.txt': new TextEncoder().encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,0,1,0,0,0,0,0,20261110,20261110'),
  };
  return parseGtfsTimetable(files);
}

const baseSearch = {
  providerId: 'provider-lviv',
  providerName: 'Lviv test feed',
  origin: [24.0001, 49.8400] as [number, number],
  destination: [24.0020, 49.8620] as [number, number],
  earliestDeparture: new Date('2026-11-10T06:00:00.000Z'),
  latestDeparture: new Date('2026-11-10T06:30:00.000Z'),
  now: new Date('2026-11-09T00:00:00.000Z'),
  maximumJourneySeconds: 2 * 60 * 60,
  maximumWaitSeconds: 2 * 60 * 60,
  maximumTransfers: 0,
  maximumAccessWalkingMeters: 900,
  maximumEgressWalkingMeters: 1_000,
  maximumTransferWalkingMeters: 400,
};

test('direct-only search expands after nearby stops exist but produce no direct scheduled route', () => {
  const feed = directOnlyFeed();
  const standard = findGtfsItinerariesWithStats(feed, baseSearch);
  assert.equal(standard.itineraries.length, 0,
    'nearby origin/destination stops have service but no direct connection between them');

  const adaptive = findGtfsItinerariesWithStats(feed, {
    ...baseSearch,
    directOnlyWalkingReachTiersMeters: [1_500, 2_500, 4_000],
  });
  assert.ok(adaptive.itineraries.some((itinerary) => itinerary.segments[0]?.routeId === 'direct'),
    'the expanded origin reach exposes the direct route without adding a transfer');
  assert.ok(adaptive.itineraries.every((itinerary) => itinerary.transfers === 0));
});

test('direct-only walking tiers stop at the explicit total-walk preference', () => {
  const policy = resolveDirectOnlyWalkingPolicy({
    maximumTransfers: 0,
    walkingRoutingConfigured: true,
    standardAccessMeters: 900,
    standardEgressMeters: 1_000,
    baseAccessMeters: 900,
    baseEgressMeters: 1_000,
    explicitTotalWalkingLimitMeters: 2_000,
  });
  assert.deepEqual(policy.reachTiersMeters, [1_500, 2_000]);
  assert.equal(policy.maximumAccessMeters, 2_000);
  assert.equal(policy.maximumEgressMeters, 2_000);
  assert.equal(policy.requiresConfirmedWalks, true);

  const alreadyExpandedBase = resolveDirectOnlyWalkingPolicy({
    maximumTransfers: 0,
    walkingRoutingConfigured: true,
    standardAccessMeters: 900,
    standardEgressMeters: 1_000,
    baseAccessMeters: 2_000,
    baseEgressMeters: 2_000,
    explicitTotalWalkingLimitMeters: 4_000,
  });
  assert.deepEqual(alreadyExpandedBase.reachTiersMeters, [2_500, 4_000]);
  assert.equal(alreadyExpandedBase.requiresConfirmedWalks, true,
    'explicitly widening the base radius still requires measured geometry');
});

test('a direct route outside the explicit total-walk limit remains excluded after expanding', () => {
  const result = findGtfsItinerariesWithStats(directOnlyFeed(), {
    ...baseSearch,
    maximumTotalWalkingMeters: 1_000,
    directOnlyWalkingReachTiersMeters: [1_500, 2_500, 4_000],
  });
  assert.deepEqual(result.itineraries, [], 'expanded stop reach must never bypass the total walking preference');
});

test('adaptive walking is disabled for transfers, missing foot routing, and ordinary searches', () => {
  for (const input of [
    { maximumTransfers: 1, walkingRoutingConfigured: true },
    { maximumTransfers: 0, walkingRoutingConfigured: false },
    { maximumTransfers: undefined, walkingRoutingConfigured: true },
  ]) {
    const policy = resolveDirectOnlyWalkingPolicy({ ...input,
      standardAccessMeters: 900, standardEgressMeters: 1_000,
      baseAccessMeters: 900, baseEgressMeters: 1_000, explicitTotalWalkingLimitMeters: undefined });
    assert.deepEqual(policy.reachTiersMeters, []);
    assert.equal(policy.maximumAccessMeters, 1_000);
    assert.equal(policy.requiresConfirmedWalks, false);
  }
});

test('adaptive walking tiers cannot be applied to a multi-transfer search', () => {
  assert.throws(() => findGtfsItinerariesWithStats(directOnlyFeed(), {
    ...baseSearch,
    maximumTransfers: 1,
    directOnlyWalkingReachTiersMeters: [1_500],
  }), /only valid when maxTransfers is zero/);
});

test('direct-only reach retries when scheduled candidates fail real-walk validation, then stops at the first usable tier', async () => {
  const searchedTiers: number[] = [];
  const outcome = await searchWalkingReachUntilFeasible(
    [1_500, 2_500, 4_000],
    async (tier) => {
      searchedTiers.push(tier);
      return [`scheduled-${tier}`];
    },
    async (candidates) => candidates.filter((candidate) => candidate === 'scheduled-2500'),
  );
  assert.deepEqual(searchedTiers, [1_500, 2_500]);
  assert.deepEqual(outcome, {
    candidates: ['scheduled-2500'], reachMeters: 2_500, attempts: 2, stoppedByBudget: false,
  });
});

test('adaptive walking reports when the route-validation budget prevents the next tier', async () => {
  const searchedTiers: number[] = [];
  const outcome = await searchWalkingReachUntilFeasible(
    [1_500, 2_500],
    async (tier) => {
      searchedTiers.push(tier);
      return [`scheduled-${tier}`];
    },
    async () => [],
    () => searchedTiers.length === 0,
  );
  assert.deepEqual(searchedTiers, [1_500]);
  assert.deepEqual(outcome, { candidates: [], reachMeters: null, attempts: 1, stoppedByBudget: true });
});
