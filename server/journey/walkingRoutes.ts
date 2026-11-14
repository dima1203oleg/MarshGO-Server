import type { GtfsItinerary } from './gtfsTimetable';
import { requestOsrmRoute } from '../routing/osrmGateway';
import { MAX_FOOT_ENDPOINT_SNAP_METERS } from '../routing/providers/osrmTransport';
import { generatePedestrianGeometry, calculatePedestrianRouteMetrics } from '../../shared/navigation/pedestrianGeometry';

export interface WalkingRoutePath {
  distanceMeters: number;
  durationSeconds: number;
  geometry: Array<[number, number]>;
}

export type PedestrianRoute = (from: [number, number], to: [number, number]) => Promise<WalkingRoutePath | null>;

export type WalkingRoutedItinerary = GtfsItinerary & {
  accessWalk: WalkingRoutePath | null;
  egressWalk: WalkingRoutePath | null;
  transferWalks: Array<WalkingRoutePath | null>;
  walkingRoutesVerified: boolean;
  walkingRoutesUnconfirmed: boolean;
  /** The access or egress walk reaches a stop outside the search radius: longer walk than planned. */
  walkReachExtended: boolean;
};

/**
 * Pavements are not crow-flights. The access/egress limit is a stop-reach *radius* — the
 * straight line that selected the stop in the timetable search — while the leg it caps is a real
 * street path. Measured live in Lviv: a destination stop 1 243 m away in a straight line needs a
 * 1 594 m confirmed walk on the foot graph, and comparing those two numbers directly discarded
 * every one of the 100 itineraries the engine had just built. A router-confirmed path is therefore
 * allowed this factor over the radius that selected its stop. An unconfirmed leg keeps the radius
 * itself: a straight-line estimate has not earned the slack.
 */
export const STREET_WALKING_DETOUR_ALLOWANCE = 1.3;

/** The walk budgets one candidate is measured against; see `applyRoutedWalkingPaths`. */
export interface WalkingLegLimits {
  maximumAccessMeters: number;
  maximumEgressMeters: number;
  maximumTransferMeters: number;
  /** Applied only to a confirmed path. Left at 1 when the passenger set an explicit walk limit. */
  streetDetourAllowance?: number;
  /**
   * The budget for a walk to the closest stop on its side when no stop lay inside the radius at
   * all. A leg inside it is kept and the journey is flagged `walkReachExtended`: a real 1.6 km
   * walk that the passenger can see and refuse is honest, an empty screen is not.
   */
  extendedMaximumAccessMeters?: number;
  extendedMaximumEgressMeters?: number;
}

const WALKING_ROUTE_TIMEOUT_MS = 1500;
/** Same pace the timetable uses for an unmeasured walk, so a degraded leg stays comparable. */
const ESTIMATED_WALKING_SPEED_METERS_PER_SECOND = 1.25;
const WALKING_ROUTE_CACHE_TTL_MS = 5 * 60_000;
const WALKING_ROUTE_FAILURE_TTL_MS = 15_000;
const MAX_WALKING_ROUTE_CACHE_ENTRIES = 20_000;
/**
 * One search routes every transit candidate it produced, and a real Lviv corridor yields 70+
 * candidates with two to three distinct walks each. Identical walks are free because a cached or
 * in-flight route returns before the budget is touched, but distinct ones are not: a budget below
 * the corridor's distinct-leg count leaves displayed journeys with straight-line estimates, which
 * is the defect passengers actually see. The default is therefore sized for a full candidate pool
 * and stays hard-bounded so no search can fan out without limit.
 */
const DEFAULT_WALKING_ROUTE_REQUESTS_PER_SEARCH = 120;
const MIN_WALKING_ROUTE_REQUESTS_PER_SEARCH = 16;
/** Absolute ceiling for one search, whatever the environment asks for. */
export const MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH = 240;
/**
 * Candidates routed per wave. The routing queue admits `ROUTING_MAX_CONCURRENCY` active plus
 * `ROUTING_MAX_QUEUE` waiting requests and rejects the rest, so issuing the whole candidate pool
 * at once would spend the budget on requests that never reached a foot graph. Six candidates
 * (~15 legs) keep a wave inside the default 12+24 capacity.
 */
const DEFAULT_WALKING_ROUTE_CANDIDATES_PER_BATCH = 6;
const MAX_WALKING_ROUTE_CANDIDATES_PER_BATCH = 12;

function boundedEnvInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim() ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Operator-tunable per-search foot-route request budget, always inside the hard ceiling. */
export function walkingRouteRequestLimit(): number {
  return boundedEnvInteger(process.env.WALKING_ROUTE_MAX_REQUESTS_PER_SEARCH,
    DEFAULT_WALKING_ROUTE_REQUESTS_PER_SEARCH, MIN_WALKING_ROUTE_REQUESTS_PER_SEARCH, MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH);
}

/** Operator-tunable candidate wave size, kept at or below the queue capacity guard. */
export function walkingRouteCandidateBatchSize(): number {
  return boundedEnvInteger(process.env.WALKING_ROUTE_CANDIDATES_PER_BATCH,
    DEFAULT_WALKING_ROUTE_CANDIDATES_PER_BATCH, 1, MAX_WALKING_ROUTE_CANDIDATES_PER_BATCH);
}

export interface WalkingRouteBudget {
  readonly limit: number;
  remaining: number;
  exhausted: boolean;
  /** Distinct foot routes actually requested from a router; cached and in-flight hits are free. */
  spent: number;
}

/**
 * Why the walking stage dropped a candidate, counted for one search. "The engine found 100
 * itineraries and the passenger saw none" is otherwise unsupportable, and each cause needs a
 * different fix: a cap that is too tight for real street distances, a timetable that departs
 * before the walk can finish, a foot graph that does not cover the pair, or a preference that
 * rejects a route the engine had already confirmed.
 */
export interface WalkingRejectionReasons {
  accessOverCap: number;
  egressOverCap: number;
  accessMissesDeparture: number;
  transferOverCap: number;
  transferMissesConnection: number;
  unroutableWalkPair: number;
  malformed: number;
  overPreferenceWalk: number;
  overPreferenceDuration: number;
  /**
   * The shortest street walk the router actually confirmed on each side, even where the candidate
   * was rejected. A search that returns nothing because every walk is over the limit is a different
   * product answer depending on whether that limit misses by 120 m or by 1200 m, and the engine
   * should not have to guess which one it is.
   */
  minimumRejectedAccessMeters: number | null;
  minimumRejectedEgressMeters: number | null;
}

/** The counted causes, i.e. everything except the two measured minima. */
export type WalkingRejectionCounter = Exclude<keyof WalkingRejectionReasons,
  'minimumRejectedAccessMeters' | 'minimumRejectedEgressMeters'>;

export function createWalkingRejectionReasons(): WalkingRejectionReasons {
  return {
    accessOverCap: 0, egressOverCap: 0, accessMissesDeparture: 0, transferOverCap: 0,
    transferMissesConnection: 0, unroutableWalkPair: 0, malformed: 0,
    overPreferenceWalk: 0, overPreferenceDuration: 0,
    minimumRejectedAccessMeters: null, minimumRejectedEgressMeters: null,
  };
}

export function createWalkingRouteBudget(limit = walkingRouteRequestLimit()): WalkingRouteBudget {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.max(0, Math.min(limit, MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH))
    : 0;
  return { limit: boundedLimit, remaining: boundedLimit, exhausted: false, spent: 0 };
}

type CachedRoute = { expiresAt: number; value: Promise<WalkingRoutePath | null> };
const routeCache = new Map<string, CachedRoute>();
const inFlightRouteRequests = new Map<string, Promise<WalkingRoutePath | null>>();

type WalkingEndpointRule = { bbox: [number, number, number, number]; url: string };
let walkingEndpointCache: { raw: string; rules: WalkingEndpointRule[] } | null = null;

/**
 * Accept common service-root forms from local/container configuration and select OSRM's
 * pedestrian profile. An explicit foot-profile URL stays unchanged.
 */
function normalizeWalkingEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '');
    if (!path) url.pathname = '/route/v1/foot';
    else if (path.endsWith('/route/v1')) url.pathname = `${path}/foot`;
    else url.pathname = path;
    return url.toString();
  } catch {
    // Keep invalid input intact so the existing provider failure path remains honest and observable.
    return value;
  }
}

function walkingEndpointRules(): WalkingEndpointRule[] {
  const raw = process.env.WALKING_ROUTING_URLS?.trim();
  if (!raw) return [];
  if (walkingEndpointCache?.raw === raw) return walkingEndpointCache.rules;
  let rules: WalkingEndpointRule[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) rules = parsed.flatMap((item): WalkingEndpointRule[] => {
      const rule = item as { bbox?: unknown; url?: unknown } | null;
      const bbox = rule?.bbox;
      const url = rule?.url;
      if (!Array.isArray(bbox) || bbox.length !== 4) return [];
      if (!bbox.every((value) => typeof value === 'number' && Number.isFinite(value))) return [];
      if (typeof url !== 'string' || !url.trim()) return [];
      return [{ bbox: bbox as [number, number, number, number], url: normalizeWalkingEndpoint(url) }];
    });
  } catch {
    rules = [];
  }
  walkingEndpointCache = { raw, rules };
  return rules;
}

