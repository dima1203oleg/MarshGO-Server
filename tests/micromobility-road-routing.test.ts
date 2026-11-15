import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBicycleRouteEstimates, roadRouteMicromobilityEstimate,
  type MicromobilityRouteEstimate, type RentalRouteNetwork, type RentalRoutePoint,
} from '../server/journey/micromobilityEstimates';
import { bicycleEndpointFor } from '../server/journey/bicycleRoutes';
import { trustedRouteGeometry } from '../server/journey/legGeometryProvenance';
import { geofenceRulesAt, rideThroughForbiddenOnSegment, type GbfsGeofence, type GbfsGeofenceRule } from '../server/mobility/gbfsGeofences';

const station = (id: string, coordinates: [number, number]): RentalRoutePoint => ({
  id, providerId: 'nextbike-lviv', providerName: 'Nextbike', networkId: 'nextbike-ua', name: id, coordinates,
  mode: 'BICYCLE', pickupAllowed: true, dropoffAllowed: true, availability: 'UNKNOWN', source: 'OSM',
});
const networks = new Map<string, RentalRouteNetwork>([['nextbike-ua', {
  networkId: 'nextbike-ua', providerIds: ['nextbike-lviv'], compatibilityStatus: 'CONFIRMED',
  returnRule: 'ANY_NETWORK_LOCATION', returnRuleSource: 'OWNER_ATTESTED',
}]]);
const PICKUP: [number, number] = [24.0316, 49.8419];
const DROPOFF: [number, number] = [24.0571, 49.8013];

function straightEstimate(): MicromobilityRouteEstimate {
  const [estimate] = buildBicycleRouteEstimates({
    origin: { name: 'Ринок', coordinates: [24.0318, 49.8421] },
    destination: { name: 'Сихів', coordinates: [24.0573, 49.8011] },
    points: [station('rynok', PICKUP), station('sykhiv', DROPOFF)], networks,
    options: { departureAt: new Date('2026-11-14T17:00:00Z'), maxWalkToRentalMeters: 900 },
  });
  assert.ok(estimate);
  return estimate;
}
const streetPath = { geometry: [PICKUP, [24.035, 49.83], [24.05, 49.81], DROPOFF] as Array<[number, number]>, distanceMeters: 6350, durationSeconds: 2077 };

test('a bike ride is rebuilt on the routed street path and its timings follow that path', async () => {
  const straight = straightEstimate();
  const outcome = await roadRouteMicromobilityEstimate(straight, { routeRide: async () => streetPath }, {});
  assert.equal(outcome.rejected, null);
  const ride = outcome.estimate!.legs.find((leg) => leg.mode === 'BICYCLE')!;
  assert.deepEqual(ride.routeGeometry, streetPath.geometry);
  assert.equal(ride.distanceMeters, 6350);
  assert.equal(ride.durationSeconds, 2077);
  assert.equal(ride.metadata.routeGeometrySource, 'osrm-bike-route');
  assert.equal(outcome.estimate!.routeAccuracy, 'SOURCE_GEOMETRY');
  assert.equal(outcome.estimate!.durationSeconds, outcome.estimate!.legs.reduce((sum, leg) => sum + leg.durationSeconds, 0));
  assert.equal(outcome.estimate!.arrivalAt.getTime() - outcome.estimate!.departureAt.getTime(), outcome.estimate!.durationSeconds * 1000);
  assert.ok(trustedRouteGeometry({ mode: 'BICYCLE', source: 'osrm-bike-route', routeGeometry: ride.routeGeometry }));
});

test('negative control: without a road router the bike candidate is dropped, never kept as a straight line', async () => {
  const outcome = await roadRouteMicromobilityEstimate(straightEstimate(), { routeRide: async () => null }, {});
  assert.equal(outcome.estimate, null);
  assert.equal(outcome.rejected, 'no-road-router');
});

