import { bboxOf, type ConnectionReport, type MobilityAsset, type MobilityAssetType, type MobilityStation } from './types';
import { fetchJson } from './safeFetch';
import { gbfsTimestamp, normalizeGeofencingZones, type GbfsGeofence, type GbfsGeofenceRule } from './gbfsGeofences';
import { UKRAINE_BOUNDARY } from './ukraineBoundary';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const validPoint = (lon: unknown, lat: unknown): lon is number => typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;

type LonLat = readonly [number, number];

function pointOnRingEdge([longitude, latitude]: LonLat, ring: readonly LonLat[]): boolean {
  for (let index = 0; index < ring.length; index++) {
    const [x1, y1] = ring[index]!;
    const [x2, y2] = ring[(index + 1) % ring.length]!;
    const cross = (longitude - x1) * (y2 - y1) - (latitude - y1) * (x2 - x1);
    const scale = Math.max(1, Math.abs(x1), Math.abs(x2), Math.abs(y1), Math.abs(y2));
    if (Math.abs(cross) <= Number.EPSILON * 16 * scale
      && longitude >= Math.min(x1, x2) - 1e-10 && longitude <= Math.max(x1, x2) + 1e-10
      && latitude >= Math.min(y1, y2) - 1e-10 && latitude <= Math.max(y1, y2) + 1e-10) return true;
  }
  return false;
}

function pointInRing(point: LonLat, ring: readonly LonLat[]): boolean {
  if (pointOnRingEdge(point, ring)) return true;
  const [longitude, latitude] = point;
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [currentLongitude, currentLatitude] = ring[index]!;
    const [previousLongitude, previousLatitude] = ring[previous]!;
    const crossesLatitude = (currentLatitude > latitude) !== (previousLatitude > latitude);
    if (crossesLatitude && longitude < (previousLongitude - currentLongitude) * (latitude - currentLatitude)
      / (previousLatitude - currentLatitude) + currentLongitude) inside = !inside;
  }
  return inside;
}

/** Point-in-polygon against the bundled Natural Earth 1:10m Ukraine-view boundary. */
export function pointIsInsideUkraine([longitude, latitude]: [number, number]): boolean {
  // Reject impossible points cheaply before evaluating the detailed multipolygon.
  if (longitude < 22.1 || longitude > 40.2 || latitude < 44.3 || latitude > 52.4) return false;
  return UKRAINE_BOUNDARY.coordinates.some((polygon) => {
    const [outerRing, ...holes] = polygon;
    if (!outerRing || !pointInRing([longitude, latitude], outerRing)) return false;
    return !holes.some((hole) => pointInRing([longitude, latitude], hole));
  });
}

/** Reject a Ukrainian feed's polygon layer when none of its vertices fall inside the Ukraine boundary. */
export function geometryHasUkrainePoint(coordinates: unknown): boolean {
  if (!Array.isArray(coordinates)) return false;
  if (coordinates.length >= 2 && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    return pointIsInsideUkraine([coordinates[0], coordinates[1]]);
  }
  return coordinates.some(geometryHasUkrainePoint);
}

/** GBFS 2.x nests feeds per language ({data:{en:{feeds}}}); 3.x has {data:{feeds}}. */
export function discoverFeeds(discovery: unknown): Map<string, string> {
  const feeds = new Map<string, string>();
  if (!isObject(discovery) || !isObject(discovery.data)) return feeds;
  const data = discovery.data;
  const lists: unknown[] = Array.isArray(data.feeds) ? [data.feeds] : Object.values(data).filter(isObject).map((lang) => lang.feeds);
  for (const list of lists) if (Array.isArray(list)) for (const feed of list) if (isObject(feed) && typeof feed.name === 'string' && typeof feed.url === 'string' && !feeds.has(feed.name)) feeds.set(feed.name, feed.url);
  return feeds;
}

/** Maps a GBFS vehicle type ("form_factor" + "propulsion_type") onto the MARSHGO asset type. */
export function assetTypeFor(formFactor: unknown, propulsion: unknown): MobilityAssetType | null {
  const electric = typeof propulsion === 'string' && /electric/.test(propulsion);
  switch (formFactor) {
    case 'bicycle': return electric ? 'EBIKE' : 'BIKE';
    case 'scooter': case 'scooter_standing': case 'scooter_seated': return typeof formFactor === 'string' && formFactor === 'scooter_seated' ? 'MOPED' : 'SCOOTER';
    case 'moped': return 'MOPED';
    case 'car': return 'CARSHARING';
    default: return null;
  }
}

