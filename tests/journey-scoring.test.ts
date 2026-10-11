import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_SCORE_WEIGHTS, paretoFrontier, scoreJourneys, selectRepresentativeJourneys, selectStrategyRecommendations, strategiesWithComparablePrices } from '../server/journey/scoring';
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

  it('uses the documented normalized weights for the default balanced mode', () => {
    assert.deepEqual(JOURNEY_SCORE_WEIGHTS.BALANCED, {
      time: 0.35, price: 0.25, transfers: 0.10, walking: 0.10, risk: 0.20, comfort: 0,
    });
  });

  it('keeps the Pareto frontier and never treats an unknown fare as zero', () => {
    const fast = { ...candidates[2], id: 'fast' };
    const cheap = { ...candidates[0], id: 'cheap' };
    const dominated = { ...candidates[0], id: 'dominated', durationSeconds: 7000, priceMinor: 13000, transfers: 1, walkingMeters: 400 };
    const unknown = { ...candidates[0], id: 'unknown', priceMinor: null };
    const frontier = paretoFrontier([fast, cheap, dominated, unknown]);
    assert.deepEqual(frontier.map((journey) => journey.id).sort(), ['cheap', 'fast', 'unknown']);
  });

  it('exposes one winner per strategy and groups an identical winner across tabs', () => {
    const recommendations = selectStrategyRecommendations([candidates[0]], ['BALANCED', 'FASTEST', 'CHEAPEST']);
    assert.equal(recommendations.length, 1);
    assert.deepEqual(recommendations[0].recommendedStrategies, ['BALANCED', 'FASTEST', 'CHEAPEST']);
  });

  it('keeps distinct winners for distinct strategies', () => {
    const recommendations = selectStrategyRecommendations(candidates, ['BALANCED', 'FASTEST', 'CHEAPEST']);
    assert.equal(recommendations.length, 3);
    assert.equal(recommendations.find((item) => item.strategy === 'FASTEST')?.journey.id, 'community-taxi');
    assert.equal(recommendations.find((item) => item.strategy === 'CHEAPEST')?.journey.id, 'bus');
  });

  it('does not merge distinct close routes under an inaccurate strategy label', () => {
    const faster = { ...candidates[0], id: 'same-bus-fast', durationSeconds: 4000, priceMinor: 10000, legs: [{ mode: 'BUS' as const }] };
    const cheaper = { ...faster, id: 'same-bus-cheap', durationSeconds: 4100, priceMinor: 9600 };
    const recommendations = selectStrategyRecommendations([faster, cheaper], ['FASTEST', 'CHEAPEST']);
    assert.equal(recommendations.length, 2);
    assert.equal(recommendations.find((item) => item.strategy === 'FASTEST')?.journey.id, 'same-bus-fast');
    assert.equal(recommendations.find((item) => item.strategy === 'CHEAPEST')?.journey.id, 'same-bus-cheap');
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

  it('keeps distinct close FASTEST and CHEAPEST winners under their correct labels', () => {
    const faster = { ...candidates[0], id: 'same-bus-fast', durationSeconds: 4000, priceMinor: 10000, legs: [{ mode: 'BUS' as const }] };
    const cheaper = { ...faster, id: 'same-bus-cheap', durationSeconds: 4100, priceMinor: 9600 };
    const recommendations = selectRepresentativeJourneys([faster, cheaper], ['FASTEST', 'CHEAPEST']);

    assert.equal(recommendations.length, 2);
    assert.equal(recommendations.find((item) => item.strategy === 'FASTEST')?.journey.id, 'same-bus-fast');
    assert.equal(recommendations.find((item) => item.strategy === 'CHEAPEST')?.journey.id, 'same-bus-cheap');
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