test('a degenerate router answer is treated as no route', async () => {
  const outcome = await roadRouteMicromobilityEstimate(straightEstimate(),
    { routeRide: async () => ({ geometry: [PICKUP], distanceMeters: 0, durationSeconds: 0 }) }, {});
  assert.equal(outcome.rejected, 'no-road-router');
});

test('a scooter ride crossing a no-ride-through zone on the routed streets is rejected', async () => {
  const straight = straightEstimate();
  const scooter: MicromobilityRouteEstimate = { ...straight, mode: 'SCOOTER',
    legs: straight.legs.map((leg) => leg.mode === 'BICYCLE' ? { ...leg, mode: 'SCOOTER' } : leg) };
  const forbidden = await roadRouteMicromobilityEstimate(scooter, {
    routeRide: async () => streetPath,
    rideThroughAllowed: (_estimate, point) => !(point[0] === 24.05 && point[1] === 49.81),
  }, {});
  assert.equal(forbidden.rejected, 'ride-through-forbidden');
  const allowed = await roadRouteMicromobilityEstimate(scooter, { routeRide: async () => streetPath, rideThroughAllowed: () => true }, {});
  const ride = allowed.estimate!.legs.find((leg) => leg.mode === 'SCOOTER')!;
  assert.equal(ride.metadata.routeGeometrySource, 'osrm-scooter-route');
  assert.ok(trustedRouteGeometry({ mode: 'SCOOTER', source: 'osrm-scooter-route', routeGeometry: ride.routeGeometry }));
});

test('the routed ride duration is re-checked against the rental cap', async () => {
  const outcome = await roadRouteMicromobilityEstimate(straightEstimate(), { routeRide: async () => streetPath }, { maxRentalDurationSeconds: 1800 });
  assert.equal(outcome.rejected, 'rental-duration-exceeded');
});

const noRideZone = (id: string, rings: Array<Array<[number, number]>>, vehicleTypeIds: string[] | null = null): GbfsGeofence => ({
  id, geometry: { type: 'Polygon', coordinates: rings },
  rules: [{ vehicleTypeIds, rideStartAllowed: null, rideEndAllowed: null, rideThroughAllowed: false, maximumSpeedKph: null, startAt: null, endAt: null }],
});
const scooterEstimate = (): MicromobilityRouteEstimate => {
  const straight = straightEstimate();
  return { ...straight, mode: 'SCOOTER', legs: straight.legs.map((leg) => leg.mode === 'BICYCLE' ? { ...leg, mode: 'SCOOTER' } : leg) };
};
// A narrow zone around the midpoint of the [24.035,49.83]→[24.05,49.81] edge; no path vertex lies inside it.
const narrowRing: Array<[number, number]> = [[24.042, 49.8195], [24.043, 49.8195], [24.043, 49.8205], [24.042, 49.8205], [24.042, 49.8195]];

test('a narrow no-ride-through zone crossed by a routed edge is rejected even when no sampled vertex lies inside it', async () => {
  const snapshot = { geofences: [noRideZone('narrow', [narrowRing])], globalRules: [] };
  const scooter = scooterEstimate();
  for (const point of streetPath.geometry) {
    assert.equal(geofenceRulesAt(snapshot, point, 'scooter', scooter.departureAt.getTime()).rideThroughAllowed, null);
  }
  const vertexOnly = await roadRouteMicromobilityEstimate(scooter, {
    routeRide: async () => streetPath,
    rideThroughAllowed: (estimate, point) => geofenceRulesAt(snapshot, point, 'scooter', estimate.departureAt.getTime()).rideThroughAllowed !== false,
  }, {});
  assert.equal(vertexOnly.rejected, null, 'vertex sampling alone must miss this zone — that is the regression being fixed');
  const segmentAware = await roadRouteMicromobilityEstimate(scooter, {
    routeRide: async () => streetPath,
    rideThroughSegmentAllowed: (estimate, from, to) => !rideThroughForbiddenOnSegment(snapshot, from, to, 'scooter', estimate.departureAt.getTime()),
  }, {});
  assert.equal(segmentAware.estimate, null);
  assert.equal(segmentAware.rejected, 'ride-through-forbidden');
});

