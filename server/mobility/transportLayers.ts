import { unzipSync, strFromU8 } from 'fflate';
import bindings from 'gtfs-realtime-bindings';
import { z } from 'zod';
import { cacheKey, smartCache } from '../cache/cacheService';
import { fetchBinary, fetchJson, UnsafeUrlError } from './safeFetch';
import { parseCsvLine, routeTypeLabel } from './gtfs';
import { extractVehicleList, matchJsonVehicleRoute } from './jsonVehicles';
import { bboxOf, type Bbox } from './types';
import { isFreshMobilityTimestamp, LIVE_MOBILITY_MAX_AGE_MS, parseMobilityTimestamp } from './timestamps';

/**
 * Map data for the 2D transport layers. Everything is loaded per viewport (bbox) and per layer, never as one "whole transport world":
 * static GTFS geometry is parsed once per feed and cached for hours, vehicle positions are cached for seconds.
 */
export type LineType = 'bus' | 'marshrutka' | 'trolleybus' | 'tram' | 'metro' | 'train' | 'suburban' | 'city_train' | 'funicular';
const LINE_TYPES = new Set<string>(['bus', 'marshrutka', 'trolleybus', 'tram', 'metro', 'train', 'suburban', 'city_train', 'funicular']);
export const isLineType = (value: string): value is LineType => LINE_TYPES.has(value);

export interface NetworkStop { id: string; name: string; lon: number; lat: number; types: LineType[]; routes: string[] }
export interface NetworkRoute { id: string; name: string; type: LineType; direction: string; directionId?: string; geometrySource?: 'gtfs_shape' | 'stop_sequence' | 'provider_geojson'; stopCount: number; coordinates: Array<[number, number]> }
export interface TransportNetwork { stops: NetworkStop[]; routes: NetworkRoute[]; bbox: Bbox | null }
export const networkSchema = z.object({
  stops: z.array(z.object({ id: z.string(), name: z.string(), lon: z.number().finite().min(-180).max(180), lat: z.number().finite().min(-90).max(90), types: z.array(z.enum(['bus', 'marshrutka', 'trolleybus', 'tram', 'metro', 'train', 'suburban', 'city_train', 'funicular'])), routes: z.array(z.string()) })),
  routes: z.array(z.object({
    id: z.string(), name: z.string(), type: z.enum(['bus', 'marshrutka', 'trolleybus', 'tram', 'metro', 'train', 'suburban', 'city_train', 'funicular']),
    direction: z.string(), directionId: z.string().optional(), geometrySource: z.enum(['gtfs_shape', 'stop_sequence', 'provider_geojson']).optional(),
    stopCount: z.number().int().nonnegative(), coordinates: z.array(z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)])).min(2).max(250_000),
  })),
  bbox: z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90), z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]).nullable(),
});
export const NETWORK_CACHE_SCHEMA_VERSION = 2;
export const GEOJSON_NETWORK_NORMALIZER_VERSION = 2;

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
    const routeName = `${route.route_short_name ?? ''} ${route.route_long_name ?? ''} ${route.route_desc ?? ''}`;
    const type = asLineType(routeTypeLabel(Number(route.route_type), routeName));
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
    if (coordinates.length >= 2) routes.push({ id: key, name: info.name, type: info.type, directionId: meta.direction,
      geometrySource: shape && shape.length >= 2 ? 'gtfs_shape' : 'stop_sequence',
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
const WANTED = /(^|\/)(stops|routes|trips|stop_times|shapes)\.txt$/;

/** Normalize an official Kyiv GeoJSON route/station feed into the same network shape as GTFS. */
export function buildGeoJsonNetwork(body: unknown, mode: LineType): TransportNetwork {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { features?: unknown }).features)) throw new Error('Invalid GeoJSON FeatureCollection');
  const features = (body as { features: unknown[] }).features;
  const groups = new Map<string, { name: string; direction: string; order: number; coordinates: Array<[number, number]>; from?: string; to?: string }[]>();
  const stops: NetworkStop[] = [];
  const points: Array<[number, number]> = [];
  for (const [featureIndex, raw] of features.entries()) {
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
    const lineParts = geometry?.type === 'LineString' && Array.isArray(geometry.coordinates)
      ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString' && Array.isArray(geometry.coordinates)
        ? geometry.coordinates.filter(Array.isArray)
        : [];
    if (lineParts.length === 0) continue;
    const name = String(props.num_route ?? props.route_short_name ?? props.route_name ?? props.route ?? props.line ?? props.name ?? '').trim();
    if (!name) continue;
    const direction = String(props.napryamok ?? props.direction ?? props.to_stop_ ?? '').trim();
    const featureId = String((feature as { id?: unknown }).id ?? props.objectid ?? props.globalid ?? `feature-${featureIndex}`);
    lineParts.forEach((part, partIndex) => {
      const coordinates = part.flatMap((point): Array<[number, number]> => {
        if (!Array.isArray(point) || point.length < 2) return [];
        const lon = Number(point[0]), lat = Number(point[1]);
        return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 && (lon !== 0 || lat !== 0) ? [[lon, lat]] : [];
      });
      if (coordinates.length < 2) return;
      // A MultiLineString may contain disjoint alternatives. Keep each path separate
      // instead of flattening it into a false straight connector on the map.
      const pathSuffix = lineParts.length > 1 ? `|${featureId}:${partIndex}` : '';
      const key = `${name}|${direction}${pathSuffix}`;
      const list = groups.get(key) ?? [];
      list.push({ name, direction, order: Number(props.order_ ?? props.sequence ?? 0), coordinates,
        ...(props.from_stop_ ? { from: String(props.from_stop_) } : {}), ...(props.to_stop_ ? { to: String(props.to_stop_) } : {}) });
      groups.set(key, list);
    });
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
    routes.push({ id: key, name: first.name, type: mode, geometrySource: 'provider_geojson', direction: first.from && last.to ? `${first.from} → ${last.to}` : first.direction,
      stopCount: segments.length + 1, coordinates: decimate(coordinates, 240) });
  }
  return { stops, routes, bbox: points.length ? bboxOf(points) ?? null : routes.length ? bboxOf(routes.flatMap((route) => route.coordinates)) ?? null : null };
}

