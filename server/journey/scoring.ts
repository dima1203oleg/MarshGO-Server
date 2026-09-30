import type { JourneyOption, JourneyStrategy } from './types';

export interface ScoreWeights {
  time: number;
  price: number;
  transfers: number;
  walking: number;
  risk: number;
  comfort: number;
}

export const JOURNEY_SCORE_WEIGHTS: Record<JourneyStrategy, ScoreWeights> = {
  FASTEST:  { time: 0.62, price: 0.08, transfers: 0.08, walking: 0.04, risk: 0.12, comfort: 0.06 },
  CHEAPEST: { time: 0.10, price: 0.62, transfers: 0.09, walking: 0.04, risk: 0.10, comfort: 0.05 },
  BALANCED: { time: 0.34, price: 0.24, transfers: 0.12, walking: 0.08, risk: 0.14, comfort: 0.08 },
  PREMIUM:  { time: 0.14, price: 0.10, transfers: 0.15, walking: 0.19, risk: 0.15, comfort: 0.27 },
  RELIABLE: { time: 0.20, price: 0.10, transfers: 0.10, walking: 0.06, risk: 0.46, comfort: 0.08 },
  CUSTOM:   { time: 0.34, price: 0.24, transfers: 0.12, walking: 0.08, risk: 0.14, comfort: 0.08 },
};

export interface ScoredJourney<T extends JourneyOption = JourneyOption> {
  journey: T;
  score: number;
  strategy: JourneyStrategy;
}

type Metric = 'durationSeconds' | 'priceMinor' | 'transfers' | 'walkingMeters' | 'risk' | 'comfortPenalty';

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
    durationSeconds: (journey) => journey.durationSeconds,
    priceMinor: (journey) => journey.priceMinor ?? Number.MAX_SAFE_INTEGER,
    transfers: (journey) => journey.transfers,
    walkingMeters: (journey) => journey.walkingMeters,
    risk: (journey) => Math.max(journey.transferRisk, journey.reliability === null ? 1 : 1 - journey.reliability),
    comfortPenalty: (journey) => journey.comfort === null ? 0.5 : 1 - journey.comfort,
  };
  const ranges = Object.fromEntries(Object.entries(metrics).map(([key, valueOf]) => {
    const values = journeys.map(valueOf);
    return [key, { min: Math.min(...values), max: Math.max(...values) }];
  })) as Record<Metric, { min: number; max: number }>;
  const combinedWeights = { ...JOURNEY_SCORE_WEIGHTS[strategy], ...weights };

  return journeys.map((journey) => {
    const values: Record<Metric, number> = {
      durationSeconds: journey.durationSeconds,
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
  }).sort((a, b) => a.score - b.score || a.journey.id.localeCompare(b.journey.id));
}

export function selectRepresentativeJourneys<T extends JourneyOption>(
  journeys: readonly T[],
  strategies: readonly JourneyStrategy[] = ['FASTEST', 'CHEAPEST', 'PREMIUM', 'BALANCED', 'RELIABLE'],
  maxSimilarityRatio = 0.05,
): Array<{ strategy: JourneyStrategy; journey: T; score: number }> {
  const selected: Array<{ strategy: JourneyStrategy; journey: T; score: number }> = [];
  for (const strategy of strategies) {
    const winner = scoreJourneys(journeys, strategy)[0];
    if (!winner) continue;
    const isDuplicate = selected.some((existing) => {
      const sameModes = existing.journey.legs.map((leg) => leg.mode).join(',') === winner.journey.legs.map((leg) => leg.mode).join(',');
      const similarTime = Math.abs(existing.journey.durationSeconds - winner.journey.durationSeconds) <= Math.max(existing.journey.durationSeconds, winner.journey.durationSeconds) * maxSimilarityRatio;
      const aPrice = existing.journey.priceMinor;
      const bPrice = winner.journey.priceMinor;
      const similarPrice = aPrice === bPrice || (aPrice !== null && bPrice !== null && Math.abs(aPrice - bPrice) <= Math.max(aPrice, bPrice, 1) * maxSimilarityRatio);
      return sameModes && existing.journey.transfers === winner.journey.transfers && similarTime && similarPrice;
    });
    if (!isDuplicate) selected.push({ strategy, journey: winner.journey, score: winner.score });
  }
  return selected;
}