test('negative control: a no-ride-through zone away from the routed streets keeps the scooter candidate', async () => {
  const farRing: Array<[number, number]> = [[24.1, 49.9], [24.11, 49.9], [24.11, 49.91], [24.1, 49.91], [24.1, 49.9]];
  const snapshot = { geofences: [noRideZone('far', [farRing])], globalRules: [] };
  const outcome = await roadRouteMicromobilityEstimate(scooterEstimate(), {
    routeRide: async () => streetPath,
    rideThroughSegmentAllowed: (estimate, from, to) => !rideThroughForbiddenOnSegment(snapshot, from, to, 'scooter', estimate.departureAt.getTime()),
  }, {});
  assert.equal(outcome.rejected, null);
  assert.deepEqual(outcome.estimate!.legs.find((leg) => leg.mode === 'SCOOTER')!.routeGeometry, streetPath.geometry);
});

test('a ride staying inside a hole of a no-ride-through zone is allowed, but crossing the hole ring is forbidden', () => {
  const outer: Array<[number, number]> = [[24.0, 49.7], [24.1, 49.7], [24.1, 49.9], [24.0, 49.9], [24.0, 49.7]];
  const holeAroundPath: Array<[number, number]> = [[24.02, 49.79], [24.07, 49.79], [24.07, 49.85], [24.02, 49.85], [24.02, 49.79]];
  const inHole = { geofences: [noRideZone('hole', [outer, holeAroundPath])], globalRules: [] };
  for (let i = 1; i < streetPath.geometry.length; i++) {
    assert.equal(rideThroughForbiddenOnSegment(inHole, streetPath.geometry[i - 1], streetPath.geometry[i], 'scooter'), false);
  }
  const smallHole: Array<[number, number]> = [[24.02, 49.825], [24.04, 49.825], [24.04, 49.85], [24.02, 49.85], [24.02, 49.825]];
  const crossingHole = { geofences: [noRideZone('small-hole', [outer, smallHole])], globalRules: [] };
  assert.equal(rideThroughForbiddenOnSegment(crossingHole, PICKUP, [24.035, 49.83], 'scooter'), false);
  assert.equal(rideThroughForbiddenOnSegment(crossingHole, [24.035, 49.83], [24.05, 49.81], 'scooter'), true);
});

test('a no-ride-through rule scoped to one vehicle type does not forbid another type', () => {
  const snapshot = { geofences: [noRideZone('typed', [narrowRing], ['e-scooter'])], globalRules: [] };
  const from: [number, number] = [24.035, 49.83], to: [number, number] = [24.05, 49.81];
  assert.equal(rideThroughForbiddenOnSegment(snapshot, from, to, 'e-scooter'), true);
  assert.equal(rideThroughForbiddenOnSegment(snapshot, from, to, 'e-bike'), false);
});

const globalRule = (rideThroughAllowed: boolean | null, vehicleTypeIds: string[] | null = null): GbfsGeofenceRule => ({
  vehicleTypeIds, rideStartAllowed: null, rideEndAllowed: null, rideThroughAllowed, maximumSpeedKph: null, startAt: null, endAt: null,
});
const allowingZone = (id: string, ring: Array<[number, number]>): GbfsGeofence => ({
  id, geometry: { type: 'Polygon', coordinates: [ring] }, rules: [globalRule(true)],
});