/** Static networks use shared L2 only when a source sync version is known; unknown versions get a short process-local cache. */
export function cachedNetwork(providerId: string, url: string, sourceVersion?: string | null): Promise<TransportNetwork> {
  const version = sourceVersion?.trim() || null;
  return smartCache.getOrLoad('gtfs_network', { providerId, url, sourceVersion: version, schemaVersion: NETWORK_CACHE_SCHEMA_VERSION }, networkSchema, {
    ttlMs: NETWORK_TTL_MS,
    l1TtlMs: version ? 10 * 60_000 : 60_000,
    maxL2Bytes: 8 * 1024 * 1024,
    shared: Boolean(version),
  }, async () => {
    const { data } = await fetchBinary(url, 60 * 1024 * 1024);
    const unzipped = unzipSync(data, { filter: (file) => WANTED.test(file.name) && file.originalSize < 200 * 1024 * 1024 });
    const files: Record<string, string> = {};
    for (const [name, content] of Object.entries(unzipped)) files[name.split('/').pop() as string] = strFromU8(content);
    return buildNetwork(files);
  });
}

export function cachedGeoJsonNetwork(providerId: string, url: string, mode: LineType, sourceVersion?: string | null): Promise<TransportNetwork> {
  const version = sourceVersion?.trim() || null;
  return smartCache.getOrLoad('gtfs_network', { providerId, url, mode, sourceVersion: version, schemaVersion: NETWORK_CACHE_SCHEMA_VERSION, geoJsonNormalizerVersion: GEOJSON_NETWORK_NORMALIZER_VERSION }, networkSchema, {
    ttlMs: NETWORK_TTL_MS,
    l1TtlMs: version ? 10 * 60_000 : 60_000,
    maxL2Bytes: 8 * 1024 * 1024,
    shared: Boolean(version),
  }, async () => {
    const { data } = await fetchJson(url, 15000);
    return buildGeoJsonNetwork(data, mode);
  });
}

