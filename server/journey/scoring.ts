import type { JourneyOption, JourneyStrategy } from './types';
import { compareStableId } from './stableOrdering';

export interface ScoreWeights {
  time: number;
  price: number;
  transfers: number;
  walking: number;
  risk: number;
  comfort: number;
}

/** Generalized-cost penalty for the effort and uncertainty of each transfer. */
export const TRANSFER_TIME_PENALTY_SECONDS = 8 * 60;

export const JOURNEY_SCORE_WEIGHTS: Record<JourneyStrategy, ScoreWeights> = {
  FASTEST:  { time: 0.62, price: 0.08, transfers: 0.08, walking: 0.04, risk: 0.12, comfort: 0.06 },
  CHEAPEST: { time: 0.10, price: 0.62, transfers: 0.09, walking: 0.04, risk: 0.10, comfort: 0.05 },
  BALANCED: { time: 0.48, price: 0.22, transfers: 0.08, walking: 0.08, risk: 0.14, comfort: 0 },
  PREMIUM:  { time: 0.14, price: 0.10, transfers: 0.15, walking: 0.19, risk: 0.15, comfort: 0.27 },
  RELIABLE: { time: 0.20, price: 0.10, transfers: 0.10, walking: 0.06, risk: 0.46, comfort: 0.08 },
  CUSTOM:   { time: 0.34, price: 0.24, transfers: 0.12, walking: 0.08, risk: 0.14, comfort: 0.08 },
};

export interface ScoredJourney<T extends JourneyOption = JourneyOption> {
  journey: T;
  score: number;
  strategy: JourneyStrategy;
}

/** CHEAPEST compares only candidates with a known, comparable fare. */
export function strategiesWithComparablePrices<T extends JourneyOption>(
  journeys: readonly T[],
  strategies: readonly JourneyStrategy[],
): JourneyStrategy[] {
  const hasComparableFare = journeys.some((journey) => journey.priceMinor !== null);
  return hasComparableFare ? [...strategies] : strategies.filter((strategy) => strategy !== 'CHEAPEST');
}

type Metric = 'durationSeconds' | 'priceMinor' | 'transfers' | 'walkingMeters' | 'risk' | 'comfortPenalty';

function riskMetric(journey: JourneyOption): number {
  return Math.max(journey.transferRisk, journey.reliability === null ? 1 : 1 - journey.reliability);
}

function dominates(a: JourneyOption, b: JourneyOption): boolean {
  if ((a.priceMinor === null) !== (b.priceMinor === null)) return false;
  // Comfort is a real optimization dimension (especially for PREMIUM).
  // Unknown comfort must stay incomparable with measured comfort, just as an
  // unknown fare stays incomparable with a known fare.
  if ((a.comfort === null) !== (b.comfort === null)) return false;
  const aPrice = a.priceMinor ?? 0;
  const bPrice = b.priceMinor ?? 0;
  const metricsA = [a.durationSeconds, aPrice, a.transfers, a.walkingMeters, riskMetric(a), a.comfort === null ? 0.5 : 1 - a.comfort];
  const metricsB = [b.durationSeconds, bPrice, b.transfers, b.walkingMeters, riskMetric(b), b.comfort === null ? 0.5 : 1 - b.comfort];
  return metricsA.every((value, index) => value <= metricsB[index])
    && metricsA.some((value, index) => value < metricsB[index]);
}

/** Keep candidates that are not worse in every measurable dimension. Unknown fares are incomparable with known fares. */
export function paretoFrontier<T extends JourneyOption>(journeys: readonly T[]): T[] {
  return journeys.filter((candidate) => !journeys.some((other) => other !== candidate && dominates(other, candidate)));
}

export interface StrategyRecommendation<T extends JourneyOption> {
  journey: T;
  strategy: JourneyStrategy;
  recommendedStrategies: JourneyStrategy[];
  score: number;
  strategyRanks?: Partial<Record<JourneyStrategy, number>>;
}

/** Keep a bounded, diverse-enough set of Pareto alternatives for each visible strategy. */
export function selectStrategyAlternatives<T extends JourneyOption>(
  journeys: readonly T[],
  strategies: readonly JourneyStrategy[],
  maximumPerStrategy = 12,
): StrategyRecommendation<T>[] {
  if (!Number.isInteger(maximumPerStrategy) || maximumPerStrategy < 1 || maximumPerStrategy > 50) {
    throw new TypeError('maximum alternatives per strategy must be between 1 and 50');
  }
  const frontier = paretoFrontier(journeys);
  const alternatives = new Map<string, StrategyRecommendation<T>>();
  for (const strategy of strategies) {
    // An unknown fare is not a zero or a comparable amount. Keep such routes
    // available to other strategies, but never include them in CHEAPEST.
    const strategyCandidates = strategy === 'CHEAPEST'
      ? frontier.filter((journey) => journey.priceMinor !== null)
      : frontier;
    const chainCounts = new Map<string, number>();
    let rank = 0;
    for (const { journey, score } of scoreJourneys(strategyCandidates, strategy)) {
      const modeChain = journey.legs.filter((leg) => leg.mode !== 'WALK').map((leg) => leg.mode).join('>') || 'WALK';
      const diversityKey = journey.diversityKey ?? modeChain;
      const count = chainCounts.get(diversityKey) ?? 0;
      if (count >= 3) continue;
      chainCounts.set(diversityKey, count + 1);
      rank += 1;
      const existing = alternatives.get(journey.id);
      if (existing) {
        existing.recommendedStrategies.push(strategy);
        existing.strategyRanks ??= {};
        existing.strategyRanks[strategy] = rank;
      } else {
        alternatives.set(journey.id, {
          journey, strategy, recommendedStrategies: [strategy], score,
          strategyRanks: { [strategy]: rank },
        });
      }
      if (rank >= maximumPerStrategy) break;
    }
  }
  return [...alternatives.values()];
}

