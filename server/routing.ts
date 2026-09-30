// Compatibility boundary for existing offers, journey and navigation services.
import { decodePolyline6 } from '../shared/navigation/geometry';
import { OsrmRoutingProvider } from './routing/providers/OsrmRoutingProvider';
import type { RouteRequest, RouteResult } from '../shared/navigation/contracts';
export { RoutingUnavailableError } from './routing/providers/osrmTransport';
export type { RoadRoute, RoadRouteLeg } from './routing/providers/osrmTransport';
import type { RoadRoute } from './routing/providers/osrmTransport';
export async function getRoadRoute(origin: [number, number], destination: [number, number]): Promise<RoadRoute> {
  return getRoadRouteThroughPoints([origin,destination]);
}
export async function getRoadRouteThroughPoints(points: [number, number][]): Promise<RoadRoute> {
  const provider = new OsrmRoutingProvider(process.env.OSRM_URL || process.env.ROUTING_ENGINE_URL);
  const route = await provider.route({ origin: points[0], destination: points.at(-1)!, waypoints: points.slice(1,-1), profile: { mode: 'CAR' }, requestId: crypto.randomUUID() });
  return { geometry: decodePolyline6(route.geometry.value), distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds,
    ...(route.legs.length ? { legs: route.legs } : {}) };
}

export async function calculateCanonicalRoute(request: RouteRequest): Promise<RouteResult> {
  const provider = new OsrmRoutingProvider(process.env.OSRM_URL || process.env.ROUTING_ENGINE_URL);
  return provider.route(request);
}
