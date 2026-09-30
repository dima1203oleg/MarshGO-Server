export type RoadRoute = {
  geometry: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
};

export class RoutingUnavailableError extends Error {
  constructor(message = 'Road routing is not configured') { super(message); }
}

export async function getRoadRoute(origin: [number, number], destination: [number, number]): Promise<RoadRoute> {
  return getRoadRouteThroughPoints([origin, destination]);
}

export async function getRoadRouteThroughPoints(points: [number, number][]): Promise<RoadRoute> {
  if (points.length < 2 || points.length > 6) throw new RoutingUnavailableError('A road route needs 2–6 valid waypoint coordinates');
  for (const point of points) {
    if (point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
      throw new RoutingUnavailableError('Road routing received invalid coordinates');
    }
  }
  const base = process.env.ROUTING_ENGINE_URL;
  if (!base) throw new RoutingUnavailableError();
  let url: URL;
  try {
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    const path = points.map(([longitude, latitude]) => `${longitude},${latitude}`).join(';');
    url = new URL(`${path}?overview=full&geometries=geojson`, normalizedBase);
  } catch { throw new RoutingUnavailableError('Routing endpoint is invalid'); }

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } }).catch(() => null);
  if (!response?.ok) throw new RoutingUnavailableError('Road routing request failed');
  const payload = await response.json() as {
    code?: string;
    routes?: Array<{ distance?: number; duration?: number; geometry?: { coordinates?: unknown } }>;
  };
  const route = payload.code === 'Ok' ? payload.routes?.[0] : undefined;
  const coordinates = route?.geometry?.coordinates;
  if (!route || !Array.isArray(coordinates) || coordinates.length < 2 ||
      !Number.isFinite(route.distance) || !Number.isFinite(route.duration) || route.distance! <= 0 || route.duration! <= 0) {
    throw new RoutingUnavailableError('Routing engine returned no usable road route');
  }
  const geometry = coordinates.map((point): [number, number] => {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
        Math.abs(Number(point[0])) > 180 || Math.abs(Number(point[1])) > 90) {
      throw new RoutingUnavailableError('Routing engine returned invalid geometry');
    }
    return [Number(point[0]), Number(point[1])];
  });
  return { geometry, distanceMeters: route.distance!, durationSeconds: route.duration! };
}
