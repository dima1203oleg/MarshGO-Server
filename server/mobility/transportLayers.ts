import { unzipSync, strFromU8 } from 'fflate';
import bindings from 'gtfs-realtime-bindings';
import { fetchBinary, fetchJson } from './safeFetch';
import { parseCsvLine, routeTypeLabel } from './gtfs';
import { extractVehicleList, vehicleTransportLabel } from './jsonVehicles';
import { bboxOf, type Bbox } from './types';

/**
 * Map data for the 2D transport layers. Everything is loaded per viewport (bbox) and per layer, never as one "whole transport world":
 * static GTFS geometry is parsed once per feed and cached for hours, vehicle positions are cached for seconds.
 */
export type LineType = 'bus' | 'marshrutka' | 'trolleybus' | 'tram' | 'metro' | 'train' | 'suburban' | 'city_train' | 'funicular';
const LINE_TYPES = new Set<string>(['bus', 'marshrutka', 'trolleybus', 'tram', 'metro', 'train', 'suburban', 'city_train', 'funicular']);
export const isLineType = (value: string): value is LineType => LINE_TYPES.has(value);

export interface NetworkStop { id: string; name: string; lon: number; lat: number; types: LineType[]; routes: string[] }
export interface NetworkRoute { id: string; name: string; type: LineType; direction: string; stopCount: number; coordinates: Array<[number, number]> }
export interface TransportNetwork { stops: NetworkStop[]; routes: NetworkRoute[]; bbox: Bbox | null }

function rows(text: string | undefined): Array<Record<string, string>> {
  if (!text) return [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? '').map((name) => name.trim());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const values = parseCsvLine(lines[i]); const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = values[c] ?? '';
    out.push(row);
  }
  return out;
}

/** Keeps at most `max` points of a line, always the first and the last. */
export function decimate<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

const asLineType = (label: string): LineType | null => (isLineType(label) ? label : null);

/**
 * Builds stops and one representative line per route from GTFS text files. A route's line is its `shapes.txt` geometry when present,
 * otherwise the stop sequence of its longest trip (per direction), so feeds without shapes still draw real lines.
 */