export function geoJsonMode(name: string): LineType | null {
  const normalized = name.normalize('NFKC').toLocaleLowerCase('uk').replace(/\s+/g, ' ').trim();
  const explicitMarshrutka = /(?:^|[^а-яіїєґa-z0-9])(?:route[\s_-]?taxi|minibus|маршрут(?:ка|ки|ку|ці|ок)|маршрутне\s+таксі|маршрутні\s+таксі)(?:$|[^а-яіїєґa-z0-9])/u;
  if (explicitMarshrutka.test(normalized)) return 'marshrutka';
  if (normalized.includes('метро') || normalized.includes('underground')) return 'metro';
  if (normalized.includes('фунікулер') || normalized.includes('funicular')) return 'funicular';
  if (normalized.includes('електричк') || normalized.includes('city express') || normalized.includes('кільцев')) return 'city_train';
  return null;
}

export function inBbox(bbox: Bbox, lon: number, lat: number): boolean { return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]; }
export function intersects(a: Bbox, b: Bbox): boolean { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }

/** A feed's route is drawn when any of its points is inside the viewport (keeps payloads small without clipping lines). */
export function routeInBbox(route: NetworkRoute, bbox: Bbox): boolean { return route.coordinates.some(([lon, lat]) => inBbox(bbox, lon, lat)); }

/** Return only the actual direction shapes for one exact raw GTFS route ID. */
export function networkRoutesForRoute(network: TransportNetwork, routeId: string, geometrySource?: NetworkRoute['geometrySource']): NetworkRoute[] {
  const prefix = `${routeId}|`;
  return network.routes.filter((route) => route.id.startsWith(prefix) && (!geometrySource || route.geometrySource === geometrySource));
}

export interface LiveVehicle {
  id: string; lon: number; lat: number; type: LineType | 'other'; route: string;
  bearing: number | null; speed: number | null; timestamp: Date | null; providerId: string;
  /** Present only for GTFS-Realtime VehiclePositions with an identified scheduled trip. */
  tripId?: string; routeId?: string; startDate?: string; currentStopSequence?: number; currentStopId?: string;
}

export function parseVehicleTimestamp(value: unknown): Date | null {
  return parseMobilityTimestamp(value);
}

/** Convert JSON feed records into live-map vehicles, retaining route identity only when it is confirmed. */
export function parseJsonVehicles(
  providerId: string,
  body: unknown,
  routeNames: ReadonlyMap<string, { name: string; type: LineType }>,
): LiveVehicle[] {
  const out: LiveVehicle[] = [];
  for (const vehicle of extractVehicleList(body)) {
    const lat = Number(vehicle.latitude ?? vehicle.lat), lon = Number(vehicle.longitude ?? vehicle.lon ?? vehicle.lng);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    const route = matchJsonVehicleRoute(vehicle, routeNames);
    const bearing = Number(vehicle.bearing ?? vehicle.course ?? vehicle.azimuth);
    const speed = Number(vehicle.speed ?? vehicle.speed_mps);
    out.push({ id: `${providerId}:${String(vehicle.vehicle_id ?? vehicle.id ?? vehicle.license_plate ?? `${lat},${lon}`)}`, lon, lat,
      type: asLineType(route.type) ?? 'other', route: route.route, ...(route.routeId ? { routeId: route.routeId } : {}),
      bearing: Number.isFinite(bearing) ? bearing : null, speed: Number.isFinite(speed) && speed >= 0 ? speed : null,
      timestamp: parseVehicleTimestamp(vehicle.timestamp ?? vehicle.updated_at ?? vehicle.last_update ?? vehicle.time), providerId });
  }
  return out;
}

export function isFreshVehicleTimestamp(timestamp: Date | null, now = Date.now()): boolean {
  return isFreshMobilityTimestamp(timestamp, now);
}

/** A vehicle whose route is absent from every loaded static feed cannot be classified; clients may ask for that bucket explicitly. */
export type RequestedVehicleType = LineType | 'other';
export const isRequestedVehicleType = (value: string): value is RequestedVehicleType => value === 'other' || isLineType(value);