function bboxContains(bbox: [number, number, number, number], point: [number, number]): boolean {
  return point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3];
}

/**
 * A foot graph covers one area only. When a configured graph set exists, a walk whose endpoints
 * are not inside the same graph must not reach a router at all: OSRM snaps to the nearest edge
 * anywhere on its graph and answers `Ok` with distance 0, which cannot be told apart from a
 * genuine zero-length walk — the leg then loses its geometry without any visible reason.
 */
export function walkingEndpointFor(from: [number, number], to?: [number, number]): string | undefined {
  const rules = walkingEndpointRules();
  if (!rules.length) {
    const configured = process.env.WALKING_ROUTING_URL?.trim();
    return configured ? normalizeWalkingEndpoint(configured) : undefined;
  }
  return rules.find(({ bbox }) => bboxContains(bbox, from) && (!to || bboxContains(bbox, to)))?.url;
}

/**
 * A bbox rule set configures the foot router just as a single URL does; requiring both
 * would leave the coverage-safe form unable to turn pedestrian routing on at all.
 */
export function walkingRoutingEnabled(): boolean {
  return Boolean(process.env.WALKING_ROUTING_URL?.trim()) || walkingEndpointRules().length > 0;
}

export interface WalkingRouteBudget {
  readonly limit: number;
  remaining: number;
  exhausted: boolean;
}

/**
 * Whether a walking router can answer for this exact origin/destination pair: any OD for a
 * single-router deployment, only an OD whose points share one configured graph otherwise.
 * A straddling or uncovered pair is genuinely unroutable — callers must degrade honestly
 * (estimated walks plus the `walking_routing_unavailable` label) instead of pretending the
 * router exists or sending the pair to the wrong graph.
 */
export function walkingRoutingConfiguredFor(origin: [number, number], destination: [number, number]): boolean {
  return Boolean(walkingEndpointFor(origin, destination));
}

function coordinateKey(point: [number, number]): string {
  const longitude = Object.is(point[0], -0) ? 0 : point[0];
  const latitude = Object.is(point[1], -0) ? 0 : point[1];
  return `${longitude},${latitude}`;
}

export function resolveWalkingEndpoint(
  from?: [number, number],
  to?: [number, number],
  fallbackEndpoint?: string,
): string | null {
  const rawUrls = process.env.WALKING_ROUTING_URLS?.trim();
  if (rawUrls && from && to) {
    try {
      const entries = JSON.parse(rawUrls) as Array<{ bbox?: [number, number, number, number]; url: string }>;
      for (const entry of entries) {
        if (!entry.url) continue;
        if (!entry.bbox) return entry.url;
        const [minLng, minLat, maxLng, maxLat] = entry.bbox;
        const fromIn = from[0] >= minLng && from[0] <= maxLng && from[1] >= minLat && from[1] <= maxLat;
        const toIn = to[0] >= minLng && to[0] <= maxLng && to[1] >= minLat && to[1] <= maxLat;
        if (fromIn || toIn) return entry.url;
      }
    } catch {
      // ignore JSON parse error
    }
  }
  return fallbackEndpoint || process.env.WALKING_ROUTING_URL?.trim() || null;
}

/**
 * Synthesizes realistic street-following pedestrian geometry between two coordinates
 * for any location across Ukraine when an OSRM foot router is not hosted or fails.
 */
export function generateRealisticPedestrianPath(
  from: [number, number],
  to: [number, number],
): WalkingRoutePath {
  const geometry = generatePedestrianGeometry(from, to);
  const metrics = calculatePedestrianRouteMetrics(geometry);
  return {
    distanceMeters: metrics.distanceMeters,
    durationSeconds: metrics.durationSeconds,
    geometry,
  };
}

/**
 * Route a walking connection through a configured OSRM-compatible foot profile.
 * A missing provider or failed route is represented as null; callers may keep
 * the timetable's straight-line estimate only while labelling it unconfirmed.
 */
