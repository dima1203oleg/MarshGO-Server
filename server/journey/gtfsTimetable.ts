import { unzipSync, strFromU8 } from 'fflate';
import { fetchBinary } from '../mobility/safeFetch';
import { parseCsvLine, routeTypeLabel } from '../mobility/gtfs';
import { journeyTransportTypeSelected, type JourneyTransportType } from './types';
import type { JourneyOption } from './types';
import { calculateGtfsItineraryFare, parseGtfsFares, type GtfsFareProduct, type GtfsFareRule, type ParsedGtfsFares } from './gtfsFares';
import { calculateCityTariffFare } from '../mobility/transportTariffs';
import { gtfsRealtimeTripUpdateKey, type GtfsRealtimeTripUpdate, type GtfsRealtimeTripUpdates } from './gtfsRealtime';
import { BoundedBestK, redistributeBoundedCandidates, retainBoundedTripGroup, type BoundedTripGroup } from './boundedTripRetention';
import { compareStableId } from './stableOrdering';
import { scoreJourneys } from './scoring';
import { toRankedGtfsItinerary } from './gtfsRanking';
import { allocateBoundedGraphBudgets } from './boundedGraphBudget';
import { BoundedPromiseCache } from './boundedPromiseCache';

const MAX_FEED_BYTES = 60 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const FAILED_FEED_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHED_GTFS_FEEDS = 32;
const MAX_ESTIMATED_GTFS_CACHE_BYTES = 256 * 1024 * 1024;
const MERGED_FEED_CACHE_TTL_MS = 60_000;
const MAX_MERGED_FEED_CACHE_ENTRIES = 2;
const MAX_DIRECT_STOPS_PER_SIDE = 20;
const MAX_NEAREST_STOPS_PER_SIDE = 20;
const MAX_STOPS_PER_SIDE = 48;
const MAX_STOPS_PER_ROUTE_PATTERN = 8;
// Google Transit accepts GTFS service times through 99:59:59. Keep the
// parser and service-date lookback aligned with that widely used ceiling.
const MAX_GTFS_SERVICE_HOUR = 99;
const MAX_GTFS_SERVICE_DAY_LOOKBACK = Math.floor(MAX_GTFS_SERVICE_HOUR / 24);
const EARTH_RADIUS_M = 6_371_000;
const MAX_ROUTE_GEOMETRY_POINTS = 500;
// Bound the per-request materialized GTFS graph. A dense city feed can create
// millions of stop-pair objects before the later itinerary sampling limits
// apply; that used to exhaust the Node heap. The route-proportional ceiling
// preserves a fair slice for each line and makes truncation explicit.
const MAX_GTFS_GRAPH_SEGMENTS = 100_000;
const MAX_GTFS_GRAPH_SEGMENTS_PER_ROUTE = 5_000;
const GTFS_RETENTION_PRIORITY_TIER_STRIDE = 2 ** 45;
const GTFS_RETENTION_ARRIVAL_BUCKET_STRIDE = 2 ** 32;
export const MAX_GTFS_TRANSFERS = 4;
export const DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS = 180;
export const DEFAULT_MAXIMUM_WAIT_SECONDS = 4 * 60 * 60;
export const DEFAULT_MAX_ACCESS_WALKING_METERS = 900;
export const DEFAULT_MAX_EGRESS_WALKING_METERS = 1000;
export const DEFAULT_MAX_TRANSFER_WALKING_METERS = 400;
const MINIMUM_INTERCITY_TRANSFER_BUFFER_SECONDS = 600;
const MINIMUM_SUBURBAN_TRANSFER_BUFFER_SECONDS = 300;

type CsvRow = Record<string, string>;
export type TransitJourneyMode = 'BUS' | 'MINIBUS' | 'RAIL' | 'TRAM' | 'TROLLEYBUS' | 'METRO' | 'FERRY' | 'FUNICULAR';
export type GtfsTransportType = 'bus' | 'marshrutka' | 'intercity_bus' | 'train' | 'suburban_train' | 'city_train' | 'tram' | 'trolleybus' | 'metro' | 'ferry' | 'funicular';

/** Keep a per-transfer wait bound within the total search horizon accepted by the planner. */
export function maximumGtfsWaitWithinJourney(maximumJourneySeconds: number,
  configuredMaximumWaitSeconds = DEFAULT_MAXIMUM_WAIT_SECONDS): number {
  if (!Number.isSafeInteger(maximumJourneySeconds) || maximumJourneySeconds < 1
    || !Number.isSafeInteger(configuredMaximumWaitSeconds) || configuredMaximumWaitSeconds < 0) {
    throw new TypeError('GTFS wait and journey bounds must be valid integer seconds');
  }
  return Math.min(maximumJourneySeconds, configuredMaximumWaitSeconds);
}

export interface GtfsTimetableFeed {
  fetchedAt: Date;
  timezone: string;
  routes: Map<string, { name: string; mode: TransitJourneyMode; transportType: GtfsTransportType; agencyId?: string; scheduleSemantics?: 'published_departures' | 'frequency_estimate' }>;
  stops: Map<string, { id: string; name: string; lon: number; lat: number; zoneId?: string; parentStation?: string; locationType?: number }>;
  trips: Map<string, { routeId: string; serviceId: string; headsign: string; shapeId?: string; directionId?: string }>;
  /** Actual GTFS shape coordinates, keyed by the feed's shape_id. */
  shapes?: Map<string, Array<[number, number]>>;
  stopTimes: Map<string, Array<{ stopId: string; sequence: number; arrivalSeconds: number; departureSeconds: number; pickupType: number; dropOffType: number; sourceStopId?: string; sourceParentStationId?: string; sourceStopName?: string; sourceStopCoordinates?: [number, number]; sourceZoneId?: string }>>;
  stopTimesByStop: Map<string, Array<{ tripId: string; index: number }>>;
  transfers?: GtfsTransferRule[];
  pathways?: GtfsPathway[];
  calendars: Map<string, { start: string; end: string; weekdays: boolean[] }>;
  exceptions: Map<string, Map<string, number>>;
  providersByRoute?: Map<string, { id: string; name: string; city: string; fetchedAt: Date }>;
  realtimeTripUpdates?: Map<string, GtfsRealtimeTripUpdate>;
  fareProducts?: Map<string, GtfsFareProduct>;
  fareRules?: Map<string, GtfsFareRule[]>;
  faresV2Present?: boolean;
}

export interface GtfsTransferRule {
  fromStopId: string;
  toStopId: string;
  transferType: number;
  minTransferTimeSeconds?: number;
  fromRouteId?: string;
  toRouteId?: string;
  fromTripId?: string;
  toTripId?: string;
}

export interface GtfsPathway {
  fromStopId: string;
  toStopId: string;
  fromCoordinates: [number, number];
  toCoordinates: [number, number];
  pathwayMode: number;
  bidirectional: boolean;
  traversalTimeSeconds?: number;
  lengthMeters?: number;
}

export interface GtfsTimetableSource {
  providerId: string;
  providerName: string;
  providerCity: string;
  feed: GtfsTimetableFeed;
  realtime?: GtfsRealtimeTripUpdates;
}

export interface GtfsDirectJourney {
  providerId: string;
  providerName: string;
  providerCity?: string;
  mode: TransitJourneyMode;
  routeId: string;
  routeName: string;
  headsign: string;
  tripId: string;
  originStop: { id: string; name: string; coordinates: [number, number] };
  destinationStop: { id: string; name: string; coordinates: [number, number] };
  /** Provider-scoped GTFS stop and parent-station IDs used by transfers/pathways. */
  originTransferNodeIds: string[];
  destinationTransferNodeIds: string[];
  transportType: GtfsTransportType;
  /** Distinguishes provider-published trip times from derived interval-based estimates. */
  scheduleSemantics: 'published_departures' | 'frequency_estimate';
  /** GTFS service date (YYYYMMDD) identifies which daily instance of tripId is used. */
  serviceDate: string;
  /** Original provider timetable values, preserved when realtime predictions are available. */
  scheduledDepartureAt: Date;
  scheduledArrivalAt: Date;
  /** Effective departure and arrival used for search and transfer feasibility. */
  departureAt: Date;
  arrivalAt: Date;
  sourceFreshAt: Date;
  distanceToOriginStopMeters: number;
  distanceFromDestinationStopMeters: number;
  /** Present only when the source supplied a usable GTFS shape for this ride segment. */
  routeGeometry?: Array<[number, number]>;
  /** Timed stop calls copied from this exact GTFS trip segment. */
  stops?: Array<{ id: string; name: string; coordinates: [number, number]; arrivalAt: string; departureAt: string; pickupType: number; dropOffType: number; skipped?: boolean }>;
  realtimeUpdatedAt?: Date;
  originZoneId?: string;
  destinationZoneId?: string;
  traveledZoneIds: string[];
}

type GtfsTransferMeasure = { walkingMeters: number; walkingSeconds: number; geometry: Array<[number, number]> | null; inSeat: boolean };
type GtfsTransferDecision = {
  feasible: boolean;
  measure: GtfsTransferMeasure;
  requiredSeconds: number;
  minimumBufferSeconds: number;
  ruleMinimumSeconds: number | null;
  rule: GtfsTransferRule | null;
};
type GtfsTransferBoarding = Pick<GtfsDirectJourney,
  'providerId' | 'tripId' | 'routeId' | 'originStop' | 'originTransferNodeIds' | 'departureAt' | 'transportType'>;

/**
 * Creates the exact transfer-feasibility context used by the GTFS router and
 * test-only searches. This is the former in-search closure moved verbatim so
 * there is one rule/pathway/feasibility authority.
 */
export function createGtfsTransferDecisionContext(context: {
  feed: GtfsTimetableFeed;
  transferRadius: number;
  minimumTransferBufferSeconds: number;
}) {
  const walkingSeconds = (meters: number) => Math.ceil(meters / 1.25);
  const transferRulesByFromStop = new Map<string, GtfsTransferRule[]>();
  for (const rule of context.feed.transfers ?? []) {
    const rules = transferRulesByFromStop.get(rule.fromStopId) ?? [];
    rules.push(rule);
    transferRulesByFromStop.set(rule.fromStopId, rules);
  }
  const transferRuleFor = (previous: GtfsDirectJourney, next: GtfsTransferBoarding): { rule: GtfsTransferRule | null; ambiguous: boolean } => {
    if (transferRulesByFromStop.size === 0) return { rule: null, ambiguous: false };
    const possibleRules = new Set<GtfsTransferRule>();
    for (const fromStopId of previous.destinationTransferNodeIds) {
      for (const candidate of transferRulesByFromStop.get(fromStopId) ?? []) possibleRules.add(candidate);
    }
    const matches = [...possibleRules].filter((rule) => previous.destinationTransferNodeIds.includes(rule.fromStopId)
      && next.originTransferNodeIds.includes(rule.toStopId)
      && (!rule.fromTripId || rule.fromTripId === previous.tripId)
      && (!rule.toTripId || rule.toTripId === next.tripId)
      && (!rule.fromRouteId || rule.fromRouteId === previous.routeId)
      && (!rule.toRouteId || rule.toRouteId === next.routeId));
    const specificity = (rule: GtfsTransferRule) => {
      if (rule.fromTripId && rule.toTripId) return 6;
      if ((rule.fromTripId && rule.toRouteId) || (rule.fromRouteId && rule.toTripId)) return 5;
      if (rule.fromTripId || rule.toTripId) return 4;
      if (rule.fromRouteId && rule.toRouteId) return 3;
      if (rule.fromRouteId || rule.toRouteId) return 2;
      return 1;
    };
    if (!matches.length) return { rule: null, ambiguous: false };
    const max = Math.max(...matches.map(specificity));
    const best = matches.filter((rule) => specificity(rule) === max);
    const signatures = new Set(best.map((rule) => `${rule.transferType}:${rule.minTransferTimeSeconds ?? ''}`));
    if (signatures.size > 1) return { rule: null, ambiguous: true };
    return { rule: best[0], ambiguous: false };
  };

  const pathwayAdjacency = new Map<string, Array<{
    to: string; seconds: number; meters: number; from: [number, number]; toCoordinates: [number, number];
  }>>();
  const pathwayNodes = new Set<string>();
  const pathwayCoordinates = new Map<string, [number, number]>();
  for (const pathway of context.feed.pathways ?? []) {
    const meters = pathway.lengthMeters ?? distanceMeters(pathway.fromCoordinates, pathway.toCoordinates);
    const seconds = pathway.traversalTimeSeconds ?? walkingSeconds(meters);
    const forward = pathwayAdjacency.get(pathway.fromStopId) ?? [];
    forward.push({ to: pathway.toStopId, seconds, meters, from: pathway.fromCoordinates, toCoordinates: pathway.toCoordinates });
    pathwayAdjacency.set(pathway.fromStopId, forward);
    pathwayNodes.add(pathway.fromStopId); pathwayNodes.add(pathway.toStopId);
    pathwayCoordinates.set(pathway.fromStopId, pathway.fromCoordinates);
    pathwayCoordinates.set(pathway.toStopId, pathway.toCoordinates);
    if (pathway.bidirectional) {
      const reverse = pathwayAdjacency.get(pathway.toStopId) ?? [];
      reverse.push({ to: pathway.fromStopId, seconds, meters, from: pathway.toCoordinates, toCoordinates: pathway.fromCoordinates });
      pathwayAdjacency.set(pathway.toStopId, reverse);
    }
  }
  const pathwayCache = new Map<string, GtfsTransferMeasure | null | false>();
  const pathwayConnection = (fromStopId: string, toStopId: string): GtfsTransferMeasure | null | false => {
    if (fromStopId === toStopId) return { walkingMeters: 0, walkingSeconds: 0, geometry: null, inSeat: false };
    const key = `${fromStopId}\u0000${toStopId}`;
    if (pathwayCache.has(key)) return pathwayCache.get(key)!;
    if (!pathwayNodes.has(fromStopId) || !pathwayNodes.has(toStopId)) {
      const result = pathwayNodes.has(fromStopId) || pathwayNodes.has(toStopId) ? null : false;
      pathwayCache.set(key, result);
      return result;
    }
    const bestSeconds = new Map<string, number>([[fromStopId, 0]]);
    const bestMeters = new Map<string, number>([[fromStopId, 0]]);
    type PathwayEdge = { to: string; seconds: number; meters: number; from: [number, number]; toCoordinates: [number, number] };
    const previous = new Map<string, { node: string; edge: PathwayEdge }>();
    const queue: Array<{ node: string; seconds: number }> = [{ node: fromStopId, seconds: 0 }];
    const visited = new Set<string>();
    while (queue.length) {
      queue.sort((a, b) => a.seconds - b.seconds || compareStableId(a.node, b.node));
      const current = queue.shift()!;
      if (visited.has(current.node)) continue;
      visited.add(current.node);
      if (current.node === toStopId) break;
      for (const edge of pathwayAdjacency.get(current.node) ?? []) {
        const nextSeconds = current.seconds + edge.seconds;
        const nextMeters = (bestMeters.get(current.node) ?? 0) + edge.meters;
        const priorSeconds = bestSeconds.get(edge.to);
        const priorMeters = bestMeters.get(edge.to);
        if (priorSeconds !== undefined && (priorSeconds < nextSeconds || (priorSeconds === nextSeconds && (priorMeters ?? Infinity) <= nextMeters))) continue;
        bestSeconds.set(edge.to, nextSeconds); bestMeters.set(edge.to, nextMeters);
        previous.set(edge.to, { node: current.node, edge });
        queue.push({ node: edge.to, seconds: nextSeconds });
      }
    }
    if (!bestSeconds.has(toStopId)) {
      pathwayCache.set(key, null);
      return null;
    }
    const path: Array<[number, number]> = [];
    let cursor = toStopId;
    while (cursor !== fromStopId) {
      const step = previous.get(cursor);
      if (!step) { pathwayCache.set(key, null); return null; }
      path.push(step.edge.toCoordinates);
      cursor = step.node;
    }
    const fromCoordinates = pathwayCoordinates.get(fromStopId);
    if (fromCoordinates) path.push(fromCoordinates);
    path.reverse();
    const result: GtfsTransferMeasure = { walkingMeters: Math.round(bestMeters.get(toStopId) ?? 0),
      walkingSeconds: Math.ceil(bestSeconds.get(toStopId) ?? 0), geometry: path, inSeat: false };
    pathwayCache.set(key, result);
    return result;
  };
  const transferBufferSeconds = (previous: Pick<GtfsDirectJourney, 'transportType'>, next: Pick<GtfsDirectJourney, 'transportType'>) => {
    const isLongDistance = (segment: Pick<GtfsDirectJourney, 'transportType'>) => ['train', 'intercity_bus'].includes(segment.transportType);
    if (isLongDistance(previous) || isLongDistance(next)) return MINIMUM_INTERCITY_TRANSFER_BUFFER_SECONDS;
    if (previous.transportType === 'suburban_train' || next.transportType === 'suburban_train') {
      return MINIMUM_SUBURBAN_TRANSFER_BUFFER_SECONDS;
    }
    return DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS;
  };
  const decideBoarding = (previous: GtfsDirectJourney, next: GtfsTransferBoarding): GtfsTransferDecision => {
    const { rule, ambiguous } = transferRuleFor(previous, next);
    if (ambiguous || rule?.transferType === 3) {
      return { feasible: false, measure: { walkingMeters: 0, walkingSeconds: 0, geometry: null, inSeat: false }, requiredSeconds: Infinity,
        minimumBufferSeconds: 0, ruleMinimumSeconds: null, rule };
    }
    const inSeat = rule?.transferType === 4;
    const fromPathwayNodes = previous.destinationTransferNodeIds.filter((id) => pathwayNodes.has(id));
    const toPathwayNodes = next.originTransferNodeIds.filter((id) => pathwayNodes.has(id));
    const candidatePaths: Array<GtfsTransferMeasure | null | false> = previous.providerId === next.providerId && (fromPathwayNodes.length || toPathwayNodes.length)
      ? fromPathwayNodes.length && toPathwayNodes.length
        ? fromPathwayNodes.flatMap((fromId) => toPathwayNodes.map((toId) => pathwayConnection(fromId, toId)))
        : [null]
      : [false];
    const routedPath = candidatePaths.filter((candidate): candidate is GtfsTransferMeasure => candidate !== null && typeof candidate === 'object')
      .sort((a, b) => a.walkingSeconds - b.walkingSeconds || a.walkingMeters - b.walkingMeters)[0]
      ?? (candidatePaths.includes(null) ? null : false);
    if (routedPath === null) {
      return { feasible: false, measure: { walkingMeters: 0, walkingSeconds: 0, geometry: null, inSeat: false }, requiredSeconds: Infinity,
        minimumBufferSeconds: 0, ruleMinimumSeconds: null, rule };
    }
    const meters = inSeat ? 0 : typeof routedPath === 'object'
      ? routedPath.walkingMeters : Math.round(distanceMeters(previous.destinationStop.coordinates, next.originStop.coordinates));
    const seconds = inSeat ? 0 : typeof routedPath === 'object'
      ? routedPath.walkingSeconds : walkingSeconds(meters);
    const measure: GtfsTransferMeasure = inSeat ? { walkingMeters: 0, walkingSeconds: 0, geometry: null, inSeat: true }
      : typeof routedPath === 'object' ? routedPath : { walkingMeters: meters, walkingSeconds: seconds, geometry: null, inSeat: false };
    if (meters > context.transferRadius) return { feasible: false, measure, requiredSeconds: Infinity,
      minimumBufferSeconds: 0, ruleMinimumSeconds: null, rule };
    const modeBuffer = Math.max(context.minimumTransferBufferSeconds, transferBufferSeconds(previous, next));
    const ruleMinimumSeconds = rule?.transferType === 2 ? rule.minTransferTimeSeconds ?? null : null;
    const requiredSeconds = inSeat ? 0 : ruleMinimumSeconds !== null
      ? Math.max(modeBuffer + seconds, ruleMinimumSeconds)
      : modeBuffer + seconds;
    const availableSeconds = Math.floor((next.departureAt.getTime() - previous.arrivalAt.getTime()) / 1000);
    return { feasible: availableSeconds >= requiredSeconds, measure, requiredSeconds,
      minimumBufferSeconds: inSeat ? 0 : modeBuffer, ruleMinimumSeconds, rule };
  };
  const decide = (previous: GtfsDirectJourney, next: GtfsDirectJourney): GtfsTransferDecision => decideBoarding(previous, next);
  const pathwayReachableCache = new Map<string, Set<string>>();
  const reachablePathwayNodes = (fromStopId: string): Set<string> => {
    const cached = pathwayReachableCache.get(fromStopId);
    if (cached) return cached;
    const reachable = new Set<string>([fromStopId]);
    const queue = [fromStopId];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const edge of pathwayAdjacency.get(queue[cursor]!) ?? []) {
        if (reachable.has(edge.to)) continue;
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    }
    pathwayReachableCache.set(fromStopId, reachable);
    return reachable;
  };
  return { decide, decideBoarding, transferRuleFor, pathwayNodes, reachablePathwayNodes, pathwayConnection };
}

interface SearchInput {
  providerId: string;
  providerName: string;
  origin: [number, number];
  destination: [number, number];
  earliestDeparture: Date;
  latestDeparture: Date;
  maximumStopDistanceMeters?: number;
  limit?: number;
  now?: Date;
}

export interface GtfsItinerarySearchInput extends SearchInput {
  maximumJourneySeconds?: number;
  maximumTransfers?: number;
  minimumTransferBufferSeconds?: number;
  maximumWaitSeconds?: number;
  /** Separate walk-shed limits keep the first and last mile explicit. */
  maximumAccessWalkingMeters?: number;
  maximumEgressWalkingMeters?: number;
  maximumTransferWalkingMeters?: number;
  allowedModes?: readonly TransitJourneyMode[];
  allowedTransportTypes?: readonly JourneyTransportType[];
  providerCity?: string;
}

export interface GtfsItinerary {
  id: string;
  providerId: string;
  providerName: string;
  segments: GtfsDirectJourney[];
  departureAt: Date;
  arrivalAt: Date;
  durationSeconds: number;
  /** Scheduled waiting from the requested start time, excluding walking and in-vehicle time. */
  waitingSeconds: number;
  transfers: number;
  walkingMeters: number;
  transferWalkingMeters: number[];
  transferWalkingSeconds: number[];
  transferWalkingGeometries: Array<Array<[number, number]> | null>;
  /** Preserve the exact feasibility inputs so routed footpaths can be revalidated. */
  transferInSeat: boolean[];
  transferMinimumBufferSeconds: number[];
  transferRuleMinimumSeconds: Array<number | null>;
  fare: ReturnType<typeof calculateGtfsItineraryFare>;
}

export interface GtfsItinerarySearchTruncation {
  stopSelection: boolean;
  candidateGraph: boolean;
  searchBudget: boolean;
  searchStepLimit: boolean;
  candidatePoolLimit: boolean;
  candidateSampling: boolean;
  responsePage: boolean;
}

export interface GtfsItinerarySearchResult {
  itineraries: GtfsItinerary[];
  searchTruncated: boolean;
  resultLimitReached: boolean;
  candidateGraphTruncated: boolean;
  truncation: GtfsItinerarySearchTruncation;
}

/** Optional lower graph limits let tests exercise bounded retention deterministically. */
export interface GtfsGraphBudgetLimits {
  totalSegments?: number;
  segmentsPerRoute?: number;
  /** Test-only override for exercising bounded intermediate-connector retention. */
  maxRouteOverflowConnectors?: number;
  /** Test-only override for verifying bounded search-frontier behavior. */
  maxQueuedSearchWork?: number;
  /** Test-only override for verifying weighted depth-pass search truncation. */
  maxSearchSteps?: number;
  /** Test-only override for exercising candidate-pool saturation with small fixtures. */
  maxCandidatesPerLegCount?: number;
  /** Test-only override for exercising post-pool search truncation with small fixtures. */
  maxObjectiveReservoirSearchSteps?: number;
}

/** Internal, read-only snapshot for alternate GTFS search experiments in tests. */
export interface GtfsCandidateGraphSnapshot {
  readonly segments: readonly { readonly id: string; readonly journey: Readonly<GtfsDirectJourney> }[];
  readonly firstLegIds: readonly string[];
  readonly originStopIds: readonly string[];
  readonly destinationStopIds: readonly string[];
  readonly earliestDepartureMs: number;
  readonly latestDepartureMs: number;
  readonly journeyEndMs: number;
  readonly maximumWaitMs: number;
  successors(previousId: string, remainingLegs: number): readonly string[];
  transferDecision(previousId: string, nextId: string): Readonly<GtfsTransferDecision>;
}

export type GtfsCandidateGraphObserver = (snapshot: GtfsCandidateGraphSnapshot) => void;

type GtfsStopContext = {
  details: { id: string; name: string; coordinates: [number, number] };
  transferNodeIds: string[];
  exactDistanceToOriginStopMeters: number;
  distanceToOriginStopMeters: number;
  distanceFromDestinationStopMeters: number;
};

// Keep stop-pair graph candidates compact. A dense feed may consider hundreds
// of thousands of pairs, while only a bounded subset is ever searched or sent
// to the client. Materialize the public journey shape after graph retention.
type RetainedGtfsSegment = {
  providerId: string;
  routeId: string;
  tripId: string;
  serviceDate: string;
  fromIndex: number;
  toIndex: number;
  originContext: GtfsStopContext;
  destinationContext: GtfsStopContext;
  scheduledDepartureAt: Date;
  scheduledArrivalAt: Date;
  departureAt: Date;
  arrivalAt: Date;
  realtimeUpdatedAt?: Date;
  originZoneId?: string;
  destinationZoneId?: string;
  sampleRank?: [number, number, number, number, number, number];
  sampleKey?: string;
};
type RetainedGtfsTrip = BoundedTripGroup<RetainedGtfsSegment>;
// Small deterministic endpoint-only reservoir to use route-budget gaps left by whole-trip bundles.
const MAX_ROUTE_OVERFLOW_SEGMENTS = 200;
// Keep connector discovery independent from endpoint fallbacks, but prevent
// dense routes from expanding the search graph with hundreds of middle trips.
const MAX_ROUTE_OVERFLOW_CONNECTORS = 8;

