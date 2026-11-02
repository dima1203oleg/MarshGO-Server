import { geofenceRulesAt, type GbfsGeofence, type GbfsGeofenceRule } from '../mobility/gbfsGeofences';

export type MicromobilityMode = 'BICYCLE' | 'SCOOTER';
export type Point = [number, number];
export interface RentalRoutePoint {
  id: string;
  providerId: string;
  providerName: string;
  networkId: string | null;
  name: string;
  coordinates: Point;
  mode: MicromobilityMode;
  pickupAllowed: boolean | null;
  dropoffAllowed: boolean | null;
  availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  source: string;
}
export interface RentalRouteNetwork {
  networkId: string;
  providerIds: string[];
  compatibilityStatus: 'CONFIRMED' | 'UNKNOWN' | 'DISABLED';
  returnRule: 'ANY_NETWORK_LOCATION' | 'FREE_FLOATING_ZONE' | 'SAME_LOCATION' | 'ONE_WAY_CONFIRMED' | 'UNKNOWN';
  returnRuleSource: 'OWNER_ATTESTED' | 'PROVIDER_API' | 'PROVIDER_DOCUMENTATION' | 'UNKNOWN';
}
export interface RentalRouteLeg {
  mode: 'WALK' | MicromobilityMode;
  origin: { name: string; coordinates: Point };
  destination: { name: string; coordinates: Point };
  distanceMeters: number;
  durationSeconds: number;
  providerId: string | null;
  providerName: string | null;
  /** Straight line only: the API must not imply road-network accuracy. */
  routeGeometry: Point[];
  metadata: Record<string, unknown>;
}
export interface MicromobilityRouteEstimate {
  id: string;
  diversityKey: string;
  providerId: string;
  providerName: string;
  mode: MicromobilityMode;
  departureAt: Date;
  arrivalAt: Date;
  durationSeconds: number;
  distanceMeters: number;
  walkingMeters: number;
  priceMinor: null;
  availabilityStatus: 'UNKNOWN';
  transfers: number;
  legs: RentalRouteLeg[];
  routeAccuracy: 'STRAIGHT_LINE_ESTIMATE';
}

export interface RoutePlace { name: string; coordinates: Point }
export interface RouteEstimateOptions {
  departureAt: Date;
  maxWalkToRentalMeters: number;
  maxWalkingMeters?: number;
  maxRentalDurationSeconds?: number;
  maxCandidates?: number;
  allowedProviderIds?: readonly string[];
  blockedProviderIds?: readonly string[];
}

const EARTH_RADIUS_METERS = 6_371_000;
export function distanceMeters(a: Point, b: Point): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

function allowedProvider(providerId: string, options: RouteEstimateOptions): boolean {
  return (!options.allowedProviderIds?.length || options.allowedProviderIds.includes(providerId))
    && !options.blockedProviderIds?.includes(providerId);
}

function nearestPoint(points: RentalRoutePoint[], place: RoutePlace, mode: MicromobilityMode, maxMeters: number, side: 'pickup' | 'dropoff') {
  return points
    .filter((point) => point.mode === mode)
    .filter((point) => (side === 'pickup' ? point.pickupAllowed !== false : point.dropoffAllowed !== false))
    .map((point) => ({ point, distance: distanceMeters(point.coordinates, place.coordinates) }))
    .filter((entry) => entry.distance <= maxMeters)
    .sort((a, b) => a.distance - b.distance || a.point.id.localeCompare(b.point.id))[0] ?? null;
}

function walkLeg(from: RoutePlace, to: RoutePlace, meters: number): RentalRouteLeg | null {
  if (meters < 1) return null;
  return {
    mode: 'WALK', origin: from, destination: to, distanceMeters: Math.round(meters),
    durationSeconds: Math.max(1, Math.ceil(meters / 1.25)), providerId: null, providerName: null,
    routeGeometry: [from.coordinates, to.coordinates],
    metadata: { routeAccuracy: 'STRAIGHT_LINE_ESTIMATE', geometryMethod: 'great-circle-line', availabilityStatus: 'AVAILABLE' },
  };
}

