import { unzipSync, strFromU8 } from 'fflate';
import bindings from 'gtfs-realtime-bindings';
import { fetchBinary, fetchJson } from './safeFetch';
import { parseCsvLine, routeTypeLabel } from './gtfs';
import { extractVehicleList, vehicleTransportLabel } from './jsonVehicles';
import type { Bbox } from './types';

/**
 * Map data for the 2D transport layers. Everything is loaded per viewport (bbox) and per layer, never as one "whole transport world":
 * static GTFS geometry is parsed once per feed and cached for hours, vehicle positions are cached for seconds.
 */
export type LineType = 'bus' | 'marshrutka' | 'trolleybus' | 'tram' | 'metro' | 'train' | 'suburban';
const LINE_TYPES = new Set<string>(['bus', 'marshrutka', 'trolleybus', 'tram', 'metro', 'train', 'suburban']);
export const isLineType = (value: string): value is LineType => LINE_TYPES.has(value);

export interface NetworkStop { id: string; name: string; lon: number; lat: number; types: LineType[] }
export interface NetworkRoute { id: string; name: string; type: LineType; coordinates: Array<[number, number]> }
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
  const longestByKey = new Map<string, { tripId: string; count: number }>();
  for (const [tripId, list] of tripStops) {
    const meta = tripRoute.get(tripId)!; const type = routeInfo.get(meta.routeId)!.type;
    for (const { stopId } of list) { const set = typesByStop.get(stopId) ?? new Set<LineType>(); set.add(type); typesByStop.set(stopId, set); }
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
    let coordinates: Array<[number, number]>;
    if (shape && shape.length >= 2) coordinates = shape.sort((a, b) => a.seq - b.seq).map((p) => [p.lon, p.lat]);
    else coordinates = (tripStops.get(tripId) ?? []).sort((a, b) => a.seq - b.seq).flatMap(({ stopId }): Array<[number, number]> => { const stop = stopById.get(stopId); return stop ? [[stop.lon, stop.lat]] : []; });
    if (coordinates.length >= 2) routes.push({ id: key, name: info.name, type: info.type, coordinates: decimate(coordinates, 160) });
  }

  const stops: NetworkStop[] = [];
  const points: Array<[number, number]> = [];
  for (const [id, stop] of stopById) {
    const types = typesByStop.get(id);
    if (!types || types.size === 0) continue;
    stops.push({ id, name: stop.name, lon: stop.lon, lat: stop.lat, types: [...types] });
    points.push([stop.lon, stop.lat]);
  }
  let bbox: Bbox | null = null;
  if (points.length) { bbox = [180, 90, -180, -90]; for (const [lon, lat] of points) { bbox[0] = Math.min(bbox[0], lon); bbox[1] = Math.min(bbox[1], lat); bbox[2] = Math.max(bbox[2], lon); bbox[3] = Math.max(bbox[3], lat); } }
  return { stops, routes, bbox };
}

const NETWORK_TTL_MS = 6 * 60 * 60_000;
const networks = new Map<string, { at: number; promise: Promise<TransportNetwork> }>();
const WANTED = /(^|\/)(stops|routes|trips|stop_times|shapes)\.txt$/;

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

export function inBbox(bbox: Bbox, lon: number, lat: number): boolean { return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]; }
export function intersects(a: Bbox, b: Bbox): boolean { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }

/** A feed's route is drawn when any of its points is inside the viewport (keeps payloads small without clipping lines). */
export function routeInBbox(route: NetworkRoute, bbox: Bbox): boolean { return route.coordinates.some(([lon, lat]) => inBbox(bbox, lon, lat)); }

export interface LiveVehicle { id: string; lon: number; lat: number; type: LineType | 'other'; route: string; bearing: number | null; providerId: string }

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
      const routeId = entity.vehicle?.trip?.routeId ?? '';
      const known = routeNames.get(routeId);
      out.push({ id: `${providerId}:${entity.id}`, lon: position.longitude, lat: position.latitude, type: known?.type ?? 'other', route: known?.name ?? routeId, bearing: Number.isFinite(position.bearing) ? Number(position.bearing) : null, providerId });
    }
    return out;
  }
  const body = (await fetchJson(url, 12000)).data;
  const out: LiveVehicle[] = [];
  for (const vehicle of extractVehicleList(body)) {
    const lat = Number(vehicle.latitude ?? vehicle.lat), lon = Number(vehicle.longitude ?? vehicle.lon ?? vehicle.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const label = vehicleTransportLabel(vehicle);
    const bearing = Number(vehicle.bearing ?? vehicle.course ?? vehicle.azimuth);
    out.push({ id: `${providerId}:${String(vehicle.vehicle_id ?? vehicle.id ?? vehicle.license_plate ?? `${lat},${lon}`)}`, lon, lat, type: asLineType(label) ?? 'other',
      route: String(vehicle.route_name ?? vehicle.route ?? vehicle.route_short_name ?? ''), bearing: Number.isFinite(bearing) ? bearing : null, providerId });
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
