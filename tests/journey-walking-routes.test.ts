import assert from 'node:assert/strict';
import test from 'node:test';
import type { GtfsItinerary } from '../server/journey/gtfsTimetable';
import { applyRoutedWalkingPaths, routePedestrianPath, type WalkingRoutePath } from '../server/journey/walkingRoutes';

const start = Date.parse('2026-10-01T08:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000);
const path = (distanceMeters: number, durationSeconds: number): WalkingRoutePath => ({
  distanceMeters, durationSeconds, geometry: [[24, 49], [24.01, 49.01]],
});

function itinerary(): GtfsItinerary {
  return {
    id: 'trip-1|trip-2', providerId: 'provider', providerName: 'Fixture',
    departureAt: at(0), arrivalAt: at(3240), durationSeconds: 3240, waitingSeconds: 420,
    transfers: 1, walkingMeters: 650,
    transferWalkingMeters: [250], transferWalkingSeconds: [200], transferWalkingGeometries: [null],
    transferInSeat: [false], transferMinimumBufferSeconds: [180], transferRuleMinimumSeconds: [null],
    fare: null,
    segments: [
      {
        departureAt: at(600), arrivalAt: at(1800),
        originStop: { coordinates: [24, 49] }, destinationStop: { coordinates: [24.01, 49] },
        distanceToOriginStopMeters: 100, distanceFromDestinationStopMeters: 0,
      },
      {
        departureAt: at(2400), arrivalAt: at(3000),
        originStop: { coordinates: [24.02, 49] }, destinationStop: { coordinates: [24.03, 49] },
        distanceToOriginStopMeters: 0, distanceFromDestinationStopMeters: 300,
      },
    ],
  } as unknown as GtfsItinerary;
}

const limits = { maximumAccessMeters: 800, maximumEgressMeters: 800, maximumTransferMeters: 800 };

test('replaces straight-line walking with routed distance, geometry, time, and waiting', () => {
  const routed = applyRoutedWalkingPaths(itinerary(), {
    access: path(500, 480), egress: path(600, 500), transfers: [path(350, 240)],
  }, limits);

  assert.ok(routed);
  assert.equal(routed.walkingRoutesVerified, true);
  assert.equal(routed.walkingMeters, 1450);
  assert.equal(routed.durationSeconds, 3500);
  assert.deepEqual(routed.transferWalkingMeters, [350]);
  assert.deepEqual(routed.transferWalkingGeometries[0], path(350, 240).geometry);
  assert.equal(routed.waitingSeconds, 480);
});

test('rejects a connection when the routed walking time makes its transfer impossible', () => {
  const routed = applyRoutedWalkingPaths(itinerary(), {
    access: path(200, 120), egress: path(200, 120), transfers: [path(500, 480)],
  }, limits);
  assert.equal(routed, null);
});

test('rejects a route when routed access cannot reach the scheduled departure or exceeds the walk shed', () => {
  const tooLate = applyRoutedWalkingPaths(itinerary(), {
    access: path(400, 700), egress: path(100, 90), transfers: [path(100, 90)],
  }, limits);
  assert.equal(tooLate, null);

  const beyondWalkShed = applyRoutedWalkingPaths(itinerary(), {
    access: path(801, 500), egress: path(100, 90), transfers: [path(100, 90)],
  }, limits);
  assert.equal(beyondWalkShed, null);
});

test('does not fabricate a route when the pedestrian provider is unconfigured', async () => {
  assert.equal(await routePedestrianPath([24, 49], [24.01, 49.01], ''), null);
});

test('uses the configured OSRM foot profile and preserves its routed geometry', async (t) => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      code: 'Ok',
      routes: [{ distance: 1480.2, duration: 500.1, geometry: { coordinates: [[24, 49], [24.01, 49.01]] }, legs: [] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const routed = await routePedestrianPath([24, 49], [24.01, 49.01], 'https://walking.example/route/v1/foot');
  assert.match(requestedUrl, /\/route\/v1\/foot\//);
  assert.deepEqual(routed, {
    distanceMeters: 1481, durationSeconds: 501, geometry: [[24, 49], [24.01, 49.01]],
  });
});