export function buildNetwork(files: Record<string, string>): TransportNetwork {
  const routeInfo = new Map<string, { name: string; type: LineType }>();
  for (const route of rows(files['routes.txt'])) {
    const type = asLineType(routeTypeLabel(Number(route.route_type)));
    if (type) routeInfo.set(route.route_id, { name: (route.route_short_name || route.route_long_name || route.route_id).trim(), type });
  }
  const stopById = new Map<string, { name: string; lon: number; lat: number }>();
  for (const stop of rows(files['stops.txt'])) {
    const lat = Number(stop.stop_lat), lon = Number(stop.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    stopById.set(stop.stop_id, { name: stop.stop_name, lon, lat });
  }
  const tripRoute = new Map<string, { routeId: string; direction: string; shapeId: string }>();
  for (const trip of rows(files['trips.txt'])) if (routeInfo.has(trip.route_id)) tripRoute.set(trip.trip_id, { routeId: trip.route_id, direction: trip.direction_id ?? '', shapeId: trip.shape_id ?? '' });

  // Pass 1: stops per trip, in order. Only trips of known routes are kept.
  const tripStops = new Map<string, Array<{ seq: number; stopId: string }>>();
  for (const row of rows(files['stop_times.txt'])) {
    if (!tripRoute.has(row.trip_id)) continue;
    const list = tripStops.get(row.trip_id) ?? []; list.push({ seq: Number(row.stop_sequence), stopId: row.stop_id }); tripStops.set(row.trip_id, list);
  }
  const typesByStop = new Map<string, Set<LineType>>();
  const routesByStop = new Map<string, Set<string>>();
  const longestByKey = new Map<string, { tripId: string; count: number }>();
  for (const [tripId, list] of tripStops) {
    const meta = tripRoute.get(tripId)!; const type = routeInfo.get(meta.routeId)!.type;
    for (const { stopId } of list) {
      const set = typesByStop.get(stopId) ?? new Set<LineType>(); set.add(type); typesByStop.set(stopId, set);
      const routeNames = routesByStop.get(stopId) ?? new Set<string>(); routeNames.add(routeInfo.get(meta.routeId)!.name); routesByStop.set(stopId, routeNames);
    }
    const key = `${meta.routeId}|${meta.direction}`;
    const best = longestByKey.get(key);
    if (!best || list.length > best.count) longestByKey.set(key, { tripId, count: list.length });
  }

  const shapes = new Map<string, Array<{ seq: number; lon: number; lat: number }>>();
  const neededShapes = new Set([...longestByKey.values()].map(({ tripId }) => tripRoute.get(tripId)!.shapeId).filter(Boolean));
  if (neededShapes.size > 0) {
    for (const point of rows(files['shapes.txt'])) {
      if (!neededShapes.has(point.shape_id)) continue;
      const lon = Number(point.shape_pt_lon), lat = Number(point.shape_pt_lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const list = shapes.get(point.shape_id) ?? []; list.push({ seq: Number(point.shape_pt_sequence), lon, lat }); shapes.set(point.shape_id, list);
    }
  }

  const routes: NetworkRoute[] = [];
  for (const [key, { tripId }] of longestByKey) {
    const routeId = key.split('|')[0]; const info = routeInfo.get(routeId)!; const meta = tripRoute.get(tripId)!;
    const shape = meta.shapeId ? shapes.get(meta.shapeId) : undefined;
    let coordinates: Array<[number, number]> = [];
    if (shape && shape.length >= 2) coordinates = shape.sort((a, b) => a.seq - b.seq).map((p): [number, number] => [p.lon, p.lat]);
    const orderedStops = [...(tripStops.get(tripId) ?? [])].sort((a, b) => a.seq - b.seq).flatMap(({ stopId }) => {
      const stop = stopById.get(stopId); return stop ? [{ id: stopId, ...stop }] : [];
    });
    if (!shape || shape.length < 2) coordinates = orderedStops.map((stop): [number, number] => [stop.lon, stop.lat]);
    if (coordinates.length >= 2) routes.push({ id: key, name: info.name, type: info.type,
      direction: orderedStops.length >= 2 ? `${orderedStops[0].name} → ${orderedStops[orderedStops.length - 1].name}` : '',
      stopCount: orderedStops.length, coordinates: decimate(coordinates, 160) });
  }

  const stops: NetworkStop[] = [];
  const points: Array<[number, number]> = [];
  for (const [id, stop] of stopById) {
    const types = typesByStop.get(id);
    if (!types || types.size === 0) continue;
    stops.push({ id, name: stop.name, lon: stop.lon, lat: stop.lat, types: [...types], routes: [...(routesByStop.get(id) ?? [])].sort((a, b) => a.localeCompare(b, 'uk')) });
    points.push([stop.lon, stop.lat]);
  }
  let bbox: Bbox | null = null;
  if (points.length) { bbox = [180, 90, -180, -90]; for (const [lon, lat] of points) { bbox[0] = Math.min(bbox[0], lon); bbox[1] = Math.min(bbox[1], lat); bbox[2] = Math.max(bbox[2], lon); bbox[3] = Math.max(bbox[3], lat); } }
  return { stops, routes, bbox };
}

const NETWORK_TTL_MS = 6 * 60 * 60_000;
const networks = new Map<string, { at: number; promise: Promise<TransportNetwork> }>();
const WANTED = /(^|\/)(stops|routes|trips|stop_times|shapes)\.txt$/;

/** Normalize an official Kyiv GeoJSON route/station feed into the same network shape as GTFS. */
export function buildGeoJsonNetwork(body: unknown, mode: LineType): TransportNetwork {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { features?: unknown }).features)) throw new Error('Invalid GeoJSON FeatureCollection');
  const features = (body as { features: unknown[] }).features;
  const groups = new Map<string, { name: string; direction: string; order: number; coordinates: Array<[number, number]>; from?: string; to?: string }[]>();
  const stops: NetworkStop[] = [];
  const points: Array<[number, number]> = [];
  for (const raw of features) {
    if (!raw || typeof raw !== 'object') continue;
    const feature = raw as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> };
    const props = feature.properties ?? {};
    const geometry = feature.geometry;
    if (geometry?.type === 'Point' && Array.isArray(geometry.coordinates)) {
      const [lon, lat] = geometry.coordinates.map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90 || (lon === 0 && lat === 0)) continue;
      const name = String(props.name ?? props.name_uk ?? props.stop_name ?? props.station_name ?? '').trim();
      if (!name) continue;
      const id = String(props.code1 ?? props.stop_id ?? props.objectid ?? name);
      stops.push({ id, name, lon, lat, types: [mode], routes: typeof props.line === 'string' ? [props.line] : [] });
      points.push([lon, lat]);
      continue;
    }
    if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) continue;
    const coordinates = geometry.coordinates.flatMap((point): Array<[number, number]> => {
      if (!Array.isArray(point) || point.length < 2) return [];
      const lon = Number(point[0]), lat = Number(point[1]);
      return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 && (lon !== 0 || lat !== 0) ? [[lon, lat]] : [];
    });
    if (coordinates.length < 2) continue;
    const name = String(props.num_route ?? props.route_short_name ?? props.line ?? props.name ?? '').trim();
    if (!name) continue;
    const direction = String(props.napryamok ?? props.direction ?? props.to_stop_ ?? '').trim();
    const key = `${name}|${direction}`;
    const list = groups.get(key) ?? [];
    list.push({ name, direction, order: Number(props.order_ ?? props.sequence ?? 0), coordinates,
      ...(props.from_stop_ ? { from: String(props.from_stop_) } : {}), ...(props.to_stop_ ? { to: String(props.to_stop_) } : {}) });
    groups.set(key, list);
  }
  const routes: NetworkRoute[] = [];
  for (const [key, segments] of groups) {
    segments.sort((a, b) => a.order - b.order);
    const coordinates: Array<[number, number]> = [];
    for (const segment of segments) for (const coordinate of segment.coordinates) {
      const previous = coordinates[coordinates.length - 1];
      if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate);
    }
    if (coordinates.length < 2) continue;
    const first = segments[0], last = segments[segments.length - 1];
    routes.push({ id: key, name: first.name, type: mode, direction: first.from && last.to ? `${first.from} → ${last.to}` : first.direction,
      stopCount: segments.length + 1, coordinates: decimate(coordinates, 240) });
  }
  return { stops, routes, bbox: points.length ? bboxOf(points) ?? null : routes.length ? bboxOf(routes.flatMap((route) => route.coordinates)) ?? null : null };
}

