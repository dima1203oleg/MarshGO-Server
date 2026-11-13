import { directWalkingGeometryConnectsEndpoints } from './directWalkingCandidate';
import type { WalkingRouteBudget, WalkingRoutePath } from './walkingRoutes';
import type { MultimodalJourney } from './multimodalChainEngine';

export type MultimodalWalkRejection =
  | 'missing_endpoint'
  | 'route_unavailable'
  | 'invalid_geometry'
  | 'missed_connection'
  | 'walking_preference'
  | 'duration_preference';

export type MultimodalWalkRouteResult =
  | { journey: MultimodalJourney; rejected: null }
  | { journey: null; rejected: MultimodalWalkRejection };

export interface MultimodalWalkRouterOptions {
  departureAt: Date;
  budget: WalkingRouteBudget;
  maximumWalkingMeters?: number;
  maximumDurationSeconds?: number;
  resolveEndpoint: (from: [number, number], to: [number, number]) => string | null;
  route: (from: [number, number], to: [number, number], endpoint: string, budget: WalkingRouteBudget) => Promise<WalkingRoutePath | null>;
}

/**
 * Replaces the multimodal engine's diagrammatic walk estimates with confirmed foot-router paths.
 * Candidates with an unroutable walk or a missed scheduled departure are omitted, never persisted
 * with a synthetic or endpoint-to-endpoint line presented as street geometry.
 */
export async function routeMultimodalWalks(
  journey: MultimodalJourney,
  options: MultimodalWalkRouterOptions,
): Promise<MultimodalWalkRouteResult> {
  const legs = journey.legs.map((leg) => ({ ...leg, metadata: leg.metadata ? { ...leg.metadata } : undefined }));
  let previousArrival = new Date(options.departureAt.getTime());
  let walkingMeters = 0;

  for (const leg of legs) {
    const scheduledDeparture = new Date(leg.departureAt.getTime());
    const scheduledArrival = new Date(leg.arrivalAt.getTime());
    if (!Number.isFinite(scheduledDeparture.getTime()) || !Number.isFinite(scheduledArrival.getTime())
      || scheduledArrival.getTime() < scheduledDeparture.getTime()) return { journey: null, rejected: 'invalid_geometry' };

    if (leg.mode !== 'WALK') {
      // Transit legs retain their source schedule/timing. A preceding routed walk may not arrive late.
      if (previousArrival.getTime() > scheduledDeparture.getTime()) return { journey: null, rejected: 'missed_connection' };
      previousArrival = scheduledArrival;
      continue;
    }

    const from = leg.origin.coordinates;
    const to = leg.destination.coordinates;
    const endpoint = options.resolveEndpoint(from, to);
    if (!endpoint) return { journey: null, rejected: 'missing_endpoint' };

    const departure = new Date(Math.max(scheduledDeparture.getTime(), previousArrival.getTime()));
    const path = await options.route(from, to, endpoint, options.budget);
    if (!path) return { journey: null, rejected: 'route_unavailable' };
    const hasValidGeometry = Array.isArray(path.geometry) && path.geometry.length >= 2
      && path.geometry.every((point) => Array.isArray(point) && point.length === 2
        && Number.isFinite(point[0]) && point[0] >= -180 && point[0] <= 180
        && Number.isFinite(point[1]) && point[1] >= -90 && point[1] <= 90);
    if (!hasValidGeometry
      || !Number.isSafeInteger(path.distanceMeters) || path.distanceMeters <= 0
      || !Number.isSafeInteger(path.durationSeconds) || path.durationSeconds <= 0
      || !directWalkingGeometryConnectsEndpoints({ path, origin: from, destination: to })) {
      return { journey: null, rejected: 'invalid_geometry' };
    }

    const arrival = new Date(departure.getTime() + path.durationSeconds * 1000);
    leg.departureAt = departure;
    leg.arrivalAt = arrival;
    leg.durationSeconds = path.durationSeconds;
    leg.distanceMeters = path.distanceMeters;
    leg.walkingDistanceMeters = path.distanceMeters;
    leg.source = 'osrm-foot-route';
    leg.routeGeometry = path.geometry;
    leg.metadata = {
      ...leg.metadata,
      routeGeometrySource: 'osrm-foot-route',
      routeAccuracy: 'SOURCE_GEOMETRY',
      walkingSpeedMetersPerSecond: path.distanceMeters / path.durationSeconds,
    };
    walkingMeters += path.distanceMeters;
    previousArrival = arrival;
  }

  const durationSeconds = Math.ceil((previousArrival.getTime() - options.departureAt.getTime()) / 1000);
  if (options.maximumWalkingMeters !== undefined && walkingMeters > options.maximumWalkingMeters) {
    return { journey: null, rejected: 'walking_preference' };
  }
  if (options.maximumDurationSeconds !== undefined && durationSeconds > options.maximumDurationSeconds) {
    return { journey: null, rejected: 'duration_preference' };
  }

  return {
    journey: { ...journey, totalDurationSeconds: durationSeconds, walkingMeters, legs },
    rejected: null,
  };
}