/** Fresh positions inside the viewport, split by the requested categories. `unclassified` keeps hidden supply visible in the response. */
export function selectFreshVehicles(received: LiveVehicle[], box: Bbox, types: readonly RequestedVehicleType[]): { vehicles: LiveVehicle[]; stale: number; unclassified: number } {
  const fresh = received.filter((vehicle) => isFreshVehicleTimestamp(vehicle.timestamp));
  const visible = fresh.filter((vehicle) => inBbox(box, vehicle.lon, vehicle.lat));
  const unclassified = visible.filter((vehicle) => vehicle.type === 'other').length;
  return { vehicles: visible.filter((vehicle) => types.includes(vehicle.type)), stale: received.length - fresh.length, unclassified };
}

/**
 * ТЗ-MG-TRANSPORT-12 requires every served feature to say how its data was obtained.
 * LIVE is a provider-stamped position inside the freshness window, STALE is one that aged out,
 * ESTIMATED has no stamp to verify, SCHEDULED is static feed geometry, UNKNOWN labels nothing.
 */
export type DataQuality = 'LIVE' | 'SCHEDULED' | 'ESTIMATED' | 'STALE' | 'UNKNOWN';
const QUALITY_SEVERITY: readonly DataQuality[] = ['STALE', 'UNKNOWN', 'ESTIMATED', 'SCHEDULED', 'LIVE'];

export type QualityEntry = { level: DataQuality; ageMs: number | null };

export function vehicleDataQuality(timestamp: Date | null, now = Date.now()): QualityEntry {
  if (!timestamp) return { level: 'ESTIMATED', ageMs: null };
  const ageMs = Math.max(0, now - timestamp.getTime());
  return { level: isFreshVehicleTimestamp(timestamp, now) ? 'LIVE' : 'STALE', ageMs };
}

/** The response is only as fresh as its least fresh marker, but the counts keep the mix visible. */
export function aggregateDataQuality(entries: readonly QualityEntry[]): {
  level: DataQuality; counts: Partial<Record<DataQuality, number>>; oldestAgeMs: number | null; newestAgeMs: number | null; freshnessWindowMs: number;
} {
  const counts: Partial<Record<DataQuality, number>> = {};
  for (const entry of entries) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
  const ages = entries.map((entry) => entry.ageMs).filter((age): age is number => age !== null);
  return {
    level: QUALITY_SEVERITY.find((level) => (counts[level] ?? 0) > 0) ?? 'UNKNOWN',
    counts,
    oldestAgeMs: ages.length > 0 ? Math.max(...ages) : null,
    newestAgeMs: ages.length > 0 ? Math.min(...ages) : null,
    freshnessWindowMs: LIVE_MOBILITY_MAX_AGE_MS,
  };
}

/** Route lines and stop positions come from static feeds, so they must never be presented as live data. */
export function scheduledDataQuality(featureCount: number) {
  return aggregateDataQuality(Array.from({ length: featureCount }, () => ({ level: 'SCHEDULED' as const, ageMs: null })));
}

const VEHICLE_TTL_MS = 10_000;
const vehicleCache = new Map<string, { at: number; promise: Promise<LiveVehicle[]> }>();
const { transit_realtime } = bindings;