// Keep the same deterministic, order-independent sample for a feed snapshot.
// GTFS feeds are often written in departure-time order, so a simple prefix cap
// silently drops the later part of the requested search window.
function gtfsSegmentRetentionPriority(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Keep a balanced sample of GTFS candidates for the cross-provider scorer.
 * When comparable fares exist, an unknown fare must not receive the same
 * zero-cost score as the cheapest known fare. It remains eligible for the
 * other sampling objectives (time, transfers, and walking).
 */
export function rankGtfsItinerariesForCandidateSampling(
  itineraries: readonly GtfsItinerary[], rankingContext: readonly JourneyOption[] = [],
): GtfsItinerary[] {
  if (!itineraries.length) return [];
  // Use the same scorer as the final cross-provider BALANCED ranking. A
  // separate proxy can discard the route that the user would ultimately see
  // as optimal (for example, a slightly slower direct service vs a transfer).
  const candidates = itineraries.map(toRankedGtfsItinerary);
  const itinerariesById = new Map(candidates.map((candidate) => [candidate.id, candidate.itinerary] as const));
  return scoreJourneys([...candidates, ...rankingContext], 'BALANCED')
    .flatMap(({ journey }) => {
      const itinerary = itinerariesById.get(journey.id);
      return itinerary ? [itinerary] : [];
    });
}

function rankGtfsItinerariesForStrategySampling(
  itineraries: readonly GtfsItinerary[],
  strategy: 'FASTEST' | 'CHEAPEST' | 'BALANCED',
  rankingContext: readonly JourneyOption[],
): GtfsItinerary[] {
  const candidates = itineraries.map(toRankedGtfsItinerary);
  const itinerariesById = new Map(candidates.map((candidate) => [candidate.id, candidate.itinerary] as const));
  return scoreJourneys([...candidates, ...rankingContext], strategy)
    .flatMap(({ journey }) => {
      const itinerary = itinerariesById.get(journey.id);
      return itinerary ? [itinerary] : [];
    });
}

/** Keep objective winners while preserving space for novel feasible trip chains. */
export function selectGtfsResponseItineraries(
  rankedResults: readonly GtfsItinerary[],
  rankings: readonly (readonly GtfsItinerary[])[],
  limit: number,
): GtfsItinerary[] {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('itinerary response limit must be positive');
  const orderedResults = [...rankedResults].sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime()
    || a.transfers - b.transfers || compareStableId(a.id, b.id));
  const legCounts = [...new Set(orderedResults.map((itinerary) => itinerary.segments.length))].sort((a, b) => a - b);
  const diversitySlots = Math.min(legCounts.length, Math.max(0, limit - 5));
  const perObjective = Math.max(1, Math.floor(limit / 5));
  const selected = new Map<string, GtfsItinerary>();
  for (const ranking of rankings) {
    for (const itinerary of ranking.slice(0, perObjective)) {
      if (selected.size >= limit) break;
      selected.set(itinerary.id, itinerary);
    }
  }
  for (const itinerary of orderedResults) {
    if (selected.size >= limit) break;
    selected.set(itinerary.id, itinerary);
  }

  // The candidate pool already contains only feasible itineraries. Replace a
  // redundant stop-pair variant with a new trip chain, never its last witness.
  const diversityRanking = rankings.at(-1) ?? orderedResults;
  const diversityLegCounts = diversitySlots > 0 ? legCounts.slice(-diversitySlots).reverse() : [];
  const tripChainKey = (itinerary: GtfsItinerary) => itinerary.segments.map((segment) =>
    `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>');
  const protectedWinners = new Set(rankings.flatMap((ranking) => ranking[0] ? [ranking[0].id] : []));
  for (const legCount of diversityLegCounts) {
    const representedChains = new Set([...selected.values()].map(tripChainKey));
    const candidate = diversityRanking.find((itinerary) => itinerary.segments.length === legCount
      && !representedChains.has(tripChainKey(itinerary)))
      ?? orderedResults.find((itinerary) => itinerary.segments.length === legCount
        && !representedChains.has(tripChainKey(itinerary)));
    if (!candidate) continue;

    const selectedByChain = new Map<string, GtfsItinerary[]>();
    for (const itinerary of selected.values()) {
      const key = tripChainKey(itinerary);
      const group = selectedByChain.get(key) ?? [];
      group.push(itinerary);
      selectedByChain.set(key, group);
    }
    const victim = [...selected.values()]
      .filter((itinerary) => !protectedWinners.has(itinerary.id)
        && (selectedByChain.get(tripChainKey(itinerary))?.length ?? 0) > 1)
      .sort((a, b) => b.arrivalAt.getTime() - a.arrivalAt.getTime() || compareStableId(b.id, a.id))[0];
    if (victim) selected.delete(victim.id);
    else if (selected.size >= limit) continue;
    selected.set(candidate.id, candidate);
  }
  return [...selected.values()].sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime()
    || a.transfers - b.transfers || compareStableId(a.id, b.id));
}

/** Keep a deterministic bounded overflow sample; rank retained candidates after collection. */
export function retainGtfsDeterministicOverflowSample(
  existing: readonly GtfsItinerary[], candidate: GtfsItinerary, maximum: number,
): GtfsItinerary[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new TypeError('objective sample maximum must be positive');
  const unique = new Map(existing.map((item) => [item.id, item]));
  unique.set(candidate.id, candidate);
  // BALANCED scores are normalized against the full candidate set, so an
  // online top-K score changes as new minima/maxima arrive and is dependent on
  // feed iteration order. Use stable identity for bounded discovery instead;
  // the retained candidates are ranked by the shared scorer after collection.
  // Compute each ID's hash once per update. Re-hashing both sides of the sort
  // comparator for every comparison made the hot overflow path needlessly
  // expensive on dense feeds.
  return [...unique.values()]
    .map((itinerary) => ({ itinerary, priority: gtfsSegmentRetentionPriority(itinerary.id) }))
    .sort((left, right) => left.priority - right.priority
      || compareStableId(left.itinerary.id, right.itinerary.id))
    .slice(0, maximum)
    .map(({ itinerary }) => itinerary);
}

/**
 * Keep objective extremes when several provider searches are combined into
 * the cross-provider candidate pool. Arrival-only truncation can otherwise
 * remove every slow, low-fare route before CHEAPEST ranking gets a chance.
 */
export function selectGtfsCandidatesForCrossProviderSearch(
  itineraries: readonly GtfsItinerary[], maximum = 100, rankingContext: readonly JourneyOption[] = [],
): GtfsItinerary[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new TypeError('candidate maximum must be positive');
  if (itineraries.length <= maximum) return [...itineraries];

  const selected = new Map<string, GtfsItinerary>();
  const take = (ranked: readonly GtfsItinerary[], count: number) => {
    for (const item of ranked) {
      if (selected.size >= maximum || count <= 0) break;
      if (selected.has(item.id)) continue;
      selected.set(item.id, item);
      count--;
    }
  };
  const byArrival = [...itineraries].sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime()
    || a.departureAt.getTime() - b.departureAt.getTime() || compareStableId(a.id, b.id));
  const byTransfers = [...itineraries].sort((a, b) => a.transfers - b.transfers
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byWalking = [...itineraries].sort((a, b) => a.walkingMeters - b.walkingMeters
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const perObjective = Math.max(1, Math.floor(maximum / 5));
  // Preserve top candidates under the same objective scorers used by the
  // final mixed-provider ranking. Duration/fare-only proxy sorting can omit a
  // strategy winner when equal fares or durations are broken by transfers,
  // walking, reliability, or the shared normalization ranges.
  take(rankGtfsItinerariesForStrategySampling(itineraries, 'FASTEST', rankingContext), perObjective);
  take(rankGtfsItinerariesForStrategySampling(itineraries, 'CHEAPEST', rankingContext), perObjective);
  // Reserve the three user-facing strategy winners before auxiliary criteria.
  // For small explicit caps (3–4), transfer/walking samples must not crowd out
  // the BALANCED winner; the production default of 100 still retains 20 each.
  take(rankGtfsItinerariesForStrategySampling(itineraries, 'BALANCED', rankingContext), perObjective);
  take(byTransfers, perObjective);
  take(byWalking, perObjective);
  take(byArrival, maximum - selected.size);
  return [...selected.values()].sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime()
    || a.departureAt.getTime() - b.departureAt.getTime() || compareStableId(a.id, b.id));
}

/** Keep useful boarding/alighting choices for the same scheduled vehicle chain. */
export function sampleGtfsTripChainCandidates(
  itineraries: readonly GtfsItinerary[], maximum = 2,
): GtfsItinerary[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new TypeError('trip-chain sample maximum must be positive');
  if (itineraries.length <= maximum) return [...itineraries];

  const selected = new Map<string, GtfsItinerary>();
  const take = (ranked: readonly GtfsItinerary[], count: number) => {
    for (const item of ranked) {
      if (selected.size >= maximum || count <= 0) break;
      if (selected.has(item.id)) continue;
      selected.set(item.id, item);
      count--;
    }
  };
  const byDuration = [...itineraries].sort((a, b) => a.durationSeconds - b.durationSeconds
    || compareStableId(a.id, b.id));
  const byFare = itineraries.filter((item) => item.fare?.currency === 'UAH')
    .sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byWalking = [...itineraries].sort((a, b) => a.walkingMeters - b.walkingMeters
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));

  const fastest = byDuration[0];
  if (fastest) selected.set(fastest.id, fastest);
  const cheapest = byFare[0];
  if (cheapest && selected.size < maximum
    && (fastest?.fare?.currency !== 'UAH' || cheapest.fare!.priceMinor < fastest.fare.priceMinor)) {
    selected.set(cheapest.id, cheapest);
  }
  // Keep the shared BALANCED winner before adding a standalone low-walking
  // fallback, which can otherwise crowd out the user's Optimal option.
  if (maximum >= 3) take(rankGtfsItinerariesForCandidateSampling(itineraries), maximum - selected.size);
  take(byWalking, maximum - selected.size);
  take(rankGtfsItinerariesForCandidateSampling(itineraries), maximum - selected.size);
  take(byDuration, maximum - selected.size);
  return [...selected.values()];
}

/** Keep route-chain samples useful to the FASTEST, CHEAPEST, and balanced views. */
export function sampleGtfsRouteChainCandidates(
  itineraries: readonly GtfsItinerary[], maximum = 8,
): GtfsItinerary[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new TypeError('route-chain sample maximum must be positive');
  if (itineraries.length <= maximum) return [...itineraries];

  const selected = new Map<string, GtfsItinerary>();
  const take = (ranked: readonly GtfsItinerary[], count: number) => {
    for (const item of ranked) {
      if (selected.size >= maximum || count <= 0) break;
      if (selected.has(item.id)) continue;
      selected.set(item.id, item);
      count--;
    }
  };
  const byDuration = [...itineraries].sort((a, b) => a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byFare = itineraries.filter((item) => item.fare?.currency === 'UAH')
    .sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byTransfers = [...itineraries].sort((a, b) => a.transfers - b.transfers || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byWalking = [...itineraries].sort((a, b) => a.walkingMeters - b.walkingMeters || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const balanced = rankGtfsItinerariesForCandidateSampling(itineraries);

  take(byDuration, 2);
  take(byFare, 2);
  take(balanced, 2);
  take(byTransfers, 1);
  take(byWalking, 1);
  take(balanced, maximum - selected.size);
  return [...selected.values()];
}

export interface GtfsStopArrival {
  stopId: string;
  stopName: string;
  routeId: string;
  routeName: string;
  transportType: GtfsTransportType;
  tripId: string;
  headsign: string;
  scheduledArrivalAt: Date;
  predictedArrivalAt: Date;
  etaSeconds: number;
  source: 'SCHEDULE' | 'TRIP_UPDATE';
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  realtimeUpdatedAt?: Date;
}

function csvRows(text: string | undefined): CsvRow[] {
  if (!text) return [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((name) => name.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(header.map((name, index) => [name, values[index] ?? '']));
  });
}

function integer(value: string | undefined, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function gtfsTime(value: string | undefined): number | null {
  if (!value || !/^\d{1,3}:\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes, seconds] = value.split(':').map(Number);
  if (minutes > 59 || seconds > 59 || hours > MAX_GTFS_SERVICE_HOUR) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

const gtfsServiceDateLookbackCache = new WeakMap<GtfsTimetableFeed, number>();
function gtfsServiceDateLookback(feed: GtfsTimetableFeed): number {
  const cached = gtfsServiceDateLookbackCache.get(feed);
  if (cached !== undefined) return cached;
  let maximumServiceTimeSeconds = 0;
  for (const stopTimes of feed.stopTimes.values()) for (const stopTime of stopTimes) {
    maximumServiceTimeSeconds = Math.max(maximumServiceTimeSeconds, stopTime.arrivalSeconds, stopTime.departureSeconds);
  }
  const lookback = Math.min(MAX_GTFS_SERVICE_DAY_LOOKBACK, Math.floor(maximumServiceTimeSeconds / 86_400));
  gtfsServiceDateLookbackCache.set(feed, lookback);
  return lookback;
}

function routeMode(routeType: number, routeName: string): { mode: TransitJourneyMode; transportType: GtfsTransportType } | null {
  const normalizedName = routeName.normalize('NFKC').toLocaleLowerCase('uk-UA');
  if (normalizedName.includes('міжміськ') || normalizedName.includes('intercity')) return { mode: 'BUS', transportType: 'intercity_bus' };
  const label = routeTypeLabel(routeType, routeName);
  if (label === 'bus') return { mode: 'BUS', transportType: 'bus' };
  if (label === 'marshrutka') return { mode: 'MINIBUS', transportType: 'marshrutka' };
  if (label === 'train') return { mode: 'RAIL', transportType: 'train' };
  if (label === 'suburban') return { mode: 'RAIL', transportType: 'suburban_train' };
  if (label === 'city_train') return { mode: 'RAIL', transportType: 'city_train' };
  if (label === 'funicular') return { mode: 'FUNICULAR', transportType: 'funicular' };
  if (label === 'tram') return { mode: 'TRAM', transportType: 'tram' };
  if (label === 'trolleybus') return { mode: 'TROLLEYBUS', transportType: 'trolleybus' };
  if (label === 'metro') return { mode: 'METRO', transportType: 'metro' };
  if (label === 'ferry') return { mode: 'FERRY', transportType: 'ferry' };
  return null;
}

export function parseGtfsTimetable(files: Record<string, Uint8Array>, fetchedAt = new Date()): GtfsTimetableFeed {
  const text = (name: string) => files[name] ? strFromU8(files[name]) : '';
  const reportedTimezone = csvRows(text('agency.txt'))[0]?.agency_timezone?.trim();
  if (!reportedTimezone || !isValidTimezone(reportedTimezone)) throw new Error('GTFS feed must include a valid agency_timezone');
  // Ukraine feeds use both the current IANA name and its deprecated alias.
  // Canonicalize before providers are grouped so Kyiv and Lviv timetables can
  // participate in one cross-provider itinerary search.
  const timezone = reportedTimezone.toLocaleLowerCase('en-US') === 'europe/kiev' ? 'Europe/Kyiv' : reportedTimezone;

  const routes = new Map<string, { name: string; mode: TransitJourneyMode; transportType: GtfsTransportType; agencyId?: string }>();
  for (const row of csvRows(text('routes.txt'))) {
    const name = row.route_short_name?.trim() || row.route_long_name?.trim() || row.route_id;
    const route = routeMode(integer(row.route_type, -1), `${row.route_short_name ?? ''} ${row.route_long_name ?? ''} ${row.route_desc ?? ''}`);
    if (!route || !row.route_id) continue;
    routes.set(row.route_id, { name, ...route, ...(row.agency_id?.trim() ? { agencyId: row.agency_id.trim() } : {}) });
  }

  const stops = new Map<string, { id: string; name: string; lon: number; lat: number; zoneId?: string; parentStation?: string; locationType?: number }>();
  for (const row of csvRows(text('stops.txt'))) {
    const lon = Number(row.stop_lon), lat = Number(row.stop_lat);
    const locationType = row.location_type?.trim() ? integer(row.location_type, -1) : 0;
    if (!row.stop_id || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90
      || (lon === 0 && lat === 0) || locationType < 0 || locationType > 4) continue;
    stops.set(row.stop_id, { id: row.stop_id, name: row.stop_name?.trim() || row.stop_id, lon, lat,
      ...(row.zone_id?.trim() ? { zoneId: row.zone_id.trim() } : {}),
      ...(row.parent_station?.trim() ? { parentStation: row.parent_station.trim() } : {}),
      ...(locationType !== 0 ? { locationType } : {}) });
  }

  const trips = new Map<string, { routeId: string; serviceId: string; headsign: string; shapeId?: string; directionId?: string }>();
  for (const row of csvRows(text('trips.txt'))) {
    if (!row.trip_id || !row.service_id || !routes.has(row.route_id)) continue;
    trips.set(row.trip_id, { routeId: row.route_id, serviceId: row.service_id, headsign: row.trip_headsign?.trim() || '',
      ...(row.shape_id?.trim() ? { shapeId: row.shape_id.trim() } : {}),
      ...(row.direction_id?.trim() ? { directionId: row.direction_id.trim() } : {}) });
  }

  const referencedShapes = new Set([...trips.values()].flatMap((trip) => trip.shapeId ? [trip.shapeId] : []));
  const shapePoints = new Map<string, Array<{ sequence: number; coordinates: [number, number] }>>();
  for (const row of csvRows(text('shapes.txt'))) {
    const shapeId = row.shape_id?.trim();
    if (!shapeId || !referencedShapes.has(shapeId)) continue;
    const lon = Number(row.shape_pt_lon), lat = Number(row.shape_pt_lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90 || (lon === 0 && lat === 0)) continue;
    const points = shapePoints.get(shapeId) ?? [];
    points.push({ sequence: integer(row.shape_pt_sequence, -1), coordinates: [lon, lat] });
    shapePoints.set(shapeId, points);
  }
  const shapes = new Map([...shapePoints].map(([shapeId, points]) => [shapeId,
    points.sort((a, b) => a.sequence - b.sequence).map(({ coordinates }) => coordinates),
  ]));

  const stopTimes: GtfsTimetableFeed['stopTimes'] = new Map();
  for (const row of csvRows(text('stop_times.txt'))) {
    if (!trips.has(row.trip_id) || !stops.has(row.stop_id)) continue;
    const arrivalSeconds = gtfsTime(row.arrival_time), departureSeconds = gtfsTime(row.departure_time);
    if (arrivalSeconds === null || departureSeconds === null) continue;
    const list = stopTimes.get(row.trip_id) ?? [];
    const sourceStop = stops.get(row.stop_id);
    list.push({ stopId: row.stop_id, sourceStopId: row.stop_id,
      ...(sourceStop?.parentStation ? { sourceParentStationId: sourceStop.parentStation } : {}),
      sequence: integer(row.stop_sequence, -1), arrivalSeconds, departureSeconds,
      pickupType: integer(row.pickup_type), dropOffType: integer(row.drop_off_type),
      ...(sourceStop ? { sourceStopName: sourceStop.name, sourceStopCoordinates: [sourceStop.lon, sourceStop.lat] as [number, number],
        ...(sourceStop.zoneId ? { sourceZoneId: sourceStop.zoneId } : {}) } : {}) });
    stopTimes.set(row.trip_id, list);
  }
  for (const list of stopTimes.values()) list.sort((a, b) => a.sequence - b.sequence);
  const stopTimesByStop = new Map<string, Array<{ tripId: string; index: number }>>();
  for (const [tripId, list] of stopTimes) list.forEach((entry, index) => {
    const matches = stopTimesByStop.get(entry.stopId) ?? [];
    matches.push({ tripId, index });
    stopTimesByStop.set(entry.stopId, matches);
  });

  const calendars = new Map<string, { start: string; end: string; weekdays: boolean[] }>();
  for (const row of csvRows(text('calendar.txt'))) {
    if (!row.service_id || !/^\d{8}$/.test(row.start_date) || !/^\d{8}$/.test(row.end_date)) continue;
    calendars.set(row.service_id, { start: row.start_date, end: row.end_date,
      weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => row[day] === '1') });
  }
  const exceptions = new Map<string, Map<string, number>>();
  for (const row of csvRows(text('calendar_dates.txt'))) {
    if (!row.service_id || !/^\d{8}$/.test(row.date) || !['1', '2'].includes(row.exception_type)) continue;
    const byDate = exceptions.get(row.service_id) ?? new Map<string, number>();
    byDate.set(row.date, Number(row.exception_type));
    exceptions.set(row.service_id, byDate);
  }

  const transfers: GtfsTransferRule[] = [];
  for (const row of csvRows(text('transfers.txt'))) {
    const transferType = row.transfer_type?.trim() ? integer(row.transfer_type, -1) : -1;
    const rawMinimum = row.min_transfer_time?.trim();
    const minTransferTimeSeconds = rawMinimum ? integer(rawMinimum, -1) : undefined;
    const fromRouteId = row.from_route_id?.trim() || undefined;
    const toRouteId = row.to_route_id?.trim() || undefined;
    const fromTripId = row.from_trip_id?.trim() || undefined;
    const toTripId = row.to_trip_id?.trim() || undefined;
    if (!stops.has(row.from_stop_id) || !stops.has(row.to_stop_id) || transferType < 0 || transferType > 5
      || (rawMinimum && (!Number.isInteger(minTransferTimeSeconds) || minTransferTimeSeconds! < 0))
      || (transferType === 2 && minTransferTimeSeconds === undefined)
      || (fromRouteId && !routes.has(fromRouteId)) || (toRouteId && !routes.has(toRouteId))
      || (fromTripId && !trips.has(fromTripId)) || (toTripId && !trips.has(toTripId))
      || ([4, 5].includes(transferType) && (!fromTripId || !toTripId))) continue;
    transfers.push({ fromStopId: row.from_stop_id, toStopId: row.to_stop_id, transferType,
      ...(minTransferTimeSeconds !== undefined ? { minTransferTimeSeconds } : {}),
      ...(fromRouteId ? { fromRouteId } : {}), ...(toRouteId ? { toRouteId } : {}),
      ...(fromTripId ? { fromTripId } : {}), ...(toTripId ? { toTripId } : {}) });
  }

  const pathways: GtfsPathway[] = [];
  for (const row of csvRows(text('pathways.txt'))) {
    const pathwayMode = integer(row.pathway_mode, -1);
    const bidirectional = row.is_bidirectional === '1';
    const rawTraversalTime = row.traversal_time?.trim();
    const traversalTimeSeconds = rawTraversalTime ? integer(rawTraversalTime, -1) : undefined;
    const rawLength = row.length?.trim();
    const lengthMeters = rawLength ? Number(rawLength) : undefined;
    if (!stops.has(row.from_stop_id) || !stops.has(row.to_stop_id) || pathwayMode < 1 || pathwayMode > 7
      || !['0', '1'].includes(row.is_bidirectional)
      || (rawTraversalTime && (!Number.isInteger(traversalTimeSeconds) || traversalTimeSeconds! < 0))
      || (rawLength && (!Number.isFinite(lengthMeters) || lengthMeters! < 0))) continue;
    const fromStop = stops.get(row.from_stop_id)!, toStop = stops.get(row.to_stop_id)!;
    pathways.push({ fromStopId: row.from_stop_id, toStopId: row.to_stop_id,
      fromCoordinates: [fromStop.lon, fromStop.lat], toCoordinates: [toStop.lon, toStop.lat], pathwayMode, bidirectional,
      ...(traversalTimeSeconds !== undefined ? { traversalTimeSeconds } : {}),
      ...(lengthMeters !== undefined ? { lengthMeters } : {}) });
  }

  const parsedFares: ParsedGtfsFares = parseGtfsFares(files);
  return { fetchedAt, timezone, routes, stops, trips, shapes, stopTimes, stopTimesByStop, calendars, exceptions, transfers, pathways,
    fareProducts: parsedFares.products, fareRules: parsedFares.rules, faresV2Present: parsedFares.faresV2Present };
}

/**
 * Combines compatible static feeds so transfers can cross provider boundaries.
 * Stops join by matching normalized names and close coordinates. A named city
 * railway-station stop may also join a nearby stop served by a national rail
 * timetable, despite operator-specific names; the transfer remains an
 * explicit, timed walking leg in the itinerary.
 */
function buildMergedGtfsTimetables(sources: readonly GtfsTimetableSource[]): GtfsTimetableFeed | null {
  if (sources.length === 0) return null;
  const ordered = [...sources].sort((a, b) => compareStableId(a.providerId, b.providerId));
  const timezone = ordered[0].feed.timezone;
  if (ordered.some((source) => source.feed.timezone !== timezone)) throw new TypeError('GTFS feeds with different timezones cannot be combined');

  const routes: GtfsTimetableFeed['routes'] = new Map();
  const stops: GtfsTimetableFeed['stops'] = new Map();
  const trips: GtfsTimetableFeed['trips'] = new Map();
  const shapes: NonNullable<GtfsTimetableFeed['shapes']> = new Map();
  const stopTimes: GtfsTimetableFeed['stopTimes'] = new Map();
  const calendars: GtfsTimetableFeed['calendars'] = new Map();
  const exceptions: GtfsTimetableFeed['exceptions'] = new Map();
  const transfers: NonNullable<GtfsTimetableFeed['transfers']> = [];
  const pathways: NonNullable<GtfsTimetableFeed['pathways']> = [];
  const fareProducts: NonNullable<GtfsTimetableFeed['fareProducts']> = new Map();
  const fareRules: NonNullable<GtfsTimetableFeed['fareRules']> = new Map();
  const realtimeTripUpdates: NonNullable<GtfsTimetableFeed['realtimeTripUpdates']> = new Map();
  let faresV2Present = false;
  const providersByRoute = new Map<string, { id: string; name: string; city: string; fetchedAt: Date }>();
  const stopsByName = new Map<string, Array<{ id: string; lon: number; lat: number }>>();
  let canonicalStopIndex = 0;
  const namedCityStations = ordered.flatMap((source) => source.providerCity === 'Україна' ? [] : [...source.feed.stops.values()]
    .filter((stop) => /(?:залізничн\p{L}*|вокзал|railway station|train station)/u.test(
      stop.name.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
    ))
    .map((stop) => ({ source, stop })));

  for (const source of ordered) {
    const prefix = `${encodeURIComponent(source.providerId)}:`;
    for (const update of (source.realtime?.fresh ? source.realtime.updates.values() : [])) {
      const trip = source.feed.trips.get(update.tripId);
      if (!trip || update.relationship === 'OTHER' || (update.routeId && update.routeId !== trip.routeId)) continue;
      const tripId = `${prefix}${update.tripId}`;
      realtimeTripUpdates.set(gtfsRealtimeTripUpdateKey(tripId, update.startDate), { ...update, tripId });
    }
    const remappedStops = new Map<string, string>();
    const railServedStops = new Set<string>();
    for (const [stopId, entries] of source.feed.stopTimesByStop) {
      if (entries.some(({ tripId }) => {
        const trip = source.feed.trips.get(tripId);
        const type = trip && source.feed.routes.get(trip.routeId)?.transportType;
        return type === 'train' || type === 'suburban_train' || type === 'city_train';
      })) railServedStops.add(stopId);
    }
    const nearbyRailwayInterchanges = source.providerCity === 'Україна'
      ? new Set([...railServedStops].filter((stopId) => {
        const stop = source.feed.stops.get(stopId);
        return Boolean(stop && namedCityStations.some(({ source: citySource, stop: cityStop }) => citySource.providerId !== source.providerId
          && distanceMeters([stop.lon, stop.lat], [cityStop.lon, cityStop.lat]) <= 150));
      }))
      : new Set<string>();
    for (const stop of source.feed.stops.values()) {
      const normalizedName = stop.name.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const namedRailwayStation = /(?:залізничн\p{L}*|вокзал|railway station|train station)/u.test(normalizedName);
      const stationAlias = namedRailwayStation || nearbyRailwayInterchanges.has(stop.id);
      const nameKey = stationAlias ? 'known railway station interchange' : normalizedName;
      if (!nameKey) continue;
      const candidates = stopsByName.get(nameKey) ?? [];
      const interchangeRadiusMeters = stationAlias ? 150 : 30;
      const match = candidates.find((candidate) => distanceMeters([stop.lon, stop.lat], [candidate.lon, candidate.lat]) <= interchangeRadiusMeters);
      const id = match?.id ?? `canonical-stop-${++canonicalStopIndex}`;
      if (!match) {
        const canonical = { id, name: stop.name, lon: stop.lon, lat: stop.lat,
          ...(stop.zoneId ? { zoneId: `${prefix}${stop.zoneId}` } : {}) };
        stops.set(id, canonical);
        candidates.push({ id, lon: stop.lon, lat: stop.lat });
        stopsByName.set(nameKey, candidates);
      } else if (stationAlias && !candidates.some((candidate) => candidate.id === id
        && candidate.lon === stop.lon && candidate.lat === stop.lat)) {
        // Keep every source platform coordinate as an alias of the canonical
        // interchange. Otherwise a third feed can be within 150 m of a
        // secondary platform, yet appear too far from the first platform
        // retained as the canonical representative (common at large stations).
        candidates.push({ id, lon: stop.lon, lat: stop.lat });
      }
      remappedStops.set(stop.id, id);
    }

    for (const [routeId, route] of source.feed.routes) {
      const mergedRouteId = `${prefix}${routeId}`;
      routes.set(mergedRouteId, route);
      providersByRoute.set(mergedRouteId, { id: source.providerId, name: source.providerName, city: source.providerCity, fetchedAt: source.feed.fetchedAt });
    }
    faresV2Present ||= source.feed.faresV2Present === true;
    for (const [fareId, product] of source.feed.fareProducts ?? []) {
      const mergedFareId = `${prefix}${fareId}`;
      fareProducts.set(mergedFareId, { ...product, id: mergedFareId, providerId: source.providerId });
    }
    for (const [fareId, rules] of source.feed.fareRules ?? []) {
      const mergedFareId = `${prefix}${fareId}`;
      fareRules.set(mergedFareId, rules.map((rule) => ({
        ...rule, fareId: mergedFareId,
        ...(rule.routeId ? { routeId: `${prefix}${rule.routeId}` } : {}),
        ...(rule.originZoneId ? { originZoneId: `${prefix}${rule.originZoneId}` } : {}),
        ...(rule.destinationZoneId ? { destinationZoneId: `${prefix}${rule.destinationZoneId}` } : {}),
        ...(rule.containsZoneId ? { containsZoneId: `${prefix}${rule.containsZoneId}` } : {}),
      })));
    }
    for (const [shapeId, coordinates] of source.feed.shapes ?? []) shapes.set(`${prefix}${shapeId}`, coordinates);
    for (const [serviceId, calendar] of source.feed.calendars) calendars.set(`${prefix}${serviceId}`, calendar);
    for (const [serviceId, byDate] of source.feed.exceptions) exceptions.set(`${prefix}${serviceId}`, new Map(byDate));
    for (const rule of source.feed.transfers ?? []) transfers.push({
      ...rule, fromStopId: `${prefix}${rule.fromStopId}`, toStopId: `${prefix}${rule.toStopId}`,
      ...(rule.fromRouteId ? { fromRouteId: `${prefix}${rule.fromRouteId}` } : {}),
      ...(rule.toRouteId ? { toRouteId: `${prefix}${rule.toRouteId}` } : {}),
      ...(rule.fromTripId ? { fromTripId: `${prefix}${rule.fromTripId}` } : {}),
      ...(rule.toTripId ? { toTripId: `${prefix}${rule.toTripId}` } : {}),
    });
    for (const pathway of source.feed.pathways ?? []) pathways.push({
      ...pathway, fromStopId: `${prefix}${pathway.fromStopId}`, toStopId: `${prefix}${pathway.toStopId}`,
    });
    for (const [tripId, trip] of source.feed.trips) {
      const mergedTripId = `${prefix}${tripId}`;
      const mergedRouteId = `${prefix}${trip.routeId}`;
      const mergedServiceId = `${prefix}${trip.serviceId}`;
      if (!routes.has(mergedRouteId)) continue;
      trips.set(mergedTripId, { ...trip, routeId: mergedRouteId, serviceId: mergedServiceId,
        ...(trip.shapeId ? { shapeId: `${prefix}${trip.shapeId}` } : {}) });
      const entries = source.feed.stopTimes.get(tripId)?.flatMap((entry) => {
        const stopId = remappedStops.get(entry.stopId);
        return stopId ? [{ ...entry, stopId,
          ...(entry.sourceStopId ? { sourceStopId: `${prefix}${entry.sourceStopId}` } : { sourceStopId: `${prefix}${entry.stopId}` }),
          ...(entry.sourceParentStationId ? { sourceParentStationId: `${prefix}${entry.sourceParentStationId}` } : {}),
          ...(entry.sourceZoneId ? { sourceZoneId: `${prefix}${entry.sourceZoneId}` } : {}) }] : [];
      }) ?? [];
      if (entries.length >= 2) stopTimes.set(mergedTripId, entries);
      else trips.delete(mergedTripId);
    }
  }

  const stopTimesByStop: GtfsTimetableFeed['stopTimesByStop'] = new Map();
  for (const [tripId, entries] of stopTimes) entries.forEach((entry, index) => {
    const matches = stopTimesByStop.get(entry.stopId) ?? [];
    matches.push({ tripId, index });
    stopTimesByStop.set(entry.stopId, matches);
  });
  const fetchedAt = new Date(Math.min(...ordered.map((source) => source.feed.fetchedAt.getTime())));
  return { fetchedAt, timezone, routes, stops, trips, shapes, stopTimes, stopTimesByStop, calendars, exceptions, transfers, pathways,
    providersByRoute, fareProducts, fareRules, faresV2Present, realtimeTripUpdates };
}

const mergeObjectIds = new WeakMap<object, number>();
let nextMergeObjectId = 0;
function mergeObjectId(value: object): number {
  let id = mergeObjectIds.get(value);
  if (id === undefined) { id = ++nextMergeObjectId; mergeObjectIds.set(value, id); }
  return id;
}
const mergedFeedCache = new Map<string, { cachedAt: number; feed: GtfsTimetableFeed }>();

/** Reuse the expensive provider-prefix/cross-feed merge for a short burst of route searches. */
export function mergeGtfsTimetables(sources: readonly GtfsTimetableSource[]): GtfsTimetableFeed | null {
  if (sources.length === 0) return null;
  const cacheKey = sources.map((source) => [
    source.providerId, source.providerName, source.providerCity, mergeObjectId(source.feed),
    source.realtime ? `${mergeObjectId(source.realtime.updates)}:${source.realtime.feedTimestamp.getTime()}:${Number(source.realtime.fresh)}` : '-',
  ].join('\u0000')).sort().join('\u0001');
  const now = Date.now();
  const cached = mergedFeedCache.get(cacheKey);
  if (cached && now - cached.cachedAt < MERGED_FEED_CACHE_TTL_MS) {
    mergedFeedCache.delete(cacheKey);
    mergedFeedCache.set(cacheKey, cached);
    return cached.feed;
  }
  if (cached) mergedFeedCache.delete(cacheKey);
  const feed = buildMergedGtfsTimetables(sources);
  if (!feed) return null;
  mergedFeedCache.set(cacheKey, { cachedAt: now, feed });
  while (mergedFeedCache.size > MAX_MERGED_FEED_CACHE_ENTRIES) {
    const oldestKey = mergedFeedCache.keys().next().value;
    if (oldestKey === undefined) break;
    mergedFeedCache.delete(oldestKey);
  }
  return feed;
}

function isValidTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); return true; } catch { return false; }
}

const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();
function timezoneFormatter(timezone: string, includeTime: boolean): Intl.DateTimeFormat {
  const key = `${timezone}:${includeTime ? 'datetime' : 'date'}`;
  let formatter = timezoneFormatters.get(key);
  if (!formatter) {
    formatter = includeTime
      ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      : new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    timezoneFormatters.set(key, formatter);
  }
  return formatter;
}

function localDate(date: Date, timezone: string): string {
  const parts = timezoneFormatter(timezone, false).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}

function weekdayFor(date: string): number {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)))).getUTCDay();
}

function serviceRuns(feed: GtfsTimetableFeed, serviceId: string, date: string): boolean {
  const exception = feed.exceptions.get(serviceId)?.get(date);
  if (exception !== undefined) return exception === 1;
  const calendar = feed.calendars.get(serviceId);
  if (!calendar || date < calendar.start || date > calendar.end) return false;
  const mondayFirst = (weekdayFor(date) + 6) % 7;
  return calendar.weekdays[mondayFirst] === true;
}

function localWallTimeToUtc(civilDate: string, secondsAfterMidnight: number, timezone: string): Date | null {
  const base = Date.UTC(Number(civilDate.slice(0, 4)), Number(civilDate.slice(4, 6)) - 1, Number(civilDate.slice(6, 8)));
  const target = base + secondsAfterMidnight * 1000;
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = timezoneFormatter(timezone, true).formatToParts(new Date(guess));
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    guess += target - represented;
  }
  const result = new Date(guess);
  if (localDate(result, timezone) !== civilDate) return null;
  return result;
}

function localServiceTimeToUtc(serviceDate: string, secondsAfterMidnight: number, timezone: string): Date | null {
  const localNoon = localWallTimeToUtc(serviceDate, 12 * 60 * 60, timezone);
  if (!localNoon) return null;
  // GTFS service time is elapsed from noon minus 12 hours. This is civil
  // midnight on ordinary dates, but can differ on daylight-saving transitions.
  return new Date(localNoon.getTime() - 12 * 60 * 60 * 1000 + secondsAfterMidnight * 1000);
}

function createServiceTimeConverter(timezone: string): (serviceDate: string, secondsAfterMidnight: number) => Date | null {
  const cache = new Map<string, Date | null>();
  return (serviceDate, secondsAfterMidnight) => {
    const key = `${serviceDate}:${secondsAfterMidnight}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const converted = localServiceTimeToUtc(serviceDate, secondsAfterMidnight, timezone);
    cache.set(key, converted);
    return converted;
  };
}

