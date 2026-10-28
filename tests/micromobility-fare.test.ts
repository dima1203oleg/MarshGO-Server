import assert from 'node:assert/strict';
import test from 'node:test';
import { micromobilityJourneyFareMinor } from '../server/journey/micromobilityFare';
import { selectStrategyAlternatives, strategiesWithComparablePrices } from '../server/journey/scoring';
import type { JourneyOption } from '../server/journey/types';

test('micromobility + transit is excluded from CHEAPEST until both fares are known', () => {
  const partialTransitFare = micromobilityJourneyFareMinor(3_000, null);
  assert.equal(partialTransitFare, null);

  const journeys: JourneyOption[] = [
    { id: 'bike+metro', priceMinor: partialTransitFare, durationSeconds: 1_800,
      transfers: 1, walkingMeters: 250, reliability: null, transferRisk: 0.4, comfort: null,
      legs: [{ mode: 'BICYCLE' }, { mode: 'METRO' }] },
    { id: 'known-bus', priceMinor: 4_000, durationSeconds: 2_400,
      transfers: 0, walkingMeters: 100, reliability: null, transferRisk: 0, comfort: null,
      legs: [{ mode: 'BUS' }] },
  ];

  const availableStrategies = strategiesWithComparablePrices(journeys, ['CHEAPEST']);
  assert.deepEqual(availableStrategies, [], 'CHEAPEST must be unavailable while any candidate has an unknown total fare');
  assert.deepEqual(selectStrategyAlternatives(journeys, availableStrategies), []);

  const fullyPricedJourneys = journeys.map((journey) => journey.id === 'bike+metro'
    ? { ...journey, priceMinor: 4_500 }
    : journey);
  const fullyPricedStrategies = strategiesWithComparablePrices(fullyPricedJourneys, ['CHEAPEST']);
  assert.deepEqual(fullyPricedStrategies, ['CHEAPEST']);
  const cheapest = selectStrategyAlternatives(fullyPricedJourneys, fullyPricedStrategies);
  assert.equal(cheapest[0]?.journey.id, 'known-bus');
});

test('a micromobility journey fare is comparable only when both component fares are valid', () => {
  assert.equal(micromobilityJourneyFareMinor(3_000, 1_500), 4_500);
  assert.equal(micromobilityJourneyFareMinor(null, 1_500), null);
  assert.equal(micromobilityJourneyFareMinor(3_000, -1), null);
  assert.equal(micromobilityJourneyFareMinor(Number.MAX_SAFE_INTEGER, 1), null);
});
