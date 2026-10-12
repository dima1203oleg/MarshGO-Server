import type { GtfsItinerary } from './gtfsTimetable';
import { fetchOsrmRoute } from '../routing/providers/osrmTransport';

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
const MAX_CONCURRENT_WALKING_ROUTES = 12;
const MAX_QUEUED_WALKING_ROUTES = 24;
export const MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH = 32;

type CachedRoute = { expiresAt: number; value: Promise<WalkingRoutePath | null> };
const routeCache = new Map<string, CachedRoute>();
let activeRouteRequests = 0;
const waitingRouteRequests: Array<() => void> = [];

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
  return `${point[0].toFixed(6)},${point[1].toFixed(6)}`;
}

async function withWalkingRouteSlot<T>(operation: () => Promise<T>): Promise<{ acquired: boolean; value: T | null }> {
  if (activeRouteRequests >= MAX_CONCURRENT_WALKING_ROUTES) {
    if (waitingRouteRequests.length >= MAX_QUEUED_WALKING_ROUTES) return { acquired: false, value: null };
    await new Promise<void>((resolve) => waitingRouteRequests.push(resolve));
  }
  activeRouteRequests++;
  try {
    return { acquired: true, value: await operation() };
  } finally {
    activeRouteRequests--;
    waitingRouteRequests.shift()?.();
  }
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
  const key = `${endpoint}\u0000${coordinateKey(from)}\u0000${coordinateKey(to)}`;
  const now = Date.now();
  const cached = routeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) routeCache.delete(key);
  if (budget) {
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      return null;
    }
    budget.remaining--;
  }

  const attempt = withWalkingRouteSlot(async () => {
    try {
      const route = await fetchOsrmRoute([from, to], endpoint, WALKING_ROUTE_TIMEOUT_MS);
      return {
        distanceMeters: Math.ceil(route.distanceMeters),
        durationSeconds: Math.ceil(route.durationSeconds),
        geometry: route.geometry,
      };
    } catch {
      return null;
    }
  });
  const value = attempt.then((result) => result.acquired ? result.value : null);
  routeCache.set(key, { expiresAt: now + WALKING_ROUTE_CACHE_TTL_MS, value });
  if (routeCache.size > MAX_WALKING_ROUTE_CACHE_ENTRIES) {
    for (const [oldKey, entry] of routeCache) {
      if (entry.expiresAt <= now || routeCache.size > MAX_WALKING_ROUTE_CACHE_ENTRIES) routeCache.delete(oldKey);
      else break;
    }
  }
  const result = await attempt;
  if (!result.acquired) {
    if (routeCache.get(key)?.value === value) routeCache.delete(key);
    return null;
  }
  if (!result.value) routeCache.set(key, { expiresAt: Date.now() + WALKING_ROUTE_FAILURE_TTL_MS, value: Promise.resolve(null) });
  return result.value;
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