/** Decode GTFS-RT positions without treating protobuf's default numeric value as a reported stop sequence. */
export function parseGtfsRealtimeVehicles(
  providerId: string,
  data: Uint8Array,
  routeNames: Map<string, { name: string; type: LineType }> = new Map(),
): LiveVehicle[] {
  const message = transit_realtime.FeedMessage.decode(data);
  const out: LiveVehicle[] = [];
  for (const entity of message.entity) {
    const vehiclePosition = entity.vehicle;
    const position = vehiclePosition?.position;
    if (!vehiclePosition || !position || !Number.isFinite(position.latitude) || !Number.isFinite(position.longitude)) continue;
    if (Math.abs(position.latitude) > 90 || Math.abs(position.longitude) > 180 || (position.latitude === 0 && position.longitude === 0)) continue;
    const routeId = vehiclePosition.trip?.routeId ?? '';
    const tripId = vehiclePosition.trip?.tripId?.trim();
    const startDate = vehiclePosition.trip?.startDate;
    const hasCurrentStopSequence = Object.prototype.hasOwnProperty.call(vehiclePosition, 'currentStopSequence');
    const currentStopSequence = hasCurrentStopSequence ? Number(vehiclePosition.currentStopSequence) : Number.NaN;
    const currentStopId = vehiclePosition.stopId?.trim();
    const known = routeNames.get(routeId);
    const speed = Number(position.speed);
    out.push({ id: `${providerId}:${entity.id}`, lon: position.longitude, lat: position.latitude, type: known?.type ?? 'other', route: known?.name ?? routeId,
      bearing: Number.isFinite(position.bearing) ? Number(position.bearing) : null, speed: Number.isFinite(speed) && speed >= 0 ? speed : null,
      timestamp: parseVehicleTimestamp(vehiclePosition.timestamp), providerId,
      ...(tripId ? { tripId } : {}), ...(routeId ? { routeId } : {}), ...(startDate && /^\d{8}$/.test(startDate) ? { startDate } : {}),
      ...(hasCurrentStopSequence && Number.isInteger(currentStopSequence) && currentStopSequence >= 0 ? { currentStopSequence } : {}),
      ...(currentStopId ? { currentStopId } : {}) });
  }
  return out;
}

async function loadVehicles(providerId: string, sourceType: string, url: string, routeNames: Map<string, { name: string; type: LineType }>): Promise<LiveVehicle[]> {
  if (sourceType === 'gtfs_rt') {
    const { data } = await fetchBinary(url, 10 * 1024 * 1024);
    return parseGtfsRealtimeVehicles(providerId, data, routeNames);
  }
  const body = (await fetchJson(url, 12000)).data;
  return parseJsonVehicles(providerId, body, routeNames);
}

/** Positions are shared between users for ten seconds so a busy map never multiplies requests to city feeds. */
export function cachedVehicles(
  providerId: string, sourceType: string, url: string,
  routeNames: Map<string, { name: string; type: LineType }>,
): Promise<LiveVehicle[]> {
  const hit = vehicleCache.get(providerId);
  if (hit && Date.now() - hit.at < VEHICLE_TTL_MS) return hit.promise;
  const promise = loadVehicles(providerId, sourceType, url, routeNames);
  vehicleCache.set(providerId, { at: Date.now(), promise });
  promise.catch(() => vehicleCache.delete(providerId));
  return promise;
}

/**
 * A vehicle's category comes from the static feed's route table, so the live-map endpoint needs a `route_id → {name, type}` map.
 * Building it from full cached networks means `JSON.parse` of every route geometry in the viewport, which measured 12.9 s for one Lviv
 * poll. This index keeps only what classification needs and is therefore safe to hold in the shared cache.
 */
export type RouteTypeEntry = [string, string, LineType];
export const routeTypeEntriesSchema = z.array(z.tuple([z.string(), z.string(), z.enum(['bus', 'marshrutka', 'trolleybus', 'tram', 'metro', 'train', 'suburban', 'city_train', 'funicular'])])) as unknown as z.ZodType<RouteTypeEntry[]>;

