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

/** Two search instants out of three leave a single non-dominated journey, which is too thin to compare. */
export const MIN_COMPARABLE_ALTERNATIVES = 3;

/** The smallest arrival difference a passenger reads as "another option" rather than a duplicate card. */
export const MIN_PERCEPTIBLE_ARRIVAL_GAP_SECONDS = 120;

/**
 * Does this journey add a decision the already-shown cards do not offer? A card is only worth showing when it
 * arrives at a materially different time or costs a materially different amount. Walk distance and transfer
 * count are deliberately not differentiators: a card with the same arrival and the same fare that walks
 * further or transfers once more is strictly worse, not a choice, and the better-walking twin of that card is
 * already non-dominated so it reached the frontier on its own.
 */
function addsADecision<T extends JourneyOption>(candidate: T, shown: readonly T[]): boolean {
  return shown.every((other) => other.id === candidate.id
    || Math.abs(other.durationSeconds - candidate.durationSeconds) >= MIN_PERCEPTIBLE_ARRIVAL_GAP_SECONDS
    || (other.priceMinor === null) !== (candidate.priceMinor === null)
    || (other.priceMinor !== null && candidate.priceMinor !== null && other.priceMinor !== candidate.priceMinor));
}

/** The chain a passenger recognises as "that line", used both for the per-chain cap and for the backfill. */
function routeChainKey<T extends JourneyOption>(journey: T): string {
  const modeChain = journey.legs.filter((leg) => leg.mode !== 'WALK').map((leg) => leg.mode).join('>') || 'WALK';
  return journey.diversityKey ?? modeChain;
}

/**
 * A search at one instant usually produces exactly one non-dominated journey: the first direct ride beats every
 * transfer chain and every later departure on duration, price and walk at once, so the frontier is a set of one
 * and the passenger gets a single card to "compare" and "select" from. Being dominated is not being the same
 * journey — the slower tram line is still a line the passenger may choose — so a thin frontier is backfilled
 * with the best journey of each chain that is not represented yet.
 *
 * The backfill has a second test, because a different line chain is not automatically a different choice: the
 * measured Lviv corridor returned three cards with the same 3 232 s arrival, the same 23 ₴ fare and walks of
 * 1 867/1 867/2 192 m, differing only in that one ride was split across two or three route ids. Three copies
 * of one decision read as a broken app, so a backfilled card must also arrive at a materially different time
 * or cost a materially different amount (see `addsADecision`). That corridor then yields 3 232 s / 3 772 s /
 * 3 952 s — three different arrivals on three different lines.
 * Frontier members are ranked first and the per-chain cap is unchanged, so the FASTEST and CHEAPEST promises
 * stay factual.
 */