export async function routePedestrianPath(
  from: [number, number],
  to: [number, number],
  endpoint = resolveWalkingEndpoint(from, to),
  budget?: WalkingRouteBudget,
): Promise<WalkingRoutePath | null> {
  if (!endpoint) return null;
  const resolvedEndpoint = normalizeWalkingEndpoint(endpoint);
  const graphVersion = process.env.WALKING_GRAPH_VERSION || process.env.OSRM_GRAPH_VERSION;
  const key = `${resolvedEndpoint}\u0000${graphVersion ?? 'no-graph-cache-disabled'}\u0000${coordinateKey(from)}\u0000${coordinateKey(to)}`;
  const now = Date.now();
  const cached = graphVersion ? routeCache.get(key) : undefined;
  if (cached && cached.expiresAt > now) { routeCache.delete(key); routeCache.set(key, cached); return cached.value; }
  if (cached) routeCache.delete(key);
  const pending = inFlightRouteRequests.get(key);
  if (pending) return pending;
  if (budget) {
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      return null;
    }
    budget.remaining--;
    budget.spent += 1;
  }

  const value = requestOsrmRoute([from, to], resolvedEndpoint, {
    timeoutMs: WALKING_ROUTE_TIMEOUT_MS,
    profile: 'FOOT',
    priority: 'background',
    cacheParameters: { maxEndpointSnapMeters: MAX_FOOT_ENDPOINT_SNAP_METERS },
  })
    .then((route) => ({ distanceMeters: Math.ceil(route.distanceMeters), durationSeconds: Math.ceil(route.durationSeconds), geometry: route.geometry }))
    .catch(() => null);
  inFlightRouteRequests.set(key, value);
  if (graphVersion) routeCache.set(key, { expiresAt: now + WALKING_ROUTE_CACHE_TTL_MS, value });
  if (graphVersion && routeCache.size > MAX_WALKING_ROUTE_CACHE_ENTRIES) {
    for (const [oldKey, entry] of routeCache) {
      if (entry.expiresAt <= now || routeCache.size > MAX_WALKING_ROUTE_CACHE_ENTRIES) routeCache.delete(oldKey);
      else break;
    }
  }
  const result = await value;
  if (inFlightRouteRequests.get(key) === value) inFlightRouteRequests.delete(key);
  if (graphVersion && !result) routeCache.set(key, { expiresAt: Date.now() + WALKING_ROUTE_FAILURE_TTL_MS, value: Promise.resolve(null) });
  return result;
}

/**
 * Replace GTFS's explicitly estimated first/last-mile and fallback transfer
 * walks with routed pedestrian paths. Re-check every affected timetable
 * connection because a real foot route can take longer than a straight line.
 *
 * A leg the router could not confirm keeps the timetable's own straight-line
 * estimate and is reported through `walkingRoutesUnconfirmed`; dropping the
 * whole journey here would hide a connection that is genuinely available,
 * which is worse than labelling one of its walks as an estimate.
 *
 * A walk that clears the radius but stays inside the extended budget is kept and flagged,
 * because the alternative — measured live, twice — was a Lviv search that generated 100 real
 * itineraries and returned none.
 */
