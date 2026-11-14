/**
 * Direct-only endpoint reach expands only after ordinary search yields no feasible itinerary.
 * Expanded legs require a configured foot router and retain the passenger's total-walk limit.
 */
export const DIRECT_ONLY_ADAPTIVE_WALKING_TIERS_METERS = [1_500, 2_500, 4_000] as const;
export const MAX_DIRECT_ONLY_WALKING_METERS = DIRECT_ONLY_ADAPTIVE_WALKING_TIERS_METERS.at(-1)!;
export const MAX_DIRECT_ONLY_WALKING_TIERS = DIRECT_ONLY_ADAPTIVE_WALKING_TIERS_METERS.length;

export interface DirectOnlyWalkingPolicyInput {
  maximumTransfers: number | undefined;
  walkingRoutingConfigured: boolean;
  standardAccessMeters: number;
  standardEgressMeters: number;
  baseAccessMeters: number;
  baseEgressMeters: number;
  explicitTotalWalkingLimitMeters: number | undefined;
}

export interface DirectOnlyWalkingPolicy {
  reachTiersMeters: number[];
  maximumAccessMeters: number;
  maximumEgressMeters: number;
  standardAccessMeters: number;
  standardEgressMeters: number;
  requiresConfirmedWalks: boolean;
}

export interface AdaptiveWalkingReachOutcome<T> {
  candidates: T[];
  reachMeters: number | null;
  attempts: number;
  stoppedByBudget: boolean;
}

/** Retry wider direct-only reaches only until a real-feasibility validator accepts a route. */
export async function searchWalkingReachUntilFeasible<T>(
  tiersMeters: readonly number[],
  searchAtReach: (reachMeters: number) => Promise<T[]>,
  validateCandidates: (candidates: T[]) => Promise<T[]>,
  canContinue: () => boolean = () => true,
): Promise<AdaptiveWalkingReachOutcome<T>> {
  let attempts = 0;
  for (const reachMeters of tiersMeters) {
    if (!canContinue()) return { candidates: [], reachMeters: null, attempts, stoppedByBudget: true };
    const candidates = await searchAtReach(reachMeters);
    attempts++;
    const feasible = await validateCandidates(candidates);
    if (feasible.length > 0) return { candidates: feasible, reachMeters, attempts, stoppedByBudget: false };
  }
  return { candidates: [], reachMeters: null, attempts, stoppedByBudget: false };
}

export function resolveDirectOnlyWalkingPolicy(input: DirectOnlyWalkingPolicyInput): DirectOnlyWalkingPolicy {
  const { maximumTransfers, walkingRoutingConfigured, standardAccessMeters, standardEgressMeters, baseAccessMeters, baseEgressMeters,
    explicitTotalWalkingLimitMeters } = input;
  if (![standardAccessMeters, standardEgressMeters, baseAccessMeters, baseEgressMeters]
    .every((value) => Number.isFinite(value) && value >= 0)
    || (explicitTotalWalkingLimitMeters !== undefined
      && (!Number.isFinite(explicitTotalWalkingLimitMeters) || explicitTotalWalkingLimitMeters < 0))) {
    throw new TypeError('direct-only walking policy bounds are invalid');
  }

  const baseAccess = Math.ceil(baseAccessMeters);
  const baseEgress = Math.ceil(baseEgressMeters);
  const standardAccess = Math.ceil(standardAccessMeters);
  const standardEgress = Math.ceil(standardEgressMeters);
  const enabled = maximumTransfers === 0 && walkingRoutingConfigured;
  const reachTiersMeters = enabled
    ? [...new Set(DIRECT_ONLY_ADAPTIVE_WALKING_TIERS_METERS
      .map((tier) => Math.min(tier, explicitTotalWalkingLimitMeters ?? tier))
      .filter((tier) => tier > Math.max(baseAccess, baseEgress)))]
    : [];
  const lastTier = reachTiersMeters.at(-1) ?? Math.max(baseAccess, baseEgress);

  return {
    reachTiersMeters,
    maximumAccessMeters: Math.max(baseAccess, lastTier),
    maximumEgressMeters: Math.max(baseEgress, lastTier),
    standardAccessMeters: standardAccess,
    standardEgressMeters: standardEgress,
    requiresConfirmedWalks: enabled && (reachTiersMeters.length > 0
      || baseAccess > standardAccess || baseEgress > standardEgress),
  };
}
