import assert from 'node:assert/strict';
import test from 'node:test';
import { routeMultimodalWalks } from '../server/journey/multimodalWalkRouter';
import type { MultimodalJourney } from '../server/journey/multimodalChainEngine';

const start = new Date('2026-11-13T08:00:00.000Z');
const origin: [number, number] = [24.0315, 49.8419];
const stop: [number, number] = [24.0395, 49.8419];
const destination: [number, number] = [24.048, 49.8419];
const finish: [number, number] = [24.0565, 49.8419];

function createJourney(): MultimodalJourney {
  return {
    id: 'chain-1', strategy: 'BALANCED', score: 100, state: 'PLANNED', source: 'test-feed',
    totalDurationSeconds: 3_900, totalPriceMinor: 3_000, confirmedPriceMinor: 3_000,
    estimatedPriceMinMinor: 3_000, estimatedPriceMaxMinor: 3_000, walkingMeters: 160,
    transfers: 0, reliabilityScore: null, comfortScore: null,
    legs: [
      { ordinal: 0, mode: 'WALK', origin: { name: 'A', coordinates: origin }, destination: { name: 'B', coordinates: stop },
        departureAt: start, arrivalAt: new Date(start.getTime() + 160_000), durationSeconds: 160, distanceMeters: 80,
        walkingDistanceMeters: 80, priceMinor: 0, currency: 'UAH', priceStatus: 'LOCKED', availabilityStatus: 'AVAILABLE',
        providerType: 'walking', state: 'SUGGESTED', source: 'walking', routeGeometry: [origin, stop] },
      { ordinal: 1, mode: 'BUS', origin: { name: 'B', coordinates: stop }, destination: { name: 'C', coordinates: destination },
        departureAt: new Date(start.getTime() + 600_000), arrivalAt: new Date(start.getTime() + 2_400_000), durationSeconds: 1_800,
        distanceMeters: 4_000, priceMinor: 3_000, currency: 'UAH', priceStatus: 'LOCKED', availabilityStatus: 'AVAILABLE',
        providerType: 'public_transit', state: 'SUGGESTED', source: 'test-feed' },
      { ordinal: 2, mode: 'WALK', origin: { name: 'C', coordinates: destination }, destination: { name: 'D', coordinates: finish },
        departureAt: new Date(start.getTime() + 2_700_000), arrivalAt: new Date(start.getTime() + 2_860_000), durationSeconds: 160,
        distanceMeters: 80, walkingDistanceMeters: 80, priceMinor: 0, currency: 'UAH', priceStatus: 'LOCKED', availabilityStatus: 'AVAILABLE',
        providerType: 'walking', state: 'SUGGESTED', source: 'walking', routeGeometry: [destination, destination] },
    ],
  };
}

function options(overrides: Partial<Parameters<typeof routeMultimodalWalks>[1]> = {}) {
  return {
    departureAt: start,
    budget: { limit: 8, remaining: 8, exhausted: false, spent: 0 },
    resolveEndpoint: () => 'http://foot-router.test/route/v1/foot',
    route: async (from: [number, number], to: [number, number]) => ({
      distanceMeters: 700,
      durationSeconds: 300,
      geometry: [from, to],
    }),
    ...overrides,
  };
}

test('replaces diagrammatic walks with routed geometry and recalculates walking metrics', async () => {
  const original = createJourney();
  const result = await routeMultimodalWalks(original, options());
  assert.ok(result.journey);
  assert.equal(result.rejected, null);
  assert.equal(result.journey.walkingMeters, 1_400);
  assert.equal(result.journey.totalDurationSeconds, 3_000);
  assert.equal(result.journey.legs[0]?.source, 'osrm-foot-route');
  assert.equal(result.journey.legs[0]?.metadata?.routeAccuracy, 'SOURCE_GEOMETRY');
  assert.deepEqual(result.journey.legs[0]?.routeGeometry, [origin, stop]);
  assert.equal(original.legs[0]?.source, 'walking', 'the input candidate must not be mutated');
});

test('rejects candidates with a missing foot-router endpoint or unavailable path', async () => {
  const missing = await routeMultimodalWalks(createJourney(), options({ resolveEndpoint: () => null }));
  assert.equal(missing.rejected, 'missing_endpoint');
  const unavailable = await routeMultimodalWalks(createJourney(), options({ route: async () => null }));
  assert.equal(unavailable.rejected, 'route_unavailable');
});

test('rejects geometry that does not connect the requested walk endpoints', async () => {
  const result = await routeMultimodalWalks(createJourney(), options({
    route: async () => ({ distanceMeters: 900, durationSeconds: 300, geometry: [[24.04, 49.85], [24.05, 49.86]] }),
  }));
  assert.equal(result.rejected, 'invalid_geometry');
});

test('rejects out-of-range route coordinates even when the reported path is long enough', async () => {
  const result = await routeMultimodalWalks(createJourney(), options({
    route: async (from, to) => ({ distanceMeters: 20_000_000, durationSeconds: 900,
      geometry: [from, [24.04, 91], to] }),
  }));
  assert.equal(result.rejected, 'invalid_geometry');
});

test('rejects routed walks that miss the next scheduled departure', async () => {
  const journey = createJourney();
  const result = await routeMultimodalWalks(journey, options({
    route: async (from, to) => ({ distanceMeters: 900, durationSeconds: 900, geometry: [from, to] }),
  }));
  assert.equal(result.rejected, 'missed_connection');
});

test('rejects a same-point synthetic station transfer rather than drawing a false walk', async () => {
  const journey = createJourney();
  journey.legs[2]!.origin = { name: 'C', coordinates: stop };
  journey.legs[2]!.destination = { name: 'C', coordinates: stop };
  const result = await routeMultimodalWalks(journey, options({
    route: async (from) => ({ distanceMeters: 200, durationSeconds: 300, geometry: [from] }),
  }));
  assert.equal(result.rejected, 'invalid_geometry');
});

test('reapplies walking and total-duration preferences after routing', async () => {
  const tooMuchWalking = await routeMultimodalWalks(createJourney(), options({ maximumWalkingMeters: 1_000 }));
  assert.equal(tooMuchWalking.rejected, 'walking_preference');
  const tooSlow = await routeMultimodalWalks(createJourney(), options({ maximumDurationSeconds: 2_500 }));
  assert.equal(tooSlow.rejected, 'duration_preference');
});
