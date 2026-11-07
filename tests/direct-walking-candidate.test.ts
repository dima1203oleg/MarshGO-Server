import assert from 'node:assert/strict';
import test from 'node:test';
import { createDirectWalkingCandidate, directWalkingGeometryConnectsEndpoints } from '../server/journey/directWalkingCandidate';
import { scoreJourneys } from '../server/journey/scoring';

const origin: [number, number] = [24.0315, 49.8419];
const destination: [number, number] = [24.0323, 49.8419];
const path = { distanceMeters: 72, durationSeconds: 58, geometry: [origin, destination] as Array<[number, number]> };

test('builds a priced-as-free candidate from measured route geometry', () => {
  const result = createDirectWalkingCandidate({ id: 'walk:nearby', path, origin, destination });
  assert.ok(result);
  assert.equal(result.kind, 'walking');
  assert.equal(result.priceMinor, 0);
  assert.equal(result.durationSeconds, 58);
  assert.equal(result.walkingMeters, 72);
  assert.deepEqual(result.legs, [{ mode: 'WALK' }]);
});

test('rejects a measured route beyond the user walking or duration limits', () => {
  assert.equal(createDirectWalkingCandidate({ id: 'walk:far', path, origin, destination, maximumWalkingMeters: 50 }), null);
  assert.equal(createDirectWalkingCandidate({ id: 'walk:slow', path, origin, destination, maximumDurationSeconds: 30 }), null);
});

test('rejects malformed or absent route geometry instead of fabricating a straight line', () => {
  assert.equal(createDirectWalkingCandidate({ id: 'walk:no-geometry', path: { ...path, geometry: [] }, origin, destination }), null);
  assert.equal(createDirectWalkingCandidate({ id: 'walk:invalid', path: { ...path, distanceMeters: Number.NaN }, origin, destination }), null);
});

test('rejects OSRM geometry whose snapped endpoints do not reach the requested places', () => {
  const snappedPath = {
    distanceMeters: 20,
    durationSeconds: 14,
    geometry: [[24.032136, 49.842068], [24.03222, 49.8419]] as Array<[number, number]>,
  };
  const requestedOrigin: [number, number] = [24.0315921, 49.841952];
  const requestedDestination: [number, number] = [24.0323731, 49.8419316];
  assert.equal(directWalkingGeometryConnectsEndpoints({ path: snappedPath, origin: requestedOrigin, destination: requestedDestination }), false);
  assert.equal(createDirectWalkingCandidate({ id: 'walk:snapped-away', path: snappedPath, origin: requestedOrigin, destination: requestedDestination }), null);
});

test('rejects an impossible measured distance shorter than the geometry chord', () => {
  assert.equal(createDirectWalkingCandidate({ id: 'walk:impossible', path: { ...path, distanceMeters: 10 }, origin, destination }), null);
});

test('rejects a looping geometry whose polyline is longer than the measured distance', () => {
  const loopingPath = {
    distanceMeters: 60,
    durationSeconds: 48,
    geometry: [origin, [24.0323, 49.8422], destination] as Array<[number, number]>,
  };
  assert.equal(createDirectWalkingCandidate({ id: 'walk:loop-distance-mismatch', path: loopingPath, origin, destination }), null);
});

test('ranks the measured short walk above a longer paid tram detour for balanced, fastest, and cheapest', () => {
  const walking = createDirectWalkingCandidate({ id: 'walk:nearby', path, origin, destination });
  assert.ok(walking);
  const tram = {
    id: 'tram:detour', durationSeconds: 7 * 60, priceMinor: 3000, transfers: 0, walkingMeters: 358,
    reliability: null, transferRisk: 0, comfort: null,
    legs: [{ mode: 'WALK' as const }, { mode: 'TRAM' as const }, { mode: 'WALK' as const }],
  };
  for (const strategy of ['BALANCED', 'FASTEST', 'CHEAPEST'] as const) {
    assert.equal(scoreJourneys([walking, tram], strategy)[0]?.journey.id, walking.id, `${strategy} should select the direct foot route`);
  }
});
