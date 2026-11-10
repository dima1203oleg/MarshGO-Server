export type RouteCoordinate = [number, number];

/** Geometry provenance is accepted only for the transport modes that produce that shape. */
const TRUSTED_GEOMETRY_MODES: Readonly<Record<string, ReadonlySet<string>>> = {
  'osrm-foot-route': new Set(['WALK']),
  'osrm-bike-route': new Set(['BICYCLE']),
  'gtfs-pathway': new Set(['WALK']),
  'gtfs-pathways': new Set(['WALK']),
  'osrm-car-route': new Set(['TAXI', 'COMMUNITY']),
  gtfs_shape: new Set(['BUS', 'MINIBUS', 'RAIL', 'TRAM', 'TROLLEYBUS', 'METRO', 'URBAN_BUS', 'FERRY', 'FUNICULAR']),
  official_geojson: new Set(['METRO']),
  // Community offer geometry is trusted only when its persisted offer route_source
  // was explicitly mapped to this road-router provenance token.
};

export type LegGeometryClaim = {
  mode?: unknown;
  source?: unknown;
  stops?: unknown;
  routeGeometry?: unknown;
  metadata?: Record<string, unknown> | undefined;
};

function coordinateLine(value: unknown): RouteCoordinate[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const points: RouteCoordinate[] = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) return null;
    const [longitude, latitude] = point as [unknown, unknown];
    if (typeof longitude !== 'number' || typeof latitude !== 'number'
      || !Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
    points.push([longitude, latitude]);
  }
  return points;
}

function hasModeCompatibleProvenance(leg: LegGeometryClaim): boolean {
  if (typeof leg.mode !== 'string') return false;
  return [leg.source, leg.metadata?.routeGeometrySource].some((claim) => typeof claim === 'string'
    && TRUSTED_GEOMETRY_MODES[claim]?.has(leg.mode as string));
}

/** Returns only a finite, valid line whose source is explicitly trusted for this leg mode. */
export function trustedRouteGeometry(leg: LegGeometryClaim): RouteCoordinate[] | null {
  if (!hasModeCompatibleProvenance(leg)) return null;
  return coordinateLine(leg.routeGeometry);
}

/** Builds the single metadata representation used for both persisted rows and response legs. */
export function legProvenanceMetadata(leg: LegGeometryClaim): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...(leg.metadata ?? {}) };
  const geometry = trustedRouteGeometry(leg);
  if (geometry) metadata.routeGeometry = geometry;
  else {
    delete metadata.routeGeometry;
    delete metadata.routeGeometrySource;
  }
  const stops = leg.stops ?? metadata.stops;
  if (Array.isArray(stops) && stops.length > 0) metadata.stops = stops;
  else delete metadata.stops;
  return metadata;
}

/** Remove stale or unverified geometry when reading journeys written before provenance checks. */
export function sanitizePersistedJourneyLeg<T extends Record<string, unknown>>(leg: T): T {
  const { routeGeometry: _legacyGeometry, ...withoutTopLevelGeometry } = leg;
  const rawMetadata = leg.metadata && typeof leg.metadata === 'object' && !Array.isArray(leg.metadata)
    ? leg.metadata as Record<string, unknown> : {};
  const metadata = legProvenanceMetadata({
    mode: leg.mode,
    source: leg.source ?? leg.dataSource,
    routeGeometry: leg.routeGeometry ?? rawMetadata.routeGeometry,
    stops: leg.stops,
    metadata: rawMetadata,
  });
  if (!metadata.routeGeometry && metadata.routeAccuracy === 'SOURCE_GEOMETRY') delete metadata.routeAccuracy;
  return {
    ...withoutTopLevelGeometry,
    metadata,
    ...(metadata.routeGeometry ? { routeGeometry: metadata.routeGeometry } : {}),
  } as unknown as T;
}

export function sanitizePersistedJourney<T extends { legs?: unknown }>(journey: T): T {
  if (!Array.isArray(journey.legs)) return journey;
  return {
    ...journey,
    legs: journey.legs.map((leg) => leg && typeof leg === 'object' && !Array.isArray(leg)
      ? sanitizePersistedJourneyLeg(leg as Record<string, unknown>) : leg),
  } as T;
}
