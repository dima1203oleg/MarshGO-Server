import type { GbfsSnapshot } from './gbfs';
import type { MobilityAssetType } from './types';

export interface MapBbox { west: number; south: number; east: number; north: number }
export interface MapFeature {
  type: 'Feature';
  id?: string;
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}

export interface MapMobilityProvider { id: string; name: string; operatorId?: string | null }

function inBbox(bbox: MapBbox, lon: number, lat: number): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function isFresh(snapshot: GbfsSnapshot, updatedAt: string | number | null | undefined, now: number): boolean {
  if (updatedAt === null || updatedAt === undefined) return false;
  const timestamp = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= -30_000 && age <= (snapshot.staleAfterSeconds ?? 60) * 1000;
}

function polygonIntersectsBbox(geometry: { type: string; coordinates: unknown }, bbox: MapBbox): boolean {
  let west = 180, east = -180, south = 90, north = -90, found = false;
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      found = true; west = Math.min(west, value[0]); east = Math.max(east, value[0]); south = Math.min(south, value[1]); north = Math.max(north, value[1]);
    }
    else value.forEach(visit);
  };
  visit(geometry.coordinates);
  return found && west <= bbox.east && east >= bbox.west && south <= bbox.north && north >= bbox.south;
}

export function buildMicromobilityPointFeatures(
  provider: MapMobilityProvider,
  snapshot: GbfsSnapshot,
  bbox: MapBbox,
  wanted: ReadonlySet<MobilityAssetType>,
  options: { includeStations?: boolean; now?: number } = {},
): MapFeature[] {
  const now = options.now ?? Date.now();
  if (!isFresh(snapshot, snapshot.lastUpdated, now)) return [];
  const providerId = provider.operatorId ?? provider.id;
  const features: MapFeature[] = [];
  for (const asset of snapshot.assets) {
    if (!asset.available || !wanted.has(asset.type) || !inBbox(bbox, asset.location[0], asset.location[1]) || !isFresh(snapshot, asset.lastUpdated, now)) continue;
    const pricing = asset.pricingPlanId ? snapshot.pricingPlans?.[asset.pricingPlanId] : undefined;
    features.push({
      type: 'Feature', id: `${provider.id}:vehicle:${asset.id}`,
      properties: {
        kind: asset.type === 'SCOOTER' ? 'scooter' : asset.type === 'CARSHARING' ? 'carsharing' : 'bike',
        id: asset.id, provider: provider.name.split(' — ')[0], providerId,
        vehicleType: asset.type, vehicleTypeId: asset.vehicleTypeId ?? null,
        availability: 'AVAILABLE', batteryPercent: asset.batteryPercent ?? null,
        rangeMeters: asset.rangeMeters ?? null, pricingPlanId: asset.pricingPlanId ?? null,
        pricing: pricing ? { currency: pricing.currency, basePrice: pricing.price, perMinutePricing: pricing.perMinutePricing } : null,
        rentalUris: asset.rentalUris ?? null, updatedAt: asset.lastUpdated ?? null,
        availabilityStatus: 'LIVE',
      },
      geometry: { type: 'Point', coordinates: asset.location },
    });
  }
  if (options.includeStations) for (const station of snapshot.stations) {
    if (!inBbox(bbox, station.location[0], station.location[1]) || !isFresh(snapshot, station.sourceUpdatedAt, now)) continue;
    features.push({
      type: 'Feature', id: `${provider.id}:station:${station.id}`,
      properties: {
        kind: 'station', id: station.id, name: station.name, provider: provider.name.split(' — ')[0], providerId,
        availability: (station.availableAssets ?? 0) > 0 ? 'AVAILABLE' : 'UNKNOWN',
        available: station.availableAssets ?? null, capacity: station.capacity ?? null,
        pickupAllowed: (station.availableAssets ?? 0) > 0, dropoffAllowed: station.returnAllowed ?? null,
        updatedAt: station.sourceUpdatedAt ?? null, availabilityStatus: 'LIVE',
      },
      geometry: { type: 'Point', coordinates: station.location },
    });
  }
  return features;
}

/** Returns source geofences separately from clustered points; stale polygons are omitted. */
export function buildMicromobilityGeofenceFeatures(
  provider: MapMobilityProvider,
  snapshot: GbfsSnapshot,
  bbox: MapBbox,
  now = Date.now(),
): MapFeature[] {
  if (snapshot.lastUpdated === null || snapshot.lastUpdated === undefined
    || now - snapshot.lastUpdated < -30_000
    || now - snapshot.lastUpdated > (snapshot.staleAfterSeconds ?? 60) * 1000) return [];
  return (snapshot.geofences ?? []).filter((zone) => polygonIntersectsBbox(zone.geometry, bbox)).map((zone) => {
    const endRules = zone.rules.map((rule) => rule.rideEndAllowed).filter((value): value is boolean => value !== null);
    const startRules = zone.rules.map((rule) => rule.rideStartAllowed).filter((value): value is boolean => value !== null);
    const effectiveSummary = (rules: boolean[]) => rules.includes(false) ? false : rules.length ? true : null;
    return {
      type: 'Feature' as const, id: `${provider.id}:geofence:${zone.id}`,
      properties: {
        kind: 'geofence', id: zone.id, provider: provider.name.split(' — ')[0], providerId: provider.operatorId ?? provider.id,
        rideStartAllowed: effectiveSummary(startRules), rideEndAllowed: effectiveSummary(endRules),
        rideThroughAllowed: effectiveSummary(zone.rules.map((rule) => rule.rideThroughAllowed).filter((value): value is boolean => value !== null)),
        maximumSpeedKph: zone.rules.flatMap((rule) => rule.maximumSpeedKph === null ? [] : [rule.maximumSpeedKph]).reduce<number | null>((min, value) => min === null ? value : Math.min(min, value), null),
        vehicleTypeIds: [...new Set(zone.rules.flatMap((rule) => rule.vehicleTypeIds ?? []))],
        updatedAt: new Date(snapshot.lastUpdated as number).toISOString(), availabilityStatus: 'LIVE',
      }, geometry: zone.geometry,
    };
  });
}

export function buildStaticRentalPointFeature(row: Record<string, unknown>): MapFeature | null {
  const lon = Number(row.lon), lat = Number(row.lat);
  if (!Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  return {
    type: 'Feature', id: `rental:${String(row.id)}`,
    properties: {
      kind: 'rental_location', id: row.id, name: row.name ?? row.operatorName ?? 'Пункт прокату',
      provider: row.providerName ?? row.operatorName ?? 'Непідтверджений оператор', providerId: row.providerId ?? null,
      networkId: row.networkId ?? null, rentalModel: row.rentalModel ?? 'UNKNOWN', source: row.source ?? null,
      availability: row.availability ?? 'UNKNOWN', availabilityStatus: row.sourceStatus ?? 'UNKNOWN',
      pickupAllowed: row.pickupAllowed ?? null, dropoffAllowed: row.dropoffAllowed ?? null,
      address: row.address ?? null, city: row.city ?? null, openingHours: row.openingHours ?? null,
      sourceUpdatedAt: row.sourceUpdatedAt ?? null, sourceImportedAt: row.sourceImportedAt ?? null,
      attribution: row.source === 'OSM' ? '© OpenStreetMap contributors, ODbL 1.0' : null,
    },
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}
