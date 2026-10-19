import type { GtfsItinerary } from './gtfsTimetable';
import { requestOsrmRoute } from '../routing/osrmGateway';

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
  walkingRoutesVerified: true;
};

const WALKING_ROUTE_TIMEOUT_MS = 1500;
const WALKING_ROUTE_CACHE_TTL_MS = 5 * 60_000;
const WALKING_ROUTE_FAILURE_TTL_MS = 15_000;
const MAX_WALKING_ROUTE_CACHE_ENTRIES = 20_000;
export const MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH = 32;

type CachedRoute = { expiresAt: number; value: Promise<WalkingRoutePath | null> };
const routeCache = new Map<string, CachedRoute>();
const inFlightRouteRequests = new Map<string, Promise<WalkingRoutePath | null>>();

export interface WalkingRouteBudget {
  readonly limit: number;
  remaining: number;
  exhausted: boolean;
}

export function createWalkingRouteBudget(limit = MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH): WalkingRouteBudget {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH)) : 0;
  return { limit: boundedLimit, remaining: boundedLimit, exhausted: false };
}

function coordinateKey(point: [number, number]): string {
  const longitude = Object.is(point[0], -0) ? 0 : point[0];
  const latitude = Object.is(point[1], -0) ? 0 : point[1];
  return `${longitude},${latitude}`;
}

/**
 * Route a walking connection through a configured OSRM-compatible foot profile.
 * A missing provider or failed route is represented as null; callers must not
 * convert that into a direct-line route.
 */
export async function routePedestrianPath(
  from: [number, number],
  to: [number, number],
  endpoint = process.env.WALKING_ROUTING_URL,
  budget?: WalkingRouteBudget,
): Promise<WalkingRoutePath | null> {
  if (!endpoint) return null;
  const graphVersion = process.env.WALKING_GRAPH_VERSION || process.env.OSRM_GRAPH_VERSION;
  const key = `${endpoint}\u0000${graphVersion ?? 'no-graph-cache-disabled'}\u0000${coordinateKey(from)}\u0000${coordinateKey(to)}`;
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
  }

  const value = requestOsrmRoute([from, to], endpoint, { timeoutMs: WALKING_ROUTE_TIMEOUT_MS, profile: 'FOOT', priority: 'background' })
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
 */
export function applyRoutedWalkingPaths(
  itinerary: GtfsItinerary,
  routes: { access: WalkingRoutePath | null; egress: WalkingRoutePath | null; transfers: Array<WalkingRoutePath | null> },
  limits: { maximumAccessMeters: number; maximumEgressMeters: number; maximumTransferMeters: number },
): WalkingRoutedItinerary | null {
  const first = itinerary.segments[0];
  const last = itinerary.segments.at(-1);
  if (!first || !last || routes.transfers.length !== itinerary.transferWalkingMeters.length) return null;

  const accessMeters = routes.access?.distanceMeters ?? 0;
  const accessSeconds = routes.access?.durationSeconds ?? 0;
  const egressMeters = routes.egress?.distanceMeters ?? 0;
  const egressSeconds = routes.egress?.durationSeconds ?? 0;
  if ((first.distanceToOriginStopMeters > 0 && !routes.access)
    || (last.distanceFromDestinationStopMeters > 0 && !routes.egress)
    || accessMeters > limits.maximumAccessMeters || egressMeters > limits.maximumEgressMeters) return null;
  if (first.departureAt.getTime() < itinerary.departureAt.getTime() + accessSeconds * 1000) return null;

  const transferWalkingMeters = [...itinerary.transferWalkingMeters];
  const transferWalkingSeconds = [...itinerary.transferWalkingSeconds];
  const transferWalkingGeometries = [...itinerary.transferWalkingGeometries];
  let transferWalkingTotal = 0;
  for (let index = 0; index < transferWalkingMeters.length; index++) {
    const previous = itinerary.segments[index];
    const next = itinerary.segments[index + 1];
    if (!previous || !next) return null;
    const inSeat = itinerary.transferInSeat[index] ?? false;
    const path = routes.transfers[index];
    if (path) {
      transferWalkingMeters[index] = path.distanceMeters;
      transferWalkingSeconds[index] = path.durationSeconds;
      transferWalkingGeometries[index] = path.geometry;
    } else if (!inSeat && transferWalkingMeters[index] > 0 && !transferWalkingGeometries[index]) {
      // The configured pedestrian provider failed for an unmodeled transfer.
      return null;
    }
    const walkMeters = inSeat ? 0 : transferWalkingMeters[index] ?? 0;
    const walkSeconds = inSeat ? 0 : transferWalkingSeconds[index] ?? 0;
    transferWalkingTotal += walkMeters;
    if (walkMeters > limits.maximumTransferMeters) return null;
    const minimumBuffer = itinerary.transferMinimumBufferSeconds[index] ?? 0;
    const operatorMinimum = itinerary.transferRuleMinimumSeconds[index] ?? 0;
    const requiredSeconds = inSeat ? 0 : Math.max(minimumBuffer + walkSeconds, operatorMinimum);
    const availableSeconds = Math.floor((next.departureAt.getTime() - previous.arrivalAt.getTime()) / 1000);
    if (availableSeconds < requiredSeconds) return null;
  }

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
    walkingRoutesVerified: true,
  };
}

/** Test-only cache reset is intentionally omitted from the public module API. */
