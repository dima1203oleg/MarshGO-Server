import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBicycleRouteEstimates, roadRouteMicromobilityEstimate,
  type MicromobilityRouteEstimate, type RentalRouteNetwork, type RentalRoutePoint,
} from '../server/journey/micromobilityEstimates';
import { bicycleEndpointFor } from '../server/journey/bicycleRoutes';
import { trustedRouteGeometry } from '../server/journey/legGeometryProvenance';

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