function routeCandidate(input: {
  origin: RoutePlace; destination: RoutePlace; pickup: RoutePlace; dropoff: RoutePlace;
  mode: MicromobilityMode; providerId: string; providerName: string; networkId: string;
  options: RouteEstimateOptions; snapshotUpdatedAt?: string | null;
  pickupDistanceMeters?: number; dropoffDistanceMeters?: number;
  geofenceVehicleTypeId?: string; pickupRule?: string; dropoffRule?: string;
}): MicromobilityRouteEstimate | null {
  const pickupWalkMeters = input.pickupDistanceMeters ?? distanceMeters(input.origin.coordinates, input.pickup.coordinates);
  const dropoffWalkMeters = input.dropoffDistanceMeters ?? distanceMeters(input.dropoff.coordinates, input.destination.coordinates);
  if (pickupWalkMeters > input.options.maxWalkToRentalMeters || dropoffWalkMeters > input.options.maxWalkToRentalMeters) return null;
  const routeMeters = distanceMeters(input.pickup.coordinates, input.dropoff.coordinates);
  if (routeMeters < 100) return null;
  const walkingMeters = Math.round(pickupWalkMeters + dropoffWalkMeters);
  if (input.options.maxWalkingMeters !== undefined && walkingMeters > input.options.maxWalkingMeters) return null;
  const speedMetersPerSecond = input.mode === 'BICYCLE' ? 4 : 4.5;
  const rentalSeconds = Math.ceil(routeMeters / speedMetersPerSecond);
  const durationSeconds = Math.ceil(pickupWalkMeters / 1.25) + rentalSeconds + Math.ceil(dropoffWalkMeters / 1.25);
  if (input.options.maxRentalDurationSeconds !== undefined && rentalSeconds > input.options.maxRentalDurationSeconds) return null;
  const providerSlug = input.providerId.replace(/[^a-z0-9_-]/gi, '-');
  const id = `rental-estimate:${input.mode.toLowerCase()}:${providerSlug}:${input.pickup.coordinates.map((value) => Math.round(value * 100000)).join(':')}:${input.dropoff.coordinates.map((value) => Math.round(value * 100000)).join(':')}`;
  const departureAt = input.options.departureAt;
  const arrivalAt = new Date(departureAt.getTime() + durationSeconds * 1000);
  const connectorStart = walkLeg(input.origin, input.pickup, pickupWalkMeters);
  const connectorEnd = walkLeg(input.dropoff, input.destination, dropoffWalkMeters);
  const micromobilityLeg: RentalRouteLeg = {
    mode: input.mode,
    origin: input.pickup,
    destination: input.dropoff,
    distanceMeters: Math.round(routeMeters),
    durationSeconds: rentalSeconds,
    providerId: input.providerId,
    providerName: input.providerName,
    routeGeometry: [input.pickup.coordinates, input.dropoff.coordinates],
    metadata: {
      routeAccuracy: 'STRAIGHT_LINE_ESTIMATE',
      geometryMethod: 'great-circle-line',
      returnRule: input.mode === 'BICYCLE' ? 'ANY_NETWORK_LOCATION' : 'FREE_FLOATING_ZONE',
      returnRuleSource: input.mode === 'BICYCLE' ? 'OWNER_ATTESTED' : 'PROVIDER_GBFS_GEOFENCE',
      networkId: input.networkId,
      availabilityStatus: 'UNKNOWN',
      bookingAvailable: false,
      priceStatus: 'UNKNOWN',
      ...(input.snapshotUpdatedAt ? { geofenceSnapshotUpdatedAt: input.snapshotUpdatedAt } : {}),
      ...(input.geofenceVehicleTypeId ? { vehicleTypeId: input.geofenceVehicleTypeId } : {}),
      ...(input.pickupRule ? { pickupRule: input.pickupRule } : {}),
      ...(input.dropoffRule ? { dropoffRule: input.dropoffRule } : {}),
    },
  };
  return {
    id, diversityKey: `${input.mode}:${input.providerId}:${input.networkId}`, providerId: input.providerId,
    providerName: input.providerName, mode: input.mode, departureAt, arrivalAt, durationSeconds,
    distanceMeters: Math.round(routeMeters + pickupWalkMeters + dropoffWalkMeters), walkingMeters,
    priceMinor: null, availabilityStatus: 'UNKNOWN', transfers: 0,
    legs: [connectorStart, micromobilityLeg, connectorEnd].filter((leg): leg is RentalRouteLeg => leg !== null),
    routeAccuracy: 'STRAIGHT_LINE_ESTIMATE',
  };
}

