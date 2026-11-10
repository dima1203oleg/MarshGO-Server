import { requestOsrmRoute } from '../routing/osrmGateway';

export interface BicycleRoutePath {
  distanceMeters: number;
  durationSeconds: number;
  geometry: Array<[number, number]>;
}

/**
 * A cycling graph MARSHGO operates itself is reached over a private container network; there is
 * no public default and no fallback service. Routing is only attempted when the operator has
 * explicitly configured a bike endpoint, and every failure returns null so the caller can keep the
 * straight-line estimate and label it honestly instead of inventing a street path.
 */
export function bicycleRoutingEnabled(): boolean {
  return Boolean(process.env.BIKING_ROUTING_URL?.trim());
}

const BICYCLE_ROUTE_TIMEOUT_MS = 2000;
/** OSRM snaps to the nearest edge of its own graph, so a stray route can return a polyline that
 *  does not begin or end where the rider actually is. A real path must anchor within this margin
 *  of both endpoints or it is treated as unroutable. */
const BICYCLE_ENDPOINT_CONTINUITY_METERS = 250;

function greatCircleMeters(a: [number, number], b: [number, number]): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Accept a bare service root or a `/route/v1` base and select OSRM's cycling profile, mirroring the
 * foot router. An explicit bike-profile URL is left intact; invalid input is kept so the honest
 * failure path stays observable instead of silently pointing at the wrong graph.
 */
export function normalizeBikeEndpoint(endpoint: string): string {
  const value = endpoint.trim();
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '');
    if (!path) url.pathname = '/route/v1/bike';
    else if (path.endsWith('/route/v1')) url.pathname = `${path}/bike`;
    else url.pathname = path;
    return url.toString();
  } catch {
    return value;
  }
}

function anchorsRoute(geometry: Array<[number, number]>, from: [number, number], to: [number, number]): boolean {
  if (geometry.length < 2) return false;
  const first = geometry[0]!;
  const last = geometry[geometry.length - 1]!;
  return greatCircleMeters(first, from) <= BICYCLE_ENDPOINT_CONTINUITY_METERS
    && greatCircleMeters(last, to) <= BICYCLE_ENDPOINT_CONTINUITY_METERS;
}

/**
 * Route a bike leg through an explicitly configured OSRM-compatible cycling profile. Returns null
 * when no router is configured, the request fails or times out, or the returned polyline does not
 * connect the endpoints — the caller must then present the leg as an estimate, never as real geometry.
 */
export async function routeBicyclePath(
  from: [number, number],
  to: [number, number],
  endpoint = process.env.BIKING_ROUTING_URL,
): Promise<BicycleRoutePath | null> {
  if (!endpoint?.trim()) return null;
  const resolvedEndpoint = normalizeBikeEndpoint(endpoint);
  try {
    const route = await requestOsrmRoute([from, to], resolvedEndpoint, {
      timeoutMs: BICYCLE_ROUTE_TIMEOUT_MS,
      profile: 'BIKE',
      priority: 'background',
    });
    if (!anchorsRoute(route.geometry, from, to)) return null;
    return {
      distanceMeters: Math.ceil(route.distanceMeters),
      durationSeconds: Math.ceil(route.durationSeconds),
      geometry: route.geometry,
    };
  } catch {
    return null;
  }
}
