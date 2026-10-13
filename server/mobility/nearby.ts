import { loadGbfsSnapshot, type GbfsSnapshot } from './gbfs';
import type { MobilityAsset, MobilityAssetType, MobilityStation } from './types';

const EARTH_RADIUS_M = 6_371_000;
export function distanceMeters(a: [number, number], b: [number, number]): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export interface NearbyAsset extends MobilityAsset { distanceM: number; providerName: string }
export interface NearbyStation extends MobilityStation { distanceM: number; providerName: string }

/** Pure filter: available assets/stations of the wanted types inside the radius, nearest first, capped. */
export function selectNearby(
  snapshots: Array<{ providerId: string; providerName: string; snapshot: GbfsSnapshot }>,
  origin: [number, number], radiusM: number, types: MobilityAssetType[], limit = 40,
): { assets: NearbyAsset[]; stations: NearbyStation[]; totalAssets: number } {
  const assets: NearbyAsset[] = []; const stations: NearbyStation[] = [];
  for (const { providerName, snapshot } of snapshots) {
    // A production GBFS payload with no source timestamp or an expired timestamp
    // cannot be advertised as current inventory. Legacy unit fixtures omit both.
    if (snapshot.lastUpdated === null || (snapshot.lastUpdated !== undefined
      && Date.now() - snapshot.lastUpdated > (snapshot.staleAfterSeconds ?? 60) * 1000)) continue;
    for (const asset of snapshot.assets) {
      if (!asset.available || !types.includes(asset.type)) continue;
      const distanceM = distanceMeters(origin, asset.location);
      if (distanceM <= radiusM) assets.push({ ...asset, distanceM: Math.round(distanceM), providerName });
    }
    for (const station of snapshot.stations) {
      const distanceM = distanceMeters(origin, station.location);
      if (distanceM <= radiusM && (station.availableAssets ?? 0) > 0) stations.push({ ...station, distanceM: Math.round(distanceM), providerName });
    }
  }
  assets.sort((a, b) => a.distanceM - b.distanceM); stations.sort((a, b) => a.distanceM - b.distanceM);
  return { assets: assets.slice(0, limit), stations: stations.slice(0, limit), totalAssets: assets.length };
}

const cache = new Map<string, { at: number; expiresAt: number; promise: Promise<GbfsSnapshot> }>();
/** Singleflight and GBFS TTL-aware server cache; ttl=0 uses a short shared poll window instead of per-user requests. */
export function cachedSnapshot(providerId: string, url: string): Promise<GbfsSnapshot> {
  const hit = cache.get(providerId);
  if (hit && Date.now() < hit.expiresAt) return hit.promise;
  const promise = loadGbfsSnapshot(providerId, url);
  const entry = { at: Date.now(), expiresAt: Date.now() + 1000, promise };
  cache.set(providerId, entry);
  promise.then((snapshot) => {
    const sourceTtlMs = snapshot.ttlSeconds === null || snapshot.ttlSeconds === undefined ? 30_000 : snapshot.ttlSeconds === 0 ? 3_000 : snapshot.ttlSeconds * 1000;
    const freshnessMs = (snapshot.staleAfterSeconds ?? 60) * 1000;
    entry.expiresAt = Date.now() + Math.max(1000, Math.min(sourceTtlMs, freshnessMs, 60_000));
  }).catch(() => cache.delete(providerId));
  return promise;
}