function comparablePool<T extends JourneyOption>(journeys: readonly T[], frontier: readonly T[]): T[] {
  const pool = [...frontier];
  if (frontier.length >= MIN_COMPARABLE_ALTERNATIVES) return pool;
  const represented = new Set(pool.map(routeChainKey));
  const frontierIds = new Set(frontier.map((journey) => journey.id));
  const rest = journeys.filter((journey) => !frontierIds.has(journey.id) && !represented.has(routeChainKey(journey)));
  for (const { journey } of scoreJourneys(rest, 'BALANCED')) {
    if (pool.length >= MIN_COMPARABLE_ALTERNATIVES) break;
    const chain = routeChainKey(journey);
    if (represented.has(chain)) continue;
    if (!addsADecision(journey, pool)) continue;
    represented.add(chain);
    pool.push(journey);
  }
  return pool;
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
  const pool = comparablePool(journeys, paretoFrontier(journeys));
  const alternatives = new Map<string, StrategyRecommendation<T>>();
  for (const strategy of strategies) {
    // An unknown fare is not a zero or a comparable amount. Keep such routes
    // available to other strategies, but never include them in CHEAPEST.
    const strategyCandidates = strategy === 'CHEAPEST'
      ? pool.filter((journey) => journey.priceMinor !== null)
      : pool;
    const chainCounts = new Map<string, number>();
    let rank = 0;
    for (const { journey, score } of scoreJourneys(strategyCandidates, strategy)) {
      const diversityKey = routeChainKey(journey);
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

  // The six metrics and their weights are resolved once per call. The previous
  // shape rebuilt a closure table, a range record and, per journey, a values
  // object plus an Object.entries array of six sub-arrays — the candidate
  // sampler calls this ~10^5 times per city search, so the arithmetic was
  // cheap and the allocation was not.
  const baseWeights = JOURNEY_SCORE_WEIGHTS[strategy];
  // `{ ...base, ...weights }` lets an explicitly present key override even with
  // undefined, so key presence, not truthiness, decides.
  const weightFor = (key: keyof ScoreWeights): number => (Object.prototype.hasOwnProperty.call(weights, key)
    ? weights[key] as number : baseWeights[key]);
  const wTime = weightFor('time');
  const wPrice = weightFor('price');
  const wTransfers = weightFor('transfers');
  const wWalking = weightFor('walking');
  const wRisk = weightFor('risk');
  const wComfort = weightFor('comfort');

  // Composite strategies compare perceived time, while the FASTEST promise
  // below continues to sort by the actual door-to-door duration. This makes
  // transfer effort a stable 8-minute generalized-cost penalty instead of a
  // data-set-dependent normalized count alone.
  //
  // Every value below is finite: the validation loop above guarantees it, which
  // is what lets a plain comparison loop replace Math.min(...values).
  let minTime = Infinity, maxTime = -Infinity;
  let minPrice = Infinity, maxPrice = -Infinity;
  let minTransfers = Infinity, maxTransfers = -Infinity;
  let minWalking = Infinity, maxWalking = -Infinity;
  let minRisk = Infinity, maxRisk = -Infinity;
  let minComfort = Infinity, maxComfort = -Infinity;
  for (const journey of journeys) {
    const time = journey.durationSeconds + journey.transfers * TRANSFER_TIME_PENALTY_SECONDS;
    if (time < minTime) minTime = time;
    if (time > maxTime) maxTime = time;
    const price = journey.priceMinor ?? Number.MAX_SAFE_INTEGER;
    if (price < minPrice) minPrice = price;
    if (price > maxPrice) maxPrice = price;
    if (journey.transfers < minTransfers) minTransfers = journey.transfers;
    if (journey.transfers > maxTransfers) maxTransfers = journey.transfers;
    if (journey.walkingMeters < minWalking) minWalking = journey.walkingMeters;
    if (journey.walkingMeters > maxWalking) maxWalking = journey.walkingMeters;
    const risk = riskMetric(journey);
    if (risk < minRisk) minRisk = risk;
    if (risk > maxRisk) maxRisk = risk;
    const comfort = journey.comfort === null ? 0.5 : 1 - journey.comfort;
    if (comfort < minComfort) minComfort = comfort;
    if (comfort > maxComfort) maxComfort = comfort;
  }

  const scored = journeys.map((journey) => {
    // Same accumulation order as the previous reduce over Object.entries, so
    // every score is bit-identical to the one the old scorer returned.
    const score = normalized(journey.durationSeconds + journey.transfers * TRANSFER_TIME_PENALTY_SECONDS, minTime, maxTime) * wTime
      + normalized(journey.priceMinor ?? Number.MAX_SAFE_INTEGER, minPrice, maxPrice) * wPrice
      + normalized(journey.transfers, minTransfers, maxTransfers) * wTransfers
      + normalized(journey.walkingMeters, minWalking, maxWalking) * wWalking
      + normalized(riskMetric(journey), minRisk, maxRisk) * wRisk
      + normalized(journey.comfort === null ? 0.5 : 1 - journey.comfort, minComfort, maxComfort) * wComfort;
    return { journey, score, strategy };
  });
  const isFastest = strategy === 'FASTEST';
  const isCheapest = strategy === 'CHEAPEST';
  return scored.sort((a, b) => {
    // These two strategies are promises about a single measurable value, so
    // make that value the primary key. The weighted score remains the tie-breaker.
    if (isFastest && a.journey.durationSeconds !== b.journey.durationSeconds) return a.journey.durationSeconds - b.journey.durationSeconds;
    if (isCheapest) {
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
