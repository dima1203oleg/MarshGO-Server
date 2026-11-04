import type { TransitJourneyMode, GtfsTransportType } from './gtfsTimetable';

export const MINIMUM_INTERCITY_TRANSFER_BUFFER_SECONDS = 600;
export const MINIMUM_URBAN_TRANSFER_BUFFER_SECONDS = 180;
export const MAX_IMPLICIT_STATION_WALK_METERS = 150;
export const MAX_ALLOWED_CHAIN_TRANSFERS = 4;

export const VERIFIED_WALKING_BOUNDS: Record<string, [number, number, number, number]> = {
  lviv: [23.9, 49.75, 24.2, 49.95],
  kyiv: [30.2, 50.25, 30.8, 50.62],
};

export type ChainGeometrySource =
  | 'gtfs_shape'
  | 'official_geojson'
  | 'osrm-foot-route'
  | 'gtfs-pathway'
  | 'straight-line-estimate';

export interface IntercityHub {
  id: string;
  name: string;
  city?: string;
  coordinates: [number, number];
  hubType: 'railway_station' | 'bus_station' | 'intermodal';
}

export interface ChainCandidateLeg {
  id: string;
  mode: TransitJourneyMode | 'WALK';
  transportType: GtfsTransportType | 'walk';
  origin: { id?: string; name: string; coordinates: [number, number] };
  destination: { id?: string; name: string; coordinates: [number, number] };
  departureAt: Date;
  arrivalAt: Date;
  durationSeconds: number;
  distanceMeters: number | null;
  priceMinor: number | null;
  fareKnown: boolean;
  currency?: string | null;
  geometrySource: ChainGeometrySource;
  routeGeometry?: Array<[number, number]>;
  providerId?: string;
  providerName?: string;
  routeName?: string;
  headsign?: string;
  tripId?: string;
}

export interface IntercityChainComposition {
  id: string;
  departureAt: Date;
  arrivalAt: Date;
  totalDurationSeconds: number;
  waitingSeconds: number;
  transfers: number;
  walkingMeters: number;
  totalPriceMinor: number | null;
  fareKnown: boolean;
  currency: string | null;
  legs: ChainCandidateLeg[];
  accessHub: IntercityHub | null;
  egressHub: IntercityHub | null;
  hasUnconfirmedGeometry: boolean;
}

export interface ComposeChainBudget {
  requestedDepartureAt: Date;
  maximumDurationSeconds?: number;
  maximumTransfers?: number;
  maximumWalkingMeters?: number;
  minimumIntercityBufferSeconds?: number;
  minimumUrbanBufferSeconds?: number;
  maximumWaitSeconds?: number;
}

const STATION_NAME_REGEX = /(?:залізничн\p{L}*|вокзал|railway station|train station|автовокзал|автостанці\p{L}*|головний вокзал|пасажирський)/iu;

export function isStationHubName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const normalized = name.normalize('NFKC').trim();
  return STATION_NAME_REGEX.test(normalized);
}

export function haversineDistanceMeters(a: [number, number], b: [number, number]): number {
  const radians = (deg: number) => deg * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

export function isWithinVerifiedWalkingBounds(coordinates: [number, number]): boolean {
  const [lon, lat] = coordinates;
  for (const box of Object.values(VERIFIED_WALKING_BOUNDS)) {
    if (lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3]) {
      return true;
    }
  }
  return false;
}

export function resolveAccessHub(
  origin: { name: string; coordinates: [number, number] },
  candidateStops: Iterable<{ id: string; name: string; lon: number; lat: number; city?: string }>,
  maxDistanceMeters = 15_000,
): IntercityHub | null {
  let bestHub: IntercityHub | null = null;
  let bestDistance = Infinity;

  for (const stop of candidateStops) {
    if (!isStationHubName(stop.name)) continue;
    const distance = haversineDistanceMeters(origin.coordinates, [stop.lon, stop.lat]);
    if (distance <= maxDistanceMeters && distance < bestDistance) {
      bestDistance = distance;
      const isBus = /автовокзал|автостанці/iu.test(stop.name);
      bestHub = {
        id: stop.id,
        name: stop.name,
        city: stop.city,
        coordinates: [stop.lon, stop.lat],
        hubType: isBus ? 'bus_station' : 'railway_station',
      };
    }
  }

  return bestHub;
}