/** Return one winner per strategy, grouping exact same candidates across tabs. */
export function selectStrategyRecommendations<T extends JourneyOption>(
  journeys: readonly T[],
  strategies: readonly JourneyStrategy[],
): StrategyRecommendation<T>[] {
  const frontier = paretoFrontier(journeys);
  const recommendations: StrategyRecommendation<T>[] = [];
  for (const strategy of strategies) {
    const winner = scoreJourneys(frontier, strategy)[0];
    if (!winner) continue;
    // Strategy labels are factual promises. Two distinct journeys can share
    // the same mode chain and be close in time/price while still having
    // different winners, so only the same candidate may be grouped.
    const representative = recommendations.find((item) => item.journey.id === winner.journey.id);
    if (representative) {
      representative.recommendedStrategies.push(strategy);
    } else {
      recommendations.push({ journey: winner.journey, strategy, recommendedStrategies: [strategy], score: winner.score });
    }
  }
  return recommendations;
}

function normalized(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export function scoreJourneys<T extends JourneyOption>(
  journeys: readonly T[],
  strategy: JourneyStrategy,
  weights: Partial<ScoreWeights> = {},
): ScoredJourney<T>[] {
  if (journeys.length === 0) return [];
  for (const journey of journeys) {
    if (!Number.isFinite(journey.durationSeconds) || journey.durationSeconds < 0
      || !Number.isInteger(journey.transfers) || journey.transfers < 0
      || !Number.isFinite(journey.walkingMeters) || journey.walkingMeters < 0
      || (journey.reliability !== null && (!Number.isFinite(journey.reliability) || journey.reliability < 0 || journey.reliability > 1))
      || !Number.isFinite(journey.transferRisk) || journey.transferRisk < 0 || journey.transferRisk > 1
      || (journey.comfort !== null && (!Number.isFinite(journey.comfort) || journey.comfort < 0 || journey.comfort > 1))
      || (journey.priceMinor !== null && (!Number.isSafeInteger(journey.priceMinor) || journey.priceMinor < 0))) {
      throw new TypeError(`journey ${journey.id} has invalid scoring features`);
    }
  }

  const metrics: Record<Metric, (journey: T) => number> = {
    // Composite strategies compare perceived time, while the FASTEST promise
    // below continues to sort by the actual door-to-door duration. This makes
    // transfer effort a stable 8-minute generalized-cost penalty instead of a
    // data-set-dependent normalized count alone.
    durationSeconds: (journey) => journey.durationSeconds + journey.transfers * TRANSFER_TIME_PENALTY_SECONDS,
    priceMinor: (journey) => journey.priceMinor ?? Number.MAX_SAFE_INTEGER,
    transfers: (journey) => journey.transfers,
    walkingMeters: (journey) => journey.walkingMeters,
    risk: riskMetric,
    comfortPenalty: (journey) => journey.comfort === null ? 0.5 : 1 - journey.comfort,
  };
  const ranges = Object.fromEntries(Object.entries(metrics).map(([key, valueOf]) => {
    const values = journeys.map(valueOf);
    return [key, { min: Math.min(...values), max: Math.max(...values) }];
  })) as Record<Metric, { min: number; max: number }>;
  const combinedWeights = { ...JOURNEY_SCORE_WEIGHTS[strategy], ...weights };

  const scored = journeys.map((journey) => {
    const values: Record<Metric, number> = {
      durationSeconds: metrics.durationSeconds(journey),
      priceMinor: metrics.priceMinor(journey),
      transfers: journey.transfers,
      walkingMeters: journey.walkingMeters,
      risk: metrics.risk(journey),
      comfortPenalty: journey.comfort === null ? 0.5 : 1 - journey.comfort,
    };
    const score = (Object.entries(values) as Array<[Metric, number]>).reduce((sum, [metric, value]) => {
      const weightKey = metric === 'durationSeconds' ? 'time'
        : metric === 'priceMinor' ? 'price'
          : metric === 'transfers' ? 'transfers'
            : metric === 'walkingMeters' ? 'walking'
              : metric === 'risk' ? 'risk' : 'comfort';
      return sum + normalized(value, ranges[metric].min, ranges[metric].max) * combinedWeights[weightKey];
    }, 0);
    return { journey, score, strategy };
  });
  return scored.sort((a, b) => {
    // These two strategies are promises about a single measurable value, so
    // make that value the primary key. The weighted score remains the tie-breaker.
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
}

export function selectRepresentativeJourneys<T extends JourneyOption>(
  journeys: readonly T[],
  strategies: readonly JourneyStrategy[] = ['FASTEST', 'CHEAPEST', 'PREMIUM', 'BALANCED', 'RELIABLE'],
  maxResults = 200,
): Array<{ strategy: JourneyStrategy; journey: T; score: number }> {
  const selected: Array<{ strategy: JourneyStrategy; journey: T; score: number }> = [];
  const selectedIds = new Set<string>();
  for (const strategy of strategies) {
    const winner = scoreJourneys(journeys, strategy)[0];
    if (!winner) continue;
    if (selectedIds.has(winner.journey.id)) continue;
    if (selected.length >= maxResults) break;
    selectedIds.add(winner.journey.id);
    selected.push({ strategy, journey: winner.journey, score: winner.score });
  }
  return selected;
}