test('a global no-ride-through rule forbids a two-point routed ride that vertex sampling cannot see', async () => {
  const snapshot = { geofences: [], globalRules: [globalRule(false)] };
  const twoPointPath = { geometry: [PICKUP, DROPOFF] as Array<[number, number]>, distanceMeters: 6350, durationSeconds: 2077 };
  const scooter = scooterEstimate();
  const vertexOnly = await roadRouteMicromobilityEstimate(scooter, {
    routeRide: async () => twoPointPath,
    rideThroughAllowed: (estimate, point) => geofenceRulesAt(snapshot, point, 'scooter', estimate.departureAt.getTime()).rideThroughAllowed !== false,
  }, {});
  assert.equal(vertexOnly.rejected, null, 'a two-point geometry has no interior vertex — vertex sampling alone must miss the global ban');
  assert.equal(rideThroughForbiddenOnSegment(snapshot, PICKUP, DROPOFF, 'scooter'), true);
  const segmentAware = await roadRouteMicromobilityEstimate(scooter, {
    routeRide: async () => twoPointPath,
    rideThroughSegmentAllowed: (estimate, from, to) => !rideThroughForbiddenOnSegment(snapshot, from, to, 'scooter', estimate.departureAt.getTime()),
  }, {});
  assert.equal(segmentAware.estimate, null);
  assert.equal(segmentAware.rejected, 'ride-through-forbidden');
});

test('an allowing zone overrides a global no-ride-through rule while the ride stays inside it', () => {
  const coveringRing: Array<[number, number]> = [[24.02, 49.79], [24.07, 49.79], [24.07, 49.85], [24.02, 49.85], [24.02, 49.79]];
  const snapshot = { geofences: [allowingZone('allow', coveringRing)], globalRules: [globalRule(false)] };
  assert.equal(rideThroughForbiddenOnSegment(snapshot, PICKUP, DROPOFF, 'scooter'), false);
});

test('leaving an allowing zone into a global no-ride-through ban is forbidden mid-segment', () => {
  const pickupOnlyRing: Array<[number, number]> = [[24.02, 49.83], [24.04, 49.83], [24.04, 49.85], [24.02, 49.85], [24.02, 49.83]];
  const snapshot = { geofences: [allowingZone('allow-pickup', pickupOnlyRing)], globalRules: [globalRule(false)] };
  assert.equal(rideThroughForbiddenOnSegment(snapshot, PICKUP, DROPOFF, 'scooter'), true);
});

test('a permissive global rule keeps the ride, and a global ban stays scoped to its vehicle types', () => {
  const permissive = { geofences: [], globalRules: [globalRule(true)] };
  assert.equal(rideThroughForbiddenOnSegment(permissive, PICKUP, DROPOFF, 'scooter'), false);
  const typed = { geofences: [], globalRules: [globalRule(false, ['e-scooter'])] };
  assert.equal(rideThroughForbiddenOnSegment(typed, PICKUP, DROPOFF, 'e-scooter'), true);
  assert.equal(rideThroughForbiddenOnSegment(typed, PICKUP, DROPOFF, 'e-bike'), false);
});

test('a city bike graph answers only for rides with both ends inside its bbox', () => {
  const previous = { urls: process.env.BIKING_ROUTING_URLS, url: process.env.BIKING_ROUTING_URL };
  try {
    delete process.env.BIKING_ROUTING_URL;
    process.env.BIKING_ROUTING_URLS = JSON.stringify([
      { bbox: [23.93, 49.75, 24.17, 49.96], url: 'http://127.0.0.1:3015' },
      { bbox: [30.2, 50.2, 30.85, 50.6], url: 'http://127.0.0.1:3016/route/v1' },
    ]);
    assert.equal(bicycleEndpointFor(PICKUP, DROPOFF), 'http://127.0.0.1:3015/route/v1/bike');
    assert.equal(bicycleEndpointFor([30.52, 50.45], [30.51, 50.44]), 'http://127.0.0.1:3016/route/v1/bike');
    assert.equal(bicycleEndpointFor(PICKUP, [30.51, 50.44]), undefined);
    assert.equal(bicycleEndpointFor([24.71, 48.92], [24.72, 48.91]), undefined);
  } finally {
    if (previous.urls === undefined) delete process.env.BIKING_ROUTING_URLS; else process.env.BIKING_ROUTING_URLS = previous.urls;
    if (previous.url !== undefined) process.env.BIKING_ROUTING_URL = previous.url;
  }
});