export function normalizeVehicles(providerId: string, vehicleTypes: unknown, status: unknown, expectedCountry?: string): { assets: MobilityAsset[]; rejected: number } {
  const typeById = new Map<string, MobilityAssetType>();
  const typeList = isObject(vehicleTypes) && isObject(vehicleTypes.data) && Array.isArray(vehicleTypes.data.vehicle_types) ? vehicleTypes.data.vehicle_types : [];
  for (const type of typeList) if (isObject(type) && typeof type.vehicle_type_id === 'string') { const mapped = assetTypeFor(type.form_factor, type.propulsion_type); if (mapped) typeById.set(type.vehicle_type_id, mapped); }
  const data = isObject(status) && isObject(status.data) ? status.data : {};
  const list = Array.isArray(data.vehicles) ? data.vehicles : Array.isArray(data.bikes) ? data.bikes : [];
  const assets: MobilityAsset[] = []; let rejected = 0;
  for (const item of list) {
    if (!isObject(item)) { rejected++; continue; }
    const id = typeof item.vehicle_id === 'string' ? item.vehicle_id : typeof item.bike_id === 'string' ? item.bike_id : null;
    const typeId = typeof item.vehicle_type_id === 'string' ? item.vehicle_type_id : undefined;
    const type = (typeId && typeById.get(typeId)) || (item.is_reserved === undefined && !typeId ? 'BIKE' : null);
    const lon = item.lon, lat = item.lat;
    if (!id || !type || !validPoint(lon, lat)
      || (expectedCountry === 'UA' && !pointIsInsideUkraine([lon as number, lat as number]))) { rejected++; continue; }
    const asset: MobilityAsset = { id, providerId, type, location: [lon, lat as number], available: item.is_reserved !== true && item.is_disabled !== true };
    if (typeof item.current_fuel_percent === 'number' && Number.isFinite(item.current_fuel_percent) && item.current_fuel_percent >= 0 && item.current_fuel_percent <= 100) asset.batteryPercent = item.current_fuel_percent;
    if (typeof item.current_range_meters === 'number') asset.rangeMeters = item.current_range_meters;
    if (typeof item.station_id === 'string') asset.stationId = item.station_id;
    if (typeId) asset.vehicleTypeId = typeId;
    if (typeof item.pricing_plan_id === 'string') asset.pricingPlanId = item.pricing_plan_id;
    const rawRentalUris = item.rental_uris;
    if (isObject(rawRentalUris)) {
      const allowedHosts = providerId === 'zelectra' ? new Set(['zelectra.app.link', 'zelectra.rideatom.com']) : new Set<string>();
      const uris = Object.fromEntries(['android','ios','web'].flatMap((key) => {
        const raw = rawRentalUris[key];
        if (typeof raw !== 'string') return [];
        try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password && allowedHosts.has(url.hostname) ? [[key, url.toString()]] : []; }
        catch { return []; }
      }));
      if (Object.keys(uris).length) asset.rentalUris = uris as MobilityAsset['rentalUris'];
    }
    const updatedAt = gbfsTimestamp(status);
    if (updatedAt !== null) asset.lastUpdated = new Date(updatedAt).toISOString();
    assets.push(asset);
  }
  return { assets, rejected };
}

export function normalizeStations(providerId: string, info: unknown, status: unknown, expectedCountry?: string): { stations: MobilityStation[]; rejected: number } {
  const infoList = isObject(info) && isObject(info.data) && Array.isArray(info.data.stations) ? info.data.stations : [];
  const statusList = isObject(status) && isObject(status.data) && Array.isArray(status.data.stations) ? status.data.stations : [];
  const statusById = new Map<string, Json>();
  for (const item of statusList) if (isObject(item) && typeof item.station_id === 'string') statusById.set(item.station_id, item);
  const stations: MobilityStation[] = []; let rejected = 0;
  for (const item of infoList) {
    if (!isObject(item) || typeof item.station_id !== 'string' || !validPoint(item.lon, item.lat)
      || (expectedCountry === 'UA' && !pointIsInsideUkraine([item.lon as number, item.lat as number]))) { rejected++; continue; }
    const live = statusById.get(item.station_id);
    const rawName = isObject(item) ? item.name : undefined;
    const name = typeof rawName === 'string' ? rawName : Array.isArray(rawName) && isObject(rawName[0]) && typeof rawName[0].text === 'string' ? rawName[0].text : item.station_id;
    const station: MobilityStation = { id: item.station_id, providerId, name, location: [item.lon as number, item.lat as number] };
    const updatedAt = gbfsTimestamp(status);
    if (updatedAt !== null) station.sourceUpdatedAt = new Date(updatedAt).toISOString();
    if (typeof item.capacity === 'number') station.capacity = item.capacity;
    if (live && typeof live.num_bikes_available === 'number') station.availableAssets = live.num_bikes_available;
    if (live && typeof live.is_returning === 'boolean') station.returnAllowed = live.is_returning;
    stations.push(station);
  }
  return { stations, rejected };
}

