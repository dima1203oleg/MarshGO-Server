import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_SCORE_WEIGHTS, MIN_COMPARABLE_ALTERNATIVES, MIN_PERCEPTIBLE_ARRIVAL_GAP_SECONDS, paretoFrontier, scoreJourneys, selectRepresentativeJourneys, selectStrategyAlternatives, selectStrategyRecommendations, strategiesWithComparablePrices, TRANSFER_TIME_PENALTY_SECONDS } from '../server/journey/scoring';
import type { ScoreWeights } from '../server/journey/scoring';
import { compareStableId } from '../server/journey/stableOrdering';
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

  it('matches a hand-computed oracle where each strategy has a different winner', () => {
    // Expected scores are derived by hand from the documented compromise
    // (time .48, price .22, transfers .08, walking .08, reliability .14) and the
    // 8-minute transfer penalty; they are deliberately not read from the
    // production weight table, so a silent weight change fails this oracle.
    const balancedPick: JourneyOption = {
      id: 'balanced-pick', durationSeconds: 1_800, priceMinor: 5_000, transfers: 0,
      walkingMeters: 400, reliability: 0.9, transferRisk: 0.1, comfort: null, legs: [{ mode: 'BUS' }],
    };
    const fastestPick: JourneyOption = {
      id: 'fastest-pick', durationSeconds: 1_500, priceMinor: 8_000, transfers: 1,
      walkingMeters: 200, reliability: 0.8, transferRisk: 0.2, comfort: null, legs: [{ mode: 'BUS' }, { mode: 'TRAM' }],
    };
    const cheapestPick: JourneyOption = {
      id: 'cheapest-pick', durationSeconds: 2_400, priceMinor: 3_000, transfers: 0,
      walkingMeters: 900, reliability: 0.95, transferRisk: 0.05, comfort: null, legs: [{ mode: 'TROLLEYBUS' }],
    };
    const fleet = [balancedPick, fastestPick, cheapestPick];
    const expectedBalancedScores = {
      'balanced-pick': 0.48 * 0 + 0.22 * 0.4 + 0.08 * 0 + 0.08 * (200 / 700) + 0.14 * (0.05 / 0.15),
      'fastest-pick': 0.48 * 0.3 + 0.22 * 1 + 0.08 * 1 + 0.08 * 0 + 0.14 * 1,
      'cheapest-pick': 0.48 * 1 + 0.22 * 0 + 0.08 * 0 + 0.08 * 1 + 0.14 * 0,
    };
    const balanced = scoreJourneys(fleet, 'BALANCED');
    for (const candidate of balanced) {
      assert.ok(Math.abs(candidate.score - expectedBalancedScores[candidate.journey.id as keyof typeof expectedBalancedScores]) < 1e-12,
        `${candidate.journey.id}: ${candidate.score}`);
    }
    assert.deepEqual(balanced.map(({ journey }) => journey.id), ['balanced-pick', 'cheapest-pick', 'fastest-pick']);
    assert.equal(scoreJourneys(fleet, 'FASTEST')[0].journey.id, 'fastest-pick');
    assert.equal(scoreJourneys(fleet, 'CHEAPEST')[0].journey.id, 'cheapest-pick');
    assert.equal(new Set([balanced[0].journey.id, scoreJourneys(fleet, 'FASTEST')[0].journey.id,
      scoreJourneys(fleet, 'CHEAPEST')[0].journey.id]).size, 3);
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

  // The scorer runs ~10^5 times per city search through the candidate sampler, so its
  // implementation was rewritten to stop allocating a closure table and per-journey metric
  // records. That is only safe if the output does not move: this test keeps the previous
  // algorithm verbatim as a reference and demands bit-identical scores and ordering over
  // randomized sets for every strategy, including the two that sort by a single promise.
  it('matches the pre-allocation-rewrite scorer exactly on randomized sets', () => {
    const reference = <T extends JourneyOption>(journeys: readonly T[], strategy: JourneyStrategy, weights: Partial<ScoreWeights> = {}) => {
      const normalizedValue = (value: number, min: number, max: number) => (max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min))));
      const risk = (journey: JourneyOption) => Math.max(journey.transferRisk, journey.reliability === null ? 1 : 1 - journey.reliability);
      const metrics: Record<string, (journey: T) => number> = {
        durationSeconds: (journey) => journey.durationSeconds + journey.transfers * TRANSFER_TIME_PENALTY_SECONDS,
        priceMinor: (journey) => journey.priceMinor ?? Number.MAX_SAFE_INTEGER,
        transfers: (journey) => journey.transfers,
        walkingMeters: (journey) => journey.walkingMeters,
        risk: (journey) => risk(journey),
        comfortPenalty: (journey) => journey.comfort === null ? 0.5 : 1 - journey.comfort,
      };
      const ranges = Object.fromEntries(Object.entries(metrics).map(([key, valueOf]) => {
        const values = journeys.map(valueOf);
        return [key, { min: Math.min(...values), max: Math.max(...values) }];
      })) as Record<string, { min: number; max: number }>;
      const combinedWeights = { ...JOURNEY_SCORE_WEIGHTS[strategy], ...weights };
      const scored = journeys.map((journey) => {
        const values: Record<string, number> = {
          durationSeconds: metrics.durationSeconds!(journey),
          priceMinor: metrics.priceMinor!(journey),
          transfers: metrics.transfers!(journey),
          walkingMeters: metrics.walkingMeters!(journey),
          risk: metrics.risk!(journey),
          comfortPenalty: metrics.comfortPenalty!(journey),
        };
        const score = (Object.entries(values) as Array<[string, number]>).reduce((sum, [metric, value]) => {
          const weightKey = metric === 'durationSeconds' ? 'time'
            : metric === 'priceMinor' ? 'price'
              : metric === 'transfers' ? 'transfers'
                : metric === 'walkingMeters' ? 'walking'
                  : metric === 'risk' ? 'risk' : 'comfort';
          return sum + normalizedValue(value, ranges[metric]!.min, ranges[metric]!.max) * (combinedWeights as Record<string, number>)[weightKey];
        }, 0);
        return { journey, score, strategy };
      });
      return scored.sort((a, b) => {
        if (strategy === 'FASTEST' && a.journey.durationSeconds !== b.journey.durationSeconds) return a.journey.durationSeconds - b.journey.durationSeconds;
        if (strategy === 'CHEAPEST') {
          if (a.journey.priceMinor === null && b.journey.priceMinor !== null) return 1;
          if (a.journey.priceMinor !== null && b.journey.priceMinor === null) return -1;
          if (a.journey.priceMinor !== null && b.journey.priceMinor !== null && a.journey.priceMinor !== b.journey.priceMinor) {
            return a.journey.priceMinor - b.journey.priceMinor;
          }
        }
        return a.score - b.score || compareStableId(a.journey.id, b.journey.id);
      });
    };
    const random = (() => { let state = 0x9e3779b9; return () => { state += 0x6d2b79f5; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; }; })();
    const strategies: JourneyStrategy[] = ['FASTEST', 'CHEAPEST', 'BALANCED', 'PREMIUM', 'RELIABLE', 'CUSTOM'];
    for (const size of [1, 2, 9, 25, 40]) {
      // Deliberately sparse: half the sets carry unknown fares or unknown comfort, and some
      // share durations exactly, so ties and null-handling are compared too.
      const set: JourneyOption[] = Array.from({ length: size }, (unused, index) => ({
        id: `j${index}`,
        durationSeconds: 1_200 + Math.floor(random() * 12) * 300,
        priceMinor: random() < 0.5 ? null : Math.floor(random() * 60) * 100,
        transfers: Math.floor(random() * 3),
        walkingMeters: Math.floor(random() * 2_400),
        reliability: random() < 0.4 ? null : Number((random() * 60 + 39).toFixed(2)) / 100,
        transferRisk: Number((random() * 60).toFixed(2)) / 100,
        comfort: random() < 0.4 ? null : Number((random() * 90 + 10).toFixed(2)) / 100,
        legs: [{ mode: 'BUS' }],
      }));
      for (const strategy of strategies) {
        for (const weights of [{}, { time: 0.5, comfort: 0.1 }, { time: undefined }] as Array<Partial<ScoreWeights>>) {
          assert.deepStrictEqual(
            scoreJourneys(set, strategy, weights),
            reference(set, strategy, weights),
            `scorer drift for ${strategy} with weights ${JSON.stringify(weights)} at size ${size}`,
          );
        }
      }
    }
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
  const busLegs: JourneyOption['legs'] = [leg('WALK', null), leg('BUS', 'lviv'), leg('WALK', null)];
  const busThenBusLegs: JourneyOption['legs'] = [leg('WALK', null), leg('BUS', 'lviv'), leg('BUS', 'lviv'), leg('WALK', null)];
  const walkBetweenLegs: JourneyOption['legs'] = [leg('WALK', null), leg('BUS', 'lviv'), leg('WALK', null), leg('BUS', 'lviv'), leg('WALK', null)];
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

  it('does not sell one ride split across lines as three choices', () => {
    // Live Lviv response of 2026-11-03 21:20: three cards, all 3 232 s, all 23 ₴, walks 1 867/1 867/2 192 m.
    // They were different route-id chains, so a chain-only backfill called them three alternatives.
    const trio: JourneyOption[] = [
      on('direct', 'transit:lviv:102', busLegs),
      on('split-at-same-stop', 'transit:lviv:102>transit:lviv:119', busThenBusLegs, { transfers: 1 }),
      on('split-after-walk', 'transit:lviv:102>transit:lviv:150', walkBetweenLegs, { transfers: 1, walkingMeters: 2_192 }),
    ];
    assert.deepEqual(paretoFrontier(trio).map((journey) => journey.id), ['direct']);
    assert.deepEqual(selectStrategyAlternatives(trio, strategies).map(({ journey }) => journey.id), ['direct'],
      'a card that is not better on any measure the passenger sees is the same ride, not a choice');
  });

  it('keeps one card per arrival the passenger can tell apart', () => {
    // The measured Lviv corridor of 2026-11-03 21:20, reduced to the chain leaders the dump reported:
    // 3 232 s ×3 chains, 3 772 s ×2 chains, 3 832 s, 3 952 s, all at 23 ₴.
    const ladder: JourneyOption[] = [
      on('bus-102', 'transit:lviv:102', busLegs),
      on('tram-1062-then-bus-102', 'transit:lviv:1062>transit:lviv:102', walkBetweenLegs, { transfers: 1, walkingMeters: 2_192 }),
      on('trolley-97-then-bus-102', 'transit:lviv:97>transit:lviv:102', busThenBusLegs, { transfers: 1 }),
      on('tram-1006-then-bus-119', 'transit:lviv:1006>transit:lviv:119', walkBetweenLegs, { durationSeconds: 3_772, transfers: 1, walkingMeters: 1_973 }),
      on('marshrutka-2300-then-bus-119', 'transit:lviv:2300>transit:lviv:119', walkBetweenLegs, { durationSeconds: 3_772, transfers: 1, walkingMeters: 2_458 }),
      on('bus-1006-then-bus-119', 'transit:lviv:1006>transit:lviv:119>transit:lviv:124', walkBetweenLegs, { durationSeconds: 3_832, transfers: 2 }),
      on('tram-119-direct', 'transit:lviv:119', busLegs, { durationSeconds: 3_952 }),
    ];
    const shown = selectStrategyAlternatives(ladder, strategies);
    const arrivals = shown.map(({ journey }) => journey.durationSeconds).sort((a, b) => a - b);
    assert.deepEqual(arrivals, [3_232, 3_772, 3_952], 'three cards, three different arrivals, no duplicated decision');
    for (const [index, arrival] of arrivals.entries()) {
      if (index === 0) continue;
      assert.ok(arrival - arrivals[index - 1] >= MIN_PERCEPTIBLE_ARRIVAL_GAP_SECONDS,
        `cards ${arrivals[index - 1]} s and ${arrival} s read as the same arrival`);
    }
    assert.equal(new Set(shown.map(({ journey }) => journey.diversityKey)).size, shown.length, 'one card per line chain');
  });

  it('treats an unknown fare as a difference the passenger weighs', () => {
    const pair: JourneyOption[] = [
      on('priced-direct', 'transit:lviv:102', trolleyLegs),
      on('unpriced-other-line', 'transit:lviv:97', trolleyLegs, { transfers: 1, priceMinor: null }),
    ];
    const ids = selectStrategyAlternatives(pair, strategies).map(({ journey }) => journey.id);
    assert.ok(ids.includes('unpriced-other-line'), 'a journey with no published fare is not covered by a priced one');
  });

  it('backfills only chains the passenger can tell apart', () => {
    const ids = selectStrategyAlternatives(corridor, strategies).map(({ journey }) => journey.id);
    assert.equal(new Set(ids).size, ids.length, 'no candidate listed twice');
    assert.deepEqual([...ids].sort(), ['bus-102', 'tram-then-bus-near']);
    assert.ok(!ids.includes('trolley-then-bus'), 'a chain with the same time, fare and walk is not a second choice');
    assert.ok(!ids.includes('marshrutka-then-bus'), 'a chain already covered by a shown one is not a third choice');
  });

  it('reaches the comparison target when the chains really differ', () => {
    const varied = corridor.map((journey) => (journey.id === 'trolley-then-bus'
      ? { ...journey, durationSeconds: 3_600, walkingMeters: 1_245 }
      : journey.id === 'marshrutka-then-bus'
        ? { ...journey, durationSeconds: 3_500, priceMinor: 1_800 }
        : journey));
    const ids = selectStrategyAlternatives(varied, strategies).map(({ journey }) => journey.id);
    assert.ok(ids.length >= MIN_COMPARABLE_ALTERNATIVES, `expected ${MIN_COMPARABLE_ALTERNATIVES} comparable cards, got ${ids.join(', ')}`);
    assert.equal(new Set(ids).size, ids.length, 'no candidate listed twice');
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