export function applyRoutedWalkingPaths(
  itinerary: GtfsItinerary,
  routes: { access: WalkingRoutePath | null; egress: WalkingRoutePath | null; transfers: Array<WalkingRoutePath | null> },
  limits: WalkingLegLimits,
  reasons?: WalkingRejectionReasons,
): WalkingRoutedItinerary | null {
  const reject = (reason: WalkingRejectionCounter): null => {
    if (reasons) reasons[reason] += 1;
    return null;
  };
  const noteRejectedWalk = (key: 'minimumRejectedAccessMeters' | 'minimumRejectedEgressMeters', meters: number): void => {
    if (!reasons || !Number.isFinite(meters)) return;
    const current = reasons[key];
    reasons[key] = current === null ? Math.ceil(meters) : Math.min(current, Math.ceil(meters));
  };
  const first = itinerary.segments[0];
  const last = itinerary.segments.at(-1);
  if (!first || !last || routes.transfers.length !== itinerary.transferWalkingMeters.length) return reject('malformed');

  const accessMeters = routes.access?.distanceMeters ?? first.distanceToOriginStopMeters;
  const accessSeconds = routes.access?.durationSeconds
    ?? Math.ceil(first.distanceToOriginStopMeters / ESTIMATED_WALKING_SPEED_METERS_PER_SECOND);
  const egressMeters = routes.egress?.distanceMeters ?? last.distanceFromDestinationStopMeters;
  const egressSeconds = routes.egress?.durationSeconds
    ?? Math.ceil(last.distanceFromDestinationStopMeters / ESTIMATED_WALKING_SPEED_METERS_PER_SECOND);
  const accessUnconfirmed = first.distanceToOriginStopMeters > 0 && !routes.access;
  const egressUnconfirmed = last.distanceFromDestinationStopMeters > 0 && !routes.egress;
  const allowance = limits.streetDetourAllowance ?? 1;
  const accessBudget = Math.ceil(routes.access ? limits.maximumAccessMeters * allowance : limits.maximumAccessMeters);
  const egressBudget = Math.ceil(routes.egress ? limits.maximumEgressMeters * allowance : limits.maximumEgressMeters);
  const accessOverCap = accessMeters > accessBudget;
  const egressOverCap = egressMeters > egressBudget;
  const accessBeyondReach = accessOverCap && accessMeters > (limits.extendedMaximumAccessMeters ?? accessBudget);
  const egressBeyondReach = egressOverCap && egressMeters > (limits.extendedMaximumEgressMeters ?? egressBudget);
  if (accessBeyondReach) noteRejectedWalk('minimumRejectedAccessMeters', accessMeters);
  if (egressBeyondReach) noteRejectedWalk('minimumRejectedEgressMeters', egressMeters);
  if (accessBeyondReach) return reject('accessOverCap');
  if (egressBeyondReach) return reject('egressOverCap');
  const walkReachExtended = (accessOverCap && !accessBeyondReach) || (egressOverCap && !egressBeyondReach);
  if (first.departureAt.getTime() < itinerary.departureAt.getTime() + accessSeconds * 1000) return reject('accessMissesDeparture');

  const transferWalkingMeters = [...itinerary.transferWalkingMeters];
  const transferWalkingSeconds = [...itinerary.transferWalkingSeconds];
  const transferWalkingGeometries = [...itinerary.transferWalkingGeometries];
  let transferUnconfirmed = false;
  let transferWalkingTotal = 0;
  for (let index = 0; index < transferWalkingMeters.length; index++) {
    const previous = itinerary.segments[index];
    const next = itinerary.segments[index + 1];
    if (!previous || !next) return reject('malformed');
    const inSeat = itinerary.transferInSeat[index] ?? false;
    const path = routes.transfers[index];
    if (path) {
      transferWalkingMeters[index] = path.distanceMeters;
      transferWalkingSeconds[index] = path.durationSeconds;
      transferWalkingGeometries[index] = path.geometry;
    } else if (!inSeat && (transferWalkingMeters[index] ?? 0) > 0 && !transferWalkingGeometries[index]) {
      // The pedestrian router failed for a transfer that has no modeled path.
      transferUnconfirmed = true;
    }
    const walkMeters = inSeat ? 0 : transferWalkingMeters[index] ?? 0;
    const walkSeconds = inSeat ? 0 : transferWalkingSeconds[index] ?? Math.ceil(walkMeters / ESTIMATED_WALKING_SPEED_METERS_PER_SECOND);
    transferWalkingTotal += walkMeters;
    if (walkMeters > limits.maximumTransferMeters) return reject('transferOverCap');
    const minimumBuffer = itinerary.transferMinimumBufferSeconds[index] ?? 0;
    const operatorMinimum = itinerary.transferRuleMinimumSeconds[index] ?? 0;
    const requiredSeconds = inSeat ? 0 : Math.max(minimumBuffer + walkSeconds, operatorMinimum);
    const availableSeconds = Math.floor((next.departureAt.getTime() - previous.arrivalAt.getTime()) / 1000);
    if (availableSeconds < requiredSeconds) return reject('transferMissesConnection');
  }

  const unconfirmed = accessUnconfirmed || egressUnconfirmed || transferUnconfirmed;
  const arrivalAt = new Date(last.arrivalAt.getTime() + egressSeconds * 1000);
  const waitingSeconds = Math.max(0, Math.ceil((first.departureAt.getTime()
    - itinerary.departureAt.getTime() - accessSeconds * 1000) / 1000))
    + itinerary.segments.slice(1).reduce((total, next, index) => {
      const previous = itinerary.segments[index];
      if (!previous || itinerary.transferInSeat[index]) return total;
      const readyAt = previous.arrivalAt.getTime() + (transferWalkingSeconds[index] ?? 0) * 1000;
      return total + Math.max(0, Math.ceil((next.departureAt.getTime() - readyAt) / 1000));
    }, 0);

  return {
    ...itinerary,
    arrivalAt,
    durationSeconds: Math.max(0, Math.ceil((arrivalAt.getTime() - itinerary.departureAt.getTime()) / 1000)),
    waitingSeconds,
    walkingMeters: accessMeters + egressMeters + transferWalkingTotal,
    transferWalkingMeters,
    transferWalkingSeconds,
    transferWalkingGeometries,
    accessWalk: routes.access,
    egressWalk: routes.egress,
    transferWalks: routes.transfers,
    walkingRoutesVerified: !unconfirmed,
    walkingRoutesUnconfirmed: unconfirmed,
    walkReachExtended,
  };
}

/** Test-only cache reset is intentionally omitted from the public module API. */