/** Full connection test: discovery → feeds present → payload validation → freshness → coordinate sanity. */
export async function testGbfsConnection(providerId: string, discoveryUrl: string, expectedCountry?: string): Promise<ConnectionReport> {
  const checks: ConnectionReport['checks'] = [];
  const counts: Record<string, number> = {};
  const started = Date.now();
  const fail = (error: string): ConnectionReport => ({ health: 'offline', checks, counts, responseMs: Date.now() - started, error });
  let discovery: unknown;
  try { discovery = (await fetchJson(discoveryUrl)).data; checks.push({ name: 'Feed accessible', ok: true }); }
  catch (error) { checks.push({ name: 'Feed accessible', ok: false, detail: error instanceof Error ? error.message : 'unknown' }); return fail('Discovery feed is unreachable'); }
  const feeds = discoverFeeds(discovery);
  checks.push({ name: 'Valid GBFS discovery', ok: feeds.size > 0, detail: `${feeds.size} feeds` });
  if (feeds.size === 0) return fail('Not a valid GBFS discovery document');
  counts.feeds = feeds.size;
  const load = async (name: string) => { const url = feeds.get(name); if (!url) return null; try { return (await fetchJson(url)).data; } catch { return undefined; } };
  const [vehicleTypes, vehicleStatus, freeBikes, stationInfo, stationStatus] = await Promise.all([load('vehicle_types'), load('vehicle_status'), load('free_bike_status'), load('station_information'), load('station_status')]);
  const statusFeed = vehicleStatus ?? freeBikes;
  let rejected = 0;
  const points: Array<[number, number]> = [];
  if (statusFeed) { const { assets, rejected: bad } = normalizeVehicles(providerId, vehicleTypes ?? undefined, statusFeed, expectedCountry); counts.vehicles = assets.length; rejected += bad; for (const asset of assets) points.push(asset.location); checks.push({ name: 'Vehicles', ok: assets.length > 0, detail: `${assets.length} valid, ${bad} rejected` }); }
  if (stationInfo) { const { stations, rejected: bad } = normalizeStations(providerId, stationInfo, stationStatus ?? undefined, expectedCountry); counts.stations = stations.length; rejected += bad; for (const station of stations) points.push(station.location); checks.push({ name: 'Stations', ok: stations.length > 0 || (counts.vehicles ?? 0) > 0, detail: `${stations.length} valid, ${bad} rejected` }); }
  if (!statusFeed && !stationInfo) { checks.push({ name: 'Vehicle or station data', ok: false }); return fail('No vehicle or station feed'); }
  if (expectedCountry === 'UA') {
    const localPoints = points.filter(pointIsInsideUkraine).length;
    counts.pointsInDeclaredCountry = localPoints;
    const coverageOk = localPoints > 0;
    checks.push({ name: 'Declared Ukrainian coverage', ok: coverageOk, detail: `${localPoints}/${points.length} valid points fall inside Ukraine` });
    if (points.length > 0 && !coverageOk) return fail('Live GBFS coordinates do not match the provider’s declared Ukrainian coverage');
  }
  const freshnessSource = [statusFeed, stationStatus].find(isObject);
  const rawUpdated = isObject(freshnessSource) ? freshnessSource.last_updated : undefined;
  const updated = typeof rawUpdated === 'number' ? rawUpdated : typeof rawUpdated === 'string' && Number.isFinite(Date.parse(rawUpdated)) ? Date.parse(rawUpdated) / 1000 : null;
  const ageSeconds = updated === null ? null : Math.round(Date.now() / 1000 - (updated > 1e12 ? updated / 1000 : updated));
  if (ageSeconds !== null) { counts.ageSeconds = ageSeconds; checks.push({ name: 'Freshness', ok: ageSeconds < 600, detail: `${ageSeconds}s old` }); }
  const allOk = checks.every((check) => check.ok);
  const coveragePoints = expectedCountry === 'UA' ? points.filter(pointIsInsideUkraine) : points;
  return { health: allOk && rejected === 0 ? 'healthy' : 'degraded', checks, counts, responseMs: Date.now() - started, ...(bboxOf(coveragePoints) ? { bbox: bboxOf(coveragePoints) } : {}) };
}