function gtfsServiceDatesForWindow(
  feed: GtfsTimetableFeed,
  startAt: Date,
  endAt: Date,
  serviceTimeToUtc: (serviceDate: string, secondsAfterMidnight: number) => Date | null,
): string[] {
  const firstDate = localDate(startAt, feed.timezone);
  const lastDate = localDate(endAt, feed.timezone);
  const lookback = gtfsServiceDateLookback(feed);
  const serviceDates: string[] = [];
  for (let date = dateStringAfter(firstDate, -lookback); date <= lastDate; date = dateStringAfter(date, 1)) {
    serviceDates.push(date);
  }

  // On a spring-forward transition, the next civil service date can begin in
  // the prior local evening. Include it only when its actual origin overlaps
  // this search window.
  const nextServiceDate = dateStringAfter(lastDate, 1);
  const nextServiceStart = serviceTimeToUtc(nextServiceDate, 0);
  if (nextServiceStart && nextServiceStart <= endAt && localDate(nextServiceStart, feed.timezone) < nextServiceDate) {
    serviceDates.push(nextServiceDate);
  }
  return serviceDates;
}

function dateStringAfter(date: string, days: number): string {
  const value = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)) + days));
  return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Return upcoming arrivals at one provider-scoped GTFS stop. Predictions only
 * use a fresh, exact-trip GTFS-Realtime TripUpdate; vehicle GPS alone is not
 * converted into an ETA here.
 */
