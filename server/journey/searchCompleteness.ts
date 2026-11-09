/** P10 completeness reporting for the journey search response. */

export const CANONICAL_ROUTE_TYPES = [
  'bus', 'marshrutka', 'trolleybus', 'tram', 'metro', 'carpool', 'taxi', 'train', 'bike', 'scooter', 'carsharing', 'transfer',
] as const;

export type CanonicalRouteType = (typeof CANONICAL_ROUTE_TYPES)[number];

export type ModeAvailabilityReason =
  | 'usable_provider_data_in_corridor'
  | 'no_routed_provider_in_corridor'
  | 'no_source_declares_this_category'
  /** The transit search itself threw, so an empty corridor is not evidence about provider coverage. */
  | 'transit_search_failed';

export type ModeAvailability = {
  mode: CanonicalRouteType;
  available: boolean;
  requested: boolean;
  reason: ModeAvailabilityReason;
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
  transitSearchFailed: boolean;
  /** Measured only when every queried feed missed a side at the walk radius; absent otherwise. */
  nearestOriginStopMeters?: number | null;
  nearestDestinationStopMeters?: number | null;
  /**
   * Set when the search planned from the closest stop although it sat outside the walking shed, so
   * the walk is longer than the request asked for. The count is how many candidates carry it.
   * Absent when every displayed journey walked inside the shed.
   */
  walkReachExtended?: true;
  journeysWithExtendedReach?: number;
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
  /** True when the transit provider search threw and returned nothing at all. */
  transitSearchFailed?: boolean | undefined;
  /** Per-side nearest-stop distances measured during a walk-radius blocked transit search. */
  walkingReach?: { nearestOriginStopMeters: number | null; nearestDestinationStopMeters: number | null;
    extended?: boolean | undefined; journeysWithExtendedReach?: number | undefined } | undefined;
};

const CANONICAL = new Set<string>(CANONICAL_ROUTE_TYPES);

/** Build the locally usable route set from provider data observed in this request's corridor. */
export function routeTypesWithUsableProviderData(input: {
  timetableTypes: Iterable<string>;
  communityOffers: number;
  bicycleInventory: number;
  scooterProviderInventory: number;
}): Set<CanonicalRouteType> {
  const routeTypes = new Set<CanonicalRouteType>();
  for (const type of input.timetableTypes) {
    const canonical = type === 'bus_unspecified' ? 'bus' : type;
    if (CANONICAL.has(canonical)) routeTypes.add(canonical as CanonicalRouteType);
  }
  if (input.communityOffers > 0) routeTypes.add('carpool');
  if (input.bicycleInventory > 0) routeTypes.add('bike');
  if (input.scooterProviderInventory > 0) routeTypes.add('scooter');
  return routeTypes;
}

/** Categories whose only source is the GTFS provider search, as opposed to carpool or micromobility feeds. */
const GTFS_ROUTED_ROUTE_TYPES = new Set<string>(['bus', 'marshrutka', 'trolleybus', 'tram', 'metro', 'train']);

/**
 * A category is only reported as available when some provider in the corridor actually
 * declares it, so a missing marshrutka reads as an honest data gap instead of a silent
 * empty result set. A failed transit search is reported as a failure, never as a gap:
 * an engine that threw proves nothing about which providers cover the corridor.
 */
export function buildSearchCompleteness(input: SearchCompletenessInput): SearchCompleteness {
  const transitSearchFailed = input.transitSearchFailed ?? false;
  const inCorridor = new Set([...input.routeTypesInCorridor].filter((type) => CANONICAL.has(type)));
  const requested = new Set((input.requestedRouteTypes ?? CANONICAL_ROUTE_TYPES).filter((type) => CANONICAL.has(type)));
  const modesUnavailable: ModeAvailability[] = CANONICAL_ROUTE_TYPES.filter((type) => !inCorridor.has(type))
    .map((type) => ({
      mode: type,
      available: false,
      requested: requested.has(type),
      reason: !requested.has(type)
        ? 'no_source_declares_this_category'
        : transitSearchFailed && GTFS_ROUTED_ROUTE_TYPES.has(type)
          ? 'transit_search_failed'
          : 'no_routed_provider_in_corridor',
    }));
  const providersFailed = transitSearchFailed
    ? input.providersQueried
    : Math.min(Math.max(input.providersFailed, 0), input.providersQueried);
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
    searchComplete: !input.searchTruncated && !transitSearchFailed && providersFailed === 0 && input.candidatesGenerated > 0,
    transitSearchFailed,
    ...(input.walkingReach ? {
      nearestOriginStopMeters: input.walkingReach.nearestOriginStopMeters,
      nearestDestinationStopMeters: input.walkingReach.nearestDestinationStopMeters,
      // The distances alone cannot tell the interface whether the journey shown is a longer walk or
      // the search really was blocked, so the extended fact travels with them.
      ...(input.walkingReach.extended ? {
        walkReachExtended: true as const,
        journeysWithExtendedReach: input.walkingReach.journeysWithExtendedReach ?? 0,
      } : {}),
    } : {}),
  };
}
