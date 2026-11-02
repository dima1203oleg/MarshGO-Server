import { loadGbfsSnapshot, type GbfsSnapshot } from './gbfs';
import type { GbfsGeofenceRule } from './gbfsGeofences';
import type { MobilityAsset, MobilityAssetType, MobilityStation } from './types';
import { z } from 'zod';
import { smartCache } from '../cache/cacheService';

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

const coordinateSchema = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
const gbfsRuleSchema: z.ZodType<GbfsGeofenceRule> = z.object({
  vehicleTypeIds: z.array(z.string()).nullable(), rideStartAllowed: z.boolean().nullable(), rideEndAllowed: z.boolean().nullable(),
  rideThroughAllowed: z.boolean().nullable(), maximumSpeedKph: z.number().nullable(), startAt: z.number().nullable(), endAt: z.number().nullable(),
});
const gbfsSnapshotSchema: z.ZodType<GbfsSnapshot> = z.object({
  assets: z.array(z.object({ id: z.string().min(1), providerId: z.string().min(1), type: z.enum(['BIKE','EBIKE','SCOOTER','MOPED','CARSHARING','TAXI']),
    location: coordinateSchema, available: z.boolean(), batteryPercent: z.number().optional(), rangeMeters: z.number().optional(), stationId: z.string().optional(),
    lastUpdated: z.string().optional(), vehicleTypeId: z.string().optional(), pricingPlanId: z.string().optional(), rentalUris: z.record(z.string(), z.string()).optional() })),
  stations: z.array(z.object({ id: z.string().min(1), providerId: z.string().min(1), name: z.string(), location: coordinateSchema,
    capacity: z.number().optional(), availableAssets: z.number().optional(), returnAllowed: z.boolean().optional(), sourceUpdatedAt: z.string().optional() })),
  geofences: z.array(z.object({ id: z.string().min(1), geometry: z.object({ type: z.enum(['Polygon','MultiPolygon']), coordinates: z.unknown() }), rules: z.array(gbfsRuleSchema), startAt: z.number().nullable().optional(), endAt: z.number().nullable().optional() })).optional(),
  globalRules: z.array(gbfsRuleSchema).optional(),
  pricingPlans: z.record(z.string(), z.object({ planId: z.string(), name: z.string().nullable(), currency: z.string().nullable(), price: z.number().nullable(),
    perMinutePricing: z.array(z.object({ start: z.number(), rate: z.number(), interval: z.number() })) })).optional(),
  fetchedAt: z.number().finite(), lastUpdated: z.number().nullable().optional(), ttlSeconds: z.number().nonnegative().nullable().optional(), staleAfterSeconds: z.number().positive().optional(),
});

/** Versioned provider snapshot cache. TTL is capped by the source TTL and the normalized stale-after boundary. */
export function cachedSnapshot(providerId: string, url: string, expectedCountry?: string): Promise<GbfsSnapshot> {
  return smartCache.getOrLoad('gbfs_snapshot', { providerId, sourceUrl: url, expectedCountry: expectedCountry ?? null }, gbfsSnapshotSchema, {
    ttlMs: 15_000,
    l1TtlMs: 15_000,
    ttlForValue: (snapshot) => {
      const sourceTtlMs = snapshot.ttlSeconds == null ? 15_000 : snapshot.ttlSeconds === 0 ? 3_000 : snapshot.ttlSeconds * 1000;
      const freshnessMs = (snapshot.staleAfterSeconds ?? 60) * 1000;
      return Math.max(1_000, Math.min(sourceTtlMs, freshnessMs, 15_000));
    },
    lockTtlMs: 12_000,
  }, () => loadGbfsSnapshot(providerId, url, expectedCountry));
}