export function buildRouteTypeEntries(routesText: string | undefined): RouteTypeEntry[] {
  const out: RouteTypeEntry[] = [];
  for (const route of rows(routesText)) {
    const type = asLineType(routeTypeLabel(Number(route.route_type), `${route.route_short_name ?? ''} ${route.route_long_name ?? ''} ${route.route_desc ?? ''}`));
    if (!type || !route.route_id) continue;
    out.push([route.route_id, (route.route_short_name || route.route_long_name || route.route_id).trim(), type]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

const ROUTES_ONLY = /(^|\/)routes\.txt$/;

async function loadGtfsRouteTypes(url: string): Promise<RouteTypeEntry[]> {
  const { data } = await fetchBinary(url, 60 * 1024 * 1024);
  const unzipped = unzipSync(data, { filter: (file) => ROUTES_ONLY.test(file.name) && file.originalSize < 64 * 1024 * 1024 });
  const entry = Object.entries(unzipped).find(([name]) => ROUTES_ONLY.test(name));
  return buildRouteTypeEntries(entry ? strFromU8(entry[1]) : undefined);
}

export function cachedGtfsRouteTypes(providerId: string, url: string, sourceVersion?: string | null): Promise<RouteTypeEntry[]> {
  const version = sourceVersion?.trim() || null;
  const parameters = { kind: 'route_types', providerId, url, sourceVersion: version, schemaVersion: NETWORK_CACHE_SCHEMA_VERSION };
  return smartCache.getOrLoad('gtfs_network', parameters, routeTypeEntriesSchema, {
    ttlMs: NETWORK_TTL_MS,
    // A provider with no source version keeps the index in L1 only, so L1 has to outlive one background refresh interval —
    // otherwise the next live-map poll pays for the whole zip download again, inside the request.
    l1TtlMs: 20 * 60_000,
    // Route names and categories age slowly, so an expired index still classifies a vehicle better than making the map wait
    // (or dropping the vehicle as unclassified). The stale copy is served while a background pass refetches it.
    staleTtlMs: 24 * 60 * 60_000,
    maxL2Bytes: 4 * 1024 * 1024,
    shared: Boolean(version),
  }, () => loadGtfsRouteTypes(url));
}

/** Cache key a caller can use to evict an index after its feed is re-synced. */
export function gtfsRouteTypesCacheKey(providerId: string, url: string, sourceVersion?: string | null): string {
  return cacheKey('gtfs_network', { kind: 'route_types', providerId, url, sourceVersion: sourceVersion?.trim() || null, schemaVersion: NETWORK_CACHE_SCHEMA_VERSION });
}

/** Later entries win, so callers pass national feeds first and municipal feeds last. */
export function mergeRouteTypeEntries(all: readonly RouteTypeEntry[][]): Map<string, { name: string; type: LineType }> {
  const merged = new Map<string, { name: string; type: LineType }>();
  for (const entries of all) for (const [id, name, type] of entries) merged.set(id, { name, type });
  return merged;
}

/**
 * A layer response must name the failing provider and say why, but the provider's feed URL can carry an API key,
 * so the raw error text never reaches the client.
 */
export function providerFailureReason(error: unknown): string {
  if (error instanceof UnsafeUrlError) return 'feed_url_rejected';
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/abort|timeout|timed out|etimedout/.test(message)) return 'timeout';
  if (/\b429\b|rate limit|too many requests/.test(message)) return 'rate_limited';
  if (/unauthor|forbidden|\b40[13]\b/.test(message)) return 'access_denied';
  if (/not found|\b404\b/.test(message)) return 'not_found';
  if (/too large/.test(message)) return 'feed_too_large';
  if (/\b5\d\d\b|server error|unavailable/.test(message)) return 'provider_unavailable';
  if (/unknown geojson transport mode/.test(message)) return 'unsupported_feed';
  if (/decode|protobuf|invalid|unexpected|out of range/.test(message)) return 'invalid_data';
  if (/incomplete|terminated|other side closed|socket hang up/.test(message)) return 'truncated_response';
  if (/enotfound|econnrefused|socket|network|fetch failed/.test(message)) return 'network_error';
  return 'error';
}

/** Error texts can interpolate the requested URL, which may carry a key, so they are never logged verbatim. */
export const redactFeedUrls = (text: string): string => text.replace(/https?:\/\/\S+/g, '[feed-url]');

export interface LayerOutcome {
  layer: string;
  ok: boolean;
  reason?: string;
  row: { id: string; name: string; source_type: string };
}

export function layerFailures(outcomes: readonly LayerOutcome[]): Array<{ id: string; name: string; sourceType: string; layer: string; reason: string }> {
  return outcomes
    .filter((item) => !item.ok)
    // Reasons are classified upstream, but an unclassified one can still carry the requested URL, so redact again at the boundary.
    .map((item) => ({ id: item.row.id, name: item.row.name.split(' — ')[0], sourceType: item.row.source_type, layer: item.layer, reason: redactFeedUrls(item.reason ?? 'error') }));
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
