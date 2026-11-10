import type { RentalRouteLeg } from './micromobilityEstimates';

export interface RoutedPath {
  geometry: Array<[number, number]>;
  distanceMeters: number;
  durationSeconds: number;
}

export interface MicromobilityGeometryDeps {
  /** Returns a real foot path or null when no pedestrian router is configured/answered. */
  routeFoot: (from: [number, number], to: [number, number]) => Promise<RoutedPath | null>;
  /** Returns a real cycling path or null when no bike router is configured/answered. */
  routeBike: (from: [number, number], to: [number, number]) => Promise<RoutedPath | null>;
}

export interface EnrichedMicromobilityLeg {
  source: string;
  routeGeometry: Array<[number, number]>;
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * A bike estimate is built from a great-circle line because the candidate generator has no street
 * geometry. When an operator has configured a real cycling or pedestrian router, replace the shape
 * (and its distance/duration) with the routed path so the map shows the streets a rider actually
 * uses. A missing or failed router is NOT a licence to invent: the leg keeps its straight-line
 * estimate and its existing honest source token, and `trustedRouteGeometry` downstream refuses to
 * promote it to SOURCE_GEOMETRY. Scooters have no street graph to route against, so they never do.
 */
export async function enrichMicromobilityLegGeometry(
  leg: RentalRouteLeg,
  deps: MicromobilityGeometryDeps,
): Promise<EnrichedMicromobilityLeg> {
  const straightLine = (): EnrichedMicromobilityLeg => ({
    source: leg.metadata.routeGeometrySource ? String(leg.metadata.routeGeometrySource)
      : leg.mode === 'WALK' ? 'walking-straight-line-estimate'
        : leg.mode === 'BICYCLE' ? 'static-bike-network-estimate' : 'gbfs-geofence-scooter-estimate',
    routeGeometry: leg.routeGeometry,
    distanceMeters: leg.distanceMeters,
    durationSeconds: leg.durationSeconds,
  });

  if (leg.mode === 'SCOOTER') return straightLine();

  const from = leg.origin.coordinates;
  const to = leg.destination.coordinates;
  const path = leg.mode === 'BICYCLE' ? await deps.routeBike(from, to) : await deps.routeFoot(from, to);
  if (!path || !Array.isArray(path.geometry) || path.geometry.length < 2) return straightLine();

  return {
    source: leg.mode === 'BICYCLE' ? 'osrm-bike-route' : 'osrm-foot-route',
    routeGeometry: path.geometry,
    distanceMeters: Number.isFinite(path.distanceMeters) && path.distanceMeters > 0 ? Math.round(path.distanceMeters) : leg.distanceMeters,
    durationSeconds: Number.isFinite(path.durationSeconds) && path.durationSeconds > 0 ? Math.round(path.durationSeconds) : leg.durationSeconds,
  };
}
