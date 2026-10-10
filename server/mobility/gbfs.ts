import { bboxOf, type ConnectionReport, type MobilityAsset, type MobilityAssetType, type MobilityStation } from './types';
import { fetchJson } from './safeFetch';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const validPoint = (lon: unknown, lat: unknown): lon is number => typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;

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

export function normalizeVehicles(providerId: string, vehicleTypes: unknown, status: unknown): { assets: MobilityAsset[]; rejected: number } {
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
    if (!id || !type || !validPoint(lon, lat)) { rejected++; continue; }
    const asset: MobilityAsset = { id, providerId, type, location: [lon, lat as number], available: item.is_reserved !== true && item.is_disabled !== true };
    if (typeof item.current_range_meters === 'number') asset.rangeMeters = item.current_range_meters;
    if (typeof item.station_id === 'string') asset.stationId = item.station_id;
    assets.push(asset);
  }
  return { assets, rejected };
}

export function normalizeStations(providerId: string, info: unknown, status: unknown): { stations: MobilityStation[]; rejected: number } {
  const infoList = isObject(info) && isObject(info.data) && Array.isArray(info.data.stations) ? info.data.stations : [];
  const statusList = isObject(status) && isObject(status.data) && Array.isArray(status.data.stations) ? status.data.stations : [];
  const statusById = new Map<string, Json>();
  for (const item of statusList) if (isObject(item) && typeof item.station_id === 'string') statusById.set(item.station_id, item);
  const stations: MobilityStation[] = []; let rejected = 0;
  for (const item of infoList) {
    if (!isObject(item) || typeof item.station_id !== 'string' || !validPoint(item.lon, item.lat)) { rejected++; continue; }
    const live = statusById.get(item.station_id);
    const rawName = isObject(item) ? item.name : undefined;
    const name = typeof rawName === 'string' ? rawName : Array.isArray(rawName) && isObject(rawName[0]) && typeof rawName[0].text === 'string' ? rawName[0].text : item.station_id;
    const station: MobilityStation = { id: item.station_id, providerId, name, location: [item.lon as number, item.lat as number] };
    if (typeof item.capacity === 'number') station.capacity = item.capacity;
    if (live && typeof live.num_bikes_available === 'number') station.availableAssets = live.num_bikes_available;
    if (live && typeof live.is_returning === 'boolean') station.returnAllowed = live.is_returning;
    stations.push(station);
  }
  return { stations, rejected };
}

/** Full connection test: discovery → feeds present → payload validation → freshness → coordinate sanity. */
export async function testGbfsConnection(providerId: string, discoveryUrl: string): Promise<ConnectionReport> {
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
  if (statusFeed) { const { assets, rejected: bad } = normalizeVehicles(providerId, vehicleTypes ?? undefined, statusFeed); counts.vehicles = assets.length; rejected += bad; for (const asset of assets) points.push(asset.location); checks.push({ name: 'Vehicles', ok: assets.length > 0, detail: `${assets.length} valid, ${bad} rejected` }); }
  if (stationInfo) { const { stations, rejected: bad } = normalizeStations(providerId, stationInfo, stationStatus ?? undefined); counts.stations = stations.length; rejected += bad; for (const station of stations) points.push(station.location); checks.push({ name: 'Stations', ok: stations.length > 0 || (counts.vehicles ?? 0) > 0, detail: `${stations.length} valid, ${bad} rejected` }); }
  if (!statusFeed && !stationInfo) { checks.push({ name: 'Vehicle or station data', ok: false }); return fail('No vehicle or station feed'); }
  const freshnessSource = [statusFeed, stationStatus].find(isObject);
  const rawUpdated = isObject(freshnessSource) ? freshnessSource.last_updated : undefined;
  const updated = typeof rawUpdated === 'number' ? rawUpdated : typeof rawUpdated === 'string' && Number.isFinite(Date.parse(rawUpdated)) ? Date.parse(rawUpdated) / 1000 : null;
  const ageSeconds = updated === null ? null : Math.round(Date.now() / 1000 - (updated > 1e12 ? updated / 1000 : updated));
  if (ageSeconds !== null) { counts.ageSeconds = ageSeconds; checks.push({ name: 'Freshness', ok: ageSeconds < 600, detail: `${ageSeconds}s old` }); }
  const allOk = checks.every((check) => check.ok);
  return { health: allOk && rejected === 0 ? 'healthy' : 'degraded', checks, counts, responseMs: Date.now() - started, ...(bboxOf(points) ? { bbox: bboxOf(points) } : {}) };
}

export interface GbfsSnapshot { assets: MobilityAsset[]; stations: MobilityStation[]; fetchedAt: number }

/** Loads the current vehicles and stations of a GBFS provider (used by the nearby-assets endpoint, cached by the caller). */
export async function loadGbfsSnapshot(providerId: string, discoveryUrl: string): Promise<GbfsSnapshot> {
  const feeds = discoverFeeds((await fetchJson(discoveryUrl)).data);
  const load = async (name: string) => { const url = feeds.get(name); if (!url) return undefined; try { return (await fetchJson(url)).data; } catch { return undefined; } };
  const [vehicleTypes, vehicleStatus, freeBikes, stationInfo, stationStatus] = await Promise.all([load('vehicle_types'), load('vehicle_status'), load('free_bike_status'), load('station_information'), load('station_status')]);
  const statusFeed = vehicleStatus ?? freeBikes;
  return {
    assets: statusFeed ? normalizeVehicles(providerId, vehicleTypes, statusFeed).assets : [],
    stations: stationInfo ? normalizeStations(providerId, stationInfo, stationStatus).stations : [],
    fetchedAt: Date.now(),
  };
}
