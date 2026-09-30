import { NavigationProviderError, type ErrorCode } from '../../../shared/navigation/errors';
import type { Maneuver } from '../../../shared/navigation/contracts';
export type RoadRouteLeg = { distanceMeters: number; durationSeconds: number };
export type RoadRouteManeuver = Maneuver;
export type RoadRoute = {
  geometry: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  legs?: RoadRouteLeg[];
  maneuvers?: RoadRouteManeuver[];
};

export class RoutingUnavailableError extends NavigationProviderError {
  constructor(message = 'Road routing is not configured', code: ErrorCode = 'ROUTING_PROVIDER_UNAVAILABLE') { super(code, 'osrm'); this.message = message; }
}

export async function fetchOsrmRoute(points: [number, number][], base: string | undefined, timeoutMs = 10000): Promise<RoadRoute> {
  if (points.length < 2 || points.length > 32) throw new RoutingUnavailableError('A road route needs 2–32 valid waypoint coordinates');
  for (const point of points) {
    if (point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
      throw new RoutingUnavailableError('Road routing received invalid coordinates');
    }
  }
  if (!base) throw new RoutingUnavailableError();
  let url: URL;
  try {
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    const path = points.map(([longitude, latitude]) => `${longitude},${latitude}`).join(';');
    url = new URL(`${path}?overview=full&geometries=geojson&steps=true`, normalizedBase);
  } catch { throw new RoutingUnavailableError('Routing endpoint is invalid'); }

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', 'user-agent': 'MARSHGO/1.0 (road routing)' } }).catch((error: unknown) => { throw new RoutingUnavailableError('Road routing request failed', error instanceof Error && error.name === 'TimeoutError' ? 'ROUTING_TIMEOUT' : 'ROUTING_PROVIDER_UNAVAILABLE'); });
  if (!response.ok) throw new RoutingUnavailableError('Road routing request failed', response.status === 429 ? 'ROUTING_RATE_LIMITED' : 'ROUTING_PROVIDER_UNAVAILABLE');
  const payload = await response.json().catch(() => { throw new RoutingUnavailableError('Invalid routing JSON', 'ROUTING_INVALID_RESPONSE'); }) as {
    code?: string;
    routes?: Array<{ distance?: number; duration?: number; geometry?: { coordinates?: unknown }; legs?: Array<{
      distance?: number; duration?: number; steps?: Array<{
        distance?: number; duration?: number; name?: string;
        maneuver?: { type?: string; modifier?: string; location?: unknown; bearing_before?: number; bearing_after?: number; exit?: number };
        intersections?: Array<{ lanes?: Array<{ indications?: string[]; valid?: boolean }> }>;
      }>;
    }> }>;
  };
  if (!payload || typeof payload !== 'object') throw new RoutingUnavailableError('Invalid routing response', 'ROUTING_INVALID_RESPONSE');
  if (payload.code === 'NoRoute') throw new RoutingUnavailableError('No road route', 'ROUTING_NO_ROUTE');
  const route = payload.code === 'Ok' ? payload.routes?.[0] : undefined;
  const coordinates = route?.geometry?.coordinates;
  if (!route || !Array.isArray(coordinates) || coordinates.length < 2 ||
      !Number.isFinite(route.distance) || !Number.isFinite(route.duration) || route.distance! <= 0 || route.duration! <= 0) {
    throw new RoutingUnavailableError('Routing engine returned no usable road route', 'ROUTING_INVALID_RESPONSE');
  }
  const geometry = coordinates.map((point): [number, number] => {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
        Math.abs(Number(point[0])) > 180 || Math.abs(Number(point[1])) > 90) {
      throw new RoutingUnavailableError('Routing engine returned invalid geometry');
    }
    return [Number(point[0]), Number(point[1])];
  });
  const legs = route.legs?.map((leg): RoadRouteLeg | null => {
    if (!Number.isFinite(leg.distance) || !Number.isFinite(leg.duration) || leg.distance! <= 0 || leg.duration! <= 0) return null;
    return { distanceMeters: leg.distance!, durationSeconds: leg.duration! };
  });
  const maneuverTypes: Record<string, Maneuver['type']> = {
    depart: 'DEPART', arrive: 'ARRIVE', turn: 'TURN', 'end of road': 'TURN', merge: 'MERGE',
    'on ramp': 'MERGE', 'off ramp': 'EXIT', exit: 'EXIT', roundabout: 'ROUNDABOUT', rotary: 'ROUNDABOUT',
    continue: 'CONTINUE', fork: 'CONTINUE', notification: 'CONTINUE', new_name: 'CONTINUE',
  };
  const modifiers: Record<string, NonNullable<Maneuver['modifier']>> = {
    left: 'LEFT', 'slight left': 'SLIGHT_LEFT', 'sharp left': 'SHARP_LEFT', right: 'RIGHT',
    'slight right': 'SLIGHT_RIGHT', 'sharp right': 'SHARP_RIGHT', straight: 'STRAIGHT', uturn: 'UTURN',
  };
  const maneuvers: Maneuver[] = [];
  route.legs?.forEach((leg, legIndex) => leg.steps?.forEach((step, stepIndex) => {
    const maneuver = step.maneuver;
    const kind = maneuver?.type ? maneuverTypes[maneuver.type] : undefined;
    const location = maneuver?.location;
    if (!kind || !Array.isArray(location) || location.length < 2 || !Number.isFinite(location[0]) || !Number.isFinite(location[1])) return;
    const modifier = maneuver?.modifier ? modifiers[maneuver.modifier] : undefined;
    const exitValue = maneuver?.exit;
    const exitNumber = Number.isInteger(exitValue) && Number(exitValue) > 0 ? Number(exitValue) : undefined;
    const lanes = step.intersections?.flatMap((intersection) => intersection.lanes ?? []).filter((lane): lane is { indications: string[]; valid: boolean } =>
      Array.isArray(lane.indications) && typeof lane.valid === 'boolean' && lane.indications.every((item) => typeof item === 'string'),
    ).map((lane) => ({ indications: lane.indications, valid: lane.valid }));
    maneuvers.push({
      id: `${legIndex}:${stepIndex}`, type: kind, location: [Number(location[0]), Number(location[1])],
      distanceMeters: Number.isFinite(step.distance) && step.distance! >= 0 ? step.distance! : 0,
      durationSeconds: Number.isFinite(step.duration) && step.duration! >= 0 ? step.duration! : 0,
      ...(step.name ? { streetName: step.name } : {}), ...(modifier ? { modifier } : {}), ...(exitNumber ? { exitNumber } : {}),
      ...(Number.isFinite(maneuver?.bearing_before) ? { bearingBefore: maneuver!.bearing_before } : {}),
      ...(Number.isFinite(maneuver?.bearing_after) ? { bearingAfter: maneuver!.bearing_after } : {}),
      ...(lanes?.length ? { lanes } : {}),
    });
  }));
  return {
    geometry, distanceMeters: route.distance!, durationSeconds: route.duration!,
    ...(legs && legs.every((leg): leg is RoadRouteLeg => leg !== null) && legs.length === points.length - 1 ? { legs } : {}),
    ...(maneuvers.length ? { maneuvers } : {}),
  };
}