export function resolveEgressHub(
  destination: { name: string; coordinates: [number, number] },
  candidateStops: Iterable<{ id: string; name: string; lon: number; lat: number; city?: string }>,
  maxDistanceMeters = 15_000,
): IntercityHub | null {
  return resolveAccessHub(destination, candidateStops, maxDistanceMeters);
}

function isLongDistance(leg: ChainCandidateLeg): boolean {
  return leg.transportType === 'train' || leg.transportType === 'intercity_bus';
}

export function createWalkLeg(
  from: { name: string; coordinates: [number, number] },
  to: { name: string; coordinates: [number, number] },
  departureAt: Date,
  options?: { distanceMeters?: number; durationSeconds?: number; hasRouterGeometry?: boolean; routeGeometry?: Array<[number, number]> },
): ChainCandidateLeg {
  const distance = options?.distanceMeters ?? Math.round(haversineDistanceMeters(from.coordinates, to.coordinates));
  const duration = options?.durationSeconds ?? Math.ceil(distance / 1.25);
  const arrivalAt = new Date(departureAt.getTime() + duration * 1000);

  const canUseRouter = isWithinVerifiedWalkingBounds(from.coordinates) && isWithinVerifiedWalkingBounds(to.coordinates);
  const geometrySource: ChainGeometrySource = canUseRouter && options?.hasRouterGeometry
    ? 'osrm-foot-route'
    : 'straight-line-estimate';

  return {
    id: `walk:${from.name}->${to.name}:${departureAt.getTime()}`,
    mode: 'WALK',
    transportType: 'walk',
    origin: from,
    destination: to,
    departureAt,
    arrivalAt,
    durationSeconds: duration,
    distanceMeters: distance,
    priceMinor: null,
    fareKnown: true,
    currency: null,
    geometrySource,
    routeGeometry: options?.routeGeometry,
  };
}