/** Route estimates use one confirmed operator network end-to-end; live stock remains unknown. */
export function buildBicycleRouteEstimates(input: {
  origin: RoutePlace; destination: RoutePlace; points: RentalRoutePoint[];
  networks: Map<string, RentalRouteNetwork>; options: RouteEstimateOptions;
}): MicromobilityRouteEstimate[] {
  const byProvider = new Map<string, RentalRoutePoint[]>();
  for (const point of input.points) {
    const rule = point.networkId ? input.networks.get(point.networkId) : undefined;
    if (point.mode !== 'BICYCLE' || !point.networkId || !rule || rule.networkId !== point.networkId
      || rule.compatibilityStatus !== 'CONFIRMED' || rule.returnRule !== 'ANY_NETWORK_LOCATION'
      || rule.returnRuleSource !== 'OWNER_ATTESTED' || !rule.providerIds.includes(point.providerId)
      || !allowedProvider(point.providerId, input.options)) continue;
    const group = byProvider.get(point.providerId) ?? [];
    group.push(point);
    byProvider.set(point.providerId, group);
  }
  const candidates: MicromobilityRouteEstimate[] = [];
  for (const [providerId, points] of byProvider) {
    const pickup = nearestPoint(points, input.origin, 'BICYCLE', input.options.maxWalkToRentalMeters, 'pickup');
    const dropoff = nearestPoint(points, input.destination, 'BICYCLE', input.options.maxWalkToRentalMeters, 'dropoff');
    if (!pickup || !dropoff || pickup.point.id === dropoff.point.id || pickup.point.networkId !== dropoff.point.networkId) continue;
    const candidate = routeCandidate({
      origin: input.origin, destination: input.destination,
      pickup: { name: pickup.point.name, coordinates: pickup.point.coordinates },
      dropoff: { name: dropoff.point.name, coordinates: dropoff.point.coordinates },
      mode: 'BICYCLE', providerId, providerName: pickup.point.providerName, networkId: pickup.point.networkId!,
      pickupDistanceMeters: pickup.distance, dropoffDistanceMeters: dropoff.distance, options: input.options,
    });
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort((a, b) => a.durationSeconds - b.durationSeconds || a.providerName.localeCompare(b.providerName)).slice(0, input.options.maxCandidates ?? 6);
}

export interface GeofenceSnapshotForRouting {
  geofences: GbfsGeofence[];
  globalRules: GbfsGeofenceRule[];
  lastUpdated: number | null;
  staleAfterSeconds: number;
}
export interface ScooterRouteProvider {
  providerId: string;
  providerName: string;
  networkId: string;
  snapshot: GeofenceSnapshotForRouting;
}

function lineSamples(a: Point, b: Point, spacingMeters = 200): Point[] {
  const distance = distanceMeters(a, b);
  const count = Math.max(1, Math.ceil(distance / spacingMeters));
  return Array.from({ length: count + 1 }, (_, index) => {
    const ratio = index / count;
    return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio] as Point;
  });
}

/** Find a fresh, type-applicable GBFS geofence point allowing the requested operation. */
export function nearestAllowedScooterPoint(input: {
  snapshot: GeofenceSnapshotForRouting; target: Point; vehicleTypeId: string;
  operation: 'start' | 'end'; at: number;
}): { coordinates: Point; distanceMeters: number } | null {
  const allowed = (point: Point) => {
    const rules = geofenceRulesAt(input.snapshot, point, input.vehicleTypeId, input.at);
    return input.operation === 'start' ? rules.rideStartAllowed === true : rules.rideEndAllowed === true;
  };
  if (allowed(input.target)) return { coordinates: input.target, distanceMeters: 0 };
  const polygons: unknown[][] = [];
  for (const zone of input.snapshot.geofences) {
    if ((zone.startAt != null && input.at < zone.startAt) || (zone.endAt != null && input.at > zone.endAt)) continue;
    const applicable = zone.rules.find((rule) => (rule.startAt === null || rule.startAt === undefined || input.at >= rule.startAt)
      && (rule.endAt === null || rule.endAt === undefined || input.at <= rule.endAt)
      && (rule.vehicleTypeIds === null || rule.vehicleTypeIds.includes(input.vehicleTypeId)));
    const zoneAllows = input.operation === 'start' ? applicable?.rideStartAllowed === true : applicable?.rideEndAllowed === true;
    if (!zoneAllows) continue;
    const raw = zone.geometry.type === 'Polygon' ? [zone.geometry.coordinates]
      : Array.isArray(zone.geometry.coordinates) ? zone.geometry.coordinates : [];
    for (const polygon of raw) if (Array.isArray(polygon) && Array.isArray(polygon[0])) polygons.push(polygon as unknown[]);
  }
  const candidates: Array<{ coordinates: Point; distanceMeters: number }> = [];
  for (const polygon of polygons) {
    const ring = polygon[0];
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const centroid: Point = [
      ring.slice(0, -1).reduce((sum, point) => sum + Number((point as number[])[0]), 0) / (ring.length - 1),
      ring.slice(0, -1).reduce((sum, point) => sum + Number((point as number[])[1]), 0) / (ring.length - 1),
    ];
    const longitudeScale = 111_320 * Math.cos(input.target[1] * Math.PI / 180);
    const latitudeScale = 111_320;
    let nearest: Point | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < ring.length - 1; index++) {
      const first = ring[index] as number[], second = ring[index + 1] as number[];
      const ax = (first[0]! - input.target[0]) * longitudeScale, ay = (first[1]! - input.target[1]) * latitudeScale;
      const bx = (second[0]! - input.target[0]) * longitudeScale, by = (second[1]! - input.target[1]) * latitudeScale;
      const dx = bx - ax, dy = by - ay;
      const ratio = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
      const point: Point = [first[0]! + (second[0]! - first[0]!) * ratio, first[1]! + (second[1]! - first[1]!) * ratio];
      const meters = distanceMeters(input.target, point);
      if (meters < nearestDistance) { nearest = point; nearestDistance = meters; }
    }
    if (!nearest) continue;
    for (const ratio of [0, 0.0001, 0.001, 0.005, 0.02, 0.1, 0.5, 1]) {
      const point: Point = [nearest[0] + (centroid[0] - nearest[0]) * ratio, nearest[1] + (centroid[1] - nearest[1]) * ratio];
      if (!allowed(point)) continue;
      candidates.push({ coordinates: point, distanceMeters: distanceMeters(input.target, point) });
      break;
    }
  }
  return candidates.sort((a, b) => a.distanceMeters - b.distanceMeters)[0] ?? null;
}