export function findGtfsStopArrivals(
  feed: GtfsTimetableFeed,
  stopId: string,
  options: { now?: Date; horizonSeconds?: number; limit?: number; routeId?: string; headsign?: string } = {},
): GtfsStopArrival[] {
  const now = options.now ?? new Date();
  const horizonSeconds = options.horizonSeconds ?? 6 * 60 * 60;
  const limit = options.limit ?? 20;
  if (!stopId || stopId.length > 255) throw new TypeError('stop ID must contain 1 to 255 characters');
  if (!Number.isFinite(now.getTime())) throw new TypeError('now must be a valid date');
  if (!Number.isInteger(horizonSeconds) || horizonSeconds < 60 || horizonSeconds > 48 * 60 * 60) {
    throw new TypeError('arrival horizon must be between 60 and 172800 seconds');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('arrival limit must be between 1 and 50');
  const routeId = options.routeId?.trim();
  const headsign = options.headsign?.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk-UA');
  if (routeId !== undefined && (!routeId || routeId.length > 255)) throw new TypeError('route ID must contain 1 to 255 characters');
  if (headsign !== undefined && (!headsign || headsign.length > 255)) throw new TypeError('headsign must contain 1 to 255 characters');

  const stop = feed.stops.get(stopId);
  if (!stop) return [];
  const horizonAt = new Date(now.getTime() + horizonSeconds * 1000);
  const toUtc = createServiceTimeConverter(feed.timezone);
  const serviceDates = new Set(gtfsServiceDatesForWindow(feed, now, horizonAt, toUtc));
  const arrivals: GtfsStopArrival[] = [];
  for (const entry of feed.stopTimesByStop.get(stopId) ?? []) {
    const trip = feed.trips.get(entry.tripId);
    const route = trip && feed.routes.get(trip.routeId);
    const stopTime = feed.stopTimes.get(entry.tripId)?.[entry.index];
    if (!trip || !route || !stopTime || stopTime.pickupType !== 0
      || (routeId && trip.routeId !== routeId)
      || (headsign && trip.headsign.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk-UA') !== headsign)) continue;

    for (const serviceDate of serviceDates) {
      if (!serviceRuns(feed, trip.serviceId, serviceDate)) continue;
      const scheduledArrivalAt = toUtc(serviceDate, stopTime.arrivalSeconds);
      if (!scheduledArrivalAt || scheduledArrivalAt > horizonAt) continue;
      const dated = datedTripStops(feed, entry.tripId, serviceDate);
      const predicted = dated.stops[entry.index];
      if (!predicted || predicted.skipped || predicted.arrivalAt < now || predicted.arrivalAt > horizonAt) continue;

      const update = dated.update?.stops.find((item) => item.stopSequence === stopTime.sequence);
      const hasRealtimeEvent = update?.relationship !== 'NO_DATA'
        && Boolean(update?.arrival?.time || update?.arrival?.delaySeconds !== undefined
          || update?.departure?.time || update?.departure?.delaySeconds !== undefined);
      const exactArrival = Boolean(update?.arrival?.time || update?.arrival?.delaySeconds !== undefined);
      const source = hasRealtimeEvent ? 'TRIP_UPDATE' : 'SCHEDULE';
      arrivals.push({ stopId, stopName: stopTime.sourceStopName ?? stop.name,
        routeId: trip.routeId, routeName: route.name, transportType: route.transportType,
        tripId: entry.tripId, headsign: trip.headsign,
        scheduledArrivalAt, predictedArrivalAt: predicted.arrivalAt,
        etaSeconds: Math.max(0, Math.ceil((predicted.arrivalAt.getTime() - now.getTime()) / 1000)),
        source, confidence: exactArrival ? 'HIGH' : hasRealtimeEvent ? 'MEDIUM' : 'LOW',
        ...(hasRealtimeEvent && dated.update ? { realtimeUpdatedAt: dated.update.updatedAt } : {}) });
    }
  }
  return arrivals.sort((a, b) => a.predictedArrivalAt.getTime() - b.predictedArrivalAt.getTime()
    || compareStableId(a.routeId, b.routeId) || compareStableId(a.tripId, b.tripId)).slice(0, limit);
}

function distanceMeters(a: [number, number], b: [number, number]): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(b[1] - a[1]), dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const shapeSnapCache = new WeakMap<GtfsTimetableFeed, Map<string, Array<{ index: number; distance: number }>>>();

function nearestShapeIndexes(feed: GtfsTimetableFeed, shapeId: string, shape: Array<[number, number]>, point: [number, number]): Array<{ index: number; distance: number }> {
  let cache = shapeSnapCache.get(feed);
  if (!cache) { cache = new Map(); shapeSnapCache.set(feed, cache); }
  const key = `${shapeId}:${point[0].toFixed(6)},${point[1].toFixed(6)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const closest = shape.map((coordinate, index) => ({ index, distance: distanceMeters(coordinate, point) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, 8);
  cache.set(key, closest);
  return closest;
}

function routeGeometryForTrip(feed: GtfsTimetableFeed, tripId: string, fromIndex: number, toIndex: number): Array<[number, number]> | undefined {
  const trip = feed.trips.get(tripId);
  const shapeId = trip?.shapeId;
  const shape = shapeId ? feed.shapes?.get(shapeId) : undefined;
  const stops = feed.stopTimes.get(tripId);
  const from = stops?.[fromIndex]?.sourceStopCoordinates;
  const to = stops?.[toIndex]?.sourceStopCoordinates;
  if (!shapeId || !shape || shape.length < 2 || !from || !to) return undefined;

  const starts = nearestShapeIndexes(feed, shapeId, shape, from);
  const ends = nearestShapeIndexes(feed, shapeId, shape, to);
  let best: { start: number; end: number; snapDistance: number } | undefined;
  for (const start of starts) for (const end of ends) {
    if (start.index >= end.index) continue;
    const snapDistance = start.distance + end.distance;
    if (!best || snapDistance < best.snapDistance) best = { start: start.index, end: end.index, snapDistance };
  }
  // Refuse distant shape matches; on loops this avoids drawing the wrong direction.
  if (!best || best.snapDistance > 600) return undefined;

  const coordinates: Array<[number, number]> = [];
  const append = (coordinate: [number, number]) => {
    const previous = coordinates.at(-1);
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate);
  };
  append(from);
  for (const coordinate of shape.slice(best.start, best.end + 1)) append(coordinate);
  append(to);
  if (coordinates.length <= MAX_ROUTE_GEOMETRY_POINTS) return coordinates;
  return Array.from({ length: MAX_ROUTE_GEOMETRY_POINTS }, (_, index) =>
    coordinates[Math.round(index * (coordinates.length - 1) / (MAX_ROUTE_GEOMETRY_POINTS - 1))],
  );
}

type DatedTripStop = { arrivalAt: Date; departureAt: Date; skipped: boolean; updated: boolean };

export type EligibleTripInstanceStopEvent = {
  stopIndex: number;
  stopTime: NonNullable<GtfsTimetableFeed['stopTimes'] extends Map<string, (infer T)[]> ? T : never>;
  scheduledArrivalAt: Date | null;
  scheduledDepartureAt: Date | null;
  arrivalAt: Date | null;
  departureAt: Date | null;
  skipped: boolean;
  updated: boolean;
  canBoard: boolean;
  canAlight: boolean;
};

export type EligibleTripInstanceEvents = {
  events: EligibleTripInstanceStopEvent[];
  /** Full trip-stop realtime vector is kept for exact segment-level update attribution. */
  datedStops?: DatedTripStop[];
  realtimeUpdate?: GtfsRealtimeTripUpdate;
};

/**
 * Resolve the service-date schedule and realtime overlay for only the selected
 * stop indexes of one trip instance. This is deliberately a pure projection:
 * it does not mutate the feed or apply graph/search sampling policy.
 */
export function eligibleTripInstanceStopEvents(
  feed: GtfsTimetableFeed,
  tripId: string,
  serviceDate: string,
  eligibleStopIndexes: readonly number[],
  serviceTimeToUtc: ReturnType<typeof createServiceTimeConverter> = createServiceTimeConverter(feed.timezone),
): EligibleTripInstanceEvents | null {
  const trip = feed.trips.get(tripId);
  const stopTimes = feed.stopTimes.get(tripId);
  if (!trip || !stopTimes || !serviceRuns(feed, trip.serviceId, serviceDate)) return null;

  const realtimeUpdate = feed.realtimeTripUpdates?.get(gtfsRealtimeTripUpdateKey(tripId, serviceDate));
  if (realtimeUpdate?.relationship === 'CANCELED' || realtimeUpdate?.relationship === 'DELETED') return null;
  const dated = realtimeUpdate?.stops.length ? datedTripStops(feed, tripId, serviceDate) : undefined;
  if (dated && dated.stops.length !== stopTimes.length) return null;

  const events = eligibleStopIndexes.map((stopIndex): EligibleTripInstanceStopEvent => {
    const stopTime = stopTimes[stopIndex];
    // The graph caller derives these indexes from `stopTimes.flatMap`, so an
    // invalid index indicates a broken caller invariant. Do not compact the
    // event vector: cursor alignment with `eligibleContexts` depends on it.
    if (!stopTime) throw new RangeError(`eligible stop index ${stopIndex} is outside trip ${tripId}`);
    const scheduledArrivalAt = serviceTimeToUtc(serviceDate, stopTime.arrivalSeconds);
    const scheduledDepartureAt = serviceTimeToUtc(serviceDate, stopTime.departureSeconds);
    const datedStop = dated?.stops[stopIndex];
    const skipped = datedStop?.skipped ?? false;
    return {
      stopIndex,
      stopTime,
      scheduledArrivalAt,
      scheduledDepartureAt,
      arrivalAt: datedStop?.arrivalAt ?? scheduledArrivalAt,
      departureAt: datedStop?.departureAt ?? scheduledDepartureAt,
      skipped,
      updated: datedStop?.updated ?? false,
      canBoard: stopTime.pickupType === 0 && !skipped,
      canAlight: stopTime.dropOffType === 0 && !skipped,
    };
  });
  return {
    events,
    ...(dated ? { datedStops: dated.stops } : {}),
    ...(dated?.update ? { realtimeUpdate: dated.update } : {}),
  };
}

export type GtfsTripLegProjection =
  | { kind: 'leg'; fromCursor: number; toCursor: number; fromEvent: EligibleTripInstanceStopEvent; toEvent: EligibleTripInstanceStopEvent }
  | { kind: 'omitted-beyond-window' };

function hasDifferentOnwardTripAtStop(
  tripIdsByStopId: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  stopId: string,
  currentTripId: string,
): boolean {
  for (const tripId of tripIdsByStopId?.get(stopId) ?? []) if (tripId !== currentTripId) return true;
  return false;
}

/** Shared, deterministic stop-pair eligibility projection for graph and event searches. */
export function* materializeTripInstanceLegs(
  events: readonly EligibleTripInstanceStopEvent[],
  options: {
    tripId: string;
    maximumTransfers: number;
    earliestDeparture: Date;
    journeyEnd: Date;
    destinationStopIds: ReadonlySet<string>;
    queryReachableTransferTripIdsByStopId?: ReadonlyMap<string, ReadonlySet<string>>;
    canBelongToDirectOnlyJourney: (fromStopId: string, toStopId: string) => boolean;
    boardingStopIndex?: number;
  },
): Generator<GtfsTripLegProjection> {
  const requestedCursor = options.boardingStopIndex === undefined
    ? -1 : events.findIndex((event) => event.stopIndex === options.boardingStopIndex);
  const firstCursor = options.boardingStopIndex === undefined ? 0 : requestedCursor;
  const lastCursor = options.boardingStopIndex === undefined ? events.length - 2 : requestedCursor;
  for (let fromCursor = firstCursor; fromCursor >= 0 && fromCursor <= lastCursor; fromCursor++) {
    const fromEvent = events[fromCursor]!;
    const from = fromEvent.stopTime;
    const departureAt = fromEvent.departureAt;
    if (!fromEvent.canBoard || !fromEvent.scheduledDepartureAt || !departureAt
      || departureAt < options.earliestDeparture || departureAt > options.journeyEnd) continue;
    for (let toCursor = fromCursor + 1; toCursor < events.length; toCursor++) {
      const toEvent = events[toCursor]!;
      const to = toEvent.stopTime;
      const hasDifferentOnwardTrip = hasDifferentOnwardTripAtStop(
        options.queryReachableTransferTripIdsByStopId, to.stopId, options.tripId,
      );
      if (options.maximumTransfers > 0 && toCursor > fromCursor + 20
        && !options.destinationStopIds.has(to.stopId)
        && !hasDifferentOnwardTrip) {
        const omittedArrivalAt = toEvent.scheduledArrivalAt;
        if (toEvent.canAlight && to.arrivalSeconds >= from.departureSeconds
          && omittedArrivalAt && omittedArrivalAt >= departureAt && omittedArrivalAt <= options.journeyEnd
          && omittedArrivalAt.getTime() - departureAt.getTime() <= 12 * 60 * 60_000) {
          yield { kind: 'omitted-beyond-window' };
        }
        continue;
      }
      if (!toEvent.canAlight || to.arrivalSeconds < from.departureSeconds
        || !toEvent.scheduledArrivalAt || !toEvent.arrivalAt
        || toEvent.arrivalAt < departureAt || toEvent.arrivalAt > options.journeyEnd
        || toEvent.arrivalAt.getTime() - departureAt.getTime() > 12 * 60 * 60_000
        || !options.canBelongToDirectOnlyJourney(from.stopId, to.stopId)) continue;
      yield { kind: 'leg', fromCursor, toCursor, fromEvent, toEvent };
    }
  }
}

function stopCallsForTrip(feed: GtfsTimetableFeed, tripId: string, fromIndex: number, toIndex: number, serviceDate: string, datedStops?: DatedTripStop[]) {
  const calls = feed.stopTimes.get(tripId)?.slice(fromIndex, toIndex + 1) ?? [];
  const serviceTimeToUtc = createServiceTimeConverter(feed.timezone);
  return calls.flatMap((call, relativeIndex) => {
    const stop = feed.stops.get(call.stopId);
    const datedStop = datedStops?.[fromIndex + relativeIndex];
    const arrivalAt = datedStop?.arrivalAt ?? serviceTimeToUtc(serviceDate, call.arrivalSeconds);
    const departureAt = datedStop?.departureAt ?? serviceTimeToUtc(serviceDate, call.departureSeconds);
    if (!stop || !arrivalAt || !departureAt) return [];
    return [{ id: stop.id, name: call.sourceStopName ?? stop.name,
      coordinates: call.sourceStopCoordinates ?? [stop.lon, stop.lat] as [number, number],
      arrivalAt: arrivalAt.toISOString(), departureAt: departureAt.toISOString(),
      pickupType: datedStop?.skipped ? 1 : call.pickupType, dropOffType: datedStop?.skipped ? 1 : call.dropOffType,
      ...(datedStop?.skipped ? { skipped: true } : {}) }];
  });
}

function datedTripStops(feed: GtfsTimetableFeed, tripId: string, serviceDate: string): { stops: DatedTripStop[]; update?: GtfsRealtimeTripUpdate } {
  const scheduled = feed.stopTimes.get(tripId) ?? [];
  const serviceTimeToUtc = createServiceTimeConverter(feed.timezone);
  const update = feed.realtimeTripUpdates?.get(gtfsRealtimeTripUpdateKey(tripId, serviceDate));
  if (update?.relationship === 'CANCELED' || update?.relationship === 'DELETED') return { stops: [], update };
  const updatesBySequence = new Map((update?.stops ?? []).map((stop) => [stop.stopSequence, stop]));
  let inheritedDelaySeconds: number | undefined;
  const stops = scheduled.flatMap((stopTime): DatedTripStop[] => {
    const scheduledArrival = serviceTimeToUtc(serviceDate, stopTime.arrivalSeconds);
    const scheduledDeparture = serviceTimeToUtc(serviceDate, stopTime.departureSeconds);
    if (!scheduledArrival || !scheduledDeparture) return [];
    const stopUpdate = updatesBySequence.get(stopTime.sequence);
    if (stopUpdate?.relationship === 'NO_DATA') {
      inheritedDelaySeconds = undefined;
      return [{ arrivalAt: scheduledArrival, departureAt: scheduledDeparture, skipped: false, updated: false }];
    }
    const arrivalDelay = stopUpdate?.arrival?.delaySeconds
      ?? (stopUpdate?.arrival?.time ? Math.round((stopUpdate.arrival.time.getTime() - scheduledArrival.getTime()) / 1000) : undefined)
      ?? stopUpdate?.departure?.delaySeconds
      ?? (stopUpdate?.departure?.time ? Math.round((stopUpdate.departure.time.getTime() - scheduledDeparture.getTime()) / 1000) : undefined)
      ?? inheritedDelaySeconds;
    const departureDelay = stopUpdate?.departure?.delaySeconds
      ?? (stopUpdate?.departure?.time ? Math.round((stopUpdate.departure.time.getTime() - scheduledDeparture.getTime()) / 1000) : undefined)
      ?? arrivalDelay;
    const arrivalAt = stopUpdate?.arrival?.time ?? new Date(scheduledArrival.getTime() + (arrivalDelay ?? 0) * 1000);
    const departureAt = stopUpdate?.departure?.time ?? new Date(scheduledDeparture.getTime() + (departureDelay ?? 0) * 1000);
    if (stopUpdate) inheritedDelaySeconds = departureDelay;
    const skipped = stopUpdate?.relationship === 'SKIPPED';
    return [{ arrivalAt, departureAt, skipped,
      updated: skipped || arrivalAt.getTime() !== scheduledArrival.getTime() || departureAt.getTime() !== scheduledDeparture.getTime() }];
  });
  return { stops, ...(update ? { update } : {}) };
}

/** Return one exact trip-instance stop arrival without inferring from another trip or service day. */
export function getGtfsTripStopArrival(feed: GtfsTimetableFeed, tripId: string, routeId: string, serviceDate: string, stopId: string, now = new Date()): {
  status: 'PREDICTED' | 'SCHEDULED' | 'UNAVAILABLE';
  /** Explicit contradictory realtime data must suppress approach highlighting. */
  approachBlocked?: boolean;
  scheduledArrivalAt?: Date;
  predictedArrivalAt?: Date;
  realtimeUpdatedAt?: Date;
} {
  if (!/^\d{8}$/.test(serviceDate) || !tripId || !routeId || !stopId) return { status: 'UNAVAILABLE' };
  const trip = feed.trips.get(tripId);
  if (!trip || trip.routeId !== routeId || !serviceRuns(feed, trip.serviceId, serviceDate)) return { status: 'UNAVAILABLE' };
  const calls = feed.stopTimes.get(tripId) ?? [];
  const callIndex = calls.findIndex((call) => (call.sourceStopId ?? call.stopId) === stopId || call.stopId === stopId);
  if (callIndex < 0) return { status: 'UNAVAILABLE' };
  const call = calls[callIndex];
  const scheduledArrivalAt = createServiceTimeConverter(feed.timezone)(serviceDate, call.arrivalSeconds);
  if (!scheduledArrivalAt) return { status: 'UNAVAILABLE' };

  const update = feed.realtimeTripUpdates?.get(gtfsRealtimeTripUpdateKey(tripId, serviceDate));
  if (update && (update.tripId !== tripId || update.startDate !== serviceDate)) return { status: 'SCHEDULED', scheduledArrivalAt };
  if (update?.relationship === 'CANCELED' || update?.relationship === 'DELETED') return { status: 'UNAVAILABLE', approachBlocked: true };
  if (update) {
    const age = now.getTime() - update.updatedAt.getTime();
    const snapshotAge = now.getTime() - update.feedTimestamp.getTime();
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(age) || !Number.isFinite(snapshotAge)
      || age > 90_000 || snapshotAge > 90_000 || age < -30_000 || snapshotAge < -30_000) {
      return { status: 'SCHEDULED', scheduledArrivalAt };
    }
  }
  if (update && update.relationship !== 'SCHEDULED') return { status: 'SCHEDULED', scheduledArrivalAt, approachBlocked: true };
  if (update?.routeId && update.routeId !== routeId) return { status: 'SCHEDULED', scheduledArrivalAt };
  const staticStopId = call.sourceStopId ?? call.stopId;
  const exactStopSequenceUpdates = update?.stops.filter((item) => item.stopSequence === call.sequence) ?? [];
  const stopUpdate = exactStopSequenceUpdates.find((item) => !item.stopId || item.stopId === staticStopId || item.stopId === call.stopId);
  if (!update || !stopUpdate || stopUpdate.relationship !== 'SCHEDULED') {
    return { status: 'SCHEDULED', scheduledArrivalAt,
      ...(stopUpdate?.relationship !== undefined && stopUpdate.relationship !== 'SCHEDULED' ? { approachBlocked: true } : {}) };
  }
  const arrivalDelay = stopUpdate.arrival?.delaySeconds
    ?? (stopUpdate.arrival?.time ? Math.round((stopUpdate.arrival.time.getTime() - scheduledArrivalAt.getTime()) / 1000) : undefined);
  const predictedArrivalAt = stopUpdate.arrival?.time
    ?? (arrivalDelay !== undefined ? new Date(scheduledArrivalAt.getTime() + arrivalDelay * 1000) : undefined);
  return predictedArrivalAt
    ? { status: 'PREDICTED', scheduledArrivalAt, predictedArrivalAt, realtimeUpdatedAt: update.updatedAt }
    : { status: 'SCHEDULED', scheduledArrivalAt };
}

export function findDirectGtfsJourneys(feed: GtfsTimetableFeed, input: SearchInput): GtfsDirectJourney[] {
  const now = input.now ?? new Date();
  if (!Number.isFinite(input.earliestDeparture.getTime()) || !Number.isFinite(input.latestDeparture.getTime())
    || input.latestDeparture < input.earliestDeparture || input.earliestDeparture < now) return [];
  const radius = input.maximumStopDistanceMeters ?? 2000;
  if (!Number.isFinite(radius) || radius < 100 || radius > 10_000) throw new TypeError('maximum stop distance must be between 100 and 10000 meters');
  const limit = input.limit ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new TypeError('limit must be between 1 and 30');

  const originStops = [...feed.stops.values()].map((stop) => ({ stop, distance: distanceMeters(input.origin, [stop.lon, stop.lat]) }))
    .filter(({ distance }) => distance <= radius).sort((a, b) => a.distance - b.distance).slice(0, MAX_DIRECT_STOPS_PER_SIDE);
  const destinationStops = [...feed.stops.values()].map((stop) => ({ stop, distance: distanceMeters(input.destination, [stop.lon, stop.lat]) }))
    .filter(({ distance }) => distance <= radius).sort((a, b) => a.distance - b.distance).slice(0, MAX_DIRECT_STOPS_PER_SIDE);
  if (originStops.length === 0 || destinationStops.length === 0) return [];
  const originById = new Map(originStops.map((item) => [item.stop.id, item]));
  const destinationById = new Map(destinationStops.map((item) => [item.stop.id, item]));
  const serviceTimeToUtc = createServiceTimeConverter(feed.timezone);
  const serviceDates = gtfsServiceDatesForWindow(feed, input.earliestDeparture, input.latestDeparture, serviceTimeToUtc);
  const results: GtfsDirectJourney[] = [];
  const segmentIndexes = new WeakMap<GtfsDirectJourney, { fromIndex: number; toIndex: number; serviceDate: string }>();
  const originEntriesByTrip = new Map<string, Array<{ index: number; originStopId: string }>>();
  for (const { stop } of originStops) for (const entry of feed.stopTimesByStop.get(stop.id) ?? []) {
    const entries = originEntriesByTrip.get(entry.tripId) ?? [];
    entries.push({ index: entry.index, originStopId: stop.id });
    originEntriesByTrip.set(entry.tripId, entries);
  }
  const searched = new Set<string>();
  for (const [tripId, originEntries] of originEntriesByTrip) {
    const trip = feed.trips.get(tripId);
    if (!trip) continue;
    const stops = feed.stopTimes.get(tripId);
    if (!stops || stops.length < 2) continue;
    const route = feed.routes.get(trip.routeId);
    if (!route) continue;
    for (const serviceDate of serviceDates) {
      if (!serviceRuns(feed, trip.serviceId, serviceDate)) continue;
      for (const originEntry of originEntries) {
        const fromIndex = originEntry.index;
        const from = stops[fromIndex];
        const originMatch = originById.get(originEntry.originStopId);
        // Only ordinary pickup/drop-off is actionable in MARSHGO. GTFS types
        // 2/3 require a separate phone or driver-coordination workflow.
        if (!originMatch || from.pickupType !== 0) continue;
        const departureAt = serviceTimeToUtc(serviceDate, from.departureSeconds);
        if (!departureAt || departureAt < input.earliestDeparture || departureAt > input.latestDeparture) continue;
        let selectedDestination: { toIndex: number; arrivalAt: Date; distance: number } | undefined;
        for (let toIndex = fromIndex + 1; toIndex < stops.length; toIndex++) {
          const to = stops[toIndex];
          const destinationMatch = destinationById.get(to.stopId);
          if (!destinationMatch || to.dropOffType !== 0 || to.arrivalSeconds < from.departureSeconds) continue;
          const arrivalAt = serviceTimeToUtc(serviceDate, to.arrivalSeconds);
          if (!arrivalAt || arrivalAt < departureAt) continue;
          const coordinates = to.sourceStopCoordinates ?? [destinationMatch.stop.lon, destinationMatch.stop.lat] as [number, number];
          const distance = distanceMeters(input.destination, coordinates);
          if (!selectedDestination || distance < selectedDestination.distance
            || (distance === selectedDestination.distance && arrivalAt < selectedDestination.arrivalAt)) {
            selectedDestination = { toIndex, arrivalAt, distance };
          }
        }
        if (!selectedDestination) continue;
        const toIndex = selectedDestination.toIndex;
        const to = stops[toIndex];
        const destinationMatch = destinationById.get(to.stopId);
        if (!destinationMatch) continue;
        const arrivalAt = selectedDestination.arrivalAt;
          const resultKey = `${tripId}:${from.stopId}:${to.stopId}:${departureAt.toISOString()}`;
          if (searched.has(resultKey)) continue;
          searched.add(resultKey);
          const originCoordinates = from.sourceStopCoordinates ?? [originMatch.stop.lon, originMatch.stop.lat] as [number, number];
          const destinationCoordinates = to.sourceStopCoordinates ?? [destinationMatch.stop.lon, destinationMatch.stop.lat] as [number, number];
          const result: GtfsDirectJourney = { providerId: input.providerId, providerName: input.providerName,
            ...(feed.providersByRoute?.get(trip.routeId)?.city ? { providerCity: feed.providersByRoute.get(trip.routeId)!.city } : {}), mode: route.mode,
            routeId: trip.routeId, routeName: route.name, headsign: trip.headsign, tripId,
            originStop: { id: originMatch.stop.id, name: from.sourceStopName ?? originMatch.stop.name, coordinates: originCoordinates },
            destinationStop: { id: destinationMatch.stop.id, name: to.sourceStopName ?? destinationMatch.stop.name, coordinates: destinationCoordinates },
            originTransferNodeIds: [from.sourceStopId ?? from.stopId, ...(from.sourceParentStationId ? [from.sourceParentStationId] : [])],
            destinationTransferNodeIds: [to.sourceStopId ?? to.stopId, ...(to.sourceParentStationId ? [to.sourceParentStationId] : [])],
            transportType: route.transportType, serviceDate,
            scheduledDepartureAt: departureAt, scheduledArrivalAt: arrivalAt,
            departureAt, arrivalAt, sourceFreshAt: feed.fetchedAt,
            distanceToOriginStopMeters: Math.round(distanceMeters(input.origin, originCoordinates)),
            distanceFromDestinationStopMeters: Math.round(distanceMeters(input.destination, destinationCoordinates)),
            ...(from.sourceZoneId ? { originZoneId: from.sourceZoneId } : {}),
            ...(to.sourceZoneId ? { destinationZoneId: to.sourceZoneId } : {}),
            scheduleSemantics: route.scheduleSemantics ?? 'published_departures',
            traveledZoneIds: stops.slice(fromIndex, toIndex + 1).flatMap((entry) => {
              const zoneId = entry.sourceZoneId;
              return zoneId ? [zoneId] : [];
            }),
          };
          segmentIndexes.set(result, { fromIndex, toIndex, serviceDate });
          results.push(result);
      }
    }
  }
  const selected = [...new Map(results.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime() || a.departureAt.getTime() - b.departureAt.getTime())
    .map((journey) => [`${journey.providerId}:${journey.tripId}:${journey.originStop.id}:${journey.destinationStop.id}:${journey.departureAt.toISOString()}`, journey])).values()].slice(0, limit);
  for (const journey of selected) {
    const indexes = segmentIndexes.get(journey);
    if (!indexes) continue;
    journey.routeGeometry = routeGeometryForTrip(feed, journey.tripId, indexes.fromIndex, indexes.toIndex);
    journey.stops = stopCallsForTrip(feed, journey.tripId, indexes.fromIndex, indexes.toIndex, indexes.serviceDate);
  }
  return selected;
}

/**
 * Build scheduled itineraries with up to five transit legs. Transfers are
 * composed at the same stop, including conservatively matched stops across
 * feeds. Walking to and from the first/last stop uses a conservative straight-
 * line estimate and is surfaced separately in the result.
 */
export function findGtfsItinerariesWithStats(
  feed: GtfsTimetableFeed,
  input: GtfsItinerarySearchInput,
  graphLimits: GtfsGraphBudgetLimits = {},
  observeCandidateGraph?: GtfsCandidateGraphObserver,
): GtfsItinerarySearchResult {
  const debugStartedAt = Date.now();
  const debugStage = (stage: string, details: Record<string, number | string> = {}) => {
    if (process.env.MARSHGO_GTFS_SEARCH_DEBUG === '1') {
      const memory = process.memoryUsage();
      console.info(JSON.stringify({ event: 'gtfs.search.debug', stage, elapsedMs: Date.now() - debugStartedAt,
        heapUsedBytes: memory.heapUsed, rssBytes: memory.rss, ...details }));
    }
  };
  const debugTraceTripChains = process.env.MARSHGO_GTFS_SEARCH_DEBUG === '1'
    ? (process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS ?? '').split('|')
      .filter((tripChain) => tripChain.length > 0 && tripChain.length <= 512).slice(0, 16)
    : [];
  const debugTraceTripChainSet = debugTraceTripChains.length > 0 ? new Set(debugTraceTripChains) : undefined;
  const debugCompletedTripChains = debugTraceTripChains.length > 0 ? new Set<string>() : undefined;
  const debugGeneratedTripChains = debugTraceTripChains.length > 0 ? new Set<string>() : undefined;
  const debugTraceCandidateTrips = process.env.MARSHGO_GTFS_SEARCH_DEBUG === '1'
    ? [...new Set((process.env.MARSHGO_GTFS_SEARCH_TRACE_CANDIDATE_TRIPS ?? '')
      .split(',').map((tripId) => tripId.trim())
      .filter((tripId) => tripId.length > 0 && tripId.length <= 128))].slice(0, 2)
    : [];
  const debugTraceCandidateTripSet = debugTraceCandidateTrips.length > 0 ? new Set(debugTraceCandidateTrips) : undefined;
  const debugCandidateTraceTargetPairs = new Set(['30617_0_1:4767:4768', '30617_0_1:44250:4595']);
  const debugSearch = process.env.MARSHGO_GTFS_SEARCH_DEBUG === '1';
  let debugEarliestQueryArrivalCalls = 0;
  let debugOnwardArrivalWeakMapHits = 0;
  let debugOnwardArrivalStringCacheHits = 0;
  let debugReachableStopSetBuilds = 0;
  let debugDestinationEventsScanned = 0;
  let debugConnectorCandidatesInspected = 0;
  let debugConnectorReservoirSorts = 0;
  let debugConnectorReservoirItemsInspected = 0;
  const debugTripChainsIn = (candidates: readonly GtfsItinerary[]) => {
    const found = new Set<string>();
    if (!debugTraceTripChainSet) return found;
    for (const itinerary of candidates) {
      const tripChain = itinerary.segments.map((segment) =>
        `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>');
      if (debugTraceTripChainSet.has(tripChain)) found.add(tripChain);
    }
    return found;
  };
  const now = input.now ?? new Date();
  const maximumJourneySeconds = input.maximumJourneySeconds ?? 24 * 60 * 60;
  const maximumTransfers = input.maximumTransfers ?? MAX_GTFS_TRANSFERS;
  const minimumTransferBufferSeconds = input.minimumTransferBufferSeconds ?? DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS;
  const maximumWaitSeconds = input.maximumWaitSeconds ?? 4 * 60 * 60;
  const maximumGraphSegments = graphLimits.totalSegments ?? MAX_GTFS_GRAPH_SEGMENTS;
  const maximumGraphSegmentsPerRoute = graphLimits.segmentsPerRoute ?? MAX_GTFS_GRAPH_SEGMENTS_PER_ROUTE;
  const maximumRouteOverflowConnectors = graphLimits.maxRouteOverflowConnectors ?? MAX_ROUTE_OVERFLOW_CONNECTORS;
  if (!Number.isSafeInteger(maximumRouteOverflowConnectors) || maximumRouteOverflowConnectors < 1) {
    throw new RangeError('maxRouteOverflowConnectors must be a positive safe integer');
  }
  // Keep the older common radius as an explicit override for callers that
  // still use it. Production search uses the distinct access/egress values.
  const accessRadius = input.maximumAccessWalkingMeters ?? input.maximumStopDistanceMeters ?? DEFAULT_MAX_ACCESS_WALKING_METERS;
  const egressRadius = input.maximumEgressWalkingMeters ?? input.maximumStopDistanceMeters ?? DEFAULT_MAX_EGRESS_WALKING_METERS;
  const transferRadius = input.maximumTransferWalkingMeters ?? DEFAULT_MAX_TRANSFER_WALKING_METERS;
  const limit = input.limit ?? 20;
  if (!Number.isFinite(input.earliestDeparture.getTime()) || !Number.isFinite(input.latestDeparture.getTime())
    || input.latestDeparture < input.earliestDeparture || input.earliestDeparture < now
    || !Number.isInteger(maximumJourneySeconds) || maximumJourneySeconds < 60 || maximumJourneySeconds > 7 * 24 * 60 * 60
    || !Number.isInteger(maximumTransfers) || maximumTransfers < 0 || maximumTransfers > MAX_GTFS_TRANSFERS
    || !Number.isInteger(minimumTransferBufferSeconds) || minimumTransferBufferSeconds < 0 || minimumTransferBufferSeconds > 7200
    || !Number.isInteger(maximumWaitSeconds) || maximumWaitSeconds < 0 || maximumWaitSeconds > maximumJourneySeconds
    || !Number.isFinite(accessRadius) || accessRadius < 100 || accessRadius > 10_000
    || !Number.isFinite(egressRadius) || egressRadius < 100 || egressRadius > 10_000
    || !Number.isFinite(transferRadius) || transferRadius < 0 || transferRadius > 10_000
    || !Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(maximumGraphSegments) || maximumGraphSegments < 1 || maximumGraphSegments > MAX_GTFS_GRAPH_SEGMENTS
    || !Number.isSafeInteger(maximumGraphSegmentsPerRoute) || maximumGraphSegmentsPerRoute < 1
    || maximumGraphSegmentsPerRoute > MAX_GTFS_GRAPH_SEGMENTS_PER_ROUTE) {
    throw new TypeError('GTFS itinerary search bounds are invalid');
  }
  const transferDecisionContext = createGtfsTransferDecisionContext({ feed, transferRadius, minimumTransferBufferSeconds });
  const { decide: transferDecision, transferRuleFor, pathwayNodes, reachablePathwayNodes, pathwayConnection } = transferDecisionContext;

  let stopSelectionTruncated = false;
  const closestStops = (point: [number, number], radius: number) => {
    const ranked = [...feed.stops.values()]
      .filter((stop) => feed.stopTimesByStop.has(stop.id))
      .map((stop) => ({ stop, distance: distanceMeters(point, [stop.lon, stop.lat]) }))
      .filter(({ distance }) => distance <= radius)
      .sort((a, b) => a.distance - b.distance);
    const selected = new Map<string, typeof ranked[number]>();
    const selectedByRoutePattern = new Map<string, number>();
    const routePatternsByStop = new Map<string, Set<string>>();
    const routePatternsAtStop = (stopId: string) => {
      const cached = routePatternsByStop.get(stopId);
      if (cached) return cached;
      const routePatterns = new Set<string>();
      for (const entry of feed.stopTimesByStop.get(stopId) ?? []) {
        const trip = feed.trips.get(entry.tripId);
        if (trip && feed.routes.has(trip.routeId)) {
          // GTFS route_id can contain both directions and branched headsigns.
          // Counting only route_id lets the nearest stops crowd out every
          // stop on the reverse direction before candidate generation starts.
          routePatterns.add(`${trip.routeId}:${trip.directionId ?? ''}:${trip.headsign.trim()}`);
        }
      }
      routePatternsByStop.set(stopId, routePatterns);
      return routePatterns;
    };
    const addSelected = (item: typeof ranked[number]) => {
      selected.set(item.stop.id, item);
      for (const routePattern of routePatternsAtStop(item.stop.id)) {
        selectedByRoutePattern.set(routePattern, (selectedByRoutePattern.get(routePattern) ?? 0) + 1);
      }
    };

    // Preserve nearby alternatives, then add stops that expose a route not
    // represented by those nearest stops. A mode-only cap discarded distinct
    // bus/tram routes whenever the closest stops were already served by that
    // same mode, including routes whose first useful stop ranked 21st.
    for (const item of ranked.slice(0, MAX_NEAREST_STOPS_PER_SIDE)) addSelected(item);
    for (const item of ranked) {
      if (selected.has(item.stop.id)) continue;
      const addsRoutePatternCoverage = [...routePatternsAtStop(item.stop.id)]
        .some((pattern) => (selectedByRoutePattern.get(pattern) ?? 0) < MAX_STOPS_PER_ROUTE_PATTERN);
      if (!addsRoutePatternCoverage) continue;
      if (selected.size >= MAX_STOPS_PER_SIDE) { stopSelectionTruncated = true; break; }
      addSelected(item);
    }
    if (selected.size < ranked.length) stopSelectionTruncated = true;
    return [...selected.values()];
  };
  const originStops = closestStops(input.origin, accessRadius);
  const destinationStops = closestStops(input.destination, egressRadius);
  debugStage('stops-selected', { originStops: originStops.length, destinationStops: destinationStops.length });
  if (!originStops.length || !destinationStops.length) {
    return { itineraries: [], searchTruncated: false, resultLimitReached: false, candidateGraphTruncated: false,
      truncation: { stopSelection: false, candidateGraph: false, searchBudget: false,
        searchStepLimit: false, candidatePoolLimit: false, candidateSampling: false, responsePage: false } };
  }

  const routeDistance = distanceMeters(input.origin, input.destination);
  // Urban searches do not need to admit nearly every stop in a city as a
  // candidate edge. Keep the wider corridor for intercity feeds and allow a
  // bounded local detour for city trips.
  const corridorWidth = routeDistance > 30_000
    ? Math.max(12_000, Math.min(60_000, routeDistance * 0.2))
    : Math.max(2_500, Math.min(8_000, routeDistance * 0.25));
  const originLat = (input.origin[1] + input.destination[1]) / 2;
  const toXY = ([lon, lat]: [number, number]) => [lon * 111_320 * Math.cos(originLat * Math.PI / 180), lat * 110_574] as const;
  const [ax, ay] = toXY(input.origin), [bx, by] = toXY(input.destination);
  const corridorStops = new Set<string>();
  for (const stop of feed.stops.values()) {
    const [px, py] = toXY([stop.lon, stop.lat]);
    const dx = bx - ax, dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    const nearestX = ax + t * dx, nearestY = ay + t * dy;
    if (Math.hypot(px - nearestX, py - nearestY) <= corridorWidth) corridorStops.add(stop.id);
  }
  originStops.forEach(({ stop }) => corridorStops.add(stop.id));
  destinationStops.forEach(({ stop }) => corridorStops.add(stop.id));

  // For an intercity query, city feeds should contribute first/last-mile links
  // and links around intercity stations. Scanning every urban trip inside a
  // 10+ km corridor creates millions of irrelevant stop-pair edges (and can
  // exhaust the API heap), even when the route only touches that city at one
  // endpoint. Keep the urban graph around endpoints and actual rail/intercity
  // bus stops, while national feeds continue to use the full route corridor.
  const intercitySearch = routeDistance > 30_000;
  const localCityCatchmentStops = new Set<string>([
    ...originStops.map(({ stop }) => stop.id),
    ...destinationStops.map(({ stop }) => stop.id),
  ]);
  if (intercitySearch) {
    const anchorPoints = new Map<string, [number, number]>();
    for (const [tripId, trip] of feed.trips) {
      const route = feed.routes.get(trip.routeId);
      const providerCity = feed.providersByRoute?.get(trip.routeId)?.city ?? input.providerCity;
      const transportType = route?.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route?.transportType;
      if (!transportType || !['train', 'suburban_train', 'intercity_bus'].includes(transportType)) continue;
      for (const stopTime of feed.stopTimes.get(tripId) ?? []) {
        if (!corridorStops.has(stopTime.stopId)) continue;
        const stop = feed.stops.get(stopTime.stopId);
        const coordinates = stopTime.sourceStopCoordinates ?? (stop ? [stop.lon, stop.lat] as [number, number] : undefined);
        if (coordinates) anchorPoints.set(stopTime.stopId, coordinates);
      }
    }

    const anchorCellSizeMeters = 2_500;
    const anchorCells = new Map<string, Array<[number, number]>>();
    for (const point of anchorPoints.values()) {
      const [x, y] = toXY(point);
      const key = `${Math.floor(x / anchorCellSizeMeters)}:${Math.floor(y / anchorCellSizeMeters)}`;
      const points = anchorCells.get(key) ?? [];
      points.push(point);
      anchorCells.set(key, points);
    }
    let excludedCityStops = false;
    for (const stop of feed.stops.values()) {
      if (!corridorStops.has(stop.id) || !feed.stopTimesByStop.has(stop.id)) continue;
      const coordinates: [number, number] = [stop.lon, stop.lat];
      const nearEndpoint = Math.min(distanceMeters(input.origin, coordinates), distanceMeters(input.destination, coordinates)) <= anchorCellSizeMeters;
      const [x, y] = toXY(coordinates);
      const cellX = Math.floor(x / anchorCellSizeMeters), cellY = Math.floor(y / anchorCellSizeMeters);
      let nearIntercityStop = false;
      for (let dx = -1; dx <= 1 && !nearIntercityStop; dx++) {
        for (let dy = -1; dy <= 1 && !nearIntercityStop; dy++) {
          for (const anchor of anchorCells.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
            if (distanceMeters(coordinates, anchor) <= anchorCellSizeMeters) {
              nearIntercityStop = true;
              break;
            }
          }
        }
      }
      if (nearEndpoint || nearIntercityStop) localCityCatchmentStops.add(stop.id);
      else excludedCityStops = true;
    }
    if (excludedCityStops) stopSelectionTruncated = true;
  }

  const journeyEnd = new Date(input.earliestDeparture.getTime() + maximumJourneySeconds * 1000);
  const maxFirstDeparture = input.latestDeparture.getTime();
  const serviceTimeToUtc = createServiceTimeConverter(feed.timezone);
  const serviceDates = new Set(gtfsServiceDatesForWindow(feed, input.earliestDeparture, journeyEnd, serviceTimeToUtc));

  const originStopIds = new Set(originStops.map(({ stop }) => stop.id));
  const destinationStopIds = new Set(destinationStops.map(({ stop }) => stop.id));
  // With zero transfers, every returned itinerary must be one scheduled
  // segment between these selected access and egress stops. Exclude other
  // pairs before graph budgeting so impossible alternatives cannot mark this
  // complete direct-only query as truncated.
  const canBelongToDirectOnlyJourney = (fromStopId: string, toStopId: string) => maximumTransfers !== 0
    || (originStopIds.has(fromStopId) && destinationStopIds.has(toStopId));
  const transferNodeIds = new Set<string>([
    ...(feed.transfers ?? []).flatMap((rule) => [rule.fromStopId, rule.toStopId]),
    ...(feed.pathways ?? []).flatMap((pathway) => [pathway.fromStopId, pathway.toStopId]),
  ]);
  const routesByStop = new Map<string, Set<string>>();
  const routesByParentStation = new Map<string, Set<string>>();
  const interchangeStopIds = new Set<string>([...originStopIds, ...destinationStopIds]);
  for (const [stopId, entries] of feed.stopTimesByStop) {
    const routeIds = new Set<string>();
    const stop = feed.stops.get(stopId);
    for (const entry of entries) {
      const trip = feed.trips.get(entry.tripId);
      if (trip) routeIds.add(trip.routeId);
      const stopTime = feed.stopTimes.get(entry.tripId)?.[entry.index];
      if (transferNodeIds.has(stopId) || transferNodeIds.has(stopTime?.sourceStopId ?? '')
        || transferNodeIds.has(stopTime?.sourceParentStationId ?? '')
        || transferNodeIds.has(stop?.parentStation ?? '')) interchangeStopIds.add(stopId);
    }
    routesByStop.set(stopId, routeIds);
    if (routeIds.size > 1) interchangeStopIds.add(stopId);
    if (stop?.parentStation) {
      const routes = routesByParentStation.get(stop.parentStation) ?? new Set<string>();
      for (const routeId of routeIds) routes.add(routeId);
      routesByParentStation.set(stop.parentStation, routes);
    }
  }
  // A trip endpoint alone is not a transfer node. Add a stop only when a
  // second route, explicit GTFS transfer/pathway, shared station, or measured
  // nearby cross-route platform can connect there; isolated termini otherwise
  // inflate a bounded graph with edges the passenger cannot use to change lines.
  // A valid transfer can be between two distinct nearby stop IDs when a feed
  // does not publish a transfers.txt rule. Add those stops to the candidate
  // graph using the configured walk shed, but keep the exact GTFS/pathway and
  // transfer-rule checks in transferDecision as the final feasibility gate.
  // The grid is over stop IDs, not hundreds of thousands of trip segments.
  const transferCellMeters = Math.max(100, transferRadius);
  const transferCell = (coordinates: [number, number]) => {
    const [lon, lat] = coordinates;
    const x = lon * 111_320 * Math.cos(lat * Math.PI / 180);
    const y = lat * 111_132;
    return [Math.floor(x / transferCellMeters), Math.floor(y / transferCellMeters)] as const;
  };
  const stopIdsByTransferCell = new Map<string, string[]>();
  for (const [stopId, routeIds] of routesByStop) {
    if (!routeIds.size) continue;
    const stop = feed.stops.get(stopId);
    if (!stop) continue;
    const [x, y] = transferCell([stop.lon, stop.lat]);
    const key = `${x}:${y}`;
    const ids = stopIdsByTransferCell.get(key) ?? [];
    ids.push(stopId);
    stopIdsByTransferCell.set(key, ids);
  }
  for (const [stopId, routeIds] of routesByStop) {
    if (!routeIds.size) continue;
    const stop = feed.stops.get(stopId);
    if (!stop) continue;
    const [cellX, cellY] = transferCell([stop.lon, stop.lat]);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const nearbyStopId of stopIdsByTransferCell.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
        if (nearbyStopId <= stopId) continue;
        const nearby = feed.stops.get(nearbyStopId);
        const nearbyRouteIds = routesByStop.get(nearbyStopId);
        if (!nearby || !nearbyRouteIds?.size || ![...routeIds].some((routeId) => !nearbyRouteIds.has(routeId))) continue;
        if (distanceMeters([stop.lon, stop.lat], [nearby.lon, nearby.lat]) > transferRadius) continue;
        interchangeStopIds.add(stopId);
        interchangeStopIds.add(nearbyStopId);
      }
    }
  }
  for (const [stopId, stop] of feed.stops) {
    if (stop.parentStation && (routesByParentStation.get(stop.parentStation)?.size ?? 0) > 1) {
      interchangeStopIds.add(stopId);
    }
  }
  debugStage('corridor-selected', { corridorStops: corridorStops.size, interchangeStops: interchangeStopIds.size,
    corridorWidthMeters: Math.round(corridorWidth) });

  const segmentsByRoute = new Map<string, RetainedGtfsTrip[]>();
  const retainedSegmentCountByRoute = new Map<string, number>();
  const overflowSegmentsByRoute = new Map<string, BoundedBestK<RetainedGtfsSegment>>();
  const overflowConnectorsByRoute = new Map<string, BoundedBestK<RetainedGtfsSegment>>();
  const retainedCandidateKey = (candidate: RetainedGtfsSegment) =>
    `${candidate.providerId}\u0000${candidate.serviceDate}\u0000${candidate.tripId}\u0000${candidate.originContext.details.id}\u0000${candidate.destinationContext.details.id}\u0000${candidate.departureAt.getTime()}\u0000${candidate.arrivalAt.getTime()}`;
  const candidateStopCountByRoute = new Map<string, number>();
  for (const [stopId, routeIds] of routesByStop) {
    if (!interchangeStopIds.has(stopId)) continue;
    for (const routeId of routeIds) {
      const route = feed.routes.get(routeId);
      if (!route || (input.allowedModes && !input.allowedModes.includes(route.mode))) continue;
      const providerCity = feed.providersByRoute?.get(routeId)?.city ?? input.providerCity;
      const transportType = route.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route.transportType;
      if (input.allowedTransportTypes && !journeyTransportTypeSelected(transportType, input.allowedTransportTypes)) continue;
      const eligibleStops = intercitySearch && providerCity !== undefined && providerCity !== 'Україна'
        ? localCityCatchmentStops : corridorStops;
      if (!eligibleStops.has(stopId)) continue;
      candidateStopCountByRoute.set(routeId, (candidateStopCountByRoute.get(routeId) ?? 0) + 1);
    }
  }
  // Weight route budgets by eligible service volume and stop-pair opportunity.
  // Equal shares waste most of the global graph limit on low-frequency lines,
  // while a single busy corridor can hit its share and truncate useful trips.
  const candidateDemandByRoute = new Map<string, number>();
  // Query-specific scheduled access/egress events let graph retention prefer
  // transfer trips that can actually join a first/last leg. These are only a
  // retention signal: the normal transferDecision remains the final authority
  // for GTFS rules, pathway topology, walking distance and buffers.
  const candidatePairDemandByTrip = new Map<string, number>();
  type QueryReachabilityEvent = {
    key: string;
    at: number;
    journeyArrivalAt?: number;
    providerId: string;
    tripId: string;
    routeId: string;
    stopId: string;
    canonicalStopId: string;
    pathwayStopId: string;
    nodeIds: string[];
  };
  const originReachableArrivalsByNode = new Map<string, QueryReachabilityEvent[]>();
  const destinationReachableDeparturesByNode = new Map<string, QueryReachabilityEvent[]>();
  const seenOriginRetentionEventsByNode = new Map<string, Set<string>>();
  const seenDestinationRetentionEventsByNode = new Map<string, Set<string>>();
  const retentionTransferRulesByFromNode = new Map<string, GtfsTransferRule[]>();
  for (const rule of feed.transfers ?? []) {
    const rules = retentionTransferRulesByFromNode.get(rule.fromStopId) ?? [];
    rules.push(rule);
    retentionTransferRulesByFromNode.set(rule.fromStopId, rules);
  }
  const retentionTransferNodes = (entry: NonNullable<GtfsTimetableFeed['stopTimes'] extends Map<string, (infer T)[]> ? T : never>) => {
    const primary = entry.sourceStopId ?? entry.stopId;
    // Keep parent station IDs for matching station-level transfer rules. Event
    // lookup itself is indexed only by the exact physical stop below.
    return entry.sourceParentStationId && entry.sourceParentStationId !== primary
      ? [primary, entry.sourceParentStationId] : [primary];
  };
  const addRetentionEvent = (
    events: Map<string, QueryReachabilityEvent[]>,
    seenEventsByNode: Map<string, Set<string>>,
    entry: NonNullable<GtfsTimetableFeed['stopTimes'] extends Map<string, (infer T)[]> ? T : never>,
    at: Date,
    tripId: string,
    routeId: string,
    journeyArrivalAt?: Date,
  ) => {
    const nodeIds = retentionTransferNodes(entry);
    const stopId = entry.sourceStopId ?? entry.stopId;
    const atMs = at.getTime();
    const eventKey = `${tripId}\u0000${stopId}\u0000${atMs}`;
    const event = { key: eventKey, at: atMs,
      ...(journeyArrivalAt ? { journeyArrivalAt: journeyArrivalAt.getTime() } : {}),
      providerId: feed.providersByRoute?.get(routeId)?.id ?? input.providerId,
      tripId, routeId, stopId, canonicalStopId: entry.stopId, pathwayStopId: stopId, nodeIds };
    for (const nodeId of new Set([stopId, entry.stopId])) {
      const seen = seenEventsByNode.get(nodeId) ?? new Set<string>();
      if (seen.has(eventKey)) continue;
      seen.add(eventKey);
      seenEventsByNode.set(nodeId, seen);
      const values = events.get(nodeId) ?? [];
      values.push(event);
      events.set(nodeId, values);
    }
  };
  const retentionRuleFor = (
    fromNodeIds: readonly string[], toNodeIds: readonly string[],
    fromTripId: string, toTripId: string, fromRouteId: string, toRouteId: string,
  ): { rule: GtfsTransferRule | null; ambiguous: boolean } => {
    if (retentionTransferRulesByFromNode.size === 0) return { rule: null, ambiguous: false };
    const candidates = new Set<GtfsTransferRule>();
    for (const nodeId of fromNodeIds) {
      for (const rule of retentionTransferRulesByFromNode.get(nodeId) ?? []) candidates.add(rule);
    }
    const matches = [...candidates].filter((rule) => fromNodeIds.includes(rule.fromStopId)
      && toNodeIds.includes(rule.toStopId)
      && (!rule.fromTripId || rule.fromTripId === fromTripId)
      && (!rule.toTripId || rule.toTripId === toTripId)
      && (!rule.fromRouteId || rule.fromRouteId === fromRouteId)
      && (!rule.toRouteId || rule.toRouteId === toRouteId));
    if (!matches.length) return { rule: null, ambiguous: false };
    const specificity = (rule: GtfsTransferRule) => rule.fromTripId && rule.toTripId ? 6
      : (rule.fromTripId && rule.toRouteId) || (rule.fromRouteId && rule.toTripId) ? 5
      : rule.fromTripId || rule.toTripId ? 4
      : rule.fromRouteId && rule.toRouteId ? 3
      : rule.fromRouteId || rule.toRouteId ? 2 : 1;
    const max = Math.max(...matches.map(specificity));
    const best = matches.filter((rule) => specificity(rule) === max);
    const signatures = new Set(best.map((rule) => `${rule.transferType}:${rule.minTransferTimeSeconds ?? ''}`));
    return signatures.size > 1 ? { rule: null, ambiguous: true } : { rule: best[0]!, ambiguous: false };
  };
  const retentionTransportType = (routeId: string): GtfsTransportType | undefined => {
    const route = feed.routes.get(routeId);
    const providerCity = feed.providersByRoute?.get(routeId)?.city ?? input.providerCity;
    return route?.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route?.transportType;
  };
  const retentionRequiredTransferSeconds = (previousRouteId: string, nextRouteId: string,
    walkingSeconds: number, minimumGapSeconds: number, rule: GtfsTransferRule | null) => {
    if (rule?.transferType === 4) return 0;
    const previousType = retentionTransportType(previousRouteId);
    const nextType = retentionTransportType(nextRouteId);
    const modeBuffer = previousType === 'train' || previousType === 'intercity_bus'
      || nextType === 'train' || nextType === 'intercity_bus' ? MINIMUM_INTERCITY_TRANSFER_BUFFER_SECONDS
      : previousType === 'suburban_train' || nextType === 'suburban_train' ? MINIMUM_SUBURBAN_TRANSFER_BUFFER_SECONDS
        : DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS;
    const requiredWithWalking = Math.max(minimumGapSeconds, modeBuffer) + walkingSeconds;
    return rule?.transferType === 2
      ? Math.max(requiredWithWalking, rule.minTransferTimeSeconds ?? 0)
      : requiredWithWalking;
  };
  for (const [tripId, trip] of feed.trips) {
    const candidateStops = candidateStopCountByRoute.get(trip.routeId) ?? 0;
    if (candidateStops < 2) continue;
    const stops = feed.stopTimes.get(tripId);
    if (!stops || stops.length < 2) continue;
    const providerCity = feed.providersByRoute?.get(trip.routeId)?.city ?? input.providerCity;
    const eligibleStopIds = intercitySearch && providerCity !== undefined && providerCity !== 'Україна'
      ? localCityCatchmentStops : corridorStops;
    const eligibleIndexes = stops.flatMap((stopTime, index) => eligibleStopIds.has(stopTime.stopId)
      && interchangeStopIds.has(stopTime.stopId) ? [index] : []);
    if (eligibleIndexes.length < 2) continue;
    let pairOpportunities = 0;
    for (const serviceDate of serviceDates) {
      const tripEvents = eligibleTripInstanceStopEvents(feed, tripId, serviceDate, eligibleIndexes, serviceTimeToUtc);
      if (!tripEvents) continue;
      for (let fromCursor = 0; fromCursor < tripEvents.events.length - 1; fromCursor++) {
        const fromEvent = tripEvents.events[fromCursor];
        const from = fromEvent.stopTime;
        if (!fromEvent.canBoard) continue;
        const departureAt = fromEvent.departureAt;
        if (!departureAt || departureAt < input.earliestDeparture || departureAt > journeyEnd) continue;
        // Mirror the graph's bounded forward stop-pair policy without
        // materializing candidate segment objects. Always retain a query
        // destination beyond the local transfer window; otherwise a long
        // direct ride can disappear merely because its line passes many
        // interchange-capable stops.
        for (let toCursor = fromCursor + 1; toCursor < tripEvents.events.length; toCursor++) {
          const toEvent = tripEvents.events[toCursor];
          const to = toEvent.stopTime;
          if (toCursor > fromCursor + 20 && !destinationStopIds.has(to.stopId)) continue;
          if (!toEvent.canAlight || to.arrivalSeconds < from.departureSeconds) continue;
          const arrivalAt = toEvent.arrivalAt;
          if (!arrivalAt || arrivalAt < departureAt || arrivalAt > journeyEnd
            || arrivalAt.getTime() - departureAt.getTime() > 12 * 60 * 60_000) continue;
          if (!canBelongToDirectOnlyJourney(from.stopId, to.stopId)) continue;
          if (originStopIds.has(from.stopId) && interchangeStopIds.has(to.stopId)) {
            const fromStop = feed.stops.get(from.stopId);
            const coordinates = from.sourceStopCoordinates ?? (fromStop ? [fromStop.lon, fromStop.lat] as [number, number] : null);
            const accessSeconds = coordinates ? Math.ceil(distanceMeters(input.origin, coordinates) / 1.25) : Infinity;
            if (departureAt.getTime() <= maxFirstDeparture
              && departureAt.getTime() >= input.earliestDeparture.getTime() + accessSeconds * 1000) {
              addRetentionEvent(originReachableArrivalsByNode, seenOriginRetentionEventsByNode, to, arrivalAt, tripId, trip.routeId);
            }
          }
          if (interchangeStopIds.has(from.stopId) && destinationStopIds.has(to.stopId)) {
            addRetentionEvent(destinationReachableDeparturesByNode, seenDestinationRetentionEventsByNode,
              from, departureAt, tripId, trip.routeId, arrivalAt);
          }
          pairOpportunities++;
        }
      }
    }
    if (pairOpportunities === 0) continue;
    const boundedPairOpportunities = Math.min(maximumGraphSegmentsPerRoute, pairOpportunities);
    candidatePairDemandByTrip.set(tripId, boundedPairOpportunities);
    candidateDemandByRoute.set(trip.routeId,
      (candidateDemandByRoute.get(trip.routeId) ?? 0) + boundedPairOpportunities);
  }
  // A national feed can produce a very large number of stop-pair candidates.
  // Keep only the stop-time indexes during graph construction and materialize
  // route shapes for the small set of itineraries that will actually be shown.
  const shapeIndexesBySegment = new WeakMap<GtfsDirectJourney, { fromIndex: number; toIndex: number; serviceDate: string }>();
  const firstLegAccessSecondsBySegment = new WeakMap<GtfsDirectJourney, number>();
  const sortedRetentionEvents = (events: Map<string, QueryReachabilityEvent[]>) => new Map([...events]
    .map(([nodeId, values]) => [nodeId, values.sort((a, b) => a.at - b.at
      || compareStableId(a.tripId, b.tripId) || compareStableId(a.stopId, b.stopId))] as const));
  const originRetentionEvents = sortedRetentionEvents(originReachableArrivalsByNode);
  const destinationRetentionEvents = sortedRetentionEvents(destinationReachableDeparturesByNode);
  const destinationRetentionEventsByReachableStop = new Map<string, QueryReachabilityEvent[]>();
  const bestPathwayMeasure = (fromStopIds: readonly string[], toStopIds: readonly string[]) => fromStopIds
    .flatMap((fromStopId) => toStopIds.map((toStopId) => pathwayConnection(fromStopId, toStopId)))
    .filter((measure): measure is GtfsTransferMeasure => Boolean(measure) && typeof measure === 'object')
    .sort((left, right) => left.walkingSeconds - right.walkingSeconds || left.walkingMeters - right.walkingMeters)[0] ?? false;
  const indexRetentionEvent = (events: Map<string, QueryReachabilityEvent[]>, indexed: Map<string, Set<string>>,
    event: QueryReachabilityEvent, reachableStopId: string) => {
    let indexedStops = indexed.get(event.key);
    if (indexedStops?.has(reachableStopId)) return;
    if (!indexedStops) {
      indexedStops = new Set<string>();
      indexed.set(event.key, indexedStops);
    }
    indexedStops.add(reachableStopId);
    const reachableEvents = events.get(reachableStopId) ?? [];
    reachableEvents.push(event);
    events.set(reachableStopId, reachableEvents);
  };
  // Index pathway-connected arrival events by every directed platform they can
  // reach, so a different platform stop ID can participate in the bounded
  // retention hint without scanning the full event set per candidate segment.
  const originRetentionEventsByReachableStop = new Map<string, QueryReachabilityEvent[]>();
  const indexedOriginEvents = new Set<QueryReachabilityEvent>();
  for (const events of originRetentionEvents.values()) for (const event of events) {
    if (indexedOriginEvents.has(event)) continue;
    indexedOriginEvents.add(event);
    for (const stopId of new Set([event.canonicalStopId, event.stopId, ...reachablePathwayNodes(event.pathwayStopId)])) {
      const reachableEvents = originRetentionEventsByReachableStop.get(stopId) ?? [];
      reachableEvents.push(event);
      originRetentionEventsByReachableStop.set(stopId, reachableEvents);
    }
  }
  // The journey search permits a same-provider walking transfer between
  // different nearby stop IDs. Mirror that spatial reachability in the
  // bounded graph-retention hint so a useful connection is not evicted before
  // the exact transferDecision check runs later.
  const indexedNearbyOriginEvents = new Map<string, Set<string>>();
  const nearbyTransferStopsByStopAndRoute = new Map<string, string[]>();
  const nearbyTransferStopIds = (eventStop: NonNullable<ReturnType<typeof feed.stops.get>>, routeId: string) => {
    const key = `${eventStop.id}\u0000${routeId}`;
    const cached = nearbyTransferStopsByStopAndRoute.get(key);
    if (cached) return cached;
    const [centerX, centerY] = transferCell([eventStop.lon, eventStop.lat]);
    const result: string[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const nearbyStopId of stopIdsByTransferCell.get(`${centerX + dx}:${centerY + dy}`) ?? []) {
        if (nearbyStopId === eventStop.id) continue;
        const nearbyStop = feed.stops.get(nearbyStopId);
        if (!nearbyStop || distanceMeters([eventStop.lon, eventStop.lat], [nearbyStop.lon, nearbyStop.lat]) > transferRadius) continue;
        const routes = routesByStop.get(nearbyStopId);
        if (!routes || ![...routes].some((candidateRouteId) => candidateRouteId !== routeId)) continue;
        result.push(nearbyStopId);
      }
    }
    nearbyTransferStopsByStopAndRoute.set(key, result);
    return result;
  };
  for (const events of originRetentionEvents.values()) for (const event of events) {
    const eventStop = feed.stops.get(event.canonicalStopId);
    if (!eventStop) continue;
    for (const nearbyStopId of nearbyTransferStopIds(eventStop, event.routeId)) {
      indexRetentionEvent(originRetentionEventsByReachableStop, indexedNearbyOriginEvents, event, nearbyStopId);
    }
  }
  const indexedDestinationEvents = new Map<string, Set<string>>();
  const indexDestinationEvent = (event: QueryReachabilityEvent, stopId: string) =>
    indexRetentionEvent(destinationRetentionEventsByReachableStop, indexedDestinationEvents, event, stopId);
  for (const events of destinationRetentionEvents.values()) for (const event of events) {
    const eventStop = feed.stops.get(event.canonicalStopId);
    if (!eventStop) continue;
    for (const stopId of new Set([event.canonicalStopId, ...reachablePathwayNodes(event.pathwayStopId)])) {
      indexDestinationEvent(event, stopId);
    }
    for (const nearbyStopId of nearbyTransferStopIds(eventStop, event.routeId)) indexDestinationEvent(event, nearbyStopId);
  }
  for (const events of originRetentionEventsByReachableStop.values()) events.sort((a, b) => a.at - b.at
    || compareStableId(a.tripId, b.tripId) || compareStableId(a.stopId, b.stopId));
  for (const events of destinationRetentionEventsByReachableStop.values()) events.sort((a, b) => a.at - b.at
    || compareStableId(a.tripId, b.tripId) || compareStableId(a.stopId, b.stopId));
  // Long in-vehicle legs to an interchange are normally omitted after the
  // bounded local stop-pair window. Preserve only interchange stops already
  // indexed with a feasible onward path toward the query destination; the
  // exact transfer rule and schedule are still validated during route search.
  const queryReachableTransferTripIdsByStopId = new Map<string, ReadonlySet<string>>(
    [...destinationRetentionEventsByReachableStop].map(([stopId, events]) => [stopId, new Set(events.map((event) => event.tripId))]),
  );
  // Keep graph-budget demand aligned with the expanded, query-reachable leg
  // set. The first bounded demand pass intentionally counts only nearby pairs
  // and direct destinations; add a capped per-trip allowance for longer legs
  // ending at an indexed transfer hub before dividing the global graph budget.
  for (const [tripId, trip] of feed.trips) {
    if ((candidateStopCountByRoute.get(trip.routeId) ?? 0) < 2) continue;
    const remainingTripDemand = maximumGraphSegmentsPerRoute - (candidatePairDemandByTrip.get(tripId) ?? 0);
    if (remainingTripDemand <= 0) continue;
    const stops = feed.stopTimes.get(tripId);
    if (!stops || stops.length < 2) continue;
    const providerCity = feed.providersByRoute?.get(trip.routeId)?.city ?? input.providerCity;
    const eligibleStopIds = intercitySearch && providerCity !== undefined && providerCity !== 'Україна'
      ? localCityCatchmentStops : corridorStops;
    const eligibleIndexes = stops.flatMap((stopTime, index) => eligibleStopIds.has(stopTime.stopId)
      && interchangeStopIds.has(stopTime.stopId) ? [index] : []);
    if (eligibleIndexes.length < 2) continue;
    let addedTripDemand = 0;
    for (const serviceDate of serviceDates) {
      const tripEvents = eligibleTripInstanceStopEvents(feed, tripId, serviceDate, eligibleIndexes, serviceTimeToUtc);
      if (!tripEvents) continue;
      const targetCursors = tripEvents.events.flatMap((event, cursor) =>
        hasDifferentOnwardTripAtStop(queryReachableTransferTripIdsByStopId, event.stopTime.stopId, tripId)
          && !destinationStopIds.has(event.stopTime.stopId) ? [cursor] : []);
      if (targetCursors.length === 0) continue;
      let firstLongTarget = 0;
      for (let fromCursor = 0; fromCursor < tripEvents.events.length - 1; fromCursor++) {
        const fromEvent = tripEvents.events[fromCursor]!;
        const from = fromEvent.stopTime;
        const departureAt = fromEvent.departureAt;
        if (!fromEvent.canBoard || !departureAt || departureAt < input.earliestDeparture || departureAt > journeyEnd) continue;
        while (firstLongTarget < targetCursors.length && targetCursors[firstLongTarget]! <= fromCursor + 20) {
          firstLongTarget++;
        }
        for (let targetIndex = firstLongTarget; targetIndex < targetCursors.length; targetIndex++) {
          const toEvent = tripEvents.events[targetCursors[targetIndex]!]!;
          const to = toEvent.stopTime;
          const arrivalAt = toEvent.arrivalAt;
          if (!toEvent.canAlight || to.arrivalSeconds < from.departureSeconds
            || !arrivalAt || arrivalAt < departureAt || arrivalAt > journeyEnd
            || arrivalAt.getTime() - departureAt.getTime() > 12 * 60 * 60_000
            || !canBelongToDirectOnlyJourney(from.stopId, to.stopId)) continue;
          addedTripDemand++;
          if (addedTripDemand >= remainingTripDemand) break;
        }
        if (addedTripDemand >= remainingTripDemand) break;
      }
      if (addedTripDemand >= remainingTripDemand) break;
    }
    if (addedTripDemand > 0) {
      candidateDemandByRoute.set(trip.routeId,
        (candidateDemandByRoute.get(trip.routeId) ?? 0) + addedTripDemand);
    }
  }
  const graphSegmentBudgetByRoute = allocateBoundedGraphBudgets(
    candidateDemandByRoute, maximumGraphSegments, maximumGraphSegmentsPerRoute,
  );
  const candidateRouteCount = graphSegmentBudgetByRoute.size;
  const estimatedGraphDemand = [...candidateDemandByRoute.values()].reduce((sum, value) => sum + value, 0);
  const graphRoutesBudgetLimited = [...candidateDemandByRoute].filter(([routeId, demand]) =>
    demand > (graphSegmentBudgetByRoute.get(routeId) ?? 0)).length;
  const graphRoutesAtPerRouteCap = [...graphSegmentBudgetByRoute.values()]
    .filter((budget) => budget === maximumGraphSegmentsPerRoute).length;
  const globalGraphBudgetBinding = estimatedGraphDemand > maximumGraphSegments;
  // Route budgets are allocated from bounded graph demand estimates. If a
  // route's estimated demand exceeds its share, the search is incomplete even
  // when that route happens not to materialize a segment before filtering.
  // Surface the bounded result as partial instead of reporting an empty graph
  // as a complete no-route answer.
  let segmentGraphTruncated = graphRoutesBudgetLimited > 0;
  const priorEventCache = new WeakMap<RetainedGtfsSegment, boolean>();
  const priorEventByTripStopCache = new Map<string, boolean>();
  const hasPriorEvent = (segment: RetainedGtfsSegment, minimumGapSeconds: number) => {
    const cached = priorEventCache.get(segment);
    if (cached !== undefined) return cached;
    const stopKey = `${segment.tripId}\u0000${segment.serviceDate}\u0000${segment.fromIndex}\u0000${minimumGapSeconds}`;
    const cachedByStop = priorEventByTripStopCache.get(stopKey);
    if (cachedByStop !== undefined) {
      priorEventCache.set(segment, cachedByStop);
      return cachedByStop;
    }
    // Type-4 rules allow zero-buffer continuations, so retain the short-gap
    // events until their exact transfer rule has been resolved.
    const latestAllowed = segment.departureAt.getTime();
    const segmentStopId = segment.originContext.details.id;
    const segmentNodes = [...new Set([segmentStopId, ...segment.originContext.transferNodeIds])];
    const minimumGapForEvent = (event: QueryReachabilityEvent) => {
      const { rule, ambiguous } = retentionRuleFor(event.nodeIds, segment.originContext.transferNodeIds,
        event.tripId, segment.tripId, event.routeId, segment.routeId);
      if (ambiguous || rule?.transferType === 3) return null;
      if (rule?.transferType === 4) return 0;
      const nearby = event.providerId === (feed.providersByRoute?.get(segment.routeId)?.id ?? input.providerId) || rule !== null
        ? feed.stops.get(event.canonicalStopId) && feed.stops.get(segmentStopId)
          ? distanceMeters([feed.stops.get(event.canonicalStopId)!.lon, feed.stops.get(event.canonicalStopId)!.lat],
            [feed.stops.get(segmentStopId)!.lon, feed.stops.get(segmentStopId)!.lat]) : null
        : null;
      const pathway = event.canonicalStopId === segmentStopId
        ? { walkingMeters: 0, walkingSeconds: 0 }
        : bestPathwayMeasure([event.pathwayStopId], segment.originContext.transferNodeIds)
          || (nearby !== null && nearby <= transferRadius
            ? { walkingMeters: nearby, walkingSeconds: Math.ceil(nearby / 1.25) } : false);
      if (!pathway || pathway.walkingMeters > transferRadius) return null;
      return retentionRequiredTransferSeconds(event.routeId, segment.routeId,
        pathway ? pathway.walkingSeconds : 0, minimumGapSeconds, rule);
    };
    for (const nodeId of segmentNodes) {
      const events = originRetentionEventsByReachableStop.get(nodeId) ?? [];
      if (!events.length) continue;
      let low = 0, high = events.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (events[middle]!.at <= latestAllowed) low = middle + 1;
        else high = middle;
      }
      for (let index = low - 1; index >= 0; index--) {
        const event = events[index]!;
        const availableSeconds = (segment.departureAt.getTime() - event.at) / 1000;
        if (availableSeconds > maximumWaitSeconds) break;
        const requiredSeconds = minimumGapForEvent(event);
        if (requiredSeconds !== null && availableSeconds >= requiredSeconds) {
          priorEventByTripStopCache.set(stopKey, true);
          priorEventCache.set(segment, true);
          return true;
        }
      }
    }
    priorEventByTripStopCache.set(stopKey, false);
    priorEventCache.set(segment, false);
    return false;
  };
  const nextEventCache = new WeakMap<RetainedGtfsSegment, boolean>();
  const nextEventByTripStopCache = new Map<string, boolean>();
  const MAX_CACHED_NEXT_EVENT_TRIP_STOPS = 16_384;
  const hasNextEvent = (segment: RetainedGtfsSegment, minimumGapSeconds: number) => {
    const cached = nextEventCache.get(segment);
    if (cached !== undefined) return cached;
    const stopKey = `${segment.providerId}\u0000${segment.serviceDate}\u0000${segment.tripId}`
      + `\u0000${segment.routeId}\u0000${segment.toIndex}\u0000${minimumGapSeconds}`;
    const cachedByStop = nextEventByTripStopCache.get(stopKey);
    if (cachedByStop !== undefined) {
      nextEventCache.set(segment, cachedByStop);
      return cachedByStop;
    }
    // Type-4 rules allow zero-buffer continuations, so retain the short-gap
    // events until their exact transfer rule has been resolved.
    const earliestAllowed = segment.arrivalAt.getTime();
    const minimumGapForEvent = (event: QueryReachabilityEvent) => {
      const { rule, ambiguous } = retentionRuleFor(segment.destinationContext.transferNodeIds, event.nodeIds,
        segment.tripId, event.tripId, segment.routeId, event.routeId);
      if (ambiguous || rule?.transferType === 3) return null;
      if (rule?.transferType === 4) return 0;
      const eventStopId = segment.destinationContext.details.id;
      const nearby = event.providerId === (feed.providersByRoute?.get(segment.routeId)?.id ?? input.providerId) || rule !== null
        ? feed.stops.get(eventStopId) && feed.stops.get(event.canonicalStopId)
          ? distanceMeters([feed.stops.get(eventStopId)!.lon, feed.stops.get(eventStopId)!.lat],
            [feed.stops.get(event.canonicalStopId)!.lon, feed.stops.get(event.canonicalStopId)!.lat]) : null
        : null;
      const pathway = eventStopId === event.canonicalStopId
        ? { walkingMeters: 0, walkingSeconds: 0 }
        : bestPathwayMeasure(segment.destinationContext.transferNodeIds, [event.pathwayStopId])
          || (nearby !== null && nearby <= transferRadius
            ? { walkingMeters: nearby, walkingSeconds: Math.ceil(nearby / 1.25) } : false);
      if (!pathway || pathway.walkingMeters > transferRadius) return null;
      return retentionRequiredTransferSeconds(segment.routeId, event.routeId,
        pathway ? pathway.walkingSeconds : 0, minimumGapSeconds, rule);
    };
    const reachableDestinationStops = new Set([segment.destinationContext.details.id,
      ...segment.destinationContext.transferNodeIds.flatMap((nodeId) => [...reachablePathwayNodes(nodeId)])]);
    // Each reachable-stop event list is already time sorted. The predicate
    // only asks whether any feasible continuation exists, so merging and
    // sorting all lists for every segment is unnecessary; scan each indexed
    // list from its own lower bound and short-circuit on the first match.
    for (const stopId of reachableDestinationStops) {
      const events = destinationRetentionEventsByReachableStop.get(stopId) ?? [];
      let low = 0, high = events.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (events[middle]!.at < earliestAllowed) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < events.length; index++) {
        const event = events[index]!;
        const availableSeconds = (event.at - segment.arrivalAt.getTime()) / 1000;
        if (availableSeconds > maximumWaitSeconds) break;
        const requiredSeconds = minimumGapForEvent(event);
        if (requiredSeconds !== null && availableSeconds >= requiredSeconds) {
          nextEventCache.set(segment, true);
          if (nextEventByTripStopCache.size < MAX_CACHED_NEXT_EVENT_TRIP_STOPS) {
            nextEventByTripStopCache.set(stopKey, true);
          }
          return true;
        }
      }
    }
    nextEventCache.set(segment, false);
    if (nextEventByTripStopCache.size < MAX_CACHED_NEXT_EVENT_TRIP_STOPS) {
      nextEventByTripStopCache.set(stopKey, false);
    }
    return false;
  };
  const MAX_ONWARD_ARRIVAL_SCAN_AFTER_FEASIBLE = 8;
  const maxJourneyArrivalAt = input.earliestDeparture.getTime() + maximumJourneySeconds * 1000;
  const onwardArrivalCache = new WeakMap<RetainedGtfsSegment, number | null>();
  const onwardArrivalByTripStopCache = new Map<string, number | null>();
  const earliestQueryArrivalAfterSegment = (segment: RetainedGtfsSegment, minimumGapSeconds: number) => {
    if (debugSearch) debugEarliestQueryArrivalCalls++;
    const cached = onwardArrivalCache.get(segment);
    if (cached !== undefined) {
      if (debugSearch) debugOnwardArrivalWeakMapHits++;
      return cached;
    }
    const stopKey = `${segment.tripId}\u0000${segment.serviceDate}\u0000${segment.toIndex}\u0000${minimumGapSeconds}`;
    const cachedByStop = onwardArrivalByTripStopCache.get(stopKey);
    if (cachedByStop !== undefined) {
      if (debugSearch) debugOnwardArrivalStringCacheHits++;
      onwardArrivalCache.set(segment, cachedByStop);
      return cachedByStop;
    }
    const earliestAllowed = segment.arrivalAt.getTime();
    const eventStopId = segment.destinationContext.details.id;
    const segmentProviderId = feed.providersByRoute?.get(segment.routeId)?.id ?? input.providerId;
    if (debugSearch) debugReachableStopSetBuilds++;
    const reachableDestinationStops = new Set([eventStopId,
      ...segment.destinationContext.transferNodeIds.flatMap((nodeId) => [...reachablePathwayNodes(nodeId)])]);
    let earliestArrival = Infinity;
    for (const stopId of reachableDestinationStops) {
      const events = destinationRetentionEventsByReachableStop.get(stopId) ?? [];
      let low = 0, high = events.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (events[middle]!.at < earliestAllowed) low = middle + 1;
        else high = middle;
      }
      let foundFeasibleAtStop = false;
      let postFeasibleScanned = 0;
      for (let index = low; index < events.length; index++) {
        if (debugSearch) debugDestinationEventsScanned++;
        const event = events[index]!;
        if (event.at >= earliestArrival) break;
        const availableSeconds = (event.at - earliestAllowed) / 1000;
        if (availableSeconds > maximumWaitSeconds) break;
        if (foundFeasibleAtStop && ++postFeasibleScanned > MAX_ONWARD_ARRIVAL_SCAN_AFTER_FEASIBLE) break;
        if (event.journeyArrivalAt === undefined
          || event.journeyArrivalAt >= earliestArrival
          || event.journeyArrivalAt > maxJourneyArrivalAt) continue;
        const { rule, ambiguous } = retentionRuleFor(segment.destinationContext.transferNodeIds, event.nodeIds,
          segment.tripId, event.tripId, segment.routeId, event.routeId);
        if (ambiguous || rule?.transferType === 3) continue;
        const inSeat = rule?.transferType === 4;
        let walkingSeconds = 0;
        if (!inSeat) {
          const nearby = event.providerId === segmentProviderId || rule !== null
            ? feed.stops.get(eventStopId) && feed.stops.get(event.canonicalStopId)
              ? distanceMeters([feed.stops.get(eventStopId)!.lon, feed.stops.get(eventStopId)!.lat],
                [feed.stops.get(event.canonicalStopId)!.lon, feed.stops.get(event.canonicalStopId)!.lat]) : null
            : null;
          const pathway = eventStopId === event.canonicalStopId
            ? { walkingMeters: 0, walkingSeconds: 0 }
            : bestPathwayMeasure(segment.destinationContext.transferNodeIds, [event.pathwayStopId])
              || (nearby !== null && nearby <= transferRadius
                ? { walkingMeters: nearby, walkingSeconds: Math.ceil(nearby / 1.25) } : false);
          if (!pathway || pathway.walkingMeters > transferRadius) continue;
          walkingSeconds = pathway.walkingSeconds;
        }
        const requiredSeconds = retentionRequiredTransferSeconds(segment.routeId, event.routeId,
          walkingSeconds, minimumGapSeconds, rule);
        if (availableSeconds < requiredSeconds) continue;
        foundFeasibleAtStop = true;
        if (event.journeyArrivalAt < earliestArrival) {
          earliestArrival = event.journeyArrivalAt;
        }
      }
    }
    const result = Number.isFinite(earliestArrival) ? earliestArrival : null;
    onwardArrivalByTripStopCache.set(stopKey, result);
    onwardArrivalCache.set(segment, result);
    return result;
  };
  let tripsConsidered = 0;
  let tripsWithEligibleStops = 0;
  const stopDetailsCache = new Map<string, { id: string; name: string; coordinates: [number, number] }>();
  const stopContextCache = new Map<string, GtfsStopContext>();
  const transferNodeCache = new Map<string, string[]>();
  const stopDetails = (stopId: string, name: string, coordinates: [number, number]) => {
    const key = `${stopId}\u0000${name}\u0000${coordinates[0]}\u0000${coordinates[1]}`;
    const cached = stopDetailsCache.get(key);
    if (cached) return cached;
    const value = { id: stopId, name, coordinates };
    stopDetailsCache.set(key, value);
    return value;
  };
  const transferNodeList = (entry: NonNullable<GtfsTimetableFeed['stopTimes'] extends Map<string, (infer T)[]> ? T : never>) => {
    const primary = entry.sourceStopId ?? entry.stopId;
    const parent = entry.sourceParentStationId;
    const key = `${primary}\u0000${parent ?? ''}`;
    const cached = transferNodeCache.get(key);
    if (cached) return cached;
    const value = parent && parent !== primary ? [primary, parent] : [primary];
    transferNodeCache.set(key, value);
    return value;
  };
  const stopContext = (entry: NonNullable<GtfsTimetableFeed['stopTimes'] extends Map<string, (infer T)[]> ? T : never>): GtfsStopContext | null => {
    const stop = feed.stops.get(entry.stopId);
    if (!stop) return null;
    const coordinates = entry.sourceStopCoordinates ?? [stop.lon, stop.lat] as [number, number];
    const name = entry.sourceStopName ?? stop.name;
    const key = `${entry.stopId}\u0000${entry.sourceStopId ?? ''}\u0000${name}\u0000${coordinates[0]}\u0000${coordinates[1]}`;
    const cached = stopContextCache.get(key);
    if (cached) return cached;
    const exactDistanceToOriginStopMeters = distanceMeters(input.origin, coordinates);
    const value = {
      details: stopDetails(stop.id, name, coordinates),
      transferNodeIds: transferNodeList(entry),
      // These distances are fixed for the queried OD pair. Calculate once per
      // stop context instead of once for every possible boarding/alighting
      // pair on every trip serving this stop.
      exactDistanceToOriginStopMeters,
      distanceToOriginStopMeters: Math.round(exactDistanceToOriginStopMeters),
      distanceFromDestinationStopMeters: Math.round(distanceMeters(input.destination, coordinates)),
    };
    stopContextCache.set(key, value);
    return value;
  };
  const emptyTraveledZoneIds: string[] = [];
  const queryFrontierConnectivity = new WeakMap<RetainedGtfsSegment, boolean>();
  const canBoardOriginCandidate = (candidate: Pick<RetainedGtfsSegment, 'originContext' | 'departureAt'>) =>
    originStopIds.has(candidate.originContext.details.id)
    && candidate.departureAt.getTime() <= maxFirstDeparture
    && candidate.departureAt.getTime() >= input.earliestDeparture.getTime()
      + Math.ceil(candidate.originContext.exactDistanceToOriginStopMeters / 1.25) * 1000;
  const compareTripSegments = (left: RetainedGtfsSegment, right: RetainedGtfsSegment) => {
    const rank = (candidate: RetainedGtfsSegment): [number, number, number, number, number, number] => {
      if (candidate.sampleRank) return candidate.sampleRank;
      const endsAtDestination = destinationStopIds.has(candidate.destinationContext.details.id);
      const canCatchOrigin = canBoardOriginCandidate(candidate);
      const duration = candidate.arrivalAt.getTime() - candidate.departureAt.getTime();
      const direct = canCatchOrigin && endsAtDestination;
      let joinsOppositeFrontier = false;
      if (!direct) {
        const cached = queryFrontierConnectivity.get(candidate);
        if (cached !== undefined) joinsOppositeFrontier = cached;
        else {
          joinsOppositeFrontier = canCatchOrigin
            ? hasNextEvent(candidate, minimumTransferBufferSeconds)
            : endsAtDestination && hasPriorEvent(candidate, minimumTransferBufferSeconds);
          queryFrontierConnectivity.set(candidate, joinsOppositeFrontier);
        }
      }
      const rankValue: [number, number, number, number, number, number] = direct
        ? [0, 0, candidate.originContext.distanceToOriginStopMeters + candidate.destinationContext.distanceFromDestinationStopMeters,
          duration, candidate.departureAt.getTime(), candidate.arrivalAt.getTime()]
        : joinsOppositeFrontier
          ? [1, 0, canCatchOrigin ? candidate.originContext.distanceToOriginStopMeters
            : candidate.destinationContext.distanceFromDestinationStopMeters,
          canCatchOrigin ? duration : candidate.arrivalAt.getTime() - input.earliestDeparture.getTime(),
          candidate.departureAt.getTime(), candidate.arrivalAt.getTime()]
        : canCatchOrigin
          ? [2, 0, candidate.originContext.distanceToOriginStopMeters, duration, candidate.departureAt.getTime(), candidate.arrivalAt.getTime()]
          : endsAtDestination
            ? [3, 0, candidate.destinationContext.distanceFromDestinationStopMeters, duration, candidate.departureAt.getTime(), candidate.arrivalAt.getTime()]
            : [4, 1, 0, duration, candidate.departureAt.getTime(), candidate.arrivalAt.getTime()];
      if (rankValue[0] === 4) {
        const hasOriginPredecessor = hasPriorEvent(candidate, minimumTransferBufferSeconds);
        const onwardArrival = hasOriginPredecessor
          ? earliestQueryArrivalAfterSegment(candidate, minimumTransferBufferSeconds)
          : null;
        const joinsQueryReachableSides = onwardArrival !== null
          || (hasOriginPredecessor && hasNextEvent(candidate, minimumTransferBufferSeconds));
        if (joinsQueryReachableSides) {
          // Among potentially complete transfer chains, prefer segments that
          // arrive earlier in the full query window before using segment-only
          // duration. A short middle hop can otherwise outrank a faster full
          // journey simply because its individual vehicle ride is short.
          rankValue[0] = 1;
          rankValue[1] = 0;
          rankValue[2] = (onwardArrival ?? candidate.arrivalAt.getTime()) - input.earliestDeparture.getTime();
        } else {
          const connectedRoutes = new Set<string>();
          for (const stopId of [...candidate.originContext.transferNodeIds, candidate.destinationContext.details.id,
            ...candidate.destinationContext.transferNodeIds]) {
            for (const routeId of routesByStop.get(stopId) ?? []) connectedRoutes.add(routeId);
            const stop = feed.stops.get(stopId);
            if (stop?.parentStation) {
              for (const routeId of routesByParentStation.get(stop.parentStation) ?? []) connectedRoutes.add(routeId);
            }
          }
          connectedRoutes.delete(candidate.routeId);
          rankValue[1] = 1;
          rankValue[2] = -connectedRoutes.size;
        }
      }
      candidate.sampleRank = rankValue;
      candidate.sampleKey = `${candidate.providerId}\u0000${candidate.serviceDate}\u0000${candidate.tripId}\u0000${candidate.originContext.details.id}\u0000${candidate.destinationContext.details.id}\u0000${candidate.departureAt.getTime()}\u0000${candidate.arrivalAt.getTime()}`;
      return rankValue;
    };
    const leftRank = rank(left);
    const rightRank = rank(right);
    for (let index = 0; index < leftRank.length; index++) {
      if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
    }
    return compareStableId(left.sampleKey ?? '', right.sampleKey ?? '');
  };
  type DebugTracedTripInstance = {
    tripId: string;
    routeId: string;
    serviceDate: string;
    eligibleStopCount: number;
    materializedCandidates: RetainedGtfsSegment[];
    materializedCandidateCount: number;
    materializedCandidateTraceOmitted: number;
    omittedBeyondWindow: number;
    retainedTripCandidates: RetainedGtfsSegment[];
    boundedTripProjectionUsed: boolean;
    graphSegmentLimitPerRoute: number;
    retentionTier: number | null;
    retentionPriorityTier: number | null;
    endpointArrivalMinute: number | null;
    retainedWholeTripGroup: boolean;
    feasibleConnectorEvaluations: number;
    bestConnector: string | null;
    connectorEvalIndexByCandidate: Map<RetainedGtfsSegment, number>;
    connectorScanIndexByCandidate: Map<RetainedGtfsSegment, number>;
  };
  const debugTracedTripInstances: DebugTracedTripInstance[] = [];
  // Feed trip insertion order is not a stable selection policy. Keep graph
  // retention and any bounded overflow fill reproducible across feed encodings.
  for (const [tripId, trip] of [...feed.trips].sort(([left], [right]) => compareStableId(left, right))) {
    tripsConsidered++;
    const route = feed.routes.get(trip.routeId);
    const stops = feed.stopTimes.get(tripId);
    if (!route || !stops || stops.length < 2 || (input.allowedModes && !input.allowedModes.includes(route.mode))) continue;
    const provider = feed.providersByRoute?.get(trip.routeId);
    const providerCity = provider?.city ?? input.providerCity;
    const transportType = route.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route.transportType;
    if (input.allowedTransportTypes && !journeyTransportTypeSelected(transportType, input.allowedTransportTypes)) continue;
    const graphSegmentLimitPerRoute = graphSegmentBudgetByRoute.get(trip.routeId) ?? 0;
    if (graphSegmentLimitPerRoute === 0) continue;
    const localFeedInIntercitySearch = intercitySearch && providerCity !== undefined && providerCity !== 'Україна';
    const eligibleStopIds = localFeedInIntercitySearch ? localCityCatchmentStops : corridorStops;
    const eligibleIndexes = stops.flatMap((stop, index) => eligibleStopIds.has(stop.stopId)
      && interchangeStopIds.has(stop.stopId) ? [index] : []);
    if (eligibleIndexes.length < 2) continue;
    tripsWithEligibleStops++;
    // A trip's stop metadata is shared across its service dates and all
    // downstream stop-pair candidates. Resolve it once before expanding those
    // pairs rather than repeating map lookups, string keys, and haversine
    // calculations for every edge.
    const eligibleContexts = eligibleIndexes.map((index) => stopContext(stops[index]));
    const traceThisTrip = debugTraceCandidateTripSet?.has(tripId) ?? false;
    for (const serviceDate of serviceDates) {
      const tripEvents = eligibleTripInstanceStopEvents(feed, tripId, serviceDate, eligibleIndexes, serviceTimeToUtc);
      if (!tripEvents) continue;
      let tripCandidates: RetainedGtfsSegment[] = [];
      let boundedTripCandidates: BoundedBestK<RetainedGtfsSegment> | undefined;
      const debugMaterializedCandidates = traceThisTrip ? ([] as RetainedGtfsSegment[]) : undefined;
      let debugMaterializedCandidateCount = 0;
      let debugMaterializedCandidateTraceOmitted = 0;
      let debugOmittedBeyondWindow = 0;
      // Duplicate stop IDs can occur in loop routes; deduplicate only within
      // this trip instance so a citywide set of every candidate key is not
      // retained alongside the graph.
      const seenTripSegments = new Set<string>();
      for (const projection of materializeTripInstanceLegs(tripEvents.events, {
        tripId, maximumTransfers, earliestDeparture: input.earliestDeparture, journeyEnd, destinationStopIds,
        queryReachableTransferTripIdsByStopId,
        canBelongToDirectOnlyJourney,
      })) {
        if (projection.kind === 'omitted-beyond-window') {
          // Preserve the partial-search signal for omitted, potentially useful legs.
          segmentGraphTruncated = true;
          if (traceThisTrip) debugOmittedBeyondWindow++;
          continue;
        }
        const { fromCursor, toCursor, fromEvent, toEvent } = projection;
        const fromIndex = fromEvent.stopIndex;
        const toIndex = toEvent.stopIndex;
        const from = fromEvent.stopTime;
        const to = toEvent.stopTime;
        const fromContext = eligibleContexts[fromCursor];
        const toContext = eligibleContexts[toCursor];
        const scheduledDepartureAt = fromEvent.scheduledDepartureAt;
        const scheduledArrivalAt = toEvent.scheduledArrivalAt;
        const departureAt = fromEvent.departureAt;
        const arrivalAt = toEvent.arrivalAt;
        if (!fromContext || !toContext || !scheduledDepartureAt || !scheduledArrivalAt || !departureAt || !arrivalAt) continue;
          // A duplicate loop-route segment is defined by the same stops and
          // departure instant. Avoid formatting an ISO timestamp for every
          // candidate edge; the numeric epoch value is an identical key with
          // substantially less allocation in dense feeds.
          const key = `${from.stopId}:${to.stopId}:${departureAt.getTime()}`;
          if (seenTripSegments.has(key)) continue;
          seenTripSegments.add(key);
          const candidate: RetainedGtfsSegment = {
            providerId: provider?.id ?? input.providerId,
            routeId: trip.routeId,
            tripId,
            serviceDate,
            fromIndex,
            toIndex,
            originContext: fromContext,
            destinationContext: toContext,
            scheduledDepartureAt,
            scheduledArrivalAt,
            departureAt,
            arrivalAt,
            ...(tripEvents.realtimeUpdate && tripEvents.datedStops?.slice(fromIndex, toIndex + 1).some((stop) => stop.updated)
              ? { realtimeUpdatedAt: tripEvents.realtimeUpdate.updatedAt } : {}),
            ...(from.sourceZoneId ? { originZoneId: from.sourceZoneId } : {}),
            ...(to.sourceZoneId ? { destinationZoneId: to.sourceZoneId } : {}),
          };
          if (traceThisTrip && debugMaterializedCandidates) {
            debugMaterializedCandidateCount++;
            const isTargetPair = debugCandidateTraceTargetPairs.has(
              `${candidate.tripId}:${from.stopId}:${to.stopId}`,
            );
            if (debugMaterializedCandidates.length < 1024 || isTargetPair) {
              debugMaterializedCandidates.push(candidate);
            } else {
              debugMaterializedCandidateTraceOmitted++;
            }
          }
          if (!boundedTripCandidates && tripCandidates.length < graphSegmentLimitPerRoute) {
            tripCandidates.push(candidate);
            continue;
          }
          if (!boundedTripCandidates) {
            boundedTripCandidates = new BoundedBestK(graphSegmentLimitPerRoute, compareTripSegments);
            for (const retained of tripCandidates) boundedTripCandidates.consider(retained);
            tripCandidates = [];
          }
          boundedTripCandidates.consider(candidate);
      }
      if (boundedTripCandidates) {
        tripCandidates = boundedTripCandidates.toSortedArray();
        segmentGraphTruncated = true;
      }
      const debugConnectorEvalIndex = traceThisTrip ? new Map<RetainedGtfsSegment, number>() : undefined;
      const debugConnectorScanIndex = traceThisTrip ? new Map<RetainedGtfsSegment, number>() : undefined;
      if (tripCandidates.length) {
        const overflowCapacity = Math.min(MAX_ROUTE_OVERFLOW_SEGMENTS, graphSegmentLimitPerRoute);
        const overflow = overflowSegmentsByRoute.get(trip.routeId)
          ?? new BoundedBestK<RetainedGtfsSegment>(overflowCapacity, compareTripSegments);
        const connectorOverflowCapacity = Math.min(maximumRouteOverflowConnectors, graphSegmentLimitPerRoute);
        const connectorOverflow = overflowConnectorsByRoute.get(trip.routeId)
          ?? new BoundedBestK<RetainedGtfsSegment>(connectorOverflowCapacity, compareTripSegments);
        let temporallyConnectsQueryEnds = false;
        let bestConnector: { segment: RetainedGtfsSegment; arrivalAt: number } | undefined;
        let feasibleConnectorEvaluations = 0;
        let connectorScanCursor = 0;
        for (const candidate of tripCandidates) {
          debugConnectorScanIndex?.set(candidate, connectorScanCursor++);
          const canCatchOrigin = canBoardOriginCandidate(candidate);
          const endsAtDestination = destinationStopIds.has(candidate.destinationContext.details.id);
          const servesQueryEndpoint = canCatchOrigin || endsAtDestination;
          if (servesQueryEndpoint) overflow.consider(candidate);
          if (servesQueryEndpoint) {
            if (!temporallyConnectsQueryEnds && hasPriorEvent(candidate, minimumTransferBufferSeconds)
              && hasNextEvent(candidate, minimumTransferBufferSeconds)) temporallyConnectsQueryEnds = true;
            continue;
          }
          if (debugSearch) debugConnectorCandidatesInspected++;
          // Keep connector work bounded while allowing the route-level
          // reservoir to inspect its full capacity. One additional feasible
          // candidate is needed to prove that the bounded reservoir omitted
          // work and report graph truncation accurately.
          if (feasibleConnectorEvaluations >= Math.max(2, connectorOverflowCapacity + 1)) continue;
          if (bestConnector && candidate.arrivalAt.getTime() > bestConnector.arrivalAt) continue;
          if (hasPriorEvent(candidate, minimumTransferBufferSeconds)) {
            const onwardArrival = earliestQueryArrivalAfterSegment(candidate, minimumTransferBufferSeconds);
            if (onwardArrival !== null) {
              feasibleConnectorEvaluations++;
              debugConnectorEvalIndex?.set(candidate, feasibleConnectorEvaluations);
              temporallyConnectsQueryEnds = true;
              const connectorReservoirWasFull = connectorOverflow.size >= connectorOverflowCapacity;
              const candidateAlreadyRetained = connectorOverflow.some((retained) => {
                if (debugSearch) debugConnectorReservoirItemsInspected++;
                return retainedCandidateKey(retained) === retainedCandidateKey(candidate);
              });
              connectorOverflow.consider(candidate);
              // A bounded connector sample can omit a feasible alternative even
              // when the estimated graph budget itself is not exhausted. Only
              // mark a unique candidate beyond the full reservoir: duplicates
              // do not make the candidate graph incomplete.
              if (connectorReservoirWasFull && !candidateAlreadyRetained) segmentGraphTruncated = true;
              if (!bestConnector || onwardArrival < bestConnector.arrivalAt
                || (onwardArrival === bestConnector.arrivalAt
                  && compareTripSegments(candidate, bestConnector.segment) < 0)) {
                bestConnector = { segment: candidate, arrivalAt: onwardArrival };
              }
            }
          }
        }
        overflowSegmentsByRoute.set(trip.routeId, overflow);
        overflowConnectorsByRoute.set(trip.routeId, connectorOverflow);
        segmentGraphTruncated ||= (retainedSegmentCountByRoute.get(trip.routeId) ?? 0) + tripCandidates.length > graphSegmentLimitPerRoute;
        const tripKey = `${trip.routeId}\u0000${tripId}\u0000${serviceDate}`;
        const canBoardFromOrigin = tripCandidates.some(canBoardOriginCandidate);
        const canAlightAtDestination = tripCandidates.some((candidate) => destinationStopIds.has(candidate.destinationContext.details.id));
        // Reserve graph capacity for endpoint-serving trips before sampling
        // transfer-only lines. A uniformly hashed reservoir can otherwise
        // discard a useful first or last leg even when those exact stops are
        // already selected for the query.
        const retentionTier = canBoardFromOrigin && canAlightAtDestination ? 0
          : canBoardFromOrigin ? 1 : canAlightAtDestination ? 2 : 3;
        // Endpoint-serving trips can still be irrelevant to the query if no
        // feasible scheduled service reaches them from the origin side (or
        // continues from them toward the destination). Within the bounded
        // route budget, reserve priority for endpoint trips that actually
        // connect to the opposite query frontier before hashing alternatives.
        const connectsOppositeQueryFrontier = tripCandidates.some((candidate) => {
          const candidateStartsAtOrigin = canBoardOriginCandidate(candidate);
          const candidateEndsAtDestination = destinationStopIds.has(candidate.destinationContext.details.id);
          return (candidateStartsAtOrigin && hasNextEvent(candidate, minimumTransferBufferSeconds))
            || (candidateEndsAtDestination && hasPriorEvent(candidate, minimumTransferBufferSeconds));
        });
        const retentionPriorityTier = retentionTier === 0 ? 0
          : connectsOppositeQueryFrontier ? 1
            : temporallyConnectsQueryEnds ? 2
              : retentionTier === 1 ? 3
                : retentionTier === 2 ? 4 : 5;
        const routeCandidates = segmentsByRoute.get(trip.routeId) ?? [];
        // When a bounded route budget cannot retain every origin-serving trip,
        // prefer earlier arrivals at query-relevant corridor stops. A direct
        // destination look-ahead cannot recognize a feeder that needs two or
        // more transfers, so hash-only tie-breaking can keep a later trip that
        // misses the only feasible downstream connection.
        const earliestEndpointArrivalMs = retentionTier === 1 && canBoardFromOrigin
          ? Math.min(...tripCandidates.filter(canBoardOriginCandidate).map((candidate) => candidate.arrivalAt.getTime()))
          : retentionTier === 2 && canAlightAtDestination
            ? Math.min(...tripCandidates.filter((candidate) => destinationStopIds.has(candidate.destinationContext.details.id))
              .map((candidate) => candidate.arrivalAt.getTime()))
            : null;
        const endpointArrivalMinute = earliestEndpointArrivalMs === null ? 0
          : Math.min(4095, Math.max(0, Math.floor((earliestEndpointArrivalMs - input.earliestDeparture.getTime()) / 60_000)));
        const stableRetentionHash = gtfsSegmentRetentionPriority(tripKey);
        const retained = retainBoundedTripGroup(routeCandidates, {
          key: tripKey,
          // Keep both-endpoint trips first, then one-endpoint trips that
          // connect to the opposite query frontier, then other scheduled
          // connectors (including multi-transfer legs). Unconnected endpoint
          // trips consume a bounded route graph only after feasible service.
          priority: retentionPriorityTier * GTFS_RETENTION_PRIORITY_TIER_STRIDE
            + endpointArrivalMinute * GTFS_RETENTION_ARRIVAL_BUCKET_STRIDE
            + stableRetentionHash,
          segments: tripCandidates,
        }, retainedSegmentCountByRoute.get(trip.routeId) ?? 0, graphSegmentLimitPerRoute);
        if (retained.retained) {
          segmentsByRoute.set(trip.routeId, routeCandidates);
          retainedSegmentCountByRoute.set(trip.routeId, retained.segments);
        }
        if (traceThisTrip && debugMaterializedCandidates && debugConnectorEvalIndex && debugConnectorScanIndex) {
          debugTracedTripInstances.push({
            tripId,
            routeId: trip.routeId,
            serviceDate,
            eligibleStopCount: eligibleIndexes.length,
            materializedCandidates: debugMaterializedCandidates,
            materializedCandidateCount: debugMaterializedCandidateCount,
            materializedCandidateTraceOmitted: debugMaterializedCandidateTraceOmitted,
            omittedBeyondWindow: debugOmittedBeyondWindow,
            retainedTripCandidates: [...tripCandidates],
            boundedTripProjectionUsed: Boolean(boundedTripCandidates),
            graphSegmentLimitPerRoute,
            retentionTier,
            retentionPriorityTier,
            endpointArrivalMinute,
            retainedWholeTripGroup: retained.retained,
            feasibleConnectorEvaluations,
            bestConnector: bestConnector
              ? `${bestConnector.segment.originContext.details.id}->${bestConnector.segment.destinationContext.details.id}`
              : null,
            connectorEvalIndexByCandidate: debugConnectorEvalIndex,
            connectorScanIndexByCandidate: debugConnectorScanIndex,
          });
        }
      } else if (traceThisTrip && debugMaterializedCandidates && debugConnectorEvalIndex && debugConnectorScanIndex) {
        debugTracedTripInstances.push({
          tripId,
          routeId: trip.routeId,
          serviceDate,
          eligibleStopCount: eligibleIndexes.length,
          materializedCandidates: debugMaterializedCandidates,
          materializedCandidateCount: debugMaterializedCandidateCount,
          materializedCandidateTraceOmitted: debugMaterializedCandidateTraceOmitted,
          omittedBeyondWindow: debugOmittedBeyondWindow,
          retainedTripCandidates: [],
          boundedTripProjectionUsed: Boolean(boundedTripCandidates),
          graphSegmentLimitPerRoute,
          retentionTier: null,
          retentionPriorityTier: null,
          endpointArrivalMinute: null,
          retainedWholeTripGroup: false,
          feasibleConnectorEvaluations: 0,
          bestConnector: null,
          connectorEvalIndexByCandidate: debugConnectorEvalIndex,
          connectorScanIndexByCandidate: debugConnectorScanIndex,
        });
      }
    }
  }
  const overflowCandidatesByRoute = new Map<string, RetainedGtfsSegment[]>();
  const overflowRouteIds = new Set([...overflowSegmentsByRoute.keys(), ...overflowConnectorsByRoute.keys()]);
  for (const routeId of overflowRouteIds) {
    const unique = new Map<string, RetainedGtfsSegment>();
    for (const candidate of [
      ...(overflowSegmentsByRoute.get(routeId)?.toSortedArray() ?? []),
      ...(overflowConnectorsByRoute.get(routeId)?.toSortedArray() ?? []),
    ]) unique.set(retainedCandidateKey(candidate), candidate);
    overflowCandidatesByRoute.set(routeId, [...unique.values()].sort(compareTripSegments));
  }

  const selectedSegmentsByRoute = new Map<string, RetainedGtfsSegment[]>();
  for (const [routeId, trips] of segmentsByRoute) {
    const selected = trips.flatMap((trip) => trip.segments);
    const selectedKeys = new Set(selected.map(retainedCandidateKey));
    const remaining = Math.max(0, (graphSegmentBudgetByRoute.get(routeId) ?? 0) - selected.length);
    const overflow = overflowCandidatesByRoute.get(routeId) ?? [];
    const fill = overflow.filter((candidate) => !selectedKeys.has(retainedCandidateKey(candidate)))
      .slice(0, remaining);
    selectedSegmentsByRoute.set(routeId, [...selected, ...fill]);
  }
  const redistributed = redistributeBoundedCandidates(
    selectedSegmentsByRoute,
    overflowCandidatesByRoute,
    maximumGraphSegments,
    maximumGraphSegmentsPerRoute,
    retainedCandidateKey,
  );
  selectedSegmentsByRoute.clear();
  for (const [routeId, routeSegments] of redistributed.routes) selectedSegmentsByRoute.set(routeId, routeSegments);
  const segments = [...selectedSegmentsByRoute.values()].flatMap((routeSegments) => routeSegments.map((candidate) => {
    const route = feed.routes.get(candidate.routeId)!;
    const trip = feed.trips.get(candidate.tripId)!;
    const provider = feed.providersByRoute?.get(candidate.routeId);
    const segment: GtfsDirectJourney = {
      providerId: candidate.providerId,
      providerName: provider?.name ?? input.providerName,
      providerCity: provider?.city ?? input.providerCity,
      mode: route.mode,
      routeId: candidate.routeId,
      routeName: route.name,
      headsign: trip.headsign,
      tripId: candidate.tripId,
      originStop: candidate.originContext.details,
      destinationStop: candidate.destinationContext.details,
      originTransferNodeIds: candidate.originContext.transferNodeIds,
      destinationTransferNodeIds: candidate.destinationContext.transferNodeIds,
      transportType: route.transportType === 'bus' && (provider?.city ?? input.providerCity) === 'Україна'
        ? 'intercity_bus' : route.transportType,
      scheduleSemantics: route.scheduleSemantics ?? 'published_departures',
      serviceDate: candidate.serviceDate,
      scheduledDepartureAt: candidate.scheduledDepartureAt,
      scheduledArrivalAt: candidate.scheduledArrivalAt,
      departureAt: candidate.departureAt,
      arrivalAt: candidate.arrivalAt,
      sourceFreshAt: provider?.fetchedAt ?? feed.fetchedAt,
      ...(candidate.realtimeUpdatedAt ? { realtimeUpdatedAt: candidate.realtimeUpdatedAt } : {}),
      distanceToOriginStopMeters: candidate.originContext.distanceToOriginStopMeters,
      distanceFromDestinationStopMeters: candidate.destinationContext.distanceFromDestinationStopMeters,
      ...(candidate.originZoneId ? { originZoneId: candidate.originZoneId } : {}),
      ...(candidate.destinationZoneId ? { destinationZoneId: candidate.destinationZoneId } : {}),
      traveledZoneIds: emptyTraveledZoneIds,
    };
    shapeIndexesBySegment.set(segment, { fromIndex: candidate.fromIndex, toIndex: candidate.toIndex, serviceDate: candidate.serviceDate });
    firstLegAccessSecondsBySegment.set(segment, Math.ceil(candidate.originContext.exactDistanceToOriginStopMeters / 1.25));
    const update = feed.realtimeTripUpdates?.get(gtfsRealtimeTripUpdateKey(candidate.tripId, candidate.serviceDate));
    if (update?.stops.length) {
      const dated = datedTripStops(feed, candidate.tripId, candidate.serviceDate);
      segment.stops = stopCallsForTrip(feed, candidate.tripId, candidate.fromIndex, candidate.toIndex,
        candidate.serviceDate, dated.stops);
    }
    return segment;
  }));
  const perRouteBudgetUsage = [...graphSegmentBudgetByRoute].map(([routeId, budget]) => ({
    budget,
    retained: selectedSegmentsByRoute.get(routeId)?.length ?? 0,
  }));
  const graphRoutesUnderfilled = perRouteBudgetUsage.filter(({ budget, retained }) => retained < budget).length;
  const graphRouteBudgetMaxUnused = Math.max(0, ...perRouteBudgetUsage.map(({ budget, retained }) => budget - retained));
  const overflowReservoirSizes = [...overflowCandidatesByRoute.values()].map((reservoir) => reservoir.length);
  const overflowConnectorReservoirs = [...overflowConnectorsByRoute].map(([routeId, reservoir]) => ({
    retained: reservoir.toSortedArray().length,
    capacity: Math.min(maximumRouteOverflowConnectors, graphSegmentBudgetByRoute.get(routeId) ?? 0),
  }));
  const overflowConnectorReservoirSizes = overflowConnectorReservoirs.map(({ retained }) => retained);
  const routeBudgetUnderfillSample = process.env.MARSHGO_GTFS_SEARCH_DEBUG === '1'
    ? [...graphSegmentBudgetByRoute].map(([routeId, budget]) => {
      const retainedSegments = selectedSegmentsByRoute.get(routeId)?.length ?? 0;
      const wholeTripSegments = (segmentsByRoute.get(routeId) ?? [])
        .reduce((total, trip) => total + trip.segments.length, 0);
      const overflowCandidates = overflowCandidatesByRoute.get(routeId)?.length ?? 0;
      return {
        routeId, budget, estimatedDemand: candidateDemandByRoute.get(routeId) ?? 0,
        wholeTripSegments, overflowCandidates, overflowAdded: Math.max(0, retainedSegments - wholeTripSegments),
        unused: Math.max(0, budget - retainedSegments),
      };
    }).filter((route) => route.unused > 0)
      .sort((left, right) => right.unused - left.unused || compareStableId(left.routeId, right.routeId))
      .slice(0, 10)
    : undefined;
  const debugCandidateTripTrace = debugTraceCandidateTripSet ? (() => {
    const finalGraphKeys = new Set(segments.map((segment) =>
      `${segment.providerId}\u0000${segment.serviceDate}\u0000${segment.tripId}\u0000${segment.originStop.id}\u0000${segment.destinationStop.id}\u0000${segment.departureAt.getTime()}\u0000${segment.arrivalAt.getTime()}`));
    const computeNonMutatingRank = (candidate: RetainedGtfsSegment,
      prior: boolean, next: boolean, onwardArrival: number | null): [number, number, number, number, number, number] => {
      if (candidate.sampleRank) return [...candidate.sampleRank] as [number, number, number, number, number, number];
      const endsAtDestination = destinationStopIds.has(candidate.destinationContext.details.id);
      const canCatchOrigin = canBoardOriginCandidate(candidate);
      const duration = candidate.arrivalAt.getTime() - candidate.departureAt.getTime();
      const direct = canCatchOrigin && endsAtDestination;
      const joinsOppositeFrontier = !direct && (canCatchOrigin ? next : endsAtDestination && prior);
      const rankValue: [number, number, number, number, number, number] = direct
        ? [0, 0, candidate.originContext.distanceToOriginStopMeters + candidate.destinationContext.distanceFromDestinationStopMeters,
          duration, candidate.departureAt.getTime(), candidate.arrivalAt.getTime()]
        : joinsOppositeFrontier
          ? [1, 0, canCatchOrigin ? candidate.originContext.distanceToOriginStopMeters
            : candidate.destinationContext.distanceFromDestinationStopMeters,
          canCatchOrigin ? duration : candidate.arrivalAt.getTime() - input.earliestDeparture.getTime(),
          candidate.departureAt.getTime(), candidate.arrivalAt.getTime()]
        : canCatchOrigin
          ? [2, 0, candidate.originContext.distanceToOriginStopMeters, duration, candidate.departureAt.getTime(), candidate.arrivalAt.getTime()]
          : endsAtDestination
            ? [3, 0, candidate.destinationContext.distanceFromDestinationStopMeters, duration, candidate.departureAt.getTime(), candidate.arrivalAt.getTime()]
            : [4, 1, 0, duration, candidate.departureAt.getTime(), candidate.arrivalAt.getTime()];
      if (rankValue[0] === 4) {
        if (onwardArrival !== null || (prior && next)) {
          rankValue[0] = 1;
          rankValue[1] = 0;
          rankValue[2] = (onwardArrival ?? candidate.arrivalAt.getTime()) - input.earliestDeparture.getTime();
        } else {
          const connectedRoutes = new Set<string>();
          for (const stopId of [...candidate.originContext.transferNodeIds, candidate.destinationContext.details.id,
            ...candidate.destinationContext.transferNodeIds]) {
            for (const routeId of routesByStop.get(stopId) ?? []) connectedRoutes.add(routeId);
            const stop = feed.stops.get(stopId);
            if (stop?.parentStation) {
              for (const routeId of routesByParentStation.get(stop.parentStation) ?? []) connectedRoutes.add(routeId);
            }
          }
          connectedRoutes.delete(candidate.routeId);
          rankValue[1] = 1;
          rankValue[2] = -connectedRoutes.size;
        }
      }
      return rankValue;
    };
    const allRows: Array<{
      priorityBucket: number;
      tripId: string;
      serviceDate: string;
      routeId: string;
      fromStopId: string;
      toStopId: string;
      fromIndex: number;
      toIndex: number;
      departureAtMs: number;
      arrivalAtMs: number;
      hasPriorEvent: boolean;
      hasNextEvent: boolean;
      earliestQueryArrivalAfterSegment: number | null;
      rank: [number, number, number, number, number, number];
      survivedTripProjection: boolean;
      connectorScanIndex: number | null;
      connectorEvalIndex: number | null;
      connectorEvalCap: number;
      retentionTier: number | null;
      retentionPriorityTier: number | null;
      survivesFinalGraph: boolean;
    }> = [];
    const trips = debugTracedTripInstances.map((instance) => {
      const projectedSet = new Set(instance.retainedTripCandidates);
      let priorTrueCount = 0;
      let nextTrueCount = 0;
      let onwardNonNullCount = 0;
      let finalGraphSurvivingCount = 0;
      for (const candidate of instance.materializedCandidates) {
        const fromStopId = candidate.originContext.details.id;
        const toStopId = candidate.destinationContext.details.id;
        const prior = hasPriorEvent(candidate, minimumTransferBufferSeconds);
        const next = hasNextEvent(candidate, minimumTransferBufferSeconds);
        const onward = prior ? earliestQueryArrivalAfterSegment(candidate, minimumTransferBufferSeconds) : null;
        if (prior) priorTrueCount++;
        if (next) nextTrueCount++;
        if (onward !== null) onwardNonNullCount++;
        const survivesFinalGraph = finalGraphKeys.has(retainedCandidateKey(candidate));
        if (survivesFinalGraph) finalGraphSurvivingCount++;
        const survivedTripProjection = projectedSet.has(candidate);
        const connectorScanIndex = instance.connectorScanIndexByCandidate.get(candidate) ?? null;
        const connectorEvalIndex = instance.connectorEvalIndexByCandidate.get(candidate) ?? null;
        const rank = computeNonMutatingRank(candidate, prior, next, onward);
        const isTargetPair = debugCandidateTraceTargetPairs.has(`${candidate.tripId}:${fromStopId}:${toStopId}`);
        const priorityBucket = isTargetPair ? 0
          : survivesFinalGraph ? 1
            : connectorEvalIndex !== null ? 2
              : survivedTripProjection ? 3
                : onward !== null ? 4
                  : (prior && next) ? 5
                    : prior || next ? 6 : 7;
        allRows.push({
          priorityBucket,
          tripId: candidate.tripId,
          serviceDate: candidate.serviceDate,
          routeId: candidate.routeId,
          fromStopId,
          toStopId,
          fromIndex: candidate.fromIndex,
          toIndex: candidate.toIndex,
          departureAtMs: candidate.departureAt.getTime(),
          arrivalAtMs: candidate.arrivalAt.getTime(),
          hasPriorEvent: prior,
          hasNextEvent: next,
          earliestQueryArrivalAfterSegment: onward,
          rank,
          survivedTripProjection,
          connectorScanIndex,
          connectorEvalIndex,
          connectorEvalCap: 2,
          retentionTier: instance.retentionTier,
          retentionPriorityTier: instance.retentionPriorityTier,
          survivesFinalGraph,
        });
      }
      return {
        tripId: instance.tripId,
        routeId: instance.routeId,
        serviceDate: instance.serviceDate,
        eligibleStopCount: instance.eligibleStopCount,
        materializedPairCount: instance.materializedCandidateCount,
        candidateRowsOmittedByTraceMemoryBound: instance.materializedCandidateTraceOmitted,
        omittedBeyondWindowCount: instance.omittedBeyondWindow,
        retainedInTripProjectionCount: instance.retainedTripCandidates.length,
        boundedTripProjectionUsed: instance.boundedTripProjectionUsed,
        graphSegmentLimitPerRoute: instance.graphSegmentLimitPerRoute,
        traceSampledPairCount: instance.materializedCandidates.length,
        traceSampledPriorTrueCount: priorTrueCount,
        traceSampledNextTrueCount: nextTrueCount,
        traceSampledOnwardNonNullCount: onwardNonNullCount,
        feasibleConnectorEvaluations: instance.feasibleConnectorEvaluations,
        feasibleConnectorEvaluationCap: 2,
        bestConnector: instance.bestConnector,
        retentionTier: instance.retentionTier,
        retentionPriorityTier: instance.retentionPriorityTier,
        endpointArrivalMinute: instance.endpointArrivalMinute,
        retainedWholeTripGroup: instance.retainedWholeTripGroup,
        traceSampledFinalGraphSurvivingCount: finalGraphSurvivingCount,
      };
    });
    allRows.sort((left, right) => {
      if (left.priorityBucket !== right.priorityBucket) return left.priorityBucket - right.priorityBucket;
      for (let index = 0; index < left.rank.length; index++) {
        if (left.rank[index] !== right.rank[index]) return left.rank[index] - right.rank[index];
      }
      return compareStableId(left.tripId, right.tripId)
        || compareStableId(left.serviceDate, right.serviceDate)
        || left.fromIndex - right.fromIndex
        || left.toIndex - right.toIndex;
    });
    const candidates = allRows.slice(0, 64).map(({ priorityBucket: _bucket, ...row }) => row);
    return { requestedTrips: debugTraceCandidateTrips, trips, candidates };
  })() : undefined;
  debugTracedTripInstances.length = 0;
  debugStage('segments-built', { tripsConsidered, tripsWithEligibleStops, segments: segments.length,
    serviceDates: serviceDates.size, corridorStops: corridorStops.size,
    candidateRouteCount, graphRoutesWithCandidates: segmentsByRoute.size,
    graphRoutesAtLimit: [...selectedSegmentsByRoute].filter(([routeId, routeSegments]) => routeSegments.length === graphSegmentBudgetByRoute.get(routeId)).length,
    graphSegmentBudgetTotal: [...graphSegmentBudgetByRoute.values()].reduce((sum, value) => sum + value, 0),
    graphSegmentBudgetUnused: Math.max(0, [...graphSegmentBudgetByRoute.values()].reduce((sum, value) => sum + value, 0) - segments.length),
    graphSegmentBudgetMax: Math.max(0, ...graphSegmentBudgetByRoute.values()),
    graphRoutesUnderfilled, graphRouteBudgetMaxUnused,
    overflowReservoirRetained: overflowReservoirSizes.reduce((sum, size) => sum + size, 0),
    overflowReservoirsAtCap: overflowReservoirSizes.filter((size) => size >= MAX_ROUTE_OVERFLOW_SEGMENTS).length,
    overflowConnectorReservoirRetained: overflowConnectorReservoirSizes.reduce((sum, size) => sum + size, 0),
    overflowConnectorReservoirsAtCap: overflowConnectorReservoirs.filter(({ retained, capacity }) =>
      capacity > 0 && retained >= capacity).length,
    overflowSegmentsRedistributed: redistributed.added,
    ...(debugSearch ? {
      earliestQueryArrivalCalls: debugEarliestQueryArrivalCalls,
      onwardArrivalWeakMapHits: debugOnwardArrivalWeakMapHits,
      onwardArrivalStringCacheHits: debugOnwardArrivalStringCacheHits,
      reachableStopSetBuilds: debugReachableStopSetBuilds,
      destinationEventsScanned: debugDestinationEventsScanned,
      connectorCandidatesInspected: debugConnectorCandidatesInspected,
      connectorReservoirSorts: debugConnectorReservoirSorts,
      connectorReservoirItemsInspected: debugConnectorReservoirItemsInspected,
    } : {}),
    ...(routeBudgetUnderfillSample ? { routeBudgetUnderfillSample: JSON.stringify(routeBudgetUnderfillSample) } : {}),
    ...(debugCandidateTripTrace ? { debugCandidateTripTrace: JSON.stringify(debugCandidateTripTrace) } : {}),
    estimatedGraphDemand, graphRoutesBudgetLimited, graphRoutesAtPerRouteCap,
    globalGraphBudgetBinding: Number(globalGraphBudgetBinding),
    segmentGraphTruncated: Number(segmentGraphTruncated) });
  // Retention reservoirs and their compact stop-context candidates are only
  // used to build the selected journey graph and its diagnostic snapshot.
  // Release these references before creating transfer adjacency and searching
  // paths so dense feeds do not keep both the discarded candidate graph and
  // the public GtfsDirectJourney graph alive throughout the search.
  segmentsByRoute.clear();
  overflowSegmentsByRoute.clear();
  selectedSegmentsByRoute.clear();
  redistributed.routes.clear();
  const outgoing = new Map<string, GtfsDirectJourney[]>();
  for (const segment of segments) {
    const choices = outgoing.get(segment.originStop.id) ?? [];
    choices.push(segment);
    outgoing.set(segment.originStop.id, choices);
  }
  for (const choices of outgoing.values()) choices.sort((a, b) => a.departureAt.getTime() - b.departureAt.getTime() || a.arrivalAt.getTime() - b.arrivalAt.getTime());

  // Index transfer endpoints by GTFS node IDs and by nearby stop IDs. The
  // geographic grid contains each stop once; it never stores a copy of every
  // scheduled segment in the cell, which made the old dense-city lookup
  // quadratic on real Lviv data.
  // Each segment is indexed once per distinct canonical boarding node. Store
  // these references in arrays: transferNodeList is already de-duplicated, so
  // a Set per node adds hashing/table overhead without changing membership.
  const outgoingByTransferNodeId = new Map<string, GtfsDirectJourney[]>();
  for (const segment of segments) {
    for (const nodeId of segment.originTransferNodeIds) {
      const choices = outgoingByTransferNodeId.get(nodeId) ?? [];
      choices.push(segment);
      outgoingByTransferNodeId.set(nodeId, choices);
    }
  }
  const outgoingStopCoordinates = new Map<string, [number, number]>();
  const outgoingStopIdsByTransferCell = new Map<string, string[]>();
  for (const [stopId, choices] of outgoing) {
    const coordinates = choices[0]?.originStop.coordinates;
    if (!coordinates) continue;
    outgoingStopCoordinates.set(stopId, coordinates);
    const [x, y] = transferCell(coordinates);
    const key = `${x}:${y}`;
    const ids = outgoingStopIdsByTransferCell.get(key) ?? [];
    ids.push(stopId);
    outgoingStopIdsByTransferCell.set(key, ids);
  }
  const transferTargetsByFromNode = new Map<string, Set<string>>();
  for (const rule of feed.transfers ?? []) {
    const targets = transferTargetsByFromNode.get(rule.fromStopId) ?? new Set<string>();
    targets.add(rule.toStopId);
    transferTargetsByFromNode.set(rule.fromStopId, targets);
  }
  const transferCandidateCache = new Map<string, GtfsDirectJourney[]>();
  const transferCandidateKey = (previous: GtfsDirectJourney) =>
    `${previous.providerId}\u0001${previous.destinationStop.id}`
      + `\u0001${previous.destinationStop.coordinates[0]}:${previous.destinationStop.coordinates[1]}`
      + `\u0001${previous.destinationTransferNodeIds.join('\u0000')}`;
  const transferCandidateViewKey = (previous: GtfsDirectJourney) => `${transferCandidateKey(previous)}\u0001${previous.routeId}`;
  const transferCandidateViewCache = new Map<string, GtfsDirectJourney[]>();
  // At each transfer depth, many scheduled segments lead to stops that cannot
  // reach the destination with the remaining leg budget. Cache a reachability-
  // filtered view once per equivalent transfer state so queue expansion does
  // not spend one search step per known-dead segment on every path.
  const transferCandidateReachableCache = new Map<string, GtfsDirectJourney[]>();

  const walkingSeconds = (meters: number) => Math.ceil(meters / 1.25);

  /** Iterate a transfer state's superset without allocating or sorting a candidate pool. */
  const forEachTransferCandidate = (previous: GtfsDirectJourney, visit: (candidate: GtfsDirectJourney) => boolean) => {
    for (const candidate of outgoing.get(previous.destinationStop.id) ?? []) if (!visit(candidate)) return false;
    const [centerX, centerY] = transferCell(previous.destinationStop.coordinates);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const stopId of outgoingStopIdsByTransferCell.get(`${centerX + dx}:${centerY + dy}`) ?? []) {
        const coordinates = outgoingStopCoordinates.get(stopId);
        if (!coordinates || distanceMeters(previous.destinationStop.coordinates, coordinates) > transferRadius) continue;
        for (const candidate of outgoing.get(stopId) ?? []) {
          const hasDeclaredCrossProviderTransfer = previous.destinationTransferNodeIds.some((fromNodeId) =>
            candidate.originTransferNodeIds.some((toNodeId) => transferTargetsByFromNode.get(fromNodeId)?.has(toNodeId)));
          // Same-feed platforms may use a bounded walking transfer even when
          // transfers.txt is incomplete. Across independent providers, require
          // a canonical merged stop or a declared transfer edge; coordinate
          // proximity alone can join unrelated nearby systems.
          if (previous.providerId !== candidate.providerId && !hasDeclaredCrossProviderTransfer) continue;
          if (!visit(candidate)) return false;
        }
      }
    }
    for (const fromNodeId of previous.destinationTransferNodeIds) {
      for (const toNodeId of transferTargetsByFromNode.get(fromNodeId) ?? []) {
        for (const candidate of outgoingByTransferNodeId.get(toNodeId) ?? []) if (!visit(candidate)) return false;
      }
    }
    if (previous.destinationTransferNodeIds.some((id) => pathwayNodes.has(id))) {
      for (const fromNodeId of previous.destinationTransferNodeIds) {
        if (!pathwayNodes.has(fromNodeId)) continue;
        for (const toNodeId of reachablePathwayNodes(fromNodeId)) {
          for (const candidate of outgoingByTransferNodeId.get(toNodeId) ?? []) {
            if (previous.providerId === candidate.providerId && !visit(candidate)) return false;
          }
        }
      }
    }
    return true;
  };

  const transferCandidatePool = (previous: GtfsDirectJourney) => {
    const stateKey = transferCandidateKey(previous);
    const cached = transferCandidateCache.get(stateKey);
    if (cached) return cached;
    {
      const choices = new Set<GtfsDirectJourney>(outgoing.get(previous.destinationStop.id) ?? []);
      const [centerX, centerY] = transferCell(previous.destinationStop.coordinates);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const stopId of outgoingStopIdsByTransferCell.get(`${centerX + dx}:${centerY + dy}`) ?? []) {
          const coordinates = outgoingStopCoordinates.get(stopId);
          if (!coordinates || distanceMeters(previous.destinationStop.coordinates, coordinates) > transferRadius) continue;
          for (const candidate of outgoing.get(stopId) ?? []) {
            const hasDeclaredCrossProviderTransfer = previous.destinationTransferNodeIds.some((fromNodeId) =>
              candidate.originTransferNodeIds.some((toNodeId) => transferTargetsByFromNode.get(fromNodeId)?.has(toNodeId)));
            // Same-feed platforms may use a bounded walking transfer even when
            // transfers.txt is incomplete. Across independent providers, require
            // a canonical merged stop or a declared transfer edge; coordinate
            // proximity alone can join unrelated nearby systems.
            if (previous.providerId !== candidate.providerId && !hasDeclaredCrossProviderTransfer) continue;
            choices.add(candidate);
          }
        }
      }
      for (const fromNodeId of previous.destinationTransferNodeIds) {
        for (const toNodeId of transferTargetsByFromNode.get(fromNodeId) ?? []) {
          for (const candidate of outgoingByTransferNodeId.get(toNodeId) ?? []) choices.add(candidate);
        }
      }
      if (previous.destinationTransferNodeIds.some((id) => pathwayNodes.has(id))) {
        for (const fromNodeId of previous.destinationTransferNodeIds) {
          if (!pathwayNodes.has(fromNodeId)) continue;
          for (const toNodeId of reachablePathwayNodes(fromNodeId)) {
            for (const candidate of outgoingByTransferNodeId.get(toNodeId) ?? []) {
              if (previous.providerId === candidate.providerId) choices.add(candidate);
            }
          }
        }
      }
      const sorted = [...choices].sort((a, b) => a.departureAt.getTime() - b.departureAt.getTime() || a.arrivalAt.getTime() - b.arrivalAt.getTime());
      transferCandidateCache.set(stateKey, sorted);
      return sorted;
    }
  };
  const transferCandidates = (previous: GtfsDirectJourney) => {
    const viewKey = transferCandidateViewKey(previous);
    const view = transferCandidateViewCache.get(viewKey);
    if (view) return view;
    const sorted = transferCandidatePool(previous);
    const eligible = sorted.filter((candidate) => {
      if (candidate.routeId !== previous.routeId) return true;
      // A GTFS type-4 transfer explicitly continues in the same vehicle. It
      // can legitimately connect two trips on the same route, so do not let
      // the generic same-route de-duplication hide it from feasibility checks.
      const { rule, ambiguous } = transferRuleFor(previous, candidate);
      return !ambiguous && rule?.transferType === 4;
    });
    transferCandidateViewCache.set(viewKey, eligible);
    return eligible;
  };

  // The feed can contain hundreds of thousands of stop-pair segments, but
  // many share the same route, transfer node, and platform coordinates. The
  // reverse reachability pass only needs one representative per equivalent
  // transfer state; indexing those once avoids rebuilding state keys and
  // scanning the full segment array at every transfer depth.
  const transferStateGroups = new Map<string, Map<string, GtfsDirectJourney>>();
  for (const segment of segments) {
    const stateKey = transferCandidateKey(segment);
    const routeStates = transferStateGroups.get(stateKey) ?? new Map<string, GtfsDirectJourney>();
    if (!routeStates.has(segment.routeId)) routeStates.set(segment.routeId, segment);
    transferStateGroups.set(stateKey, routeStates);
  }

  const results = new Map<string, GtfsItinerary>();
  const MAX_SEARCH_RESULTS = limit * 25;
  // Once a leg-count pool is full, keep searching a bounded window so late
  // objective improvements can enter the reservoirs without scanning the
  // entire dense feed. Any remaining work is still reported as truncated.
  const MAX_OBJECTIVE_RESERVOIR_SEARCH_STEPS = graphLimits.maxObjectiveReservoirSearchSteps ?? 25_000;
  if (!Number.isSafeInteger(MAX_OBJECTIVE_RESERVOIR_SEARCH_STEPS) || MAX_OBJECTIVE_RESERVOIR_SEARCH_STEPS < 0) {
    throw new RangeError('maxObjectiveReservoirSearchSteps must be a non-negative safe integer');
  }
  let candidatePoolReachedAtStep: number | null = null;
  const objectiveCandidateSamples = new Map<string, GtfsItinerary[]>();
  const objectiveSampleLimit = Math.max(1, Math.floor(limit / 5));
  const retainObjectiveCandidate = (key: string, candidate: GtfsItinerary,
    compare: (left: GtfsItinerary, right: GtfsItinerary) => number) => {
    const sample = objectiveCandidateSamples.get(key) ?? [];
    if (sample.some((item) => item.id === candidate.id)) return;
    let low = 0, high = sample.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(sample[middle], candidate) <= 0) low = middle + 1;
      else high = middle;
    }
    if (low >= objectiveSampleLimit) return;
    sample.splice(low, 0, candidate);
    if (sample.length > objectiveSampleLimit) sample.pop();
    objectiveCandidateSamples.set(key, sample);
  };
  const retainCandidateObjectives = (candidate: GtfsItinerary) => {
    retainObjectiveCandidate('duration', candidate, (a, b) => a.durationSeconds - b.durationSeconds
      || a.transfers - b.transfers || compareStableId(a.id, b.id));
    if (candidate.fare?.currency === 'UAH') retainObjectiveCandidate('fare', candidate, (a, b) => a.fare!.priceMinor - b.fare!.priceMinor
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
    retainObjectiveCandidate('transfers', candidate, (a, b) => a.transfers - b.transfers
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
    retainObjectiveCandidate('walking', candidate, (a, b) => a.walkingMeters - b.walkingMeters
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
    objectiveCandidateSamples.set('balanced', retainGtfsDeterministicOverflowSample(
      objectiveCandidateSamples.get('balanced') ?? [], candidate, objectiveSampleLimit));
  };
  const resultCountByRouteChain = new Map<string, number>();
  const resultIdsByRouteChain = new Map<string, Set<string>>();
  const resultIdsByTripChain = new Map<string, Set<string>>();
  const resultCountByLegCount = new Map<number, number>();
  const candidatePoolReachedAtStepByLegCount = new Map<number, number>();
  const MAX_RESULTS_PER_ROUTE_CHAIN = 8;
  // Keep a few useful boarding/alighting variants for the same scheduled
  // vehicles, selected across time, fare, transfer, and walking objectives.
  const MAX_RESULTS_PER_TRIP_CHAIN = 4;
  const maxTransitLegs = maximumTransfers + 1;
  // Keep the per-leg sampling cap independent of the caller's response-page
  // size so later cross-provider ranking receives a consistent diverse pool.
  // The separate global result cap below still bounds retained path objects.
  const MAX_CANDIDATES_PER_LEG_COUNT = graphLimits.maxCandidatesPerLegCount ?? 750;
  if (!Number.isSafeInteger(MAX_CANDIDATES_PER_LEG_COUNT) || MAX_CANDIDATES_PER_LEG_COUNT < 1) {
    throw new RangeError('maxCandidatesPerLegCount must be a positive safe integer');
  }
  // Most city-feed stops cannot lead to this destination. Exclude those dead
  // ends before enumerating timed transfer combinations.
  const reachableWithin = [destinationStopIds];
  for (let legCount = 1; legCount <= maxTransitLegs; legCount++) {
    const reachable = new Set(reachableWithin[legCount - 1]);
    for (const previousByRoute of transferStateGroups.values()) {
      const previous = previousByRoute.values().next().value as GtfsDirectJourney | undefined;
      if (!previous) continue;
      const reachableCandidateRoutes = new Set<string>();
      let sameRouteInSeatReachable = false;
      forEachTransferCandidate(previous, (next) => {
        if (!reachable.has(next.destinationStop.id)) return true;
        reachableCandidateRoutes.add(next.routeId);
        if (next.routeId === previous.routeId) {
          const { rule, ambiguous } = transferRuleFor(previous, next);
          if (!ambiguous && rule?.transferType === 4) sameRouteInSeatReachable = true;
        }
        // Two distinct onward routes provide a feasible choice for every
        // previous line, so stop scanning this broad candidate pool early.
        return reachableCandidateRoutes.size <= 1;
      });
      // Reachability is queried at the arrival end of the current itinerary
      // leg. Keep that arrival stop reachable when a valid onward segment can
      // reach the destination within the remaining leg budget, including when
      // an explicit GTFS transfer/pathway joins distinct canonical stop IDs.
      if (reachableCandidateRoutes.size > 1) reachable.add(previous.destinationStop.id);
      else if (reachableCandidateRoutes.size === 1) {
        const onlyCandidateRoute = reachableCandidateRoutes.values().next().value as string;
        for (const [previousRoute, routeState] of previousByRoute) {
          if (previousRoute !== onlyCandidateRoute || sameRouteInSeatReachable) reachable.add(routeState.destinationStop.id);
        }
      }
    }
    reachableWithin.push(reachable);
  }
  const transferCandidatesWithin = (previous: GtfsDirectJourney, remainingLegs: number) => {
    const cacheKey = `${transferCandidateViewKey(previous)}\u0001${remainingLegs}`;
    const cached = transferCandidateReachableCache.get(cacheKey);
    if (cached) return cached;
    const canReach = reachableWithin[remainingLegs - 1];
    const candidates = transferCandidates(previous).filter((candidate) => canReach.has(candidate.destinationStop.id));
    transferCandidateReachableCache.set(cacheKey, candidates);
    return candidates;
  };
  debugStage('reachability-built', { transferStates: transferCandidateCache.size,
    routeStates: transferCandidateViewCache.size, reachableStops: reachableWithin.at(-1)?.size ?? 0 });
  let candidateSamplingTruncated = false;
  const addPath = (path: GtfsDirectJourney[], expectedLegCount: number) => {
    if (path.length !== expectedLegCount) return;
    if (debugTraceTripChainSet) {
      const tripChain = path.map((segment) => `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>');
      if (debugTraceTripChainSet.has(tripChain)) debugCompletedTripChains?.add(tripChain);
    }
    const first = path[0];
    const last = path.at(-1)!;
    const accessMeters = first.distanceToOriginStopMeters;
    const egressMeters = last.distanceFromDestinationStopMeters;
    const transferDecisions = path.slice(1).map((segment, index) => transferDecision(path[index], segment));
    const transferWalkingMeters = transferDecisions.map(({ measure }) => measure.walkingMeters);
    const transferWalkingSeconds = transferDecisions.map(({ measure }) => measure.walkingSeconds);
    const transferWalkingGeometries = transferDecisions.map(({ measure }) => measure.geometry);
    // Search time means when the passenger is ready to start, so initial access
    // walking and waiting for the first service are part of the door-to-door
    // duration. Ranking only the interval between the first and last vehicle
    // would incorrectly prefer a later departure with an earlier onboard start.
    const departureAt = new Date(input.earliestDeparture);
    const egressSeconds = walkingSeconds(egressMeters);
    const arrivalAt = new Date(last.arrivalAt.getTime() + egressSeconds * 1000);
    const durationSeconds = Math.ceil((arrivalAt.getTime() - departureAt.getTime()) / 1000);
    if (durationSeconds > maximumJourneySeconds) return;
    const initialWaitSeconds = Math.max(0, Math.ceil((first.departureAt.getTime()
      - departureAt.getTime() - walkingSeconds(accessMeters) * 1000) / 1000));
    const transferWaitingSeconds = path.slice(1).reduce((total, segment, index) => {
      const transferWalkSeconds = transferWalkingSeconds[index] ?? 0;
      const readyAt = path[index].arrivalAt.getTime() + transferWalkSeconds * 1000;
      return total + Math.max(0, Math.ceil((segment.departureAt.getTime() - readyAt) / 1000));
    }, 0);
    const id = path.map((segment) => `${segment.providerId}:${segment.serviceDate}:${segment.tripId}:${segment.originStop.id}:${segment.destinationStop.id}:${segment.departureAt.getTime()}:${segment.arrivalAt.getTime()}`).join('|');
    if (results.has(id)) return;
    const routeChain = path.map((segment, index) => index === 0 || path[index - 1].providerId !== segment.providerId
      || path[index - 1].routeId !== segment.routeId ? `${segment.providerId}:${segment.routeId}` : '')
      .filter(Boolean).join('>');
    const routeChainIds = resultIdsByRouteChain.get(routeChain) ?? new Set<string>();
    const tripChain = path.map((segment) => `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>');
    if (debugGeneratedTripChains) debugGeneratedTripChains.add(tripChain);
    const tripChainIds = resultIdsByTripChain.get(tripChain) ?? new Set<string>();
    const isKnownTripChain = tripChainIds.size > 0;
    const legCount = resultCountByLegCount.get(path.length) ?? 0;
    const canReplaceRouteChainCandidate = routeChainIds.size >= MAX_RESULTS_PER_ROUTE_CHAIN;
    const candidate: GtfsItinerary = {
      id, providerId: first.providerId,
      providerName: [...new Set(path.map((segment) => segment.providerName))].join(' + '),
      segments: path, departureAt, arrivalAt, durationSeconds,
      waitingSeconds: initialWaitSeconds + transferWaitingSeconds,
      transfers: transferDecisions.filter(({ measure }) => !measure.inSeat).length,
      walkingMeters: accessMeters + egressMeters + transferWalkingMeters.reduce((sum, meters) => sum + meters, 0),
      transferWalkingMeters, transferWalkingSeconds, transferWalkingGeometries,
      transferInSeat: transferDecisions.map(({ measure }) => measure.inSeat),
      transferMinimumBufferSeconds: transferDecisions.map(({ minimumBufferSeconds }) => minimumBufferSeconds),
      transferRuleMinimumSeconds: transferDecisions.map(({ ruleMinimumSeconds }) => ruleMinimumSeconds),
      fare: calculateGtfsItineraryFare({ products: feed.fareProducts ?? new Map(), rules: feed.fareRules ?? new Map(), faresV2Present: feed.faresV2Present === true }, path.map((segment) => ({
        providerId: segment.providerId, routeId: segment.routeId,
        ...(feed.routes.get(segment.routeId)?.agencyId ? { agencyId: feed.routes.get(segment.routeId)!.agencyId } : {}),
        departureAt: segment.departureAt, arrivalAt: segment.arrivalAt,
      ...(segment.originZoneId ? { originZoneId: segment.originZoneId } : {}),
      ...(segment.destinationZoneId ? { destinationZoneId: segment.destinationZoneId } : {}),
        traveledZoneIds: (() => {
          const indexes = shapeIndexesBySegment.get(segment);
          const stopTimes = feed.stopTimes.get(segment.tripId) ?? [];
          return indexes
            ? stopTimes.slice(indexes.fromIndex, indexes.toIndex + 1).flatMap((entry) => entry.sourceZoneId ? [entry.sourceZoneId] : [])
            : segment.traveledZoneIds;
        })(),
      }))) ?? calculateCityTariffFare(path.map((segment) => ({
        providerCity: segment.providerCity,
        mode: segment.mode,
        transportType: segment.transportType,
        departureAt: segment.departureAt,
        arrivalAt: segment.arrivalAt,
      }))),
    };
    if ((!isKnownTripChain && !canReplaceRouteChainCandidate
      && (legCount >= MAX_CANDIDATES_PER_LEG_COUNT || results.size >= MAX_SEARCH_RESULTS))) {
      if (!candidatePoolReachedAtStepByLegCount.has(path.length)) {
        candidatePoolReachedAtStepByLegCount.set(path.length, searchSteps);
      }
      // Keep a small per-objective reservoir after the bounded general pool
      // fills. A late known-cheapest option must remain available to the
      // CHEAPEST response even though the complete search is still flagged as
      // sampled/truncated.
      retainCandidateObjectives(candidate);
      candidateSamplingTruncated = true;
      return;
    }
    const existingVariants = [...tripChainIds].flatMap((existingId) => {
      const existing = results.get(existingId);
      return existing ? [existing] : [];
    });
    const selectedVariants = sampleGtfsTripChainCandidates([...existingVariants, candidate], MAX_RESULTS_PER_TRIP_CHAIN);
    const selectedIds = new Set(selectedVariants.map((itinerary) => itinerary.id));
    if (!selectedIds.has(id)) {
      // The local two-variant limit can reject a search-wide winner for
      // walking or balanced effort; preserve it for final global ranking.
      retainCandidateObjectives(candidate);
      candidateSamplingTruncated = true;
      return;
    }

    const replacedTripVariants = existingVariants.filter((variant) => !selectedIds.has(variant.id));
    const tripVariantsForRouteSample = [...routeChainIds]
      .filter((existingId) => !replacedTripVariants.some((variant) => variant.id === existingId))
      .flatMap((existingId) => {
        const existing = results.get(existingId);
        return existing ? [existing] : [];
      });
    const selectedRouteVariants = sampleGtfsRouteChainCandidates([...tripVariantsForRouteSample, candidate], MAX_RESULTS_PER_ROUTE_CHAIN);
    const selectedRouteIds = new Set(selectedRouteVariants.map((itinerary) => itinerary.id));
    if (!selectedRouteIds.has(id)) {
      // Route-chain normalization is local; a rejected option may still win
      // once candidates from the whole search are compared.
      retainCandidateObjectives(candidate);
      candidateSamplingTruncated = true;
      return;
    }

    const removedIds = new Set([...replacedTripVariants.map((variant) => variant.id),
      ...tripVariantsForRouteSample.filter((variant) => !selectedRouteIds.has(variant.id)).map((variant) => variant.id)]);
    if (results.size - removedIds.size + 1 > MAX_SEARCH_RESULTS) {
      retainCandidateObjectives(candidate);
      candidateSamplingTruncated = true;
      return;
    }

    for (const removedId of removedIds) {
      const removed = results.get(removedId);
      if (!removed) continue;
      // Keep previously selected candidates that the replacement evicts from
      // the bounded result pool available to the global objective reservoirs.
      retainCandidateObjectives(removed);
      results.delete(removedId);
      routeChainIds.delete(removedId);
      const removedTripChain = removed.segments.map((segment) => `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>');
      const removedTripChainIds = resultIdsByTripChain.get(removedTripChain);
      removedTripChainIds?.delete(removedId);
      if (removedTripChainIds?.size === 0) resultIdsByTripChain.delete(removedTripChain);
      resultCountByRouteChain.set(routeChain, Math.max(0, (resultCountByRouteChain.get(routeChain) ?? 1) - 1));
      resultCountByLegCount.set(removed.segments.length,
        Math.max(0, (resultCountByLegCount.get(removed.segments.length) ?? 1) - 1));
    }
    results.set(id, candidate);
    tripChainIds.add(id);
    resultIdsByTripChain.set(tripChain, tripChainIds);
    routeChainIds.add(id);
    resultIdsByRouteChain.set(routeChain, routeChainIds);
    resultCountByRouteChain.set(routeChain, (resultCountByRouteChain.get(routeChain) ?? 0) + 1);
    resultCountByLegCount.set(path.length, (resultCountByLegCount.get(path.length) ?? 0) + 1);
    if ((resultCountByLegCount.get(path.length) ?? 0) >= MAX_CANDIDATES_PER_LEG_COUNT
      && !candidatePoolReachedAtStepByLegCount.has(path.length)) {
      candidatePoolReachedAtStepByLegCount.set(path.length, searchSteps);
    }
    if (results.size >= MAX_SEARCH_RESULTS && candidatePoolReachedAtStep === null) candidatePoolReachedAtStep = searchSteps;
    if (removedIds.size > 0) candidateSamplingTruncated = true;
  };

  // Bound both graph expansion and queued alternatives. Search is round-robin
  // across first-leg route groups: a dense early route cannot spend the whole
  // budget before later lines contribute candidates to fastest/cheapest/balanced.
  let searchSteps = 0;
  // Dense urban feeds can require hundreds of thousands of bounded cursor
  // steps before the diverse 2/3-leg pool is complete. Keep a finite ceiling,
  // but do not cut off ordinary city results at the first-route frontier.
  const MAX_SEARCH_STEPS = graphLimits.maxSearchSteps ?? 1_000_000;
  if (!Number.isSafeInteger(MAX_SEARCH_STEPS) || MAX_SEARCH_STEPS < 1) {
    throw new RangeError('maxSearchSteps must be a positive safe integer');
  }
  // A step ceiling alone does not bound memory: each expanded path can enqueue
  // a large transfer fan-out before the next work item is visited. Keep the
  // pending frontier bounded independently, and disclose any dropped work via
  // the existing search-budget truncation flag.
  const MAX_QUEUED_SEARCH_WORK = graphLimits.maxQueuedSearchWork ?? 10_000;
  let queueWorkDropped = false;
  let globalBudgetPreventedDepthPass = false;
  let maximumQueuedSearchWork = 0;

  // Feed/trip insertion order is not a routing priority. In a dense city feed,
  // the bounded DFS could spend its entire budget on late or poorly connected
  // trips before it reached an earlier departure. Search feasible first legs
  // in passenger-ready order so the bounded candidate set is useful even when
  // the graph still needs a stronger search strategy to become exhaustive.
  const firstLegAccessSeconds = (segment: GtfsDirectJourney) => firstLegAccessSecondsBySegment.get(segment)!;
  const firstLegs = segments.filter((segment) => originStopIds.has(segment.originStop.id)
    && segment.departureAt.getTime() <= maxFirstDeparture
    && segment.departureAt.getTime() >= input.earliestDeparture.getTime()
      + firstLegAccessSeconds(segment) * 1000)
    .sort((a, b) => {
      const aReadyAt = a.departureAt.getTime() - firstLegAccessSeconds(a) * 1000;
      const bReadyAt = b.departureAt.getTime() - firstLegAccessSeconds(b) * 1000;
      return aReadyAt - bReadyAt
        || a.departureAt.getTime() - b.departureAt.getTime()
        || a.distanceToOriginStopMeters - b.distanceToOriginStopMeters
        || a.arrivalAt.getTime() - b.arrivalAt.getTime()
        || compareStableId(a.tripId, b.tripId)
        || compareStableId(a.destinationStop.id, b.destinationStop.id);
    });

  // Optional test seam: expose copies of the exact graph that production is
  // about to traverse. The observer receives stable IDs and delegates every
  // graph query back to the production closures above, so tests do not rebuild
  // corridor/catchment/interchange policy or successor adjacency themselves.
  // With no observer (the production call path), this branch does not execute.
  if (observeCandidateGraph) {
    const graphId = (segment: GtfsDirectJourney) => [segment.providerId, segment.serviceDate, segment.tripId,
      segment.originStop.id, segment.destinationStop.id, segment.departureAt.getTime(), segment.arrivalAt.getTime()].join(':');
    const byId = new Map<string, GtfsDirectJourney>();
    for (const segment of segments) {
      const id = graphId(segment);
      if (byId.has(id)) throw new Error(`duplicate GTFS candidate graph segment id: ${id}`);
      byId.set(id, segment);
    }
    const freezeJourney = (segment: GtfsDirectJourney): Readonly<GtfsDirectJourney> => Object.freeze({
      ...segment,
      originStop: Object.freeze({ ...segment.originStop,
        coordinates: Object.freeze([...segment.originStop.coordinates]) as unknown as [number, number] }),
      destinationStop: Object.freeze({ ...segment.destinationStop,
        coordinates: Object.freeze([...segment.destinationStop.coordinates]) as unknown as [number, number] }),
      originTransferNodeIds: Object.freeze([...segment.originTransferNodeIds]) as unknown as string[],
      destinationTransferNodeIds: Object.freeze([...segment.destinationTransferNodeIds]) as unknown as string[],
      traveledZoneIds: Object.freeze([...segment.traveledZoneIds]) as unknown as string[],
      ...(segment.routeGeometry ? { routeGeometry: Object.freeze(segment.routeGeometry.map((point) =>
        Object.freeze([...point]) as unknown as [number, number])) as unknown as Array<[number, number]> } : {}),
      ...(segment.stops ? { stops: Object.freeze(segment.stops.map((stop) => Object.freeze({ ...stop,
        coordinates: Object.freeze([...stop.coordinates]) as unknown as [number, number] }))) as unknown as GtfsDirectJourney['stops'] } : {}),
      scheduledDepartureAt: new Date(segment.scheduledDepartureAt), scheduledArrivalAt: new Date(segment.scheduledArrivalAt),
      departureAt: new Date(segment.departureAt), arrivalAt: new Date(segment.arrivalAt), sourceFreshAt: new Date(segment.sourceFreshAt),
      ...(segment.realtimeUpdatedAt ? { realtimeUpdatedAt: new Date(segment.realtimeUpdatedAt) } : {}),
    });
    const frozenSegments = Object.freeze([...byId].map(([id, journey]) => Object.freeze({ id, journey: freezeJourney(journey) })));
    const snapshot: GtfsCandidateGraphSnapshot = Object.freeze({
      segments: frozenSegments,
      firstLegIds: Object.freeze(firstLegs.map(graphId)),
      originStopIds: Object.freeze([...originStopIds]),
      destinationStopIds: Object.freeze([...destinationStopIds]),
      earliestDepartureMs: input.earliestDeparture.getTime(),
      latestDepartureMs: input.latestDeparture.getTime(),
      journeyEndMs: journeyEnd.getTime(),
      maximumWaitMs: maximumWaitSeconds * 1000,
      successors(previousId: string, remainingLegs: number) {
        const previous = byId.get(previousId);
        if (!previous || !Number.isInteger(remainingLegs) || remainingLegs < 1) return Object.freeze([]);
        return Object.freeze(transferCandidatesWithin(previous, remainingLegs).map(graphId));
      },
      transferDecision(previousId: string, nextId: string) {
        const previous = byId.get(previousId), next = byId.get(nextId);
        if (!previous || !next) throw new Error('unknown GTFS candidate graph segment id');
        const decision = transferDecision(previous, next);
        return Object.freeze({ ...decision, measure: Object.freeze({ ...decision.measure,
          ...(decision.measure.geometry ? { geometry: Object.freeze(decision.measure.geometry.map((point) =>
            Object.freeze([...point]) as unknown as [number, number])) as unknown as Array<[number, number]> } : {}) }),
        ...(decision.rule ? { rule: Object.freeze({ ...decision.rule }) } : {}) });
      },
    });
    observeCandidateGraph(snapshot);
  }

  type PathWork = { kind: 'path'; path: GtfsDirectJourney[] };
  type ChildWork = {
    kind: 'children';
    path: GtfsDirectJourney[];
    last: GtfsDirectJourney;
    choices: GtfsDirectJourney[];
    nextIndex: number;
    latestNext: number;
    remainingLegs: number;
    previousIds: Set<string>;
    visitedStops: Set<string>;
  };
  type SearchWork = PathWork | ChildWork;
  type RouteSearchQueue = {
    firstLegs: GtfsDirectJourney[];
    firstLegIndex: number;
    work: SearchWork[];
    workIndex: number;
    preferFirstLeg: boolean;
  };
  const pausedDepthPassQueues = new Map<number, RouteSearchQueue[]>();
  const truncatedDepthPasses = new Set<number>();
  const enqueueWork = (queue: RouteSearchQueue, work: SearchWork) => {
    if (queuesPendingWork >= MAX_QUEUED_SEARCH_WORK) {
      queueWorkDropped = true;
      return;
    }
    queue.work.push(work);
    maximumQueuedSearchWork = Math.max(maximumQueuedSearchWork,
      queuesPendingWork + 1);
    queuesPendingWork++;
  };
  let queuesPendingWork = 0;
  const canContinueCandidateSearch = (legCount: number) => {
    const candidatePoolHasRoom = results.size < MAX_SEARCH_RESULTS
      && (resultCountByLegCount.get(legCount) ?? 0) < MAX_CANDIDATES_PER_LEG_COUNT;
    const legReservoirReachedAt = candidatePoolReachedAtStepByLegCount.get(legCount);
    const withinLegObjectiveReservoir = legReservoirReachedAt === undefined
      || searchSteps - legReservoirReachedAt < MAX_OBJECTIVE_RESERVOIR_SEARCH_STEPS;
    return candidatePoolHasRoom || withinLegObjectiveReservoir;
  };
  const takeNextWork = (queue: RouteSearchQueue): SearchWork | undefined => {
    if (queue.preferFirstLeg && queue.firstLegIndex < queue.firstLegs.length) {
      queue.preferFirstLeg = false;
      return { kind: 'path', path: [queue.firstLegs[queue.firstLegIndex++]] };
    }
    if (queue.workIndex < queue.work.length) {
      queue.preferFirstLeg = true;
      const work = queue.work[queue.workIndex++];
      queuesPendingWork--;
      if (queue.workIndex >= 128 && queue.workIndex * 2 >= queue.work.length) {
        queue.work.splice(0, queue.workIndex);
        queue.workIndex = 0;
      }
      return work;
    }
    if (queue.firstLegIndex < queue.firstLegs.length) {
      queue.preferFirstLeg = false;
      return { kind: 'path', path: [queue.firstLegs[queue.firstLegIndex++]] };
    }
    return undefined;
  };
  const hasQueuedWork = (queues: RouteSearchQueue[]) => queues.some((queue) =>
    queue.firstLegIndex < queue.firstLegs.length || queue.workIndex < queue.work.length);
  const expandPath = (path: GtfsDirectJourney[], queue: RouteSearchQueue, maximumLegsForPass: number) => {
    searchSteps++;
    const last = path.at(-1)!;
    if (destinationStopIds.has(last.destinationStop.id) && path.length === maximumLegsForPass) {
      addPath(path, maximumLegsForPass);
    }
    const remainingLegs = maximumLegsForPass - path.length;
    if (remainingLegs <= 0 || !reachableWithin[remainingLegs].has(last.destinationStop.id)) return;
    const previousIds = new Set(path.map((segment) => segment.tripId));
    const visitedStops = new Set(path.map((segment) => segment.originStop.id));
    visitedStops.add(last.destinationStop.id);
    const choices = transferCandidatesWithin(last, remainingLegs);
    const latestNext = Math.min(last.arrivalAt.getTime() + maximumWaitSeconds * 1000, journeyEnd.getTime());
    let low = 0, high = choices.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (choices[middle].departureAt.getTime() < last.arrivalAt.getTime()) low = middle + 1;
      else high = middle;
    }
    if (low >= choices.length || choices[low].departureAt.getTime() > latestNext) return;
    enqueueWork(queue, { kind: 'children', path, last, choices, nextIndex: low, latestNext,
      remainingLegs, previousIds, visitedStops });
  };
  const expandNextChild = (work: ChildWork, queue: RouteSearchQueue) => {
    searchSteps++;
    const next = work.choices[work.nextIndex++];
    if (next.departureAt.getTime() <= work.latestNext
      && reachableWithin[work.remainingLegs - 1].has(next.destinationStop.id)
      && !work.previousIds.has(next.tripId) && !work.visitedStops.has(next.destinationStop.id)
      && transferDecision(work.last, next).feasible) {
      enqueueWork(queue, { kind: 'path', path: [...work.path, next] });
    }
    if (work.nextIndex < work.choices.length
      && work.choices[work.nextIndex].departureAt.getTime() <= work.latestNext) {
      enqueueWork(queue, work);
    }
  };
  const runDepthPass = (queues: RouteSearchQueue[], maximumLegsForPass: number, stepLimit: number) => {
    while (searchSteps < stepLimit && searchSteps < MAX_SEARCH_STEPS
      && canContinueCandidateSearch(maximumLegsForPass)) {
      let processed = false;
      for (const queue of queues) {
        if (searchSteps >= stepLimit || searchSteps >= MAX_SEARCH_STEPS
          || !canContinueCandidateSearch(maximumLegsForPass)) break;
        const work = takeNextWork(queue);
        if (!work) continue;
        processed = true;
        if (work.kind === 'path') expandPath(work.path, queue, maximumLegsForPass);
        else expandNextChild(work, queue);
      }
      if (!processed) break;
    }
  };
  const countPendingWork = (queues: RouteSearchQueue[]) => queues.reduce((count, queue) =>
    count + queue.work.length - queue.workIndex, 0);
  // Give each possible chain length an explicit share of the bounded search.
  // A single depth-first pass otherwise fills its candidate pool with the
  // maximum-transfer branches before it has represented useful shorter trips.
  const depthWeights = [0.05, 0.35, 0.27, 0.20, 0.13].slice(0, maxTransitLegs);
  for (let depthIndex = 0; depthIndex < maxTransitLegs; depthIndex++) {
    const maximumLegsForPass = depthIndex + 1;
    if ((resultCountByLegCount.get(maximumLegsForPass) ?? 0) >= limit) continue;
    if (searchSteps >= MAX_SEARCH_STEPS) { globalBudgetPreventedDepthPass = true; break; }
    if (results.size >= MAX_SEARCH_RESULTS
      && !candidatePoolReachedAtStepByLegCount.has(maximumLegsForPass)) {
      candidatePoolReachedAtStepByLegCount.set(maximumLegsForPass, searchSteps);
    }
    const remainingWeight = depthWeights.slice(depthIndex).reduce((sum, weight) => sum + weight, 0);
    const stepLimit = depthIndex === maxTransitLegs - 1
      ? MAX_SEARCH_STEPS
      : Math.min(MAX_SEARCH_STEPS, searchSteps + Math.max(1,
        Math.floor((MAX_SEARCH_STEPS - searchSteps) * depthWeights[depthIndex] / remainingWeight)));
    const firstLegGroups = new Map<string, GtfsDirectJourney[]>();
    for (const segment of firstLegs) {
      const key = `${segment.providerId}:${segment.routeId}`;
      const group = firstLegGroups.get(key) ?? [];
      group.push(segment);
      firstLegGroups.set(key, group);
    }
    queuesPendingWork = 0;
    const queues: RouteSearchQueue[] = [...firstLegGroups.values()].map((group) => ({
      firstLegs: group, firstLegIndex: 0, work: [], workIndex: 0, preferFirstLeg: true,
    }));
    runDepthPass(queues, maximumLegsForPass, stepLimit);
    if (hasQueuedWork(queues)) {
      truncatedDepthPasses.add(maximumLegsForPass);
      if (searchSteps >= stepLimit && stepLimit < MAX_SEARCH_STEPS
        && canContinueCandidateSearch(maximumLegsForPass)) {
        pausedDepthPassQueues.set(maximumLegsForPass, queues);
      }
    }
  }

  // Reuse budget left idle by a shallow depth pass only after all weighted
  // passes have had their own independent queues and allocations. Never use a
  // deeper pass's cursor to stand in for a shallower one: their path lengths
  // and completeness requirements differ.
  if (!queueWorkDropped && searchSteps < MAX_SEARCH_STEPS && pausedDepthPassQueues.size > 0) {
    const pausedDepths = [...pausedDepthPassQueues.keys()].sort((a, b) => a - b);
    let remainingWeight = pausedDepths.reduce((sum, depth) => sum + (depthWeights[depth - 1] ?? 1), 0);
    for (let index = 0; index < pausedDepths.length && searchSteps < MAX_SEARCH_STEPS; index++) {
      const depth = pausedDepths[index]!;
      const queues = pausedDepthPassQueues.get(depth)!;
      if (!hasQueuedWork(queues) || !canContinueCandidateSearch(depth)) continue;
      const weight = depthWeights[depth - 1] ?? 1;
      const stepLimit = index === pausedDepths.length - 1
        ? MAX_SEARCH_STEPS
        : Math.min(MAX_SEARCH_STEPS, searchSteps + Math.max(1,
          Math.floor((MAX_SEARCH_STEPS - searchSteps) * weight / remainingWeight)));
      queuesPendingWork = countPendingWork(queues);
      runDepthPass(queues, depth, stepLimit);
      if (!hasQueuedWork(queues)) truncatedDepthPasses.delete(depth);
      remainingWeight -= weight;
    }
  }
  const searchBudgetTruncated = queueWorkDropped || globalBudgetPreventedDepthPass || truncatedDepthPasses.size > 0;

  const allCandidateIds = new Set(results.keys());
  let rankedResults = [...results.values()];
  for (const sample of objectiveCandidateSamples.values()) {
    for (const candidate of sample) {
      if (allCandidateIds.has(candidate.id)) continue;
      allCandidateIds.add(candidate.id);
      rankedResults.push(candidate);
    }
  }
  const debugTripChainsBeforeFinalSampling = debugTraceTripChainSet ? debugTripChainsIn(rankedResults) : undefined;
  // Objective reservoirs are independent bounded samples. Their union can
  // exceed the per-chain limits even though the general result pool cannot;
  // reapply both limits before ranking the public response candidates.
  const candidatesByTripChain = new Map<string, GtfsItinerary[]>();
  for (const candidate of rankedResults) {
    const tripChain = candidate.segments.map((segment) =>
      `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>');
    const group = candidatesByTripChain.get(tripChain) ?? [];
    group.push(candidate);
    candidatesByTripChain.set(tripChain, group);
  }
  const boundedTripCandidates = [...candidatesByTripChain.values()].flatMap((group) =>
    sampleGtfsTripChainCandidates(group, MAX_RESULTS_PER_TRIP_CHAIN));
  const debugTripChainsAfterTripSampling = debugTraceTripChainSet ? debugTripChainsIn(boundedTripCandidates) : undefined;
  const candidatesByRouteChain = new Map<string, GtfsItinerary[]>();
  for (const candidate of boundedTripCandidates) {
    const routeChain = candidate.segments.filter((segment, index) => index === 0
      || candidate.segments[index - 1]?.providerId !== segment.providerId
      || candidate.segments[index - 1]?.routeId !== segment.routeId)
      .map((segment) => `${segment.providerId}:${segment.routeId}`).join('>');
    const group = candidatesByRouteChain.get(routeChain) ?? [];
    group.push(candidate);
    candidatesByRouteChain.set(routeChain, group);
  }
  rankedResults = [...candidatesByRouteChain.values()].flatMap((group) =>
    sampleGtfsRouteChainCandidates(group, MAX_RESULTS_PER_ROUTE_CHAIN));
  const debugTripChainsAfterRouteSampling = debugTraceTripChainSet ? debugTripChainsIn(rankedResults) : undefined;
  if (rankedResults.length < allCandidateIds.size) candidateSamplingTruncated = true;
  rankedResults.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime() || a.transfers - b.transfers || compareStableId(a.id, b.id));
  const byDuration = [...rankedResults].sort((a, b) => a.durationSeconds - b.durationSeconds
    || a.transfers - b.transfers || compareStableId(a.id, b.id));
  const byComparableFare = rankedResults.filter((itinerary) => itinerary.fare?.currency === 'UAH')
    .sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byTransfers = [...rankedResults].sort((a, b) => a.transfers - b.transfers
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byWalking = [...rankedResults].sort((a, b) => a.walkingMeters - b.walkingMeters
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const balanced = rankGtfsItinerariesForCandidateSampling(rankedResults);

  // Preserve objective extremes before filling the remaining response with
  // the fastest alternatives. The API scores these candidates again together
  // with carpool and other providers, so the GTFS stage must not discard its
  // only known-cheapest or low-transfer option just because it arrives later.
  // Protect the objective witnesses while reserving coverage for otherwise-hidden chains.
  const itineraries = selectGtfsResponseItineraries(
    rankedResults, [byDuration, byComparableFare, byTransfers, byWalking, balanced], limit,
  );
  for (const itinerary of itineraries) {
    for (const segment of itinerary.segments) {
      const indexes = shapeIndexesBySegment.get(segment);
      if (!indexes) continue;
      segment.routeGeometry ??= routeGeometryForTrip(feed, segment.tripId, indexes.fromIndex, indexes.toIndex);
      segment.stops ??= stopCallsForTrip(feed, segment.tripId, indexes.fromIndex, indexes.toIndex, indexes.serviceDate);
      segment.traveledZoneIds = (feed.stopTimes.get(segment.tripId) ?? [])
        .slice(indexes.fromIndex, indexes.toIndex + 1)
        .flatMap((entry) => entry.sourceZoneId ? [entry.sourceZoneId] : []);
    }
  }
  debugStage('itineraries-ranked', { searchSteps, firstLegs: firstLegs.length, candidateResults: rankedResults.length,
    ...Object.fromEntries(Array.from({ length: maxTransitLegs }, (_, index) =>
      [`candidatesWith${index + 1}Legs`, resultCountByLegCount.get(index + 1) ?? 0])),
    returnedByLegCount: JSON.stringify(itineraries.reduce<Record<number, number>>((counts, itinerary) => {
      counts[itinerary.segments.length] = (counts[itinerary.segments.length] ?? 0) + 1;
      return counts;
    }, {})),
    returned: itineraries.length,
    stopSelectionTruncated: Number(stopSelectionTruncated), searchBudgetTruncated: Number(searchBudgetTruncated),
    searchStepLimitReached: Number(searchSteps >= MAX_SEARCH_STEPS), candidateResultLimitReached: Number(results.size >= MAX_SEARCH_RESULTS),
    searchStepLimit: MAX_SEARCH_STEPS, candidatePoolReachedAtStep: candidatePoolReachedAtStep ?? 0,
    candidatePoolReachedAtStepByLegCount: JSON.stringify(Object.fromEntries(candidatePoolReachedAtStepByLegCount)),
    candidateSamplingTruncated: Number(candidateSamplingTruncated), segmentGraphTruncated: Number(segmentGraphTruncated),
    maxQueuedSearchWork: maximumQueuedSearchWork,
    ...(debugTraceTripChains.length > 0 ? { debugTripChainPresence: (() => {
      const requestedTripKeys = new Set(debugTraceTripChains.flatMap((tripChain) => tripChain.split('>')));
      const retainedTargetTripKeys = new Set<string>();
      const retainedSegmentsByTripKey = new Map<string, GtfsDirectJourney[]>();
      for (const segment of segments) {
        const tripKey = `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`;
        if (!requestedTripKeys.has(tripKey)) continue;
        retainedTargetTripKeys.add(tripKey);
        const retained = retainedSegmentsByTripKey.get(tripKey) ?? [];
        retained.push(segment);
        retainedSegmentsByTripKey.set(tripKey, retained);
      }
      const isTransferCandidate = (previous: GtfsDirectJourney, candidate: GtfsDirectJourney) => {
        if (previous.destinationStop.id === candidate.originStop.id) return true;
        const [previousCellX, previousCellY] = transferCell(previous.destinationStop.coordinates);
        const [candidateCellX, candidateCellY] = transferCell(candidate.originStop.coordinates);
        const inNearbyCell = Math.abs(previousCellX - candidateCellX) <= 1
          && Math.abs(previousCellY - candidateCellY) <= 1;
        if (inNearbyCell
          && distanceMeters(previous.destinationStop.coordinates, candidate.originStop.coordinates) <= transferRadius) {
          const hasDeclaredCrossProviderTransfer = previous.destinationTransferNodeIds.some((fromNodeId) =>
            candidate.originTransferNodeIds.some((toNodeId) => transferTargetsByFromNode.get(fromNodeId)?.has(toNodeId)));
          if (previous.providerId === candidate.providerId || hasDeclaredCrossProviderTransfer) return true;
        }
        if (previous.destinationTransferNodeIds.some((fromNodeId) =>
          candidate.originTransferNodeIds.some((toNodeId) => transferTargetsByFromNode.get(fromNodeId)?.has(toNodeId)))) return true;
        if (previous.providerId === candidate.providerId) {
          return previous.destinationTransferNodeIds.some((fromNodeId) =>
            pathwayNodes.has(fromNodeId) && candidate.originTransferNodeIds.some((toNodeId) =>
              reachablePathwayNodes(fromNodeId).has(toNodeId)));
        }
        return false;
      };
      return JSON.stringify(Object.fromEntries(debugTraceTripChains.map((tripChain) => {
        const targetTrips = tripChain.split('>');
        let graphPath: {
          firstLegCount: number;
          feasibleDestinationPath: boolean;
          complete: boolean;
          scannedTargetSegments: number;
          rejectionCounts: {
            transferAdjacency: number;
            repeatedTrip: number;
            destination: number;
            cycle: number;
            departureBeforeArrival: number;
            waitHorizon: number;
            sameRouteRule: number;
            transferDecision: number;
            journeyDuration: number;
            feasible: number;
          };
        } | null = null;
        if (targetTrips.length === 2) {
          const firstLegCandidates = firstLegs.filter((segment) =>
            `${segment.providerId}:${segment.serviceDate}:${segment.tripId}` === targetTrips[0]);
          const targetSecondLegs = retainedSegmentsByTripKey.get(targetTrips[1]) ?? [];
          const rejectionCounts = {
            transferAdjacency: 0,
            repeatedTrip: 0,
            destination: 0,
            cycle: 0,
            departureBeforeArrival: 0,
            waitHorizon: 0,
            sameRouteRule: 0,
            transferDecision: 0,
            journeyDuration: 0,
            feasible: 0,
          };
          let scannedTargetSegments = 0;
          for (const first of firstLegCandidates) {
            const visitedStops = new Set([first.originStop.id, first.destinationStop.id]);
            const latestNext = Math.min(first.arrivalAt.getTime() + maximumWaitSeconds * 1000, journeyEnd.getTime());
            for (const next of targetSecondLegs) {
              scannedTargetSegments++;
              if (!isTransferCandidate(first, next)) { rejectionCounts.transferAdjacency++; continue; }
              if (next.tripId === first.tripId) { rejectionCounts.repeatedTrip++; continue; }
              if (!destinationStopIds.has(next.destinationStop.id)) { rejectionCounts.destination++; continue; }
              if (visitedStops.has(next.destinationStop.id)) { rejectionCounts.cycle++; continue; }
              if (next.departureAt.getTime() < first.arrivalAt.getTime()) { rejectionCounts.departureBeforeArrival++; continue; }
              if (next.departureAt.getTime() > latestNext) { rejectionCounts.waitHorizon++; continue; }
              if (next.routeId === first.routeId) {
                const { rule, ambiguous } = transferRuleFor(first, next);
                if (ambiguous || rule?.transferType !== 4) { rejectionCounts.sameRouteRule++; continue; }
              }
              if (!transferDecision(first, next).feasible) { rejectionCounts.transferDecision++; continue; }
              const arrivalWithEgressMs = next.arrivalAt.getTime()
                + walkingSeconds(next.distanceFromDestinationStopMeters) * 1000;
              if (Math.ceil((arrivalWithEgressMs - input.earliestDeparture.getTime()) / 1000) > maximumJourneySeconds) {
                rejectionCounts.journeyDuration++;
                continue;
              }
              rejectionCounts.feasible++;
            }
          }
          // This trace checks only retained segments for the requested exact
          // trip, so its negative result cannot be lost behind unrelated hub
          // fan-out or a broad candidate scan cap.
          graphPath = {
            firstLegCount: firstLegCandidates.length,
            feasibleDestinationPath: rejectionCounts.feasible > 0,
            complete: true,
            scannedTargetSegments,
            rejectionCounts,
          };
        }
        return [tripChain, {
          allLegTripsInRetainedGraph: targetTrips.every((targetTrip) => retainedTargetTripKeys.has(targetTrip)),
          pathCompleted: debugCompletedTripChains?.has(tripChain) ?? false,
          generated: debugGeneratedTripChains?.has(tripChain) ?? false,
          candidateGraphPath: graphPath,
          candidatePoolBeforeFinalSampling: debugTripChainsBeforeFinalSampling?.has(tripChain) ?? false,
          afterTripChainSampling: debugTripChainsAfterTripSampling?.has(tripChain) ?? false,
          rankedPool: debugTripChainsAfterRouteSampling?.has(tripChain) ?? false,
          responsePage: itineraries.some((itinerary) => itinerary.segments
            .map((segment) => `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>') === tripChain),
        }];
      })));
    })() } : {}),
    searchTruncated: Number(stopSelectionTruncated || segmentGraphTruncated || searchBudgetTruncated || searchSteps >= MAX_SEARCH_STEPS
      || results.size >= MAX_SEARCH_RESULTS || candidateSamplingTruncated),
    resultLimitReached: Number(rankedResults.length > itineraries.length || candidateSamplingTruncated) });
  return {
    itineraries,
    searchTruncated: stopSelectionTruncated || segmentGraphTruncated || searchBudgetTruncated || searchSteps >= MAX_SEARCH_STEPS
      || results.size >= MAX_SEARCH_RESULTS || candidateSamplingTruncated,
    resultLimitReached: rankedResults.length > itineraries.length || candidateSamplingTruncated,
    candidateGraphTruncated: segmentGraphTruncated,
    truncation: {
      stopSelection: stopSelectionTruncated,
      candidateGraph: segmentGraphTruncated,
      searchBudget: searchBudgetTruncated,
      searchStepLimit: searchSteps >= MAX_SEARCH_STEPS,
      candidatePoolLimit: results.size >= MAX_SEARCH_RESULTS,
      candidateSampling: candidateSamplingTruncated,
      responsePage: rankedResults.length > itineraries.length,
    },
  };
}

export function findGtfsItineraries(feed: GtfsTimetableFeed, input: GtfsItinerarySearchInput): GtfsItinerary[] {
  return findGtfsItinerariesWithStats(feed, input).itineraries;
}

const feedCache = new BoundedPromiseCache<GtfsTimetableFeed>(
  MAX_CACHED_GTFS_FEEDS,
  MAX_ESTIMATED_GTFS_CACHE_BYTES,
  CACHE_TTL_MS,
  FAILED_FEED_CACHE_TTL_MS,
);

/** Internal worker diagnostics; this is not exposed as a public API route. */
export function getCachedGtfsTimetableStats(): { entries: number; estimatedBytes: number } {
  return { entries: feedCache.size, estimatedBytes: feedCache.weight };
}

// Parsed JS objects use substantially more memory than their source CSV. This
// deliberately conservative estimate accounts for map entries and per-row
// objects; it is a cache bound, not a claim about exact process RSS.
function estimateGtfsFeedCacheBytes(feed: GtfsTimetableFeed): number {
  let stopTimeRows = 0;
  for (const rows of feed.stopTimes.values()) stopTimeRows += rows.length;
  let shapePoints = 0;
  for (const points of feed.shapes?.values() ?? []) shapePoints += points.length;
  const retainedRecords = stopTimeRows * 512
    + feed.stops.size * 768
    + feed.stopTimesByStop.size * 192
    + feed.trips.size * 512
    + shapePoints * 48
    + feed.routes.size * 768
    + feed.calendars.size * 512
    + (feed.transfers?.length ?? 0) * 512;
  const ancillary = (feed.pathways?.length ?? 0) * 512
    + (feed.fareProducts?.size ?? 0) * 512
    + (feed.fareRules?.size ?? 0) * 512
    + (feed.exceptions.size * 256);
  return Math.max(1, retainedRecords + ancillary);
}

export function cachedGtfsTimetable(providerId: string, url: string, now = Date.now()): Promise<GtfsTimetableFeed> {
  return feedCache.getOrLoad(providerId, async () => {
    const { data } = await fetchBinary(url, MAX_FEED_BYTES, 15_000);
    const unzipped = unzipSync(data, { filter: (file) => /(^|\/)(agency|routes|stops|trips|stop_times|calendar|calendar_dates|shapes|transfers|pathways|levels|fare_attributes|fare_rules|fare_media|fare_products|fare_leg_rules|fare_leg_join_rules|fare_transfer_rules|rider_categories|timeframes|networks|route_networks|areas|stop_areas)\.txt$/.test(file.name) && file.originalSize < 200 * 1024 * 1024 });
    const files = Object.fromEntries(Object.entries(unzipped).map(([name, content]) => [name.split('/').pop() as string, content]));
    return parseGtfsTimetable(files);
  }, estimateGtfsFeedCacheBytes, now);
}
