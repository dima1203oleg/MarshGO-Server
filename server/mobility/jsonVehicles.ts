import { fetchJson } from './safeFetch';
import { routeTypeLabel } from './gtfs';
import { bboxOf, type ConnectionReport } from './types';
import { isFreshMobilityTimestamp, parseMobilityTimestamp } from './timestamps';
import { pointIsInsideUkraine } from './gbfs';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Finds the vehicle list in the shapes used by Dozor / EasyWay / iCity feeds: a top-level array or {positions|vehicles|data: [...]}. */
export function extractVehicleList(body: unknown): Json[] {
  // Some municipal endpoints return JSON encoded inside a JSON string. Decode
  // one bounded layer only; fetchJson already caps the response body size.
  let decoded = body;
  if (typeof decoded === 'string' && decoded.length <= 5_000_000) {
    try { decoded = JSON.parse(decoded) as unknown; } catch { return []; }
  }
  const objectBody = isObject(decoded) ? decoded : null;
  const list = Array.isArray(decoded) ? decoded : objectBody ? (['positions', 'vehicles', 'data', 'items'] as const).map((key) => objectBody[key]).find(Array.isArray) : undefined;
  return Array.isArray(list) ? list.filter(isObject) : [];
}

const num = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);

/** A city-scoped Ukrainian feed with substantial foreign-coordinate pollution is not healthy. */
export function hasAcceptableCountryCoverage(totalEntries: number, outsideCountry: number): boolean {
  return totalEntries > 0 && outsideCountry / totalEntries <= 0.05;
}

/** A live vehicle feed is fully fresh only when every accepted position is inside the live window. */
export function hasFullyFreshVehiclePositions(validVehicles: number, freshVehicles: number): boolean {
  return validVehicles > 0 && freshVehicles === validVehicles;
}

/** A mixed-age fleet can still provide live service because stale units are filtered individually at the map boundary. */
export function hasAcceptableFreshVehicleCoverage(validVehicles: number, freshVehicles: number, minimumRatio = 0.7): boolean {
  return Number.isInteger(validVehicles) && validVehicles > 0
    && Number.isInteger(freshVehicles) && freshVehicles > 0 && freshVehicles <= validVehicles
    && Number.isFinite(minimumRatio) && minimumRatio > 0 && minimumRatio <= 1
    && freshVehicles / validVehicles >= minimumRatio;
}

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

export function summarizeVehicles(list: Json[], now = Date.now(), expectedCountry?: string) {
  let valid = 0, invalid = 0, outsideCountry = 0, timestamped = 0, fresh = 0, stale = 0, missingTimestamps = 0; let newest = 0;
  const points: Array<[number, number]> = [];
  const byType: Record<string, number> = {};
  for (const vehicle of list) {
    const lat = num(vehicle.latitude ?? vehicle.lat), lon = num(vehicle.longitude ?? vehicle.lon ?? vehicle.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) { invalid++; continue; }
    if (expectedCountry === 'UA' && !pointIsInsideUkraine([lon, lat])) { outsideCountry++; continue; }
    valid++; points.push([lon, lat]);
    const label = vehicleTransportLabel(vehicle);
    byType[label] = (byType[label] ?? 0) + 1;
    const timestamp = parseMobilityTimestamp(vehicle.timestamp ?? vehicle.updated_at ?? vehicle.last_update ?? vehicle.time, 'Europe/Kyiv', now);
    if (timestamp) {
      timestamped++;
      newest = Math.max(newest, timestamp.getTime());
      if (isFreshMobilityTimestamp(timestamp, now)) fresh++;
      else stale++;
    } else missingTimestamps++;
  }
  return { points, valid, invalid, outsideCountry, timestamped, fresh, stale, missingTimestamps, byType, newestTimestampMs: newest || null,
    ageSeconds: newest > 0 ? Math.round((now - newest) / 1000) : null };
}

export async function testJsonVehiclesConnection(url: string, expectedCountry?: string): Promise<ConnectionReport> {
  const checks: ConnectionReport['checks'] = [];
  const started = Date.now();
  let body: unknown;
  try { body = (await fetchJson(url, 12000)).data; checks.push({ name: 'Feed accessible', ok: true }); }
  catch (error) { const detail = error instanceof Error ? error.message : 'unknown'; checks.push({ name: 'Feed accessible', ok: false, detail }); return { health: 'offline', checks, counts: {}, responseMs: Date.now() - started, error: detail }; }
  const list = extractVehicleList(body);
  checks.push({ name: 'Vehicle list found', ok: list.length > 0, detail: `${list.length} entries` });
  if (list.length === 0) return { health: 'degraded', checks, counts: {}, responseMs: Date.now() - started, error: 'No vehicles in the feed (it may be empty at night)' };
  const summary = summarizeVehicles(list, Date.now(), expectedCountry);
  if (expectedCountry) {
    checks.push({ name: 'Expected country positions', ok: summary.valid > 0, detail: `${summary.valid} in ${expectedCountry}; ${summary.outsideCountry} outside` });
    checks.push({ name: 'Country coverage quality', ok: hasAcceptableCountryCoverage(list.length, summary.outsideCountry), detail: `${summary.outsideCountry}/${list.length} entries outside ${expectedCountry}; maximum 5%` });
  }
  checks.push({ name: 'Coordinates', ok: summary.valid > 0 && summary.invalid <= summary.valid * 0.05, detail: `${summary.valid} valid, ${summary.invalid} invalid` });
  checks.push({ name: 'Timestamped positions', ok: summary.timestamped > 0, detail: `${summary.timestamped} of ${summary.valid} positions have a parseable update time` });
  checks.push({ name: 'Live vehicle freshness coverage', ok: hasAcceptableFreshVehicleCoverage(summary.valid, summary.fresh),
    detail: `${summary.fresh}/${summary.valid} valid positions are fresh (minimum 70%); ${summary.stale} stale and ${summary.missingTimestamps} without timestamps are excluded individually from live maps` });
  const fresh = summary.newestTimestampMs !== null
    && isFreshMobilityTimestamp(new Date(summary.newestTimestampMs), Date.now());
  checks.push({ name: 'Freshness', ok: fresh, detail: summary.ageSeconds === null ? 'no parseable update time' : `${summary.ageSeconds}s old; live threshold is 90s` });
  const counts: Record<string, number> = { vehicles: summary.valid, timestamped: summary.timestamped,
    freshVehiclePositions: summary.fresh, staleVehiclePositions: summary.stale, missingVehicleTimestamps: summary.missingTimestamps,
    invalidVehicleCoordinates: summary.invalid,
    ...(summary.outsideCountry ? { vehicles_outside_country: summary.outsideCountry } : {}),
    ...Object.fromEntries(Object.entries(summary.byType).map(([type, count]) => [`vehicles_${type}`, count])),
    ...(summary.ageSeconds !== null ? { ageSeconds: summary.ageSeconds } : {}) };
  return { health: checks.every((check) => check.ok) ? 'healthy' : 'degraded', checks, counts, responseMs: Date.now() - started, ...(bboxOf(summary.points) ? { bbox: bboxOf(summary.points) } : {}) };
}