/** Scooter routes are estimated only between fresh GBFS start/end-allowed zones. */
export function buildScooterRouteEstimates(input: {
  origin: RoutePlace; destination: RoutePlace; providers: ScooterRouteProvider[]; options: RouteEstimateOptions;
  now?: number;
}): MicromobilityRouteEstimate[] {
  const now = input.now ?? Date.now();
  const candidates: MicromobilityRouteEstimate[] = [];
  for (const provider of input.providers) {
    if (!allowedProvider(provider.providerId, input.options)) continue;
    const snapshot = provider.snapshot;
    if (snapshot.lastUpdated === null || now - snapshot.lastUpdated < -30_000
      || now - snapshot.lastUpdated > snapshot.staleAfterSeconds * 1000) continue;
    const vehicleTypeIds = new Set([
      ...snapshot.geofences.flatMap((zone) => zone.rules.flatMap((rule) => rule.vehicleTypeIds ?? [])),
      ...snapshot.globalRules.flatMap((rule) => rule.vehicleTypeIds ?? []),
    ]);
    if (vehicleTypeIds.size === 0) vehicleTypeIds.add('__provider_wide__');
    for (const vehicleTypeId of vehicleTypeIds) {
      const pickup = nearestAllowedScooterPoint({ snapshot, target: input.origin.coordinates, vehicleTypeId, operation: 'start', at: input.options.departureAt.getTime() });
      const dropoff = nearestAllowedScooterPoint({ snapshot, target: input.destination.coordinates, vehicleTypeId, operation: 'end', at: input.options.departureAt.getTime() });
      if (!pickup || !dropoff || pickup.distanceMeters > input.options.maxWalkToRentalMeters
        || dropoff.distanceMeters > input.options.maxWalkToRentalMeters) continue;
      if (lineSamples(pickup.coordinates, dropoff.coordinates, 100).slice(1, -1).some((point) =>
        geofenceRulesAt(snapshot, point, vehicleTypeId, input.options.departureAt.getTime()).rideThroughAllowed === false)) continue;
      const candidate = routeCandidate({
        origin: input.origin, destination: input.destination,
        pickup: { name: `${provider.providerName} · зона посадки`, coordinates: pickup.coordinates },
        dropoff: { name: `${provider.providerName} · зона повернення`, coordinates: dropoff.coordinates },
        mode: 'SCOOTER', providerId: provider.providerId, providerName: provider.providerName, networkId: provider.networkId,
        pickupDistanceMeters: pickup.distanceMeters, dropoffDistanceMeters: dropoff.distanceMeters, options: input.options,
        snapshotUpdatedAt: new Date(snapshot.lastUpdated).toISOString(), geofenceVehicleTypeId: vehicleTypeId,
        pickupRule: 'ride_start_allowed', dropoffRule: 'ride_end_allowed',
      });
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((a, b) => a.durationSeconds - b.durationSeconds || a.providerName.localeCompare(b.providerName))
    .slice(0, input.options.maxCandidates ?? 6);
}
