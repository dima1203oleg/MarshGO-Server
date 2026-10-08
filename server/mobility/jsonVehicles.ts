import { fetchJson } from './safeFetch';
import { routeTypeLabel } from './gtfs';
import { bboxOf, type ConnectionReport } from './types';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Finds the vehicle list in the shapes used by Dozor / EasyWay / iCity feeds: a top-level array or {positions|vehicles|data: [...]}. */
export function extractVehicleList(body: unknown): Json[] {
  const list = Array.isArray(body) ? body : isObject(body) ? (['positions', 'vehicles', 'data', 'items'] as const).map((key) => body[key]).find(Array.isArray) : undefined;
  return Array.isArray(list) ? list.filter(isObject) : [];
}

const num = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);

/** Maps the many transport-type spellings of local feeds onto the MARSHGO labels. */
export function vehicleTransportLabel(vehicle: Json): string {
  const routeType = num(vehicle.route_type);
  if (Number.isFinite(routeType)) return routeTypeLabel(routeType);
  const raw = String(vehicle.transport_type ?? vehicle.type ?? '').toLowerCase();
  if (/marshrutka|minibus|маршрутк/.test(raw)) return 'marshrutka';
  if (/trolley|trol\b|тролейб/.test(raw)) return 'trolleybus';
  if (/tram|трамв/.test(raw)) return 'tram';
  if (/metro|subway|метро/.test(raw)) return 'metro';
  if (/train|rail|поїзд|електрич/.test(raw)) return 'train';
  if (/bus|автобус/.test(raw)) return 'bus';
  return 'other';
}

export function summarizeVehicles(list: Json[]) {
  let valid = 0, invalid = 0; let newest = 0;
  const points: Array<[number, number]> = [];
  const byType: Record<string, number> = {};
  for (const vehicle of list) {
    const lat = num(vehicle.latitude ?? vehicle.lat), lon = num(vehicle.longitude ?? vehicle.lon ?? vehicle.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) { invalid++; continue; }
    valid++; points.push([lon, lat]);
    const label = vehicleTransportLabel(vehicle);
    byType[label] = (byType[label] ?? 0) + 1;
    const ts = num(vehicle.timestamp);
    if (Number.isFinite(ts) && ts > newest) newest = ts;
  }
  return { points, valid, invalid, byType, ageSeconds: newest > 0 ? Math.round(Date.now() / 1000 - newest) : null };
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
  if (summary.ageSeconds !== null) checks.push({ name: 'Freshness', ok: summary.ageSeconds < 1800, detail: `${summary.ageSeconds}s old` });
  const counts: Record<string, number> = { vehicles: summary.valid, ...Object.fromEntries(Object.entries(summary.byType).map(([type, count]) => [`vehicles_${type}`, count])), ...(summary.ageSeconds !== null ? { ageSeconds: summary.ageSeconds } : {}) };
  return { health: checks.every((check) => check.ok) ? 'healthy' : 'degraded', checks, counts, responseMs: Date.now() - started, ...(bboxOf(summary.points) ? { bbox: bboxOf(summary.points) } : {}) };
}
