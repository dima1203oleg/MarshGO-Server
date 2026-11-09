import {
  findGtfsItinerariesWithStats,
  findGtfsStopArrivals,
  mergeGtfsTimetables,
  type GtfsItinerarySearchInput,
  type GtfsTimetableFeed,
  type GtfsTimetableSource,
} from './gtfsTimetable';
import type { GtfsRealtimeTripUpdates } from './gtfsRealtime';

const JOURNEY_MODES = new Set(['BUS', 'MINIBUS', 'RAIL', 'TRAM', 'TROLLEYBUS', 'METRO']);

export interface GtfsSearchGroupDescriptor {
  id: string;
  timezone: string;
  sources: Array<{ providerId: string; providerName: string; providerCity: string }>;
  routeTypes: string[];
  hasMetro: boolean;
  transferStops: Array<{ name: string; coordinates: [number, number]; endpoint: 'origin' | 'destination' }>;
}

export interface GtfsSearchAnchor {
  origin: [number, number];
  destination: [number, number];
}

const MICROMOBILITY_TRANSFER_STOP_RADIUS_METERS = 8_000;
const MICROMOBILITY_TRANSFER_STOP_LIMIT_PER_ENDPOINT = 2;

function distanceMeters(a: [number, number], b: [number, number]): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const [lonA, latA] = a.map(radians) as [number, number];
  const [lonB, latB] = b.map(radians) as [number, number];
  const latDelta = latB - latA;
  const lonDelta = lonB - lonA;
  const h = Math.sin(latDelta / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(lonDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function selectMicromobilityTransferStops(feed: GtfsTimetableFeed, anchors?: GtfsSearchAnchor) {
  if (!anchors) return [];
  const servedStopIds = new Set<string>();
  for (const [tripId, trip] of feed.trips) {
    const route = feed.routes.get(trip.routeId);
    if (!route || !JOURNEY_MODES.has(route.mode)) continue;
    for (const call of feed.stopTimes.get(tripId) ?? []) servedStopIds.add(call.stopId);
  }
  const stops = [...servedStopIds].flatMap((id) => {
    const stop = feed.stops.get(id);
    return stop ? [{ name: stop.name, coordinates: [stop.lon, stop.lat] as [number, number] }] : [];
  });
  const selected: GtfsSearchGroupDescriptor['transferStops'] = [];
  for (const endpoint of ['origin', 'destination'] as const) {
    const anchor = anchors[endpoint];
    selected.push(...stops.map((stop) => ({ stop, distance: distanceMeters(anchor, stop.coordinates) }))
      .filter(({ distance }) => distance <= MICROMOBILITY_TRANSFER_STOP_RADIUS_METERS)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MICROMOBILITY_TRANSFER_STOP_LIMIT_PER_ENDPOINT)
      .map(({ stop }) => ({ ...stop, endpoint })));
  }
  return selected;
}

export interface GtfsSearchGroup {
  sources: GtfsTimetableSource[];
  feed: GtfsTimetableFeed;
}

/** Bounded LRU/TTL snapshots; each entry can retain a full parsed GTFS feed. */
export class GtfsSearchGroupCache {
  private readonly entries = new Map<string, { group: GtfsSearchGroup; expiresAt: number }>();

  constructor(private readonly maxEntries = 8, private readonly ttlMs = 5 * 60_000) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs < 1) {
      throw new Error('GTFS search group cache bounds must be positive');
    }
  }

  get size(): number { return this.entries.size; }

  get(id: string, now = Date.now()): GtfsSearchGroup | undefined {
    this.pruneExpired(now);
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.group;
  }

  set(id: string, group: GtfsSearchGroup, now = Date.now()): void {
    this.pruneExpired(now);
    this.entries.delete(id);
    this.entries.set(id, { group, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
  }

  private pruneExpired(now: number): void {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }
}

export function buildGtfsSearchGroups(sources: readonly GtfsTimetableSource[], idPrefix: string, anchors?: GtfsSearchAnchor): {
  descriptors: GtfsSearchGroupDescriptor[];
  groups: Map<string, GtfsSearchGroup>;
} {
  const byTimezone = new Map<string, GtfsTimetableSource[]>();
  for (const source of sources) {
    const group = byTimezone.get(source.feed.timezone) ?? [];
    group.push(source);
    byTimezone.set(source.feed.timezone, group);
  }

  const descriptors: GtfsSearchGroupDescriptor[] = [];
  const groups = new Map<string, GtfsSearchGroup>();
  for (const [timezone, groupSources] of byTimezone) {
    const feed = mergeGtfsTimetables(groupSources);
    if (!feed) continue;
    const id = `${idPrefix}:${descriptors.length}`;
    const routeTypes = new Set<string>();
    for (const source of groupSources) for (const route of source.feed.routes.values()) {
      // Parser support cannot add an unapproved mode to the product.
      if (!JOURNEY_MODES.has(route.mode)) continue;
      routeTypes.add(route.transportType);
      if (route.transportType === 'intercity_bus') routeTypes.add('bus');
      if (route.transportType === 'suburban_train' || route.transportType === 'city_train') routeTypes.add('train');
    }
    groups.set(id, { sources: [...groupSources], feed });
    descriptors.push({ id, timezone,
      sources: groupSources.map(({ providerId, providerName, providerCity }) => ({ providerId, providerName, providerCity })),
      routeTypes: [...routeTypes], hasMetro: [...feed.routes.values()].some((route) => route.mode === 'METRO'),
      transferStops: selectMicromobilityTransferStops(feed, anchors) });
  }
  return { descriptors, groups };
}

export function searchGtfsGroup(group: GtfsSearchGroup, input: GtfsItinerarySearchInput) {
  const first = group.sources[0];
  if (!first) throw new Error('GTFS search group has no providers');
  return findGtfsItinerariesWithStats(group.feed, { ...input, providerId: first.providerId, providerName: first.providerName });
}

export function selectGtfsTripMetadata(feed: GtfsTimetableFeed, tripIds: readonly string[]) {
  const trips: Array<[string, { routeId: string; directionId?: string }]> = [];
  const stopTimes: Array<[string, Array<{ stopId: string; sourceStopId?: string; sequence: number }>]> = [];
  for (const tripId of new Set(tripIds)) {
    const trip = feed.trips.get(tripId);
    if (!trip) continue;
    trips.push([tripId, { routeId: trip.routeId, ...(trip.directionId ? { directionId: trip.directionId } : {}) }]);
    stopTimes.push([tripId, (feed.stopTimes.get(tripId) ?? []).map(({ stopId, sourceStopId, sequence }) => ({
      stopId, ...(sourceStopId ? { sourceStopId } : {}), sequence,
    }))]);
  }
  return { trips, stopTimes };
}

export function selectGtfsStopArrivals(
  feed: GtfsTimetableFeed,
  realtime: GtfsRealtimeTripUpdates | null,
  stopId: string,
  now: Date,
  limit: number,
  filters: { routeId?: string; headsign?: string } = {},
) {
  let realtimeStatus: 'AVAILABLE' | 'STALE' | 'UNAVAILABLE' | 'NOT_CONFIGURED' | 'TEMPORARILY_UNAVAILABLE' = realtime ? 'UNAVAILABLE' : 'NOT_CONFIGURED';
  let realtimeUpdatedAt: Date | undefined;
  const realtimeFeedTimestamp = realtime && realtime.feedTimestamp.getTime() > 0 ? realtime.feedTimestamp : undefined;
  if (realtime?.fresh) {
    realtimeStatus = 'AVAILABLE';
    realtimeUpdatedAt = realtime.feedTimestamp;
  } else if (realtime?.reason === 'STALE') {
    realtimeStatus = 'STALE';
  }
  const searchFeed = realtime?.fresh ? { ...feed, realtimeTripUpdates: realtime.updates } : feed;
  return {
    arrivals: findGtfsStopArrivals(searchFeed, stopId, { now, limit, ...filters }),
    stopKnown: feed.stops.has(stopId),
    scheduleUpdatedAt: feed.fetchedAt,
    realtimeStatus,
    ...(realtimeUpdatedAt ? { realtimeUpdatedAt } : {}),
    ...(realtimeFeedTimestamp ? { realtimeFeedTimestamp } : {}),
  };
}