/** Static feeds are parsed once and shared for six hours; a failed load is not cached. */
export function cachedNetwork(providerId: string, url: string): Promise<TransportNetwork> {
  const hit = networks.get(providerId);
  if (hit && Date.now() - hit.at < NETWORK_TTL_MS) return hit.promise;
  const promise = (async () => {
    const { data } = await fetchBinary(url, 60 * 1024 * 1024);
    const unzipped = unzipSync(data, { filter: (file) => WANTED.test(file.name) && file.originalSize < 200 * 1024 * 1024 });
    const files: Record<string, string> = {};
    for (const [name, content] of Object.entries(unzipped)) files[name.split('/').pop() as string] = strFromU8(content);
    return buildNetwork(files);
  })();
  networks.set(providerId, { at: Date.now(), promise });
  promise.catch(() => networks.delete(providerId));
  return promise;
}

export function cachedGeoJsonNetwork(providerId: string, url: string, mode: LineType): Promise<TransportNetwork> {
  const key = `geojson:${providerId}`;
  const hit = networks.get(key);
  if (hit && Date.now() - hit.at < NETWORK_TTL_MS) return hit.promise;
  const promise = fetchJson(url, 15000).then(({ data }) => buildGeoJsonNetwork(data, mode));
  networks.set(key, { at: Date.now(), promise });
  promise.catch(() => networks.delete(key));
  return promise;
}

export function geoJsonMode(name: string): LineType | null {
  const normalized = name.toLocaleLowerCase('uk');
  if (normalized.includes('routeTaxi'.toLocaleLowerCase('uk')) || normalized.includes('маршрут')) return 'marshrutka';
  if (normalized.includes('метро') || normalized.includes('underground')) return 'metro';
  if (normalized.includes('фунікулер') || normalized.includes('funicular')) return 'funicular';
  if (normalized.includes('електричк') || normalized.includes('city express') || normalized.includes('кільцев')) return 'city_train';
  return null;
}

export function inBbox(bbox: Bbox, lon: number, lat: number): boolean { return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]; }
export function intersects(a: Bbox, b: Bbox): boolean { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }

/** A feed's route is drawn when any of its points is inside the viewport (keeps payloads small without clipping lines). */
export function routeInBbox(route: NetworkRoute, bbox: Bbox): boolean { return route.coordinates.some(([lon, lat]) => inBbox(bbox, lon, lat)); }

