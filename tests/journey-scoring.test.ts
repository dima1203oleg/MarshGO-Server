import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreJourneys, selectRepresentativeJourneys, strategiesWithComparablePrices } from '../server/journey/scoring';
import type { JourneyOption } from '../server/journey/types';

const candidates: JourneyOption[] = [
  { id: 'bus', durationSeconds: 6600, priceMinor: 12000, transfers: 0, walkingMeters: 200, reliability: 0.82, transferRisk: 0, comfort: 0.6, legs: [{ mode: 'BUS' }] },
  { id: 'community', durationSeconds: 5100, priceMinor: 25000, transfers: 0, walkingMeters: 0, reliability: 0.91, transferRisk: 0, comfort: 0.8, legs: [{ mode: 'COMMUNITY' }] },
  { id: 'community-taxi', durationSeconds: 3900, priceMinor: 42000, transfers: 1, walkingMeters: 300, reliability: 0.88, transferRisk: 0.12, comfort: 0.95, legs: [{ mode: 'COMMUNITY' }, { mode: 'TAXI' }] },
];

describe('Journey strategy scoring', () => {
  it('ranks door-to-door FASTEST and CHEAPEST alternatives by their strategy', () => {
    assert.equal(scoreJourneys(candidates, 'FASTEST')[0].journey.id, 'community-taxi');
    assert.equal(scoreJourneys(candidates, 'CHEAPEST')[0].journey.id, 'bus');
  });

  it('keeps FASTEST and CHEAPEST strict across direct and chained alternatives', () => {
    const chain: JourneyOption = { id: 'bus-transfer-rail', durationSeconds: 5400, priceMinor: 18000, transfers: 1, walkingMeters: 250, reliability: null, transferRisk: 0.3, comfort: null, legs: [{ mode: 'BUS' }, { mode: 'RAIL' }] };
    const cheapestSlow: JourneyOption = { ...candidates[0], id: 'cheapest-slow', durationSeconds: 12000, priceMinor: 7000 };
    const fastestExpensive: JourneyOption = { ...candidates[1], id: 'fastest-expensive', durationSeconds: 3000, priceMinor: 45000 };
    const unknownFare: JourneyOption = { ...chain, id: 'unknown-fare', durationSeconds: 3600, priceMinor: null };
    assert.equal(scoreJourneys([chain, cheapestSlow, fastestExpensive, unknownFare], 'CHEAPEST')[0].journey.id, 'cheapest-slow');
    assert.equal(scoreJourneys([chain, cheapestSlow, fastestExpensive, unknownFare], 'FASTEST')[0].journey.id, 'fastest-expensive');
    assert.ok(scoreJourneys([chain, cheapestSlow, fastestExpensive, unknownFare], 'CHEAPEST').at(-1)?.journey.priceMinor === null);
  });

  it('does not label a route CHEAPEST while any compared provider fare is unknown', () => {
    const unknownFare: JourneyOption = { ...candidates[0], id: 'unknown-fare', priceMinor: null };
    assert.ok(strategiesWithComparablePrices(candidates, ['CHEAPEST', 'FASTEST']).includes('CHEAPEST'));
    assert.deepEqual(strategiesWithComparablePrices([...candidates, unknownFare], ['CHEAPEST', 'FASTEST']), ['FASTEST']);
  });

  it('selects representative alternatives and suppresses near-identical routes', () => {
    const similar: JourneyOption = { ...candidates[2], id: 'community-taxi-similar', durationSeconds: 3980, priceMinor: 43000 };
    const selected = selectRepresentativeJourneys([...candidates, similar]);
    assert.equal(new Set(selected.map((item) => item.journey.id)).size, selected.length);
    assert.ok(selected.some((item) => item.journey.id === 'community-taxi'));
  });

  it('penalizes fragile connections for the RELIABLE strategy', () => {
    const tightConnection: JourneyOption = { ...candidates[0], id: 'tight', durationSeconds: 6000, priceMinor: 10000, reliability: 0.9, transferRisk: 1 };
    const bufferedConnection: JourneyOption = { ...candidates[1], id: 'buffered', durationSeconds: 7200, priceMinor: 30000, reliability: 0.95, transferRisk: 0.05 };
    assert.equal(scoreJourneys([tightConnection, bufferedConnection], 'RELIABLE')[0].journey.id, 'buffered');
  });

  it('rejects incomplete or invalid option measurements instead of inventing values', () => {
    assert.throws(() => scoreJourneys([{ ...candidates[0], reliability: 1.2 }], 'RELIABLE'), /invalid scoring features/);
    assert.throws(() => scoreJourneys([{ ...candidates[0], priceMinor: -1 }], 'CHEAPEST'), /invalid scoring features/);
  });
});