export interface GbfsSnapshot {
  assets: MobilityAsset[];
  stations: MobilityStation[];
  geofences?: GbfsGeofence[];
  globalRules?: GbfsGeofenceRule[];
  pricingPlans?: Record<string, { planId: string; name: string | null; currency: string | null; price: number | null; perMinutePricing: Array<{ start: number; rate: number; interval: number }> }>;
  fetchedAt: number;
  lastUpdated?: number | null;
  ttlSeconds?: number | null;
  staleAfterSeconds?: number;
}

function normalizePricingPlans(payload: unknown): NonNullable<GbfsSnapshot['pricingPlans']> {
  const data = isObject(payload) && isObject(payload.data) ? payload.data : {};
  const plans = Array.isArray(data.plans) ? data.plans : Array.isArray(data.system_pricing_plans) ? data.system_pricing_plans : [];
  const result: NonNullable<GbfsSnapshot['pricingPlans']> = {};
  for (const raw of plans) {
    if (!isObject(raw) || typeof raw.plan_id !== 'string' || !raw.plan_id) continue;
    const name = Array.isArray(raw.name) && isObject(raw.name[0]) && typeof raw.name[0].text === 'string' ? raw.name[0].text : null;
    const perMinutePricing = Array.isArray(raw.per_min_pricing) ? raw.per_min_pricing.flatMap((rule) => isObject(rule)
      && typeof rule.start === 'number' && typeof rule.rate === 'number' && typeof rule.interval === 'number'
      && rule.start >= 0 && rule.rate >= 0 && rule.interval > 0 ? [{ start: rule.start, rate: rule.rate, interval: rule.interval }] : []) : [];
    result[raw.plan_id] = {
      planId: raw.plan_id, name, currency: typeof raw.currency === 'string' ? raw.currency : null,
      price: typeof raw.price === 'number' && Number.isFinite(raw.price) && raw.price >= 0 ? raw.price : null,
      perMinutePricing,
    };
  }
  return result;
}

/** Loads the current vehicles and stations of a GBFS provider (used by the nearby-assets endpoint, cached by the caller). */
export async function loadGbfsSnapshot(providerId: string, discoveryUrl: string, expectedCountry?: string): Promise<GbfsSnapshot> {
  const feeds = discoverFeeds((await fetchJson(discoveryUrl)).data);
  const load = async (name: string) => { const url = feeds.get(name); if (!url) return undefined; try { return (await fetchJson(url)).data; } catch { return undefined; } };
  const [vehicleTypes, vehicleStatus, freeBikes, stationInfo, stationStatus, geofencing, pricingPlans] = await Promise.all([load('vehicle_types'), load('vehicle_status'), load('free_bike_status'), load('station_information'), load('station_status'), load('geofencing_zones'), load('system_pricing_plans')]);
  const statusFeed = vehicleStatus ?? freeBikes;
  const zones = normalizeGeofencingZones(geofencing);
  const dynamicFeeds = [statusFeed, stationStatus, geofencing].filter(isObject);
  const ttlValues = dynamicFeeds.flatMap((feed) => typeof feed.ttl === 'number' && Number.isFinite(feed.ttl) && feed.ttl >= 0 ? [feed.ttl] : []);
  const ttlSeconds = ttlValues.length ? Math.min(...ttlValues) : null;
  const updatedValues = dynamicFeeds.map(gbfsTimestamp).filter((value): value is number => value !== null);
  const lastUpdated = updatedValues.length ? Math.min(...updatedValues) : null;
  const staleAfterSeconds = ttlSeconds === null ? 60 : Math.max(15, ttlSeconds === 0 ? 30 : ttlSeconds * 2);
  return {
    assets: statusFeed ? normalizeVehicles(providerId, vehicleTypes, statusFeed, expectedCountry).assets : [],
    stations: stationInfo ? normalizeStations(providerId, stationInfo, stationStatus, expectedCountry).stations : [],
    geofences: expectedCountry === 'UA' ? zones.geofences.filter((zone) => geometryHasUkrainePoint(zone.geometry.coordinates)) : zones.geofences,
    globalRules: zones.globalRules,
    pricingPlans: normalizePricingPlans(pricingPlans),
    fetchedAt: Date.now(), lastUpdated, ttlSeconds, staleAfterSeconds,
  };
}