export interface LiveVehicle { id: string; lon: number; lat: number; type: LineType | 'other'; route: string; bearing: number | null; speed: number | null; timestamp: Date | null; providerId: string }

export function parseVehicleTimestamp(value: unknown): Date | null {
  let milliseconds: number;
  if (typeof value === 'number' && Number.isFinite(value)) milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
  else if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    milliseconds = Number.isFinite(numeric) ? (numeric < 1_000_000_000_000 ? numeric * 1000 : numeric) : Date.parse(value);
  } else return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function isFreshVehicleTimestamp(timestamp: Date | null, now = Date.now()): boolean {
  if (!timestamp) return false;
  const age = now - timestamp.getTime();
  return age >= -30_000 && age <= 120_000;
}

const VEHICLE_TTL_MS = 10_000;
const vehicleCache = new Map<string, { at: number; promise: Promise<LiveVehicle[]> }>();
const { transit_realtime } = bindings;

async function loadVehicles(providerId: string, sourceType: string, url: string, routeNames: Map<string, { name: string; type: LineType }>): Promise<LiveVehicle[]> {
  if (sourceType === 'gtfs_rt') {
    const { data } = await fetchBinary(url, 10 * 1024 * 1024);
    const message = transit_realtime.FeedMessage.decode(data);
    const out: LiveVehicle[] = [];
    for (const entity of message.entity) {
      const position = entity.vehicle?.position;
      if (!position || !Number.isFinite(position.latitude) || !Number.isFinite(position.longitude)) continue;
      if (Math.abs(position.latitude) > 90 || Math.abs(position.longitude) > 180 || (position.latitude === 0 && position.longitude === 0)) continue;
      const routeId = entity.vehicle?.trip?.routeId ?? '';
      const known = routeNames.get(routeId);
      const speed = Number(position.speed);
      out.push({ id: `${providerId}:${entity.id}`, lon: position.longitude, lat: position.latitude, type: known?.type ?? 'other', route: known?.name ?? routeId,
        bearing: Number.isFinite(position.bearing) ? Number(position.bearing) : null, speed: Number.isFinite(speed) && speed >= 0 ? speed : null,
        timestamp: parseVehicleTimestamp(entity.vehicle?.timestamp), providerId });
    }
    return out;
  }
  const body = (await fetchJson(url, 12000)).data;
  const out: LiveVehicle[] = [];
  for (const vehicle of extractVehicleList(body)) {
    const lat = Number(vehicle.latitude ?? vehicle.lat), lon = Number(vehicle.longitude ?? vehicle.lon ?? vehicle.lng);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    const label = vehicleTransportLabel(vehicle);
    const bearing = Number(vehicle.bearing ?? vehicle.course ?? vehicle.azimuth);
    const speed = Number(vehicle.speed ?? vehicle.speed_mps);
    out.push({ id: `${providerId}:${String(vehicle.vehicle_id ?? vehicle.id ?? vehicle.license_plate ?? `${lat},${lon}`)}`, lon, lat, type: asLineType(label) ?? 'other',
      route: String(vehicle.route_name ?? vehicle.route ?? vehicle.route_short_name ?? ''), bearing: Number.isFinite(bearing) ? bearing : null,
      speed: Number.isFinite(speed) && speed >= 0 ? speed : null, timestamp: parseVehicleTimestamp(vehicle.timestamp ?? vehicle.updated_at ?? vehicle.last_update), providerId });
  }
  return out;
}

/** Positions are shared between users for ten seconds so a busy map never multiplies requests to city feeds. */
export function cachedVehicles(providerId: string, sourceType: string, url: string, routeNames: Map<string, { name: string; type: LineType }>): Promise<LiveVehicle[]> {
  const hit = vehicleCache.get(providerId);
  if (hit && Date.now() - hit.at < VEHICLE_TTL_MS) return hit.promise;
  const promise = loadVehicles(providerId, sourceType, url, routeNames);
  vehicleCache.set(providerId, { at: Date.now(), promise });
  promise.catch(() => vehicleCache.delete(providerId));
  return promise;
}

export function parseBbox(raw: unknown, maxSpanDegrees = 2): Bbox | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const [west, south, east, north] = parts;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  if (east - west > maxSpanDegrees || north - south > maxSpanDegrees) return null;
  return [west, south, east, north];
}