export function composeChain(
  localAccessLegs: readonly ChainCandidateLeg[],
  intercityLeg: ChainCandidateLeg,
  localEgressLegs: readonly ChainCandidateLeg[],
  budget: ComposeChainBudget,
  accessHub: IntercityHub | null = null,
  egressHub: IntercityHub | null = null,
): IntercityChainComposition | null {
  const minIntercityBuffer = budget.minimumIntercityBufferSeconds ?? MINIMUM_INTERCITY_TRANSFER_BUFFER_SECONDS;
  const minUrbanBuffer = budget.minimumUrbanBufferSeconds ?? MINIMUM_URBAN_TRANSFER_BUFFER_SECONDS;
  const maxTransfers = budget.maximumTransfers ?? MAX_ALLOWED_CHAIN_TRANSFERS;

  const totalTransitLegs = localAccessLegs.length + 1 + localEgressLegs.length;
  const transfers = totalTransitLegs - 1;
  if (transfers > maxTransfers || transfers > MAX_ALLOWED_CHAIN_TRANSFERS) {
    return null;
  }

  const allLegs: ChainCandidateLeg[] = [];
  let currentTime = budget.requestedDepartureAt;

  // 1. Local access legs (e.g. urban bus/tram in origin city)
  for (let i = 0; i < localAccessLegs.length; i++) {
    const leg = localAccessLegs[i]!;
    if (leg.departureAt < currentTime) return null;

    if (allLegs.length > 0) {
      const prev = allLegs.at(-1)!;
      const transferGap = (leg.departureAt.getTime() - prev.arrivalAt.getTime()) / 1000;
      const requiredBuffer = isLongDistance(prev) || isLongDistance(leg) ? minIntercityBuffer : minUrbanBuffer;
      if (transferGap < requiredBuffer) return null;

      const walkDist = haversineDistanceMeters(prev.destination.coordinates, leg.origin.coordinates);
      if (walkDist > 10) {
        const walk = createWalkLeg(prev.destination, leg.origin, prev.arrivalAt, { distanceMeters: Math.round(walkDist) });
        if (walk.arrivalAt > leg.departureAt) return null;
        allLegs.push(walk);
      }
    }

    allLegs.push(leg);
    currentTime = leg.arrivalAt;
  }

  // 2. Transfer from last access leg to intercity leg
  if (allLegs.length > 0) {
    const lastAccess = allLegs.at(-1)!;
    const intercityGap = (intercityLeg.departureAt.getTime() - lastAccess.arrivalAt.getTime()) / 1000;
    if (intercityGap < minIntercityBuffer) {
      return null;
    }

    const hubWalkDist = haversineDistanceMeters(lastAccess.destination.coordinates, intercityLeg.origin.coordinates);
    if (hubWalkDist > 5) {
      const walk = createWalkLeg(lastAccess.destination, intercityLeg.origin, lastAccess.arrivalAt, { distanceMeters: Math.round(hubWalkDist) });
      if (walk.arrivalAt > intercityLeg.departureAt) return null;
      allLegs.push(walk);
    }
  } else {
    if (intercityLeg.departureAt < currentTime) return null;
  }

  // 3. Intercity leg (e.g. train or intercity bus)
  allLegs.push(intercityLeg);

  // 4. Local egress legs (e.g. urban metro/bus in destination city)
  for (let i = 0; i < localEgressLegs.length; i++) {
    const leg = localEgressLegs[i]!;
    const prev = allLegs.at(-1)!;

    const gap = (leg.departureAt.getTime() - prev.arrivalAt.getTime()) / 1000;
    const requiredBuffer = isLongDistance(prev) || isLongDistance(leg) ? minIntercityBuffer : minUrbanBuffer;
    if (gap < requiredBuffer) return null;

    const walkDist = haversineDistanceMeters(prev.destination.coordinates, leg.origin.coordinates);
    if (walkDist > 10) {
      const walk = createWalkLeg(prev.destination, leg.origin, prev.arrivalAt, { distanceMeters: Math.round(walkDist) });
      if (walk.arrivalAt > leg.departureAt) return null;
      allLegs.push(walk);
    }

    allLegs.push(leg);
  }

  const firstLeg = allLegs[0];
  const lastLeg = allLegs.at(-1);
  if (!firstLeg || !lastLeg) return null;

  const totalDurationSeconds = Math.ceil((lastLeg.arrivalAt.getTime() - firstLeg.departureAt.getTime()) / 1000);
  if (budget.maximumDurationSeconds && totalDurationSeconds > budget.maximumDurationSeconds) {
    return null;
  }

  const waitingSeconds = Math.max(0, Math.ceil((firstLeg.departureAt.getTime() - budget.requestedDepartureAt.getTime()) / 1000));
  if (budget.maximumWaitSeconds && waitingSeconds > budget.maximumWaitSeconds) {
    return null;
  }

  let walkingMeters = 0;
  for (const leg of allLegs) {
    if (leg.mode === 'WALK' && leg.distanceMeters) {
      walkingMeters += leg.distanceMeters;
    }
  }
  if (budget.maximumWalkingMeters !== undefined && walkingMeters > budget.maximumWalkingMeters) {
    return null;
  }

  // Price honesty calculation:
  // If ANY transit leg has unknown price (priceMinor === null), total price is unknown (null).
  let fareKnown = true;
  let totalPriceMinor: number | null = 0;
  let currency: string | null = null;

  for (const leg of allLegs) {
    if (leg.mode === 'WALK') continue; // Walking does not contribute to transit fare
    if (!leg.fareKnown || leg.priceMinor === null) {
      fareKnown = false;
      totalPriceMinor = null;
      break;
    }
    if (totalPriceMinor !== null) {
      totalPriceMinor += leg.priceMinor;
      currency = leg.currency ?? currency ?? 'UAH';
    }
  }

  const hasUnconfirmedGeometry = allLegs.some((leg) => leg.geometrySource === 'straight-line-estimate');

  return {
    id: `chain:${firstLeg.id}->${intercityLeg.id}->${lastLeg.id}`,
    departureAt: firstLeg.departureAt,
    arrivalAt: lastLeg.arrivalAt,
    totalDurationSeconds,
    waitingSeconds,
    transfers,
    walkingMeters,
    totalPriceMinor,
    fareKnown,
    currency,
    legs: allLegs,
    accessHub,
    egressHub,
    hasUnconfirmedGeometry,
  };
}
