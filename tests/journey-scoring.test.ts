import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_SCORE_WEIGHTS, MIN_COMPARABLE_ALTERNATIVES, paretoFrontier, scoreJourneys, selectRepresentativeJourneys, selectStrategyAlternatives, selectStrategyRecommendations, strategiesWithComparablePrices, TRANSFER_TIME_PENALTY_SECONDS } from '../server/journey/scoring';
import type { JourneyLegMode, JourneyOption, JourneyStrategy } from '../server/journey/types';

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

  it('uses locale-independent IDs to break equal-score ties regardless of input order', () => {
    const tied = ['Z', 'a', 'Б', 'А', '10', '2'].map((id) => ({ ...candidates[0]!, id }));
    const forward = scoreJourneys(tied, 'BALANCED').map(({ journey }) => journey.id);
    const reversed = scoreJourneys([...tied].reverse(), 'BALANCED').map(({ journey }) => journey.id);
    assert.deepEqual(forward, ['10', '2', 'Z', 'a', 'А', 'Б']);
    assert.deepEqual(reversed, forward);
  });

  it('uses the documented normalized weights for the default balanced mode', () => {
    assert.deepEqual(JOURNEY_SCORE_WEIGHTS.BALANCED, {
      time: 0.48, price: 0.22, transfers: 0.08, walking: 0.08, risk: 0.14, comfort: 0,
    });
  });

  it('applies an 8-minute perceived-time transfer penalty only to composite ranking, not the factual FASTEST winner', () => {
    const direct: JourneyOption = { ...candidates[0]!, id: 'direct', durationSeconds: 3_000, priceMinor: 10_000, transfers: 0 };
    const connection: JourneyOption = { ...candidates[0]!, id: 'one-transfer', durationSeconds: 2_700, priceMinor: 10_000, transfers: 1 };
    const timeOnly = { time: 1, price: 0, transfers: 0, walking: 0, risk: 0, comfort: 0 };

    assert.equal(TRANSFER_TIME_PENALTY_SECONDS, 480);
    assert.equal(scoreJourneys([direct, connection], 'BALANCED', timeOnly)[0]?.journey.id, 'direct',
      'a 5-minute actual saving does not outweigh the fixed 8-minute transfer effort in a composite strategy');
    assert.equal(scoreJourneys([direct, connection], 'FASTEST', timeOnly)[0]?.journey.id, 'one-transfer',
      'FASTEST remains strictly ordered by real duration');
  });

  it('keeps the Pareto frontier and never treats an unknown fare as zero', () => {
    const fast = { ...candidates[2], id: 'fast' };
    const cheap = { ...candidates[0], id: 'cheap' };
    const dominated = { ...candidates[0], id: 'dominated', durationSeconds: 7000, priceMinor: 13000, transfers: 1, walkingMeters: 400 };
    const unknown = { ...candidates[0], id: 'unknown', priceMinor: null };
    const frontier = paretoFrontier([fast, cheap, dominated, unknown]);
    assert.deepEqual(frontier.map((journey) => journey.id).sort(), ['cheap', 'fast', 'unknown']);
  });

  it('keeps a slower, more comfortable option for PREMIUM ranking', () => {
    const standard = {
      ...candidates[1], id: 'standard', durationSeconds: 3000, priceMinor: 15000,
      transfers: 0, walkingMeters: 0, reliability: 0.95, transferRisk: 0, comfort: 0.2,
    };
    const premium = {
      ...standard, id: 'premium', durationSeconds: 3300, priceMinor: 18000, comfort: 0.99,
    };

    assert.deepEqual(paretoFrontier([standard, premium]).map((journey) => journey.id).sort(), ['premium', 'standard']);
    assert.equal(scoreJourneys(paretoFrontier([standard, premium]), 'PREMIUM')[0].journey.id, 'premium');
  });

  it('keeps measured and unknown comfort incomparable in the Pareto frontier', () => {
    const unknown = { ...candidates[0], id: 'unknown-comfort', comfort: null };
    const measured = { ...candidates[0], id: 'measured-comfort', comfort: 0.1 };
    assert.deepEqual(paretoFrontier([unknown, measured]).map((journey) => journey.id).sort(), ['measured-comfort', 'unknown-comfort']);
  });

  it('exposes one winner per strategy and groups an identical winner across tabs', () => {
    const recommendations = selectStrategyRecommendations([candidates[0]], ['BALANCED', 'FASTEST', 'CHEAPEST']);
    assert.equal(recommendations.length, 1);
    assert.deepEqual(recommendations[0].recommendedStrategies, ['BALANCED', 'FASTEST', 'CHEAPEST']);
  });

  it('returns a bounded union of ranked alternatives and records each strategy rank', () => {
    const alternatives: JourneyOption[] = [
      { ...candidates[0], id: 'balanced-choice', durationSeconds: 6000, priceMinor: 12000, transfers: 0, walkingMeters: 200 },
      { ...candidates[1], id: 'fast-choice', durationSeconds: 3000, priceMinor: 40000, transfers: 0, walkingMeters: 100 },
      { ...candidates[0], id: 'cheap-choice', durationSeconds: 12000, priceMinor: 3000, transfers: 1, walkingMeters: 700 },
      { ...candidates[0], id: 'dominated-choice', durationSeconds: 13000, priceMinor: 4000, transfers: 2, walkingMeters: 900 },
    ];
    const selected = selectStrategyAlternatives(alternatives, ['BALANCED', 'FASTEST', 'CHEAPEST'], 2);
    assert.ok(selected.length >= 3);
    assert.equal(selected.some((item) => item.journey.id === 'dominated-choice'), false);
    for (const recommendation of selected) {
      assert.ok(recommendation.recommendedStrategies.length > 0);
      for (const strategy of recommendation.recommendedStrategies) {
        assert.ok(Number.isInteger(recommendation.strategyRanks?.[strategy]));
        assert.ok((recommendation.strategyRanks?.[strategy] ?? 0) <= 2);
      }
    }
  });

  it('rejects unbounded result limits', () => {
    assert.throws(() => selectStrategyAlternatives(candidates, ['FASTEST'], 51), /between 1 and 50/);
  });

  it('limits repeated scheduled runs from the same transport chain', () => {
    const sameChain: JourneyOption[] = Array.from({ length: 6 }, (_, index) => ({
      ...candidates[0], id: `bus-run-${index}`, diversityKey: 'transit:bus>tram',
      durationSeconds: 3000 + index * 600, priceMinor: 18000 - index * 1000,
    }));
    const selected = selectStrategyAlternatives(sameChain, ['BALANCED'], 12);
    assert.equal(selected.length, 3);
    assert.equal(new Set(selected.map((item) => item.journey.diversityKey)).size, 1);
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

  it('keeps CHEAPEST available for comparable fares and excludes candidates with unknown fares', () => {
    const unknownFare: JourneyOption = { ...candidates[0], id: 'unknown-fare', priceMinor: null };
    assert.ok(strategiesWithComparablePrices(candidates, ['CHEAPEST', 'FASTEST']).includes('CHEAPEST'));
    assert.deepEqual(strategiesWithComparablePrices([...candidates, unknownFare], ['CHEAPEST', 'FASTEST']), ['CHEAPEST', 'FASTEST']);
    assert.deepEqual(strategiesWithComparablePrices([unknownFare], ['CHEAPEST', 'FASTEST']), ['FASTEST']);
    const selected = selectStrategyAlternatives([candidates[0]!, unknownFare], ['CHEAPEST'], 12);
    assert.ok(selected.length > 0);
    assert.ok(selected.every(({ journey }) => journey.priceMinor !== null));
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

// PARETO-YIELD-1: a live Lviv search returned one card from 80 validated candidates. The diagnostic dump showed
// all 80 leaving at the same requested instant and differing only in route chain and stop-approach footpath, so
// the direct bus beat every transfer chain on duration, fare, transfers and walk at once and the frontier was a
// set of one. These fixtures are synthetic; the metric values and the chain shape are the measured ones.
describe('a thin frontier still gives the passenger something to compare', () => {
  const leg = (mode: JourneyLegMode, providerId: string | null = null) => ({ mode, ...(providerId ? { providerId } : {}) });
  const tramLegs: JourneyOption['legs'] = [leg('WALK', null), leg('TRAM', 'lviv'), leg('WALK', null), leg('BUS', 'lviv'), leg('WALK', null)];
  const trolleyLegs: JourneyOption['legs'] = [leg('WALK', null), leg('TROLLEYBUS', 'lviv'), leg('WALK', null), leg('BUS', 'lviv'), leg('WALK', null)];
  const on = (id: string, diversityKey: string, legs: JourneyOption['legs'] = trolleyLegs, over: Partial<JourneyOption> = {}): JourneyOption => ({
    id, durationSeconds: 3_232, priceMinor: 2_300, transfers: 0, walkingMeters: 1_867,
    reliability: null, transferRisk: 0, comfort: null, diversityKey, legs, ...over,
  });
  // One departure instant, four route chains, and three footpath copies of the direct bus.
  const corridor: JourneyOption[] = [
    on('bus-102', 'transit:lviv:102', trolleyLegs),
    on('bus-102-far-stop', 'transit:lviv:102', trolleyLegs, { walkingMeters: 2_063 }),
    on('bus-102-farther-stop', 'transit:lviv:102', trolleyLegs, { walkingMeters: 2_466 }),
    on('tram-then-bus', 'transit:lviv:1006>transit:lviv:119', tramLegs, { durationSeconds: 3_772, transfers: 1, walkingMeters: 2_055 }),
    on('tram-then-bus-near', 'transit:lviv:1006>transit:lviv:119', tramLegs, { durationSeconds: 3_772, transfers: 1, walkingMeters: 1_973 }),
    on('trolley-then-bus', 'transit:lviv:97>transit:lviv:102', trolleyLegs, { transfers: 1 }),
    on('marshrutka-then-bus', 'transit:lviv:2300>transit:lviv:119', tramLegs, { durationSeconds: 3_772, transfers: 1, walkingMeters: 2_458 }),
  ];
  const strategies: JourneyStrategy[] = ['FASTEST', 'CHEAPEST', 'BALANCED', 'PREMIUM', 'RELIABLE'];

  it('reproduces the measured collapse before asserting the fix', () => {
    assert.deepEqual(paretoFrontier(corridor).map((journey) => journey.id), ['bus-102']);
  });

  it('backfills other route chains so the list can be compared and selected', () => {
    const selected = selectStrategyAlternatives(corridor, strategies);
    assert.ok(selected.length >= MIN_COMPARABLE_ALTERNATIVES, `expected ${MIN_COMPARABLE_ALTERNATIVES} cards, got ${selected.length}`);
    assert.equal(new Set(selected.map(({ journey }) => journey.id)).size, selected.length, 'no candidate listed twice');
    assert.equal(selected.filter(({ journey }) => journey.id === 'bus-102').length, 1);
    assert.ok(selected.some(({ journey }) => journey.id === 'trolley-then-bus'), 'the second line is offered');
    assert.ok(selected.some(({ journey }) => journey.id === 'tram-then-bus-near'), 'a line is represented by its quickest ride, not by a worse copy');
  });

  it('keeps the non-dominated journey as the factual FASTEST and CHEAPEST winner', () => {
    const selected = selectStrategyAlternatives(corridor, strategies);
    const winner = selected.find(({ journey }) => journey.id === 'bus-102');
    for (const strategy of ['FASTEST', 'CHEAPEST'] as const) {
      assert.equal(winner?.strategyRanks?.[strategy], 1, `${strategy} must stay a measurable promise`);
    }
    assert.ok(selected.every((item) => item.strategyRanks?.FASTEST !== 1 || item.journey.id === 'bus-102'));
  });

  it('still prices an unknown fare as unknown rather than as the cheapest backfill', () => {
    const noFare = corridor.map((journey) => ({ ...journey, priceMinor: journey.id === 'marshrutka-then-bus' ? null : journey.priceMinor }));
    const cheapest = selectStrategyAlternatives(noFare, ['CHEAPEST']);
    assert.ok(cheapest.length > 0);
    assert.ok(cheapest.every(({ journey }) => journey.priceMinor !== null), 'an unknown fare is not a zero fare');
  });

  it('collapses footpath copies of one line instead of filling the list with them', () => {
    const selected = selectStrategyAlternatives(corridor, ['BALANCED'], 12);
    assert.equal(selected.filter(({ journey }) => journey.diversityKey === 'transit:lviv:102').length, 1);
  });

  it('does not pad a frontier that already offers a real choice', () => {
    const rich: JourneyOption[] = [
      on('a', 'transit:lviv:1', trolleyLegs, { durationSeconds: 3_000, walkingMeters: 2_500 }),
      on('b', 'transit:lviv:2', trolleyLegs, { durationSeconds: 3_400, walkingMeters: 1_500 }),
      on('c', 'transit:lviv:3', trolleyLegs, { durationSeconds: 3_800, priceMinor: 1_500, walkingMeters: 900 }),
      on('d', 'transit:lviv:4', trolleyLegs, { durationSeconds: 4_200, walkingMeters: 2_600 }),
    ];
    assert.equal(paretoFrontier(rich).length, 3);
    assert.deepEqual(selectStrategyAlternatives(rich, ['BALANCED']).map(({ journey }) => journey.id).sort(), ['a', 'b', 'c']);
  });

  it('never invents a card when the search really produced one journey', () => {
    const single = corridor.filter(({ id }) => id === 'bus-102');
    assert.deepEqual(selectStrategyAlternatives(single, strategies).map(({ journey }) => journey.id), ['bus-102']);
    assert.deepEqual(selectStrategyAlternatives([], strategies), []);
  });
});
