import { fetchJson } from './safeFetch';
import { routeTypeLabel } from './gtfs';
import { bboxOf, type ConnectionReport } from './types';
import { isFreshMobilityTimestamp, parseMobilityTimestamp } from './timestamps';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Finds the vehicle list in the shapes used by Dozor / EasyWay / iCity feeds: a top-level array or {positions|vehicles|data: [...]}. */
export function extractVehicleList(body: unknown): Json[] {
  const list = Array.isArray(body) ? body : isObject(body) ? (['positions', 'vehicles', 'data', 'items'] as const).map((key) => body[key]).find(Array.isArray) : undefined;
  return Array.isArray(list) ? list.filter(isObject) : [];
}

const num = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);

/** Maps an explicitly supplied mode spelling, without inferring from generic route_type. */
function explicitVehicleTransportLabel(vehicle: Json): string | null {
  const raw = String(vehicle.transport_type ?? vehicle.type ?? '').toLowerCase();
  if (/marshrutka|minibus|маршрутк/.test(raw)) return 'marshrutka';
  if (/trolley|trol\b|тролейб/.test(raw)) return 'trolleybus';
  if (/tram|трамв/.test(raw)) return 'tram';
  if (/metro|subway|метро/.test(raw)) return 'metro';
  if (/train|rail|поїзд|електрич/.test(raw)) return 'train';
  if (/bus|автобус/.test(raw)) return 'bus';
  return null;
}

/** Maps the many transport-type spellings of local feeds onto the MARSHGO labels. */
export function vehicleTransportLabel(vehicle: Json): string {
  const explicit = explicitVehicleTransportLabel(vehicle);
  if (explicit) return explicit;
  const routeType = num(vehicle.route_type);
  if (Number.isFinite(routeType)) return routeTypeLabel(routeType);
  return 'other';
}

export interface JsonVehicleRouteMatch {
  route: string;
  type: string;
  /** Set only when a unique published route label matches the loaded route index. */
  routeId?: string;
}

const routeLabelKey = (value: unknown): string => typeof value === 'string' || typeof value === 'number'
  ? String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA')
  : '';

const textField = (...values: unknown[]): string => {
  for (const value of values) {
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) return String(value).trim();
  }
  return '';
};

/**
 * Resolve a JSON vehicle label against the supplied route index. The map endpoint currently
 * merges multiple providers' route IDs, so a raw JSON route_id is not trusted by itself:
 * namespaces can collide. Labels are accepted only when they identify one loaded route.
 */
export function matchJsonVehicleRoute(
  vehicle: Json,
  routeNames: ReadonlyMap<string, { name: string; type: string }>,
): JsonVehicleRouteMatch {
  const route = textField(vehicle.route_short_name, vehicle.route_name, vehicle.route_long_name, vehicle.route, vehicle.line);
  const routeKey = routeLabelKey(route);
  if (routeKey) {
    const matches = [...routeNames.entries()].filter(([, candidate]) => routeLabelKey(candidate.name) === routeKey);
    if (matches.length === 1) {
      const [routeId, match] = matches[0];
      const explicitType = explicitVehicleTransportLabel(vehicle);
      if (explicitType && explicitType !== match.type) return { route, type: explicitType };
      return { routeId, route: match.name, type: explicitType ?? match.type };
    }
  }
  return { route, type: vehicleTransportLabel(vehicle) };
}

export function summarizeVehicles(list: Json[], now = Date.now()) {
  let valid = 0, invalid = 0, timestamped = 0; let newest = 0;
  const points: Array<[number, number]> = [];
  const byType: Record<string, number> = {};
  for (const vehicle of list) {
    const lat = num(vehicle.latitude ?? vehicle.lat), lon = num(vehicle.longitude ?? vehicle.lon ?? vehicle.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) { invalid++; continue; }
    valid++; points.push([lon, lat]);
    const label = vehicleTransportLabel(vehicle);
    byType[label] = (byType[label] ?? 0) + 1;
    const timestamp = parseMobilityTimestamp(vehicle.timestamp ?? vehicle.updated_at ?? vehicle.last_update ?? vehicle.time, 'Europe/Kyiv', now);
    if (timestamp) { timestamped++; newest = Math.max(newest, timestamp.getTime()); }
  }
  return { points, valid, invalid, timestamped, byType, newestTimestampMs: newest || null,
    ageSeconds: newest > 0 ? Math.round((now - newest) / 1000) : null };
}

export async function testJsonVehiclesConnection(url: string): Promise<ConnectionReport> {
  const checks: ConnectionReport['checks'] = [];
  const started = Date.now();
  let body: unknown;
  try { body = (await fetchJson(url, 12000)).data; checks.push({ name: 'Feed accessible', ok: true }); }
  catch (error) { const detail = error instanceof Error ? error.message : 'unknown'; checks.push({ name: 'Feed accessible', ok: false, detail }); return { health: 'offline', checks, counts: {}, responseMs: Date.now() - started, error: detail }; }
  const list = extractVehicleList(body);
  checks.push({ name: 'Vehicle list found', ok: list.length > 0, detail: `${list.length} entries` });
  if (list.length === 0) return { health: 'degraded', checks, counts: {}, responseMs: Date.now() - started, error: 'No vehicles in the feed (it may be empty at night)' };
  const summary = summarizeVehicles(list);
  checks.push({ name: 'Coordinates', ok: summary.valid > 0 && summary.invalid <= summary.valid * 0.05, detail: `${summary.valid} valid, ${summary.invalid} invalid` });
  checks.push({ name: 'Timestamped positions', ok: summary.timestamped > 0, detail: `${summary.timestamped} of ${summary.valid} positions have a parseable update time` });
  const fresh = summary.newestTimestampMs !== null
    && isFreshMobilityTimestamp(new Date(summary.newestTimestampMs), Date.now());
  checks.push({ name: 'Freshness', ok: fresh, detail: summary.ageSeconds === null ? 'no parseable update time' : `${summary.ageSeconds}s old; live threshold is 90s` });
  const counts: Record<string, number> = { vehicles: summary.valid, timestamped: summary.timestamped, ...Object.fromEntries(Object.entries(summary.byType).map(([type, count]) => [`vehicles_${type}`, count])), ...(summary.ageSeconds !== null ? { ageSeconds: summary.ageSeconds } : {}) };
  return { health: checks.every((check) => check.ok) ? 'healthy' : 'degraded', checks, counts, responseMs: Date.now() - started, ...(bboxOf(summary.points) ? { bbox: bboxOf(summary.points) } : {}) };
}
