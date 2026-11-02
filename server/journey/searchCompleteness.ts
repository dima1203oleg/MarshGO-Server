/** P10 completeness reporting for the journey search response. */

export const CANONICAL_ROUTE_TYPES = [
  'bus', 'marshrutka', 'trolleybus', 'tram', 'metro', 'carpool', 'taxi', 'train', 'bike', 'scooter', 'carsharing', 'transfer',
] as const;

export type CanonicalRouteType = (typeof CANONICAL_ROUTE_TYPES)[number];

export type ModeAvailability = {
  mode: CanonicalRouteType;
  available: boolean;
  requested: boolean;
  reason: 'usable_provider_data_in_corridor' | 'no_routed_provider_in_corridor' | 'no_source_declares_this_category';
};

export type SearchCompleteness = {
  providersQueried: number;
  providersSucceeded: number;
  providersFailed: number;
  modesAvailable: CanonicalRouteType[];
  modesUnavailable: ModeAvailability[];
  candidatesGenerated: number;
  candidatesValidated: number;
  candidatesRejected: number;
  candidatesDeduplicated: number;
  resultsReturned: number;
  searchTruncated: boolean;
  searchComplete: boolean;
};

export type SearchCompletenessInput = {
  providersQueried: number;
  providersFailed: number;
  /** Route types the search actually had usable provider data for in this corridor. */
  routeTypesInCorridor: Iterable<string>;
  /** Categories the user asked for; `undefined` means all canonical categories. */
  requestedRouteTypes?: readonly string[] | undefined;
  candidatesGenerated: number;
  candidatesValidated: number;
  candidatesDeduplicated: number;
  resultsReturned: number;
  searchTruncated: boolean;
};

const CANONICAL = new Set<string>(CANONICAL_ROUTE_TYPES);

/**
 * A category is only reported as available when some provider in the corridor actually
 * declares it, so a missing marshrutka reads as an honest data gap instead of a silent
 * empty result set.
 */
export function buildSearchCompleteness(input: SearchCompletenessInput): SearchCompleteness {
  const inCorridor = new Set([...input.routeTypesInCorridor].filter((type) => CANONICAL.has(type)));
  const requested = new Set((input.requestedRouteTypes ?? CANONICAL_ROUTE_TYPES).filter((type) => CANONICAL.has(type)));
  const modesUnavailable: ModeAvailability[] = CANONICAL_ROUTE_TYPES.filter((type) => !inCorridor.has(type))
    .map((type) => ({
      mode: type,
      available: false,
      requested: requested.has(type),
      reason: requested.has(type) ? 'no_routed_provider_in_corridor' : 'no_source_declares_this_category',
    }));
  const providersFailed = Math.min(Math.max(input.providersFailed, 0), input.providersQueried);
  const candidatesRejected = Math.max(input.candidatesGenerated - input.candidatesValidated, 0);
  return {
    providersQueried: input.providersQueried,
    providersSucceeded: input.providersQueried - providersFailed,
    providersFailed,
    modesAvailable: CANONICAL_ROUTE_TYPES.filter((type) => inCorridor.has(type)),
    modesUnavailable,
    candidatesGenerated: input.candidatesGenerated,
    candidatesValidated: input.candidatesValidated,
    candidatesRejected,
    candidatesDeduplicated: input.candidatesDeduplicated,
    resultsReturned: input.resultsReturned,
    searchTruncated: input.searchTruncated,
    searchComplete: !input.searchTruncated && providersFailed === 0 && input.candidatesGenerated > 0,
  };
}
