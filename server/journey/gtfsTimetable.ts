import { unzipSync, strFromU8 } from 'fflate';
import { fetchBinary } from '../mobility/safeFetch';
import { parseCsvLine, routeTypeLabel } from '../mobility/gtfs';
import { journeyTransportTypeSelected, type JourneyTransportType } from './types';
import { calculateGtfsItineraryFare, parseGtfsFares, type GtfsFareProduct, type GtfsFareRule, type ParsedGtfsFares } from './gtfsFares';
import { calculateCityTariffFare } from '../mobility/transportTariffs';
import { gtfsRealtimeTripUpdateKey, type GtfsRealtimeTripUpdate, type GtfsRealtimeTripUpdates } from './gtfsRealtime';
import { BoundedBestK, retainBoundedTripGroup, type BoundedTripGroup } from './boundedTripRetention';
import { compareStableId } from './stableOrdering';
import { allocateBoundedGraphBudgets } from './boundedGraphBudget';
import { BoundedPromiseCache } from './boundedPromiseCache';

const MAX_FEED_BYTES = 60 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const FAILED_FEED_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHED_GTFS_FEEDS = 32;
const MAX_ESTIMATED_GTFS_CACHE_BYTES = 256 * 1024 * 1024;
const MERGED_FEED_CACHE_TTL_MS = 60_000;
const MAX_MERGED_FEED_CACHE_ENTRIES = 2;
const MAX_DIRECT_STOPS_PER_SIDE = 20;
const MAX_NEAREST_STOPS_PER_SIDE = 20;
const MAX_STOPS_PER_SIDE = 48;
const MAX_STOPS_PER_ROUTE_PATTERN = 2;
const EARTH_RADIUS_M = 6_371_000;
const MAX_ROUTE_GEOMETRY_POINTS = 500;
// Bound the per-request materialized GTFS graph. A dense city feed can create
// millions of stop-pair objects before the later itinerary sampling limits
// apply; that used to exhaust the Node heap. The route-proportional ceiling
// preserves a fair slice for each line and makes truncation explicit.
const MAX_GTFS_GRAPH_SEGMENTS = 100_000;
const MAX_GTFS_GRAPH_SEGMENTS_PER_ROUTE = 5_000;
export const MAX_GTFS_TRANSFERS = 4;
export const DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS = 180;
export const DEFAULT_MAXIMUM_WAIT_SECONDS = 4 * 60 * 60;
export const DEFAULT_MAX_ACCESS_WALKING_METERS = 900;
export const DEFAULT_MAX_EGRESS_WALKING_METERS = 1000;
export const DEFAULT_MAX_TRANSFER_WALKING_METERS = 400;
const MINIMUM_INTERCITY_TRANSFER_BUFFER_SECONDS = 600;
const MINIMUM_SUBURBAN_TRANSFER_BUFFER_SECONDS = 300;

type CsvRow = Record<string, string>;
export type TransitJourneyMode = 'BUS' | 'MINIBUS' | 'RAIL' | 'TRAM' | 'TROLLEYBUS' | 'METRO' | 'FERRY' | 'FUNICULAR';
export type GtfsTransportType = 'bus' | 'marshrutka' | 'intercity_bus' | 'train' | 'suburban_train' | 'city_train' | 'tram' | 'trolleybus' | 'metro' | 'ferry' | 'funicular';

/** Keep a per-transfer wait bound within the total search horizon accepted by the planner. */
export function maximumGtfsWaitWithinJourney(maximumJourneySeconds: number,
  configuredMaximumWaitSeconds = DEFAULT_MAXIMUM_WAIT_SECONDS): number {
  if (!Number.isSafeInteger(maximumJourneySeconds) || maximumJourneySeconds < 1
    || !Number.isSafeInteger(configuredMaximumWaitSeconds) || configuredMaximumWaitSeconds < 0) {
    throw new TypeError('GTFS wait and journey bounds must be valid integer seconds');
  }
  return Math.min(maximumJourneySeconds, configuredMaximumWaitSeconds);
}

export interface GtfsTimetableFeed {
  fetchedAt: Date;
  timezone: string;
  routes: Map<string, { name: string; mode: TransitJourneyMode; transportType: GtfsTransportType; agencyId?: string; scheduleSemantics?: 'published_departures' | 'frequency_estimate' }>;
  stops: Map<string, { id: string; name: string; lon: number; lat: number; zoneId?: string; parentStation?: string; locationType?: number }>;
  trips: Map<string, { routeId: string; serviceId: string; headsign: string; shapeId?: string; directionId?: string }>;
  /** Actual GTFS shape coordinates, keyed by the feed's shape_id. */
  shapes?: Map<string, Array<[number, number]>>;
  stopTimes: Map<string, Array<{ stopId: string; sequence: number; arrivalSeconds: number; departureSeconds: number; pickupType: number; dropOffType: number; sourceStopId?: string; sourceParentStationId?: string; sourceStopName?: string; sourceStopCoordinates?: [number, number]; sourceZoneId?: string }>>;
  stopTimesByStop: Map<string, Array<{ tripId: string; index: number }>>;
  transfers?: GtfsTransferRule[];
  pathways?: GtfsPathway[];
  calendars: Map<string, { start: string; end: string; weekdays: boolean[] }>;
  exceptions: Map<string, Map<string, number>>;
  providersByRoute?: Map<string, { id: string; name: string; city: string; fetchedAt: Date }>;
  realtimeTripUpdates?: Map<string, GtfsRealtimeTripUpdate>;
  fareProducts?: Map<string, GtfsFareProduct>;
  fareRules?: Map<string, GtfsFareRule[]>;
  faresV2Present?: boolean;
}

export interface GtfsTransferRule {
  fromStopId: string;
  toStopId: string;
  transferType: number;
  minTransferTimeSeconds?: number;
  fromRouteId?: string;
  toRouteId?: string;
  fromTripId?: string;
  toTripId?: string;
}

export interface GtfsPathway {
  fromStopId: string;
  toStopId: string;
  fromCoordinates: [number, number];
  toCoordinates: [number, number];
  pathwayMode: number;
  bidirectional: boolean;
  traversalTimeSeconds?: number;
  lengthMeters?: number;
}

export interface GtfsTimetableSource {
  providerId: string;
  providerName: string;
  providerCity: string;
  feed: GtfsTimetableFeed;
  realtime?: GtfsRealtimeTripUpdates;
}

export interface GtfsDirectJourney {
  providerId: string;
  providerName: string;
  providerCity?: string;
  mode: TransitJourneyMode;
  routeId: string;
  routeName: string;
  headsign: string;
  tripId: string;
  originStop: { id: string; name: string; coordinates: [number, number] };
  destinationStop: { id: string; name: string; coordinates: [number, number] };
  /** Provider-scoped GTFS stop and parent-station IDs used by transfers/pathways. */
  originTransferNodeIds: string[];
  destinationTransferNodeIds: string[];
  transportType: GtfsTransportType;
  /** Distinguishes provider-published trip times from derived interval-based estimates. */
  scheduleSemantics: 'published_departures' | 'frequency_estimate';
  /** GTFS service date (YYYYMMDD) identifies which daily instance of tripId is used. */
  serviceDate: string;
  /** Original provider timetable values, preserved when realtime predictions are available. */
  scheduledDepartureAt: Date;
  scheduledArrivalAt: Date;
  /** Effective departure and arrival used for search and transfer feasibility. */
  departureAt: Date;
  arrivalAt: Date;
  sourceFreshAt: Date;
  distanceToOriginStopMeters: number;
  distanceFromDestinationStopMeters: number;
  /** Present only when the source supplied a usable GTFS shape for this ride segment. */
  routeGeometry?: Array<[number, number]>;
  /** Timed stop calls copied from this exact GTFS trip segment. */
  stops?: Array<{ id: string; name: string; coordinates: [number, number]; arrivalAt: string; departureAt: string; pickupType: number; dropOffType: number; skipped?: boolean }>;
  realtimeUpdatedAt?: Date;
  originZoneId?: string;
  destinationZoneId?: string;
  traveledZoneIds: string[];
}

interface SearchInput {
  providerId: string;
  providerName: string;
  origin: [number, number];
  destination: [number, number];
  earliestDeparture: Date;
  latestDeparture: Date;
  maximumStopDistanceMeters?: number;
  limit?: number;
  now?: Date;
}

export interface GtfsItinerarySearchInput extends SearchInput {
  maximumJourneySeconds?: number;
  maximumTransfers?: number;
  minimumTransferBufferSeconds?: number;
  maximumWaitSeconds?: number;
  /** Separate walk-shed limits keep the first and last mile explicit. */
  maximumAccessWalkingMeters?: number;
  maximumEgressWalkingMeters?: number;
  maximumTransferWalkingMeters?: number;
  allowedModes?: readonly TransitJourneyMode[];
  allowedTransportTypes?: readonly JourneyTransportType[];
  providerCity?: string;
}

export interface GtfsItinerary {
  id: string;
  providerId: string;
  providerName: string;
  segments: GtfsDirectJourney[];
  departureAt: Date;
  arrivalAt: Date;
  durationSeconds: number;
  /** Scheduled waiting from the requested start time, excluding walking and in-vehicle time. */
  waitingSeconds: number;
  transfers: number;
  walkingMeters: number;
  transferWalkingMeters: number[];
  transferWalkingSeconds: number[];
  transferWalkingGeometries: Array<Array<[number, number]> | null>;
  /** Preserve the exact feasibility inputs so routed footpaths can be revalidated. */
  transferInSeat: boolean[];
  transferMinimumBufferSeconds: number[];
  transferRuleMinimumSeconds: Array<number | null>;
  fare: ReturnType<typeof calculateGtfsItineraryFare>;
}

export interface GtfsItinerarySearchResult {
  itineraries: GtfsItinerary[];
  searchTruncated: boolean;
  resultLimitReached: boolean;
  candidateGraphTruncated: boolean;
}

/** Optional lower graph limits let tests exercise bounded retention deterministically. */
export interface GtfsGraphBudgetLimits {
  totalSegments?: number;
  segmentsPerRoute?: number;
}

type RetainedGtfsSegment = {
  segment: GtfsDirectJourney;
  fromIndex: number;
  toIndex: number;
  sampleRank?: [number, number, number, number, number];
  sampleKey?: string;
};
type RetainedGtfsTrip = BoundedTripGroup<RetainedGtfsSegment>;
// Small deterministic endpoint-only reservoir to use route-budget gaps left by whole-trip bundles.
const MAX_ROUTE_OVERFLOW_SEGMENTS = 200;

// Keep the same deterministic, order-independent sample for a feed snapshot.
// GTFS feeds are often written in departure-time order, so a simple prefix cap
// silently drops the later part of the requested search window.
function gtfsSegmentRetentionPriority(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Keep a balanced sample of GTFS candidates for the cross-provider scorer.
 * When comparable fares exist, an unknown fare must not receive the same
 * zero-cost score as the cheapest known fare. It remains eligible for the
 * other sampling objectives (time, transfers, and walking).
 */
export function rankGtfsItinerariesForCandidateSampling(itineraries: readonly GtfsItinerary[]): GtfsItinerary[] {
  if (!itineraries.length) return [];
  const comparableFares = itineraries.filter((itinerary) => itinerary.fare?.currency === 'UAH');
  const minDuration = Math.min(...itineraries.map((itinerary) => itinerary.durationSeconds));
  const maxDuration = Math.max(...itineraries.map((itinerary) => itinerary.durationSeconds));
  const minFare = comparableFares.length ? Math.min(...comparableFares.map((itinerary) => itinerary.fare!.priceMinor)) : 0;
  const maxFare = comparableFares.length ? Math.max(...comparableFares.map((itinerary) => itinerary.fare!.priceMinor)) : 0;
  const minTransfers = Math.min(...itineraries.map((itinerary) => itinerary.transfers));
  const maxTransfers = Math.max(...itineraries.map((itinerary) => itinerary.transfers));
  const minWalking = Math.min(...itineraries.map((itinerary) => itinerary.walkingMeters));
  const maxWalking = Math.max(...itineraries.map((itinerary) => itinerary.walkingMeters));
  const normalize = (value: number, min: number, max: number) => max === min ? 0 : (value - min) / (max - min);
  const score = (itinerary: GtfsItinerary) => {
    const hasComparableFare = itinerary.fare?.currency === 'UAH';
    const fareCost = comparableFares.length
      ? hasComparableFare ? normalize(itinerary.fare!.priceMinor, minFare, maxFare) : 1
      : 0;
    return 0.35 * normalize(itinerary.durationSeconds, minDuration, maxDuration)
      + 0.25 * fareCost
      + 0.10 * normalize(itinerary.transfers, minTransfers, maxTransfers)
      + 0.10 * normalize(itinerary.walkingMeters, minWalking, maxWalking)
      + 0.20 * (itinerary.transfers > 0 ? 0.3 : 0);
  };
  return [...itineraries].sort((a, b) => score(a) - score(b)
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
}

/**
 * Keep objective extremes when several provider searches are combined into
 * the cross-provider candidate pool. Arrival-only truncation can otherwise
 * remove every slow, low-fare route before CHEAPEST ranking gets a chance.
 */
export function selectGtfsCandidatesForCrossProviderSearch(
  itineraries: readonly GtfsItinerary[], maximum = 100,
): GtfsItinerary[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new TypeError('candidate maximum must be positive');
  if (itineraries.length <= maximum) return [...itineraries];

  const selected = new Map<string, GtfsItinerary>();
  const take = (ranked: readonly GtfsItinerary[], count: number) => {
    for (const item of ranked) {
      if (selected.size >= maximum || count <= 0) break;
      if (selected.has(item.id)) continue;
      selected.set(item.id, item);
      count--;
    }
  };
  const byArrival = [...itineraries].sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime()
    || a.departureAt.getTime() - b.departureAt.getTime() || compareStableId(a.id, b.id));
  const byDuration = [...itineraries].sort((a, b) => a.durationSeconds - b.durationSeconds
    || compareStableId(a.id, b.id));
  const byFare = itineraries.filter((item) => item.fare?.currency === 'UAH')
    .sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byTransfers = [...itineraries].sort((a, b) => a.transfers - b.transfers
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byWalking = [...itineraries].sort((a, b) => a.walkingMeters - b.walkingMeters
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const perObjective = Math.max(1, Math.floor(maximum / 5));
  take(byDuration, perObjective);
  take(byFare, perObjective);
  take(byTransfers, perObjective);
  take(byWalking, perObjective);
  take(rankGtfsItinerariesForCandidateSampling(itineraries), perObjective);
  take(byArrival, maximum - selected.size);
  return [...selected.values()].sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime()
    || a.departureAt.getTime() - b.departureAt.getTime() || compareStableId(a.id, b.id));
}

/** Keep useful boarding/alighting choices for the same scheduled vehicle chain. */
export function sampleGtfsTripChainCandidates(
  itineraries: readonly GtfsItinerary[], maximum = 2,
): GtfsItinerary[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new TypeError('trip-chain sample maximum must be positive');
  if (itineraries.length <= maximum) return [...itineraries];

  const selected = new Map<string, GtfsItinerary>();
  const take = (ranked: readonly GtfsItinerary[], count: number) => {
    for (const item of ranked) {
      if (selected.size >= maximum || count <= 0) break;
      if (selected.has(item.id)) continue;
      selected.set(item.id, item);
      count--;
    }
  };
  const byDuration = [...itineraries].sort((a, b) => a.durationSeconds - b.durationSeconds
    || compareStableId(a.id, b.id));
  const byFare = itineraries.filter((item) => item.fare?.currency === 'UAH')
    .sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byWalking = [...itineraries].sort((a, b) => a.walkingMeters - b.walkingMeters
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));

  const fastest = byDuration[0];
  if (fastest) selected.set(fastest.id, fastest);
  const cheapest = byFare[0];
  if (cheapest && selected.size < maximum
    && (fastest?.fare?.currency !== 'UAH' || cheapest.fare!.priceMinor < fastest.fare.priceMinor)) {
    selected.set(cheapest.id, cheapest);
  }
  take(byWalking, maximum - selected.size);
  take(rankGtfsItinerariesForCandidateSampling(itineraries), maximum - selected.size);
  take(byDuration, maximum - selected.size);
  return [...selected.values()];
}

/** Keep route-chain samples useful to the FASTEST, CHEAPEST, and balanced views. */
export function sampleGtfsRouteChainCandidates(
  itineraries: readonly GtfsItinerary[], maximum = 8,
): GtfsItinerary[] {
  if (!Number.isInteger(maximum) || maximum < 1) throw new TypeError('route-chain sample maximum must be positive');
  if (itineraries.length <= maximum) return [...itineraries];

  const selected = new Map<string, GtfsItinerary>();
  const take = (ranked: readonly GtfsItinerary[], count: number) => {
    for (const item of ranked) {
      if (selected.size >= maximum || count <= 0) break;
      if (selected.has(item.id)) continue;
      selected.set(item.id, item);
      count--;
    }
  };
  const byDuration = [...itineraries].sort((a, b) => a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byFare = itineraries.filter((item) => item.fare?.currency === 'UAH')
    .sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byTransfers = [...itineraries].sort((a, b) => a.transfers - b.transfers || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byWalking = [...itineraries].sort((a, b) => a.walkingMeters - b.walkingMeters || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const balanced = rankGtfsItinerariesForCandidateSampling(itineraries);

  take(byDuration, 2);
  take(byFare, 2);
  take(balanced, 2);
  take(byTransfers, 1);
  take(byWalking, 1);
  take(balanced, maximum - selected.size);
  return [...selected.values()];
}

export interface GtfsStopArrival {
  stopId: string;
  stopName: string;
  routeId: string;
  routeName: string;
  transportType: GtfsTransportType;
  tripId: string;
  headsign: string;
  scheduledArrivalAt: Date;
  predictedArrivalAt: Date;
  etaSeconds: number;
  source: 'SCHEDULE' | 'TRIP_UPDATE';
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  realtimeUpdatedAt?: Date;
}

function csvRows(text: string | undefined): CsvRow[] {
  if (!text) return [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((name) => name.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(header.map((name, index) => [name, values[index] ?? '']));
  });
}

function integer(value: string | undefined, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function gtfsTime(value: string | undefined): number | null {
  if (!value || !/^\d{1,3}:\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes, seconds] = value.split(':').map(Number);
  if (minutes > 59 || seconds > 59 || hours > 71) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function routeMode(routeType: number, routeName: string): { mode: TransitJourneyMode; transportType: GtfsTransportType } | null {
  const normalizedName = routeName.normalize('NFKC').toLocaleLowerCase('uk-UA');
  if (normalizedName.includes('міжміськ') || normalizedName.includes('intercity')) return { mode: 'BUS', transportType: 'intercity_bus' };
  const label = routeTypeLabel(routeType, routeName);
  if (label === 'bus') return { mode: 'BUS', transportType: 'bus' };
  if (label === 'marshrutka') return { mode: 'MINIBUS', transportType: 'marshrutka' };
  if (label === 'train') return { mode: 'RAIL', transportType: 'train' };
  if (label === 'suburban') return { mode: 'RAIL', transportType: 'suburban_train' };
  if (label === 'city_train') return { mode: 'RAIL', transportType: 'city_train' };
  if (label === 'funicular') return { mode: 'FUNICULAR', transportType: 'funicular' };
  if (label === 'tram') return { mode: 'TRAM', transportType: 'tram' };
  if (label === 'trolleybus') return { mode: 'TROLLEYBUS', transportType: 'trolleybus' };
  if (label === 'metro') return { mode: 'METRO', transportType: 'metro' };
  if (label === 'ferry') return { mode: 'FERRY', transportType: 'ferry' };
  return null;
}

export function parseGtfsTimetable(files: Record<string, Uint8Array>, fetchedAt = new Date()): GtfsTimetableFeed {
  const text = (name: string) => files[name] ? strFromU8(files[name]) : '';
  const reportedTimezone = csvRows(text('agency.txt'))[0]?.agency_timezone?.trim();
  if (!reportedTimezone || !isValidTimezone(reportedTimezone)) throw new Error('GTFS feed must include a valid agency_timezone');
  // Ukraine feeds use both the current IANA name and its deprecated alias.
  // Canonicalize before providers are grouped so Kyiv and Lviv timetables can
  // participate in one cross-provider itinerary search.
  const timezone = reportedTimezone.toLocaleLowerCase('en-US') === 'europe/kiev' ? 'Europe/Kyiv' : reportedTimezone;

  const routes = new Map<string, { name: string; mode: TransitJourneyMode; transportType: GtfsTransportType; agencyId?: string }>();
  for (const row of csvRows(text('routes.txt'))) {
    const name = row.route_short_name?.trim() || row.route_long_name?.trim() || row.route_id;
    const route = routeMode(integer(row.route_type, -1), `${row.route_short_name ?? ''} ${row.route_long_name ?? ''} ${row.route_desc ?? ''}`);
    if (!route || !row.route_id) continue;
    routes.set(row.route_id, { name, ...route, ...(row.agency_id?.trim() ? { agencyId: row.agency_id.trim() } : {}) });
  }

  const stops = new Map<string, { id: string; name: string; lon: number; lat: number; zoneId?: string; parentStation?: string; locationType?: number }>();
  for (const row of csvRows(text('stops.txt'))) {
    const lon = Number(row.stop_lon), lat = Number(row.stop_lat);
    const locationType = row.location_type?.trim() ? integer(row.location_type, -1) : 0;
    if (!row.stop_id || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90
      || (lon === 0 && lat === 0) || locationType < 0 || locationType > 4) continue;
    stops.set(row.stop_id, { id: row.stop_id, name: row.stop_name?.trim() || row.stop_id, lon, lat,
      ...(row.zone_id?.trim() ? { zoneId: row.zone_id.trim() } : {}),
      ...(row.parent_station?.trim() ? { parentStation: row.parent_station.trim() } : {}),
      ...(locationType !== 0 ? { locationType } : {}) });
  }

  const trips = new Map<string, { routeId: string; serviceId: string; headsign: string; shapeId?: string; directionId?: string }>();
  for (const row of csvRows(text('trips.txt'))) {
    if (!row.trip_id || !row.service_id || !routes.has(row.route_id)) continue;
    trips.set(row.trip_id, { routeId: row.route_id, serviceId: row.service_id, headsign: row.trip_headsign?.trim() || '',
      ...(row.shape_id?.trim() ? { shapeId: row.shape_id.trim() } : {}),
      ...(row.direction_id?.trim() ? { directionId: row.direction_id.trim() } : {}) });
  }

  const referencedShapes = new Set([...trips.values()].flatMap((trip) => trip.shapeId ? [trip.shapeId] : []));
  const shapePoints = new Map<string, Array<{ sequence: number; coordinates: [number, number] }>>();
  for (const row of csvRows(text('shapes.txt'))) {
    const shapeId = row.shape_id?.trim();
    if (!shapeId || !referencedShapes.has(shapeId)) continue;
    const lon = Number(row.shape_pt_lon), lat = Number(row.shape_pt_lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90 || (lon === 0 && lat === 0)) continue;
    const points = shapePoints.get(shapeId) ?? [];
    points.push({ sequence: integer(row.shape_pt_sequence, -1), coordinates: [lon, lat] });
    shapePoints.set(shapeId, points);
  }
  const shapes = new Map([...shapePoints].map(([shapeId, points]) => [shapeId,
    points.sort((a, b) => a.sequence - b.sequence).map(({ coordinates }) => coordinates),
  ]));

  const stopTimes: GtfsTimetableFeed['stopTimes'] = new Map();
  for (const row of csvRows(text('stop_times.txt'))) {
    if (!trips.has(row.trip_id) || !stops.has(row.stop_id)) continue;
    const arrivalSeconds = gtfsTime(row.arrival_time), departureSeconds = gtfsTime(row.departure_time);
    if (arrivalSeconds === null || departureSeconds === null) continue;
    const list = stopTimes.get(row.trip_id) ?? [];
    const sourceStop = stops.get(row.stop_id);
    list.push({ stopId: row.stop_id, sourceStopId: row.stop_id,
      ...(sourceStop?.parentStation ? { sourceParentStationId: sourceStop.parentStation } : {}),
      sequence: integer(row.stop_sequence, -1), arrivalSeconds, departureSeconds,
      pickupType: integer(row.pickup_type), dropOffType: integer(row.drop_off_type),
      ...(sourceStop ? { sourceStopName: sourceStop.name, sourceStopCoordinates: [sourceStop.lon, sourceStop.lat] as [number, number],
        ...(sourceStop.zoneId ? { sourceZoneId: sourceStop.zoneId } : {}) } : {}) });
    stopTimes.set(row.trip_id, list);
  }
  for (const list of stopTimes.values()) list.sort((a, b) => a.sequence - b.sequence);
  const stopTimesByStop = new Map<string, Array<{ tripId: string; index: number }>>();
  for (const [tripId, list] of stopTimes) list.forEach((entry, index) => {
    const matches = stopTimesByStop.get(entry.stopId) ?? [];
    matches.push({ tripId, index });
    stopTimesByStop.set(entry.stopId, matches);
  });

  const calendars = new Map<string, { start: string; end: string; weekdays: boolean[] }>();
  for (const row of csvRows(text('calendar.txt'))) {
    if (!row.service_id || !/^\d{8}$/.test(row.start_date) || !/^\d{8}$/.test(row.end_date)) continue;
    calendars.set(row.service_id, { start: row.start_date, end: row.end_date,
      weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => row[day] === '1') });
  }
  const exceptions = new Map<string, Map<string, number>>();
  for (const row of csvRows(text('calendar_dates.txt'))) {
    if (!row.service_id || !/^\d{8}$/.test(row.date) || !['1', '2'].includes(row.exception_type)) continue;
    const byDate = exceptions.get(row.service_id) ?? new Map<string, number>();
    byDate.set(row.date, Number(row.exception_type));
    exceptions.set(row.service_id, byDate);
  }

  const transfers: GtfsTransferRule[] = [];
  for (const row of csvRows(text('transfers.txt'))) {
    const transferType = row.transfer_type?.trim() ? integer(row.transfer_type, -1) : -1;
    const rawMinimum = row.min_transfer_time?.trim();
    const minTransferTimeSeconds = rawMinimum ? integer(rawMinimum, -1) : undefined;
    const fromRouteId = row.from_route_id?.trim() || undefined;
    const toRouteId = row.to_route_id?.trim() || undefined;
    const fromTripId = row.from_trip_id?.trim() || undefined;
    const toTripId = row.to_trip_id?.trim() || undefined;
    if (!stops.has(row.from_stop_id) || !stops.has(row.to_stop_id) || transferType < 0 || transferType > 5
      || (rawMinimum && (!Number.isInteger(minTransferTimeSeconds) || minTransferTimeSeconds! < 0))
      || (transferType === 2 && minTransferTimeSeconds === undefined)
      || (fromRouteId && !routes.has(fromRouteId)) || (toRouteId && !routes.has(toRouteId))
      || (fromTripId && !trips.has(fromTripId)) || (toTripId && !trips.has(toTripId))
      || ([4, 5].includes(transferType) && (!fromTripId || !toTripId))) continue;
    transfers.push({ fromStopId: row.from_stop_id, toStopId: row.to_stop_id, transferType,
      ...(minTransferTimeSeconds !== undefined ? { minTransferTimeSeconds } : {}),
      ...(fromRouteId ? { fromRouteId } : {}), ...(toRouteId ? { toRouteId } : {}),
      ...(fromTripId ? { fromTripId } : {}), ...(toTripId ? { toTripId } : {}) });
  }

  const pathways: GtfsPathway[] = [];
  for (const row of csvRows(text('pathways.txt'))) {
    const pathwayMode = integer(row.pathway_mode, -1);
    const bidirectional = row.is_bidirectional === '1';
    const rawTraversalTime = row.traversal_time?.trim();
    const traversalTimeSeconds = rawTraversalTime ? integer(rawTraversalTime, -1) : undefined;
    const rawLength = row.length?.trim();
    const lengthMeters = rawLength ? Number(rawLength) : undefined;
    if (!stops.has(row.from_stop_id) || !stops.has(row.to_stop_id) || pathwayMode < 1 || pathwayMode > 7
      || !['0', '1'].includes(row.is_bidirectional)
      || (rawTraversalTime && (!Number.isInteger(traversalTimeSeconds) || traversalTimeSeconds! < 0))
      || (rawLength && (!Number.isFinite(lengthMeters) || lengthMeters! < 0))) continue;
    const fromStop = stops.get(row.from_stop_id)!, toStop = stops.get(row.to_stop_id)!;
    pathways.push({ fromStopId: row.from_stop_id, toStopId: row.to_stop_id,
      fromCoordinates: [fromStop.lon, fromStop.lat], toCoordinates: [toStop.lon, toStop.lat], pathwayMode, bidirectional,
      ...(traversalTimeSeconds !== undefined ? { traversalTimeSeconds } : {}),
      ...(lengthMeters !== undefined ? { lengthMeters } : {}) });
  }

  const parsedFares: ParsedGtfsFares = parseGtfsFares(files);
  return { fetchedAt, timezone, routes, stops, trips, shapes, stopTimes, stopTimesByStop, calendars, exceptions, transfers, pathways,
    fareProducts: parsedFares.products, fareRules: parsedFares.rules, faresV2Present: parsedFares.faresV2Present };
}

/**
 * Combines compatible static feeds so transfers can cross provider boundaries.
 * Stops join by matching normalized names and close coordinates. A named city
 * railway-station stop may also join a nearby stop served by a national rail
 * timetable, despite operator-specific names; the transfer remains an
 * explicit, timed walking leg in the itinerary.
 */
function buildMergedGtfsTimetables(sources: readonly GtfsTimetableSource[]): GtfsTimetableFeed | null {
  if (sources.length === 0) return null;
  const ordered = [...sources].sort((a, b) => compareStableId(a.providerId, b.providerId));
  const timezone = ordered[0].feed.timezone;
  if (ordered.some((source) => source.feed.timezone !== timezone)) throw new TypeError('GTFS feeds with different timezones cannot be combined');

  const routes: GtfsTimetableFeed['routes'] = new Map();
  const stops: GtfsTimetableFeed['stops'] = new Map();
  const trips: GtfsTimetableFeed['trips'] = new Map();
  const shapes: NonNullable<GtfsTimetableFeed['shapes']> = new Map();
  const stopTimes: GtfsTimetableFeed['stopTimes'] = new Map();
  const calendars: GtfsTimetableFeed['calendars'] = new Map();
  const exceptions: GtfsTimetableFeed['exceptions'] = new Map();
  const transfers: NonNullable<GtfsTimetableFeed['transfers']> = [];
  const pathways: NonNullable<GtfsTimetableFeed['pathways']> = [];
  const fareProducts: NonNullable<GtfsTimetableFeed['fareProducts']> = new Map();
  const fareRules: NonNullable<GtfsTimetableFeed['fareRules']> = new Map();
  const realtimeTripUpdates: NonNullable<GtfsTimetableFeed['realtimeTripUpdates']> = new Map();
  let faresV2Present = false;
  const providersByRoute = new Map<string, { id: string; name: string; city: string; fetchedAt: Date }>();
  const stopsByName = new Map<string, Array<{ id: string; lon: number; lat: number }>>();
  let canonicalStopIndex = 0;
  const namedCityStations = ordered.flatMap((source) => source.providerCity === 'Україна' ? [] : [...source.feed.stops.values()]
    .filter((stop) => /(?:залізничн\p{L}*|вокзал|railway station|train station)/u.test(
      stop.name.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
    ))
    .map((stop) => ({ source, stop })));

  for (const source of ordered) {
    const prefix = `${encodeURIComponent(source.providerId)}:`;
    for (const update of (source.realtime?.fresh ? source.realtime.updates.values() : [])) {
      const trip = source.feed.trips.get(update.tripId);
      if (!trip || update.relationship === 'OTHER' || (update.routeId && update.routeId !== trip.routeId)) continue;
      const tripId = `${prefix}${update.tripId}`;
      realtimeTripUpdates.set(gtfsRealtimeTripUpdateKey(tripId, update.startDate), { ...update, tripId });
    }
    const remappedStops = new Map<string, string>();
    const railServedStops = new Set<string>();
    for (const [stopId, entries] of source.feed.stopTimesByStop) {
      if (entries.some(({ tripId }) => {
        const trip = source.feed.trips.get(tripId);
        const type = trip && source.feed.routes.get(trip.routeId)?.transportType;
        return type === 'train' || type === 'suburban_train' || type === 'city_train';
      })) railServedStops.add(stopId);
    }
    const nearbyRailwayInterchanges = source.providerCity === 'Україна'
      ? new Set([...railServedStops].filter((stopId) => {
        const stop = source.feed.stops.get(stopId);
        return Boolean(stop && namedCityStations.some(({ source: citySource, stop: cityStop }) => citySource.providerId !== source.providerId
          && distanceMeters([stop.lon, stop.lat], [cityStop.lon, cityStop.lat]) <= 150));
      }))
      : new Set<string>();
    for (const stop of source.feed.stops.values()) {
      const normalizedName = stop.name.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const namedRailwayStation = /(?:залізничн\p{L}*|вокзал|railway station|train station)/u.test(normalizedName);
      const stationAlias = namedRailwayStation || nearbyRailwayInterchanges.has(stop.id);
      const nameKey = stationAlias ? 'known railway station interchange' : normalizedName;
      if (!nameKey) continue;
      const candidates = stopsByName.get(nameKey) ?? [];
      const interchangeRadiusMeters = stationAlias ? 150 : 30;
      const match = candidates.find((candidate) => distanceMeters([stop.lon, stop.lat], [candidate.lon, candidate.lat]) <= interchangeRadiusMeters);
      const id = match?.id ?? `canonical-stop-${++canonicalStopIndex}`;
      if (!match) {
        const canonical = { id, name: stop.name, lon: stop.lon, lat: stop.lat,
          ...(stop.zoneId ? { zoneId: `${prefix}${stop.zoneId}` } : {}) };
        stops.set(id, canonical);
        candidates.push({ id, lon: stop.lon, lat: stop.lat });
        stopsByName.set(nameKey, candidates);
      } else if (stationAlias && !candidates.some((candidate) => candidate.id === id
        && candidate.lon === stop.lon && candidate.lat === stop.lat)) {
        // Keep every source platform coordinate as an alias of the canonical
        // interchange. Otherwise a third feed can be within 150 m of a
        // secondary platform, yet appear too far from the first platform
        // retained as the canonical representative (common at large stations).
        candidates.push({ id, lon: stop.lon, lat: stop.lat });
      }
      remappedStops.set(stop.id, id);
    }

    for (const [routeId, route] of source.feed.routes) {
      const mergedRouteId = `${prefix}${routeId}`;
      routes.set(mergedRouteId, route);
      providersByRoute.set(mergedRouteId, { id: source.providerId, name: source.providerName, city: source.providerCity, fetchedAt: source.feed.fetchedAt });
    }
    faresV2Present ||= source.feed.faresV2Present === true;
    for (const [fareId, product] of source.feed.fareProducts ?? []) {
      const mergedFareId = `${prefix}${fareId}`;
      fareProducts.set(mergedFareId, { ...product, id: mergedFareId, providerId: source.providerId });
    }
    for (const [fareId, rules] of source.feed.fareRules ?? []) {
      const mergedFareId = `${prefix}${fareId}`;
      fareRules.set(mergedFareId, rules.map((rule) => ({
        ...rule, fareId: mergedFareId,
        ...(rule.routeId ? { routeId: `${prefix}${rule.routeId}` } : {}),
        ...(rule.originZoneId ? { originZoneId: `${prefix}${rule.originZoneId}` } : {}),
        ...(rule.destinationZoneId ? { destinationZoneId: `${prefix}${rule.destinationZoneId}` } : {}),
        ...(rule.containsZoneId ? { containsZoneId: `${prefix}${rule.containsZoneId}` } : {}),
      })));
    }
    for (const [shapeId, coordinates] of source.feed.shapes ?? []) shapes.set(`${prefix}${shapeId}`, coordinates);
    for (const [serviceId, calendar] of source.feed.calendars) calendars.set(`${prefix}${serviceId}`, calendar);
    for (const [serviceId, byDate] of source.feed.exceptions) exceptions.set(`${prefix}${serviceId}`, new Map(byDate));
    for (const rule of source.feed.transfers ?? []) transfers.push({
      ...rule, fromStopId: `${prefix}${rule.fromStopId}`, toStopId: `${prefix}${rule.toStopId}`,
      ...(rule.fromRouteId ? { fromRouteId: `${prefix}${rule.fromRouteId}` } : {}),
      ...(rule.toRouteId ? { toRouteId: `${prefix}${rule.toRouteId}` } : {}),
      ...(rule.fromTripId ? { fromTripId: `${prefix}${rule.fromTripId}` } : {}),
      ...(rule.toTripId ? { toTripId: `${prefix}${rule.toTripId}` } : {}),
    });
    for (const pathway of source.feed.pathways ?? []) pathways.push({
      ...pathway, fromStopId: `${prefix}${pathway.fromStopId}`, toStopId: `${prefix}${pathway.toStopId}`,
    });
    for (const [tripId, trip] of source.feed.trips) {
      const mergedTripId = `${prefix}${tripId}`;
      const mergedRouteId = `${prefix}${trip.routeId}`;
      const mergedServiceId = `${prefix}${trip.serviceId}`;
      if (!routes.has(mergedRouteId)) continue;
      trips.set(mergedTripId, { ...trip, routeId: mergedRouteId, serviceId: mergedServiceId,
        ...(trip.shapeId ? { shapeId: `${prefix}${trip.shapeId}` } : {}) });
      const entries = source.feed.stopTimes.get(tripId)?.flatMap((entry) => {
        const stopId = remappedStops.get(entry.stopId);
        return stopId ? [{ ...entry, stopId,
          ...(entry.sourceStopId ? { sourceStopId: `${prefix}${entry.sourceStopId}` } : { sourceStopId: `${prefix}${entry.stopId}` }),
          ...(entry.sourceParentStationId ? { sourceParentStationId: `${prefix}${entry.sourceParentStationId}` } : {}),
          ...(entry.sourceZoneId ? { sourceZoneId: `${prefix}${entry.sourceZoneId}` } : {}) }] : [];
      }) ?? [];
      if (entries.length >= 2) stopTimes.set(mergedTripId, entries);
      else trips.delete(mergedTripId);
    }
  }

  const stopTimesByStop: GtfsTimetableFeed['stopTimesByStop'] = new Map();
  for (const [tripId, entries] of stopTimes) entries.forEach((entry, index) => {
    const matches = stopTimesByStop.get(entry.stopId) ?? [];
    matches.push({ tripId, index });
    stopTimesByStop.set(entry.stopId, matches);
  });
  const fetchedAt = new Date(Math.min(...ordered.map((source) => source.feed.fetchedAt.getTime())));
  return { fetchedAt, timezone, routes, stops, trips, shapes, stopTimes, stopTimesByStop, calendars, exceptions, transfers, pathways,
    providersByRoute, fareProducts, fareRules, faresV2Present, realtimeTripUpdates };
}

const mergeObjectIds = new WeakMap<object, number>();
let nextMergeObjectId = 0;
function mergeObjectId(value: object): number {
  let id = mergeObjectIds.get(value);
  if (id === undefined) { id = ++nextMergeObjectId; mergeObjectIds.set(value, id); }
  return id;
}
const mergedFeedCache = new Map<string, { cachedAt: number; feed: GtfsTimetableFeed }>();

/** Reuse the expensive provider-prefix/cross-feed merge for a short burst of route searches. */
export function mergeGtfsTimetables(sources: readonly GtfsTimetableSource[]): GtfsTimetableFeed | null {
  if (sources.length === 0) return null;
  const cacheKey = sources.map((source) => [
    source.providerId, source.providerName, source.providerCity, mergeObjectId(source.feed),
    source.realtime ? `${mergeObjectId(source.realtime.updates)}:${source.realtime.feedTimestamp.getTime()}:${Number(source.realtime.fresh)}` : '-',
  ].join('\u0000')).sort().join('\u0001');
  const now = Date.now();
  const cached = mergedFeedCache.get(cacheKey);
  if (cached && now - cached.cachedAt < MERGED_FEED_CACHE_TTL_MS) {
    mergedFeedCache.delete(cacheKey);
    mergedFeedCache.set(cacheKey, cached);
    return cached.feed;
  }
  if (cached) mergedFeedCache.delete(cacheKey);
  const feed = buildMergedGtfsTimetables(sources);
  if (!feed) return null;
  mergedFeedCache.set(cacheKey, { cachedAt: now, feed });
  while (mergedFeedCache.size > MAX_MERGED_FEED_CACHE_ENTRIES) {
    const oldestKey = mergedFeedCache.keys().next().value;
    if (oldestKey === undefined) break;
    mergedFeedCache.delete(oldestKey);
  }
  return feed;
}

function isValidTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); return true; } catch { return false; }
}

const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();
function timezoneFormatter(timezone: string, includeTime: boolean): Intl.DateTimeFormat {
  const key = `${timezone}:${includeTime ? 'datetime' : 'date'}`;
  let formatter = timezoneFormatters.get(key);
  if (!formatter) {
    formatter = includeTime
      ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      : new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    timezoneFormatters.set(key, formatter);
  }
  return formatter;
}

function localDate(date: Date, timezone: string): string {
  const parts = timezoneFormatter(timezone, false).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}

function weekdayFor(date: string): number {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)))).getUTCDay();
}

function serviceRuns(feed: GtfsTimetableFeed, serviceId: string, date: string): boolean {
  const exception = feed.exceptions.get(serviceId)?.get(date);
  if (exception !== undefined) return exception === 1;
  const calendar = feed.calendars.get(serviceId);
  if (!calendar || date < calendar.start || date > calendar.end) return false;
  const mondayFirst = (weekdayFor(date) + 6) % 7;
  return calendar.weekdays[mondayFirst] === true;
}

function localServiceTimeToUtc(serviceDate: string, secondsAfterMidnight: number, timezone: string): Date | null {
  const dayOffset = Math.floor(secondsAfterMidnight / 86400);
  const time = secondsAfterMidnight % 86400;
  const base = Date.UTC(Number(serviceDate.slice(0, 4)), Number(serviceDate.slice(4, 6)) - 1, Number(serviceDate.slice(6, 8)) + dayOffset);
  const target = base + time * 1000;
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = timezoneFormatter(timezone, true).formatToParts(new Date(guess));
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    guess += target - represented;
  }
  const result = new Date(guess);
  if (localDate(result, timezone) !== dateStringAfter(serviceDate, dayOffset)) return null;
  return result;
}

function createServiceTimeConverter(timezone: string): (serviceDate: string, secondsAfterMidnight: number) => Date | null {
  const cache = new Map<string, Date | null>();
  return (serviceDate, secondsAfterMidnight) => {
    const key = `${serviceDate}:${secondsAfterMidnight}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const converted = localServiceTimeToUtc(serviceDate, secondsAfterMidnight, timezone);
    cache.set(key, converted);
    return converted;
  };
}

function dateStringAfter(date: string, days: number): string {
  const value = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)) + days));
  return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Return upcoming arrivals at one provider-scoped GTFS stop. Predictions only
 * use a fresh, exact-trip GTFS-Realtime TripUpdate; vehicle GPS alone is not
 * converted into an ETA here.
 */
export function findGtfsStopArrivals(
  feed: GtfsTimetableFeed,
  stopId: string,
  options: { now?: Date; horizonSeconds?: number; limit?: number; routeId?: string; headsign?: string } = {},
): GtfsStopArrival[] {
  const now = options.now ?? new Date();
  const horizonSeconds = options.horizonSeconds ?? 6 * 60 * 60;
  const limit = options.limit ?? 20;
  if (!stopId || stopId.length > 255) throw new TypeError('stop ID must contain 1 to 255 characters');
  if (!Number.isFinite(now.getTime())) throw new TypeError('now must be a valid date');
  if (!Number.isInteger(horizonSeconds) || horizonSeconds < 60 || horizonSeconds > 48 * 60 * 60) {
    throw new TypeError('arrival horizon must be between 60 and 172800 seconds');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('arrival limit must be between 1 and 50');
  const routeId = options.routeId?.trim();
  const headsign = options.headsign?.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk-UA');
  if (routeId !== undefined && (!routeId || routeId.length > 255)) throw new TypeError('route ID must contain 1 to 255 characters');
  if (headsign !== undefined && (!headsign || headsign.length > 255)) throw new TypeError('headsign must contain 1 to 255 characters');

  const stop = feed.stops.get(stopId);
  if (!stop) return [];
  const horizonAt = new Date(now.getTime() + horizonSeconds * 1000);
  const firstServiceDate = localDate(now, feed.timezone);
  const lastServiceDate = localDate(horizonAt, feed.timezone);
  // GTFS permits stop times through 71:59:59, so an arrival just after
  // midnight can belong to a service day up to two calendar days earlier.
  const serviceDates = new Set<string>();
  const firstRelevantDate = dateStringAfter(firstServiceDate, -2);
  const daysToLast = Math.round((Date.UTC(Number(lastServiceDate.slice(0, 4)), Number(lastServiceDate.slice(4, 6)) - 1, Number(lastServiceDate.slice(6, 8)))
    - Date.UTC(Number(firstRelevantDate.slice(0, 4)), Number(firstRelevantDate.slice(4, 6)) - 1, Number(firstRelevantDate.slice(6, 8)))) / 86_400_000);
  for (let offset = 0; offset <= daysToLast; offset++) serviceDates.add(dateStringAfter(firstRelevantDate, offset));
  const toUtc = createServiceTimeConverter(feed.timezone);
  const arrivals: GtfsStopArrival[] = [];
  for (const entry of feed.stopTimesByStop.get(stopId) ?? []) {
    const trip = feed.trips.get(entry.tripId);
    const route = trip && feed.routes.get(trip.routeId);
    const stopTime = feed.stopTimes.get(entry.tripId)?.[entry.index];
    if (!trip || !route || !stopTime || stopTime.pickupType !== 0
      || (routeId && trip.routeId !== routeId)
      || (headsign && trip.headsign.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk-UA') !== headsign)) continue;

    for (const serviceDate of serviceDates) {
      if (!serviceRuns(feed, trip.serviceId, serviceDate)) continue;
      const scheduledArrivalAt = toUtc(serviceDate, stopTime.arrivalSeconds);
      if (!scheduledArrivalAt || scheduledArrivalAt > horizonAt) continue;
      const dated = datedTripStops(feed, entry.tripId, serviceDate);
      const predicted = dated.stops[entry.index];
      if (!predicted || predicted.skipped || predicted.arrivalAt < now || predicted.arrivalAt > horizonAt) continue;

      const update = dated.update?.stops.find((item) => item.stopSequence === stopTime.sequence);
      const hasRealtimeEvent = update?.relationship !== 'NO_DATA'
        && Boolean(update?.arrival?.time || update?.arrival?.delaySeconds !== undefined
          || update?.departure?.time || update?.departure?.delaySeconds !== undefined);
      const exactArrival = Boolean(update?.arrival?.time || update?.arrival?.delaySeconds !== undefined);
      const source = hasRealtimeEvent ? 'TRIP_UPDATE' : 'SCHEDULE';
      arrivals.push({ stopId, stopName: stopTime.sourceStopName ?? stop.name,
        routeId: trip.routeId, routeName: route.name, transportType: route.transportType,
        tripId: entry.tripId, headsign: trip.headsign,
        scheduledArrivalAt, predictedArrivalAt: predicted.arrivalAt,
        etaSeconds: Math.max(0, Math.ceil((predicted.arrivalAt.getTime() - now.getTime()) / 1000)),
        source, confidence: exactArrival ? 'HIGH' : hasRealtimeEvent ? 'MEDIUM' : 'LOW',
        ...(hasRealtimeEvent && dated.update ? { realtimeUpdatedAt: dated.update.updatedAt } : {}) });
    }
  }
  return arrivals.sort((a, b) => a.predictedArrivalAt.getTime() - b.predictedArrivalAt.getTime()
    || compareStableId(a.routeId, b.routeId) || compareStableId(a.tripId, b.tripId)).slice(0, limit);
}

function distanceMeters(a: [number, number], b: [number, number]): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(b[1] - a[1]), dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const shapeSnapCache = new WeakMap<GtfsTimetableFeed, Map<string, Array<{ index: number; distance: number }>>>();

function nearestShapeIndexes(feed: GtfsTimetableFeed, shapeId: string, shape: Array<[number, number]>, point: [number, number]): Array<{ index: number; distance: number }> {
  let cache = shapeSnapCache.get(feed);
  if (!cache) { cache = new Map(); shapeSnapCache.set(feed, cache); }
  const key = `${shapeId}:${point[0].toFixed(6)},${point[1].toFixed(6)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const closest = shape.map((coordinate, index) => ({ index, distance: distanceMeters(coordinate, point) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, 8);
  cache.set(key, closest);
  return closest;
}

function routeGeometryForTrip(feed: GtfsTimetableFeed, tripId: string, fromIndex: number, toIndex: number): Array<[number, number]> | undefined {
  const trip = feed.trips.get(tripId);
  const shapeId = trip?.shapeId;
  const shape = shapeId ? feed.shapes?.get(shapeId) : undefined;
  const stops = feed.stopTimes.get(tripId);
  const from = stops?.[fromIndex]?.sourceStopCoordinates;
  const to = stops?.[toIndex]?.sourceStopCoordinates;
  if (!shapeId || !shape || shape.length < 2 || !from || !to) return undefined;

  const starts = nearestShapeIndexes(feed, shapeId, shape, from);
  const ends = nearestShapeIndexes(feed, shapeId, shape, to);
  let best: { start: number; end: number; snapDistance: number } | undefined;
  for (const start of starts) for (const end of ends) {
    if (start.index >= end.index) continue;
    const snapDistance = start.distance + end.distance;
    if (!best || snapDistance < best.snapDistance) best = { start: start.index, end: end.index, snapDistance };
  }
  // Refuse distant shape matches; on loops this avoids drawing the wrong direction.
  if (!best || best.snapDistance > 600) return undefined;

  const coordinates: Array<[number, number]> = [];
  const append = (coordinate: [number, number]) => {
    const previous = coordinates.at(-1);
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate);
  };
  append(from);
  for (const coordinate of shape.slice(best.start, best.end + 1)) append(coordinate);
  append(to);
  if (coordinates.length <= MAX_ROUTE_GEOMETRY_POINTS) return coordinates;
  return Array.from({ length: MAX_ROUTE_GEOMETRY_POINTS }, (_, index) =>
    coordinates[Math.round(index * (coordinates.length - 1) / (MAX_ROUTE_GEOMETRY_POINTS - 1))],
  );
}

type DatedTripStop = { arrivalAt: Date; departureAt: Date; skipped: boolean; updated: boolean };

function stopCallsForTrip(feed: GtfsTimetableFeed, tripId: string, fromIndex: number, toIndex: number, serviceDate: string, datedStops?: DatedTripStop[]) {
  const calls = feed.stopTimes.get(tripId)?.slice(fromIndex, toIndex + 1) ?? [];
  const serviceTimeToUtc = createServiceTimeConverter(feed.timezone);
  return calls.flatMap((call, relativeIndex) => {
    const stop = feed.stops.get(call.stopId);
    const datedStop = datedStops?.[fromIndex + relativeIndex];
    const arrivalAt = datedStop?.arrivalAt ?? serviceTimeToUtc(serviceDate, call.arrivalSeconds);
    const departureAt = datedStop?.departureAt ?? serviceTimeToUtc(serviceDate, call.departureSeconds);
    if (!stop || !arrivalAt || !departureAt) return [];
    return [{ id: stop.id, name: call.sourceStopName ?? stop.name,
      coordinates: call.sourceStopCoordinates ?? [stop.lon, stop.lat] as [number, number],
      arrivalAt: arrivalAt.toISOString(), departureAt: departureAt.toISOString(),
      pickupType: datedStop?.skipped ? 1 : call.pickupType, dropOffType: datedStop?.skipped ? 1 : call.dropOffType,
      ...(datedStop?.skipped ? { skipped: true } : {}) }];
  });
}

function datedTripStops(feed: GtfsTimetableFeed, tripId: string, serviceDate: string): { stops: DatedTripStop[]; update?: GtfsRealtimeTripUpdate } {
  const scheduled = feed.stopTimes.get(tripId) ?? [];
  const serviceTimeToUtc = createServiceTimeConverter(feed.timezone);
  const update = feed.realtimeTripUpdates?.get(gtfsRealtimeTripUpdateKey(tripId, serviceDate));
  if (update?.relationship === 'CANCELED' || update?.relationship === 'DELETED') return { stops: [], update };
  const updatesBySequence = new Map((update?.stops ?? []).map((stop) => [stop.stopSequence, stop]));
  let inheritedDelaySeconds: number | undefined;
  const stops = scheduled.flatMap((stopTime): DatedTripStop[] => {
    const scheduledArrival = serviceTimeToUtc(serviceDate, stopTime.arrivalSeconds);
    const scheduledDeparture = serviceTimeToUtc(serviceDate, stopTime.departureSeconds);
    if (!scheduledArrival || !scheduledDeparture) return [];
    const stopUpdate = updatesBySequence.get(stopTime.sequence);
    if (stopUpdate?.relationship === 'NO_DATA') {
      inheritedDelaySeconds = undefined;
      return [{ arrivalAt: scheduledArrival, departureAt: scheduledDeparture, skipped: false, updated: false }];
    }
    const arrivalDelay = stopUpdate?.arrival?.delaySeconds
      ?? (stopUpdate?.arrival?.time ? Math.round((stopUpdate.arrival.time.getTime() - scheduledArrival.getTime()) / 1000) : undefined)
      ?? stopUpdate?.departure?.delaySeconds
      ?? (stopUpdate?.departure?.time ? Math.round((stopUpdate.departure.time.getTime() - scheduledDeparture.getTime()) / 1000) : undefined)
      ?? inheritedDelaySeconds;
    const departureDelay = stopUpdate?.departure?.delaySeconds
      ?? (stopUpdate?.departure?.time ? Math.round((stopUpdate.departure.time.getTime() - scheduledDeparture.getTime()) / 1000) : undefined)
      ?? arrivalDelay;
    const arrivalAt = stopUpdate?.arrival?.time ?? new Date(scheduledArrival.getTime() + (arrivalDelay ?? 0) * 1000);
    const departureAt = stopUpdate?.departure?.time ?? new Date(scheduledDeparture.getTime() + (departureDelay ?? 0) * 1000);
    if (stopUpdate) inheritedDelaySeconds = departureDelay;
    const skipped = stopUpdate?.relationship === 'SKIPPED';
    return [{ arrivalAt, departureAt, skipped,
      updated: skipped || arrivalAt.getTime() !== scheduledArrival.getTime() || departureAt.getTime() !== scheduledDeparture.getTime() }];
  });
  return { stops, ...(update ? { update } : {}) };
}

export function findDirectGtfsJourneys(feed: GtfsTimetableFeed, input: SearchInput): GtfsDirectJourney[] {
  const now = input.now ?? new Date();
  if (!Number.isFinite(input.earliestDeparture.getTime()) || !Number.isFinite(input.latestDeparture.getTime())
    || input.latestDeparture < input.earliestDeparture || input.earliestDeparture < now) return [];
  const radius = input.maximumStopDistanceMeters ?? 2000;
  if (!Number.isFinite(radius) || radius < 100 || radius > 10_000) throw new TypeError('maximum stop distance must be between 100 and 10000 meters');
  const limit = input.limit ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new TypeError('limit must be between 1 and 30');

  const originStops = [...feed.stops.values()].map((stop) => ({ stop, distance: distanceMeters(input.origin, [stop.lon, stop.lat]) }))
    .filter(({ distance }) => distance <= radius).sort((a, b) => a.distance - b.distance).slice(0, MAX_DIRECT_STOPS_PER_SIDE);
  const destinationStops = [...feed.stops.values()].map((stop) => ({ stop, distance: distanceMeters(input.destination, [stop.lon, stop.lat]) }))
    .filter(({ distance }) => distance <= radius).sort((a, b) => a.distance - b.distance).slice(0, MAX_DIRECT_STOPS_PER_SIDE);
  if (originStops.length === 0 || destinationStops.length === 0) return [];
  const originById = new Map(originStops.map((item) => [item.stop.id, item]));
  const destinationById = new Map(destinationStops.map((item) => [item.stop.id, item]));
  const firstDate = localDate(input.earliestDeparture, feed.timezone);
  const lastDate = localDate(input.latestDeparture, feed.timezone);
  const serviceTimeToUtc = createServiceTimeConverter(feed.timezone);
  // GTFS permits stop times beyond 24:00. Include the prior service day so
  // trips such as Monday 24:15 can be found for a Tuesday 00:15 departure.
  const serviceDates = [...new Set([dateStringAfter(firstDate, -1), firstDate, lastDate])];
  const results: GtfsDirectJourney[] = [];
  const segmentIndexes = new WeakMap<GtfsDirectJourney, { fromIndex: number; toIndex: number; serviceDate: string }>();
  const originEntriesByTrip = new Map<string, Array<{ index: number; originStopId: string }>>();
  for (const { stop } of originStops) for (const entry of feed.stopTimesByStop.get(stop.id) ?? []) {
    const entries = originEntriesByTrip.get(entry.tripId) ?? [];
    entries.push({ index: entry.index, originStopId: stop.id });
    originEntriesByTrip.set(entry.tripId, entries);
  }
  const searched = new Set<string>();
  for (const [tripId, originEntries] of originEntriesByTrip) {
    const trip = feed.trips.get(tripId);
    if (!trip) continue;
    const stops = feed.stopTimes.get(tripId);
    if (!stops || stops.length < 2) continue;
    const route = feed.routes.get(trip.routeId);
    if (!route) continue;
    for (const serviceDate of serviceDates) {
      if (!serviceRuns(feed, trip.serviceId, serviceDate)) continue;
      for (const originEntry of originEntries) {
        const fromIndex = originEntry.index;
        const from = stops[fromIndex];
        const originMatch = originById.get(originEntry.originStopId);
        // Only ordinary pickup/drop-off is actionable in MARSHGO. GTFS types
        // 2/3 require a separate phone or driver-coordination workflow.
        if (!originMatch || from.pickupType !== 0) continue;
        const departureAt = serviceTimeToUtc(serviceDate, from.departureSeconds);
        if (!departureAt || departureAt < input.earliestDeparture || departureAt > input.latestDeparture) continue;
        let selectedDestination: { toIndex: number; arrivalAt: Date; distance: number } | undefined;
        for (let toIndex = fromIndex + 1; toIndex < stops.length; toIndex++) {
          const to = stops[toIndex];
          const destinationMatch = destinationById.get(to.stopId);
          if (!destinationMatch || to.dropOffType !== 0 || to.arrivalSeconds < from.departureSeconds) continue;
          const arrivalAt = serviceTimeToUtc(serviceDate, to.arrivalSeconds);
          if (!arrivalAt || arrivalAt < departureAt) continue;
          const coordinates = to.sourceStopCoordinates ?? [destinationMatch.stop.lon, destinationMatch.stop.lat] as [number, number];
          const distance = distanceMeters(input.destination, coordinates);
          if (!selectedDestination || distance < selectedDestination.distance
            || (distance === selectedDestination.distance && arrivalAt < selectedDestination.arrivalAt)) {
            selectedDestination = { toIndex, arrivalAt, distance };
          }
        }
        if (!selectedDestination) continue;
        const toIndex = selectedDestination.toIndex;
        const to = stops[toIndex];
        const destinationMatch = destinationById.get(to.stopId);
        if (!destinationMatch) continue;
        const arrivalAt = selectedDestination.arrivalAt;
          const resultKey = `${tripId}:${from.stopId}:${to.stopId}:${departureAt.toISOString()}`;
          if (searched.has(resultKey)) continue;
          searched.add(resultKey);
          const originCoordinates = from.sourceStopCoordinates ?? [originMatch.stop.lon, originMatch.stop.lat] as [number, number];
          const destinationCoordinates = to.sourceStopCoordinates ?? [destinationMatch.stop.lon, destinationMatch.stop.lat] as [number, number];
          const result: GtfsDirectJourney = { providerId: input.providerId, providerName: input.providerName,
            ...(feed.providersByRoute?.get(trip.routeId)?.city ? { providerCity: feed.providersByRoute.get(trip.routeId)!.city } : {}), mode: route.mode,
            routeId: trip.routeId, routeName: route.name, headsign: trip.headsign, tripId,
            originStop: { id: originMatch.stop.id, name: from.sourceStopName ?? originMatch.stop.name, coordinates: originCoordinates },
            destinationStop: { id: destinationMatch.stop.id, name: to.sourceStopName ?? destinationMatch.stop.name, coordinates: destinationCoordinates },
            originTransferNodeIds: [from.sourceStopId ?? from.stopId, ...(from.sourceParentStationId ? [from.sourceParentStationId] : [])],
            destinationTransferNodeIds: [to.sourceStopId ?? to.stopId, ...(to.sourceParentStationId ? [to.sourceParentStationId] : [])],
            transportType: route.transportType, serviceDate,
            scheduledDepartureAt: departureAt, scheduledArrivalAt: arrivalAt,
            departureAt, arrivalAt, sourceFreshAt: feed.fetchedAt,
            distanceToOriginStopMeters: Math.round(distanceMeters(input.origin, originCoordinates)),
            distanceFromDestinationStopMeters: Math.round(distanceMeters(input.destination, destinationCoordinates)),
            ...(from.sourceZoneId ? { originZoneId: from.sourceZoneId } : {}),
            ...(to.sourceZoneId ? { destinationZoneId: to.sourceZoneId } : {}),
            scheduleSemantics: route.scheduleSemantics ?? 'published_departures',
            traveledZoneIds: stops.slice(fromIndex, toIndex + 1).flatMap((entry) => {
              const zoneId = entry.sourceZoneId;
              return zoneId ? [zoneId] : [];
            }),
          };
          segmentIndexes.set(result, { fromIndex, toIndex, serviceDate });
          results.push(result);
      }
    }
  }
  const selected = [...new Map(results.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime() || a.departureAt.getTime() - b.departureAt.getTime())
    .map((journey) => [`${journey.providerId}:${journey.tripId}:${journey.originStop.id}:${journey.destinationStop.id}:${journey.departureAt.toISOString()}`, journey])).values()].slice(0, limit);
  for (const journey of selected) {
    const indexes = segmentIndexes.get(journey);
    if (!indexes) continue;
    journey.routeGeometry = routeGeometryForTrip(feed, journey.tripId, indexes.fromIndex, indexes.toIndex);
    journey.stops = stopCallsForTrip(feed, journey.tripId, indexes.fromIndex, indexes.toIndex, indexes.serviceDate);
  }
  return selected;
}

/**
 * Build scheduled itineraries with up to five transit legs. Transfers are
 * composed at the same stop, including conservatively matched stops across
 * feeds. Walking to and from the first/last stop uses a conservative straight-
 * line estimate and is surfaced separately in the result.
 */
export function findGtfsItinerariesWithStats(
  feed: GtfsTimetableFeed,
  input: GtfsItinerarySearchInput,
  graphLimits: GtfsGraphBudgetLimits = {},
): GtfsItinerarySearchResult {
  const debugStartedAt = Date.now();
  const debugStage = (stage: string, details: Record<string, number | string> = {}) => {
    if (process.env.MARSHGO_GTFS_SEARCH_DEBUG === '1') {
      const memory = process.memoryUsage();
      console.info(JSON.stringify({ event: 'gtfs.search.debug', stage, elapsedMs: Date.now() - debugStartedAt,
        heapUsedBytes: memory.heapUsed, rssBytes: memory.rss, ...details }));
    }
  };
  const now = input.now ?? new Date();
  const maximumJourneySeconds = input.maximumJourneySeconds ?? 24 * 60 * 60;
  const maximumTransfers = input.maximumTransfers ?? MAX_GTFS_TRANSFERS;
  const minimumTransferBufferSeconds = input.minimumTransferBufferSeconds ?? DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS;
  const maximumWaitSeconds = input.maximumWaitSeconds ?? 4 * 60 * 60;
  const maximumGraphSegments = graphLimits.totalSegments ?? MAX_GTFS_GRAPH_SEGMENTS;
  const maximumGraphSegmentsPerRoute = graphLimits.segmentsPerRoute ?? MAX_GTFS_GRAPH_SEGMENTS_PER_ROUTE;
  // Keep the older common radius as an explicit override for callers that
  // still use it. Production search uses the distinct access/egress values.
  const accessRadius = input.maximumAccessWalkingMeters ?? input.maximumStopDistanceMeters ?? DEFAULT_MAX_ACCESS_WALKING_METERS;
  const egressRadius = input.maximumEgressWalkingMeters ?? input.maximumStopDistanceMeters ?? DEFAULT_MAX_EGRESS_WALKING_METERS;
  const transferRadius = input.maximumTransferWalkingMeters ?? DEFAULT_MAX_TRANSFER_WALKING_METERS;
  const limit = input.limit ?? 20;
  if (!Number.isFinite(input.earliestDeparture.getTime()) || !Number.isFinite(input.latestDeparture.getTime())
    || input.latestDeparture < input.earliestDeparture || input.earliestDeparture < now
    || !Number.isInteger(maximumJourneySeconds) || maximumJourneySeconds < 60 || maximumJourneySeconds > 7 * 24 * 60 * 60
    || !Number.isInteger(maximumTransfers) || maximumTransfers < 0 || maximumTransfers > MAX_GTFS_TRANSFERS
    || !Number.isInteger(minimumTransferBufferSeconds) || minimumTransferBufferSeconds < 0 || minimumTransferBufferSeconds > 7200
    || !Number.isInteger(maximumWaitSeconds) || maximumWaitSeconds < 0 || maximumWaitSeconds > maximumJourneySeconds
    || !Number.isFinite(accessRadius) || accessRadius < 100 || accessRadius > 10_000
    || !Number.isFinite(egressRadius) || egressRadius < 100 || egressRadius > 10_000
    || !Number.isFinite(transferRadius) || transferRadius < 0 || transferRadius > 10_000
    || !Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(maximumGraphSegments) || maximumGraphSegments < 1 || maximumGraphSegments > MAX_GTFS_GRAPH_SEGMENTS
    || !Number.isSafeInteger(maximumGraphSegmentsPerRoute) || maximumGraphSegmentsPerRoute < 1
    || maximumGraphSegmentsPerRoute > MAX_GTFS_GRAPH_SEGMENTS_PER_ROUTE) {
    throw new TypeError('GTFS itinerary search bounds are invalid');
  }

  let stopSelectionTruncated = false;
  const closestStops = (point: [number, number], radius: number) => {
    const ranked = [...feed.stops.values()]
      .filter((stop) => feed.stopTimesByStop.has(stop.id))
      .map((stop) => ({ stop, distance: distanceMeters(point, [stop.lon, stop.lat]) }))
      .filter(({ distance }) => distance <= radius)
      .sort((a, b) => a.distance - b.distance);
    const selected = new Map<string, typeof ranked[number]>();
    const selectedByRoutePattern = new Map<string, number>();
    const routePatternsByStop = new Map<string, Set<string>>();
    const routePatternsAtStop = (stopId: string) => {
      const cached = routePatternsByStop.get(stopId);
      if (cached) return cached;
      const routePatterns = new Set<string>();
      for (const entry of feed.stopTimesByStop.get(stopId) ?? []) {
        const trip = feed.trips.get(entry.tripId);
        if (trip && feed.routes.has(trip.routeId)) {
          // GTFS route_id can contain both directions and branched headsigns.
          // Counting only route_id lets the nearest stops crowd out every
          // stop on the reverse direction before candidate generation starts.
          routePatterns.add(`${trip.routeId}:${trip.directionId ?? ''}:${trip.headsign.trim()}`);
        }
      }
      routePatternsByStop.set(stopId, routePatterns);
      return routePatterns;
    };
    const addSelected = (item: typeof ranked[number]) => {
      selected.set(item.stop.id, item);
      for (const routePattern of routePatternsAtStop(item.stop.id)) {
        selectedByRoutePattern.set(routePattern, (selectedByRoutePattern.get(routePattern) ?? 0) + 1);
      }
    };

    // Preserve nearby alternatives, then add stops that expose a route not
    // represented by those nearest stops. A mode-only cap discarded distinct
    // bus/tram routes whenever the closest stops were already served by that
    // same mode, including routes whose first useful stop ranked 21st.
    for (const item of ranked.slice(0, MAX_NEAREST_STOPS_PER_SIDE)) addSelected(item);
    for (const item of ranked) {
      if (selected.has(item.stop.id)) continue;
      const addsRoutePatternCoverage = [...routePatternsAtStop(item.stop.id)]
        .some((pattern) => (selectedByRoutePattern.get(pattern) ?? 0) < MAX_STOPS_PER_ROUTE_PATTERN);
      if (!addsRoutePatternCoverage) continue;
      if (selected.size >= MAX_STOPS_PER_SIDE) { stopSelectionTruncated = true; break; }
      addSelected(item);
    }
    if (selected.size < ranked.length) stopSelectionTruncated = true;
    return [...selected.values()];
  };
  const originStops = closestStops(input.origin, accessRadius);
  const destinationStops = closestStops(input.destination, egressRadius);
  debugStage('stops-selected', { originStops: originStops.length, destinationStops: destinationStops.length });
  if (!originStops.length || !destinationStops.length) {
    return { itineraries: [], searchTruncated: false, resultLimitReached: false, candidateGraphTruncated: false };
  }

  const routeDistance = distanceMeters(input.origin, input.destination);
  // Urban searches do not need to admit nearly every stop in a city as a
  // candidate edge. Keep the wider corridor for intercity feeds and allow a
  // bounded local detour for city trips.
  const corridorWidth = routeDistance > 30_000
    ? Math.max(12_000, Math.min(60_000, routeDistance * 0.2))
    : Math.max(2_500, Math.min(8_000, routeDistance * 0.25));
  const originLat = (input.origin[1] + input.destination[1]) / 2;
  const toXY = ([lon, lat]: [number, number]) => [lon * 111_320 * Math.cos(originLat * Math.PI / 180), lat * 110_574] as const;
  const [ax, ay] = toXY(input.origin), [bx, by] = toXY(input.destination);
  const corridorStops = new Set<string>();
  for (const stop of feed.stops.values()) {
    const [px, py] = toXY([stop.lon, stop.lat]);
    const dx = bx - ax, dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    const nearestX = ax + t * dx, nearestY = ay + t * dy;
    if (Math.hypot(px - nearestX, py - nearestY) <= corridorWidth) corridorStops.add(stop.id);
  }
  originStops.forEach(({ stop }) => corridorStops.add(stop.id));
  destinationStops.forEach(({ stop }) => corridorStops.add(stop.id));

  // For an intercity query, city feeds should contribute first/last-mile links
  // and links around intercity stations. Scanning every urban trip inside a
  // 10+ km corridor creates millions of irrelevant stop-pair edges (and can
  // exhaust the API heap), even when the route only touches that city at one
  // endpoint. Keep the urban graph around endpoints and actual rail/intercity
  // bus stops, while national feeds continue to use the full route corridor.
  const intercitySearch = routeDistance > 30_000;
  const localCityCatchmentStops = new Set<string>([
    ...originStops.map(({ stop }) => stop.id),
    ...destinationStops.map(({ stop }) => stop.id),
  ]);
  if (intercitySearch) {
    const anchorPoints = new Map<string, [number, number]>();
    for (const [tripId, trip] of feed.trips) {
      const route = feed.routes.get(trip.routeId);
      const providerCity = feed.providersByRoute?.get(trip.routeId)?.city ?? input.providerCity;
      const transportType = route?.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route?.transportType;
      if (!transportType || !['train', 'suburban_train', 'intercity_bus'].includes(transportType)) continue;
      for (const stopTime of feed.stopTimes.get(tripId) ?? []) {
        if (!corridorStops.has(stopTime.stopId)) continue;
        const stop = feed.stops.get(stopTime.stopId);
        const coordinates = stopTime.sourceStopCoordinates ?? (stop ? [stop.lon, stop.lat] as [number, number] : undefined);
        if (coordinates) anchorPoints.set(stopTime.stopId, coordinates);
      }
    }

    const anchorCellSizeMeters = 2_500;
    const anchorCells = new Map<string, Array<[number, number]>>();
    for (const point of anchorPoints.values()) {
      const [x, y] = toXY(point);
      const key = `${Math.floor(x / anchorCellSizeMeters)}:${Math.floor(y / anchorCellSizeMeters)}`;
      const points = anchorCells.get(key) ?? [];
      points.push(point);
      anchorCells.set(key, points);
    }
    let excludedCityStops = false;
    for (const stop of feed.stops.values()) {
      if (!corridorStops.has(stop.id) || !feed.stopTimesByStop.has(stop.id)) continue;
      const coordinates: [number, number] = [stop.lon, stop.lat];
      const nearEndpoint = Math.min(distanceMeters(input.origin, coordinates), distanceMeters(input.destination, coordinates)) <= anchorCellSizeMeters;
      const [x, y] = toXY(coordinates);
      const cellX = Math.floor(x / anchorCellSizeMeters), cellY = Math.floor(y / anchorCellSizeMeters);
      let nearIntercityStop = false;
      for (let dx = -1; dx <= 1 && !nearIntercityStop; dx++) {
        for (let dy = -1; dy <= 1 && !nearIntercityStop; dy++) {
          for (const anchor of anchorCells.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
            if (distanceMeters(coordinates, anchor) <= anchorCellSizeMeters) {
              nearIntercityStop = true;
              break;
            }
          }
        }
      }
      if (nearEndpoint || nearIntercityStop) localCityCatchmentStops.add(stop.id);
      else excludedCityStops = true;
    }
    if (excludedCityStops) stopSelectionTruncated = true;
  }

  const journeyEnd = new Date(input.earliestDeparture.getTime() + maximumJourneySeconds * 1000);
  const firstServiceDate = localDate(input.earliestDeparture, feed.timezone);
  const lastServiceDate = localDate(journeyEnd, feed.timezone);
  const serviceTimeToUtc = createServiceTimeConverter(feed.timezone);
  const serviceDates = new Set<string>();
  const dayCount = Math.ceil((journeyEnd.getTime() - input.earliestDeparture.getTime()) / 86_400_000) + 2;
  for (let day = -1; day <= dayCount; day++) {
    const date = dateStringAfter(firstServiceDate, day);
    if (date <= lastServiceDate || day < 0) serviceDates.add(date);
  }

  const originStopIds = new Set(originStops.map(({ stop }) => stop.id));
  const destinationStopIds = new Set(destinationStops.map(({ stop }) => stop.id));
  const transferNodeIds = new Set<string>([
    ...(feed.transfers ?? []).flatMap((rule) => [rule.fromStopId, rule.toStopId]),
    ...(feed.pathways ?? []).flatMap((pathway) => [pathway.fromStopId, pathway.toStopId]),
  ]);
  const routesByStop = new Map<string, Set<string>>();
  const routesByParentStation = new Map<string, Set<string>>();
  const interchangeStopIds = new Set<string>([...originStopIds, ...destinationStopIds]);
  for (const [stopId, entries] of feed.stopTimesByStop) {
    const routeIds = new Set<string>();
    const stop = feed.stops.get(stopId);
    for (const entry of entries) {
      const trip = feed.trips.get(entry.tripId);
      if (trip) routeIds.add(trip.routeId);
      const stopTime = feed.stopTimes.get(entry.tripId)?.[entry.index];
      if (transferNodeIds.has(stopId) || transferNodeIds.has(stopTime?.sourceStopId ?? '')
        || transferNodeIds.has(stopTime?.sourceParentStationId ?? '')
        || transferNodeIds.has(stop?.parentStation ?? '')) interchangeStopIds.add(stopId);
    }
    routesByStop.set(stopId, routeIds);
    if (routeIds.size > 1) interchangeStopIds.add(stopId);
    if (stop?.parentStation) {
      const routes = routesByParentStation.get(stop.parentStation) ?? new Set<string>();
      for (const routeId of routeIds) routes.add(routeId);
      routesByParentStation.set(stop.parentStation, routes);
    }
  }
  // A trip endpoint alone is not a transfer node. Add a stop only when a
  // second route, explicit GTFS transfer/pathway, shared station, or measured
  // nearby cross-route platform can connect there; isolated termini otherwise
  // inflate a bounded graph with edges the passenger cannot use to change lines.
  // A valid transfer can be between two distinct nearby stop IDs when a feed
  // does not publish a transfers.txt rule. Add those stops to the candidate
  // graph using the configured walk shed, but keep the exact GTFS/pathway and
  // transfer-rule checks in transferDecision as the final feasibility gate.
  // The grid is over stop IDs, not hundreds of thousands of trip segments.
  const transferCellMeters = Math.max(100, transferRadius);
  const transferCell = (coordinates: [number, number]) => {
    const [lon, lat] = coordinates;
    const x = lon * 111_320 * Math.cos(lat * Math.PI / 180);
    const y = lat * 111_132;
    return [Math.floor(x / transferCellMeters), Math.floor(y / transferCellMeters)] as const;
  };
  const stopIdsByTransferCell = new Map<string, string[]>();
  for (const [stopId, routeIds] of routesByStop) {
    if (!routeIds.size) continue;
    const stop = feed.stops.get(stopId);
    if (!stop) continue;
    const [x, y] = transferCell([stop.lon, stop.lat]);
    const key = `${x}:${y}`;
    const ids = stopIdsByTransferCell.get(key) ?? [];
    ids.push(stopId);
    stopIdsByTransferCell.set(key, ids);
  }
  for (const [stopId, routeIds] of routesByStop) {
    if (!routeIds.size) continue;
    const stop = feed.stops.get(stopId);
    if (!stop) continue;
    const [cellX, cellY] = transferCell([stop.lon, stop.lat]);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const nearbyStopId of stopIdsByTransferCell.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
        if (nearbyStopId <= stopId) continue;
        const nearby = feed.stops.get(nearbyStopId);
        const nearbyRouteIds = routesByStop.get(nearbyStopId);
        if (!nearby || !nearbyRouteIds?.size || ![...routeIds].some((routeId) => !nearbyRouteIds.has(routeId))) continue;
        if (distanceMeters([stop.lon, stop.lat], [nearby.lon, nearby.lat]) > transferRadius) continue;
        interchangeStopIds.add(stopId);
        interchangeStopIds.add(nearbyStopId);
      }
    }
  }
  for (const [stopId, stop] of feed.stops) {
    if (stop.parentStation && (routesByParentStation.get(stop.parentStation)?.size ?? 0) > 1) {
      interchangeStopIds.add(stopId);
    }
  }
  debugStage('corridor-selected', { corridorStops: corridorStops.size, interchangeStops: interchangeStopIds.size,
    corridorWidthMeters: Math.round(corridorWidth) });

  const segmentsByRoute = new Map<string, RetainedGtfsTrip[]>();
  const retainedSegmentCountByRoute = new Map<string, number>();
  const overflowSegmentsByRoute = new Map<string, BoundedBestK<RetainedGtfsSegment>>();
  const candidateStopCountByRoute = new Map<string, number>();
  for (const [stopId, routeIds] of routesByStop) {
    if (!interchangeStopIds.has(stopId)) continue;
    for (const routeId of routeIds) {
      const route = feed.routes.get(routeId);
      if (!route || (input.allowedModes && !input.allowedModes.includes(route.mode))) continue;
      const providerCity = feed.providersByRoute?.get(routeId)?.city ?? input.providerCity;
      const transportType = route.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route.transportType;
      if (input.allowedTransportTypes && !journeyTransportTypeSelected(transportType, input.allowedTransportTypes)) continue;
      const eligibleStops = intercitySearch && providerCity !== undefined && providerCity !== 'Україна'
        ? localCityCatchmentStops : corridorStops;
      if (!eligibleStops.has(stopId)) continue;
      candidateStopCountByRoute.set(routeId, (candidateStopCountByRoute.get(routeId) ?? 0) + 1);
    }
  }
  // Weight route budgets by eligible service volume and stop-pair opportunity.
  // Equal shares waste most of the global graph limit on low-frequency lines,
  // while a single busy corridor can hit its share and truncate useful trips.
  const candidateDemandByRoute = new Map<string, number>();
  // Query-specific scheduled access/egress events let graph retention prefer
  // transfer trips that can actually join a first/last leg. These are only a
  // retention signal: the normal transferDecision remains the final authority
  // for GTFS rules, pathway topology, walking distance and buffers.
  type QueryReachabilityEvent = {
    at: number;
    tripId: string;
    routeId: string;
    stopId: string;
    nodeIds: string[];
  };
  const originReachableArrivalsByNode = new Map<string, QueryReachabilityEvent[]>();
  const destinationReachableDeparturesByNode = new Map<string, QueryReachabilityEvent[]>();
  const seenOriginRetentionEventsByNode = new Map<string, Set<string>>();
  const seenDestinationRetentionEventsByNode = new Map<string, Set<string>>();
  const retentionTransferRulesByFromNode = new Map<string, GtfsTransferRule[]>();
  for (const rule of feed.transfers ?? []) {
    const rules = retentionTransferRulesByFromNode.get(rule.fromStopId) ?? [];
    rules.push(rule);
    retentionTransferRulesByFromNode.set(rule.fromStopId, rules);
  }
  const retentionTransferNodes = (entry: NonNullable<GtfsTimetableFeed['stopTimes'] extends Map<string, (infer T)[]> ? T : never>) => {
    const primary = entry.sourceStopId ?? entry.stopId;
    // Keep parent station IDs for matching station-level transfer rules. Event
    // lookup itself is indexed only by the exact physical stop below.
    return entry.sourceParentStationId && entry.sourceParentStationId !== primary
      ? [primary, entry.sourceParentStationId] : [primary];
  };
  const addRetentionEvent = (
    events: Map<string, QueryReachabilityEvent[]>,
    seenEventsByNode: Map<string, Set<string>>,
    entry: NonNullable<GtfsTimetableFeed['stopTimes'] extends Map<string, (infer T)[]> ? T : never>,
    at: Date,
    tripId: string,
    routeId: string,
  ) => {
    const nodeIds = retentionTransferNodes(entry);
    const stopId = entry.sourceStopId ?? entry.stopId;
    const atMs = at.getTime();
    const event = { at: atMs, tripId, routeId, stopId, nodeIds };
    const eventKey = `${tripId}\u0000${stopId}\u0000${atMs}`;
    const seen = seenEventsByNode.get(stopId) ?? new Set<string>();
    if (seen.has(eventKey)) return;
    seen.add(eventKey);
    seenEventsByNode.set(stopId, seen);
    const values = events.get(stopId) ?? [];
    values.push(event);
    events.set(stopId, values);
  };
  const retentionRuleFor = (
    fromNodeIds: readonly string[], toNodeIds: readonly string[],
    fromTripId: string, toTripId: string, fromRouteId: string, toRouteId: string,
  ): { rule: GtfsTransferRule | null; ambiguous: boolean } => {
    if (retentionTransferRulesByFromNode.size === 0) return { rule: null, ambiguous: false };
    const candidates = new Set<GtfsTransferRule>();
    for (const nodeId of fromNodeIds) {
      for (const rule of retentionTransferRulesByFromNode.get(nodeId) ?? []) candidates.add(rule);
    }
    const matches = [...candidates].filter((rule) => fromNodeIds.includes(rule.fromStopId)
      && toNodeIds.includes(rule.toStopId)
      && (!rule.fromTripId || rule.fromTripId === fromTripId)
      && (!rule.toTripId || rule.toTripId === toTripId)
      && (!rule.fromRouteId || rule.fromRouteId === fromRouteId)
      && (!rule.toRouteId || rule.toRouteId === toRouteId));
    if (!matches.length) return { rule: null, ambiguous: false };
    const specificity = (rule: GtfsTransferRule) => rule.fromTripId && rule.toTripId ? 6
      : (rule.fromTripId && rule.toRouteId) || (rule.fromRouteId && rule.toTripId) ? 5
      : rule.fromTripId || rule.toTripId ? 4
      : rule.fromRouteId && rule.toRouteId ? 3
      : rule.fromRouteId || rule.toRouteId ? 2 : 1;
    const max = Math.max(...matches.map(specificity));
    const best = matches.filter((rule) => specificity(rule) === max);
    const signatures = new Set(best.map((rule) => `${rule.transferType}:${rule.minTransferTimeSeconds ?? ''}`));
    return signatures.size > 1 ? { rule: null, ambiguous: true } : { rule: best[0]!, ambiguous: false };
  };
  for (const [tripId, trip] of feed.trips) {
    const candidateStops = candidateStopCountByRoute.get(trip.routeId) ?? 0;
    if (candidateStops < 2) continue;
    const stops = feed.stopTimes.get(tripId);
    if (!stops || stops.length < 2) continue;
    const providerCity = feed.providersByRoute?.get(trip.routeId)?.city ?? input.providerCity;
    const eligibleStopIds = intercitySearch && providerCity !== undefined && providerCity !== 'Україна'
      ? localCityCatchmentStops : corridorStops;
    const eligibleIndexes = stops.flatMap((stopTime, index) => eligibleStopIds.has(stopTime.stopId)
      && interchangeStopIds.has(stopTime.stopId) ? [index] : []);
    const eligibleStopTimes = eligibleIndexes.map((index) => stops[index]);
    if (eligibleStopTimes.length < 2) continue;
    let pairOpportunities = 0;
    for (const serviceDate of serviceDates) {
      if (!serviceRuns(feed, trip.serviceId, serviceDate)) continue;
      const update = feed.realtimeTripUpdates?.get(gtfsRealtimeTripUpdateKey(tripId, serviceDate));
      if (update?.relationship === 'CANCELED' || update?.relationship === 'DELETED') continue;
      const dated = update?.stops.length ? datedTripStops(feed, tripId, serviceDate) : undefined;
      if (dated && dated.stops.length !== stops.length) continue;
      const scheduledTimes = eligibleIndexes.map((index) => dated?.stops[index] ?? {
        departureAt: serviceTimeToUtc(serviceDate, stops[index].departureSeconds),
        arrivalAt: serviceTimeToUtc(serviceDate, stops[index].arrivalSeconds),
        skipped: false,
      });
      for (let fromCursor = 0; fromCursor < eligibleStopTimes.length - 1; fromCursor++) {
        const from = eligibleStopTimes[fromCursor];
        if (from.pickupType !== 0 || scheduledTimes[fromCursor].skipped) continue;
        const departureAt = scheduledTimes[fromCursor].departureAt;
        if (!departureAt || departureAt < input.earliestDeparture || departureAt > journeyEnd) continue;
        // Mirror the graph's bounded forward stop-pair and schedule window
        // without materializing candidate segment objects in this demand pass.
        const toEnd = Math.min(eligibleStopTimes.length, fromCursor + 21);
        for (let toCursor = fromCursor + 1; toCursor < toEnd; toCursor++) {
          const to = eligibleStopTimes[toCursor];
          if (to.dropOffType !== 0 || scheduledTimes[toCursor].skipped || to.arrivalSeconds < from.departureSeconds) continue;
          const arrivalAt = scheduledTimes[toCursor].arrivalAt;
          if (!arrivalAt || arrivalAt < departureAt || arrivalAt > journeyEnd
            || arrivalAt.getTime() - departureAt.getTime() > 12 * 60 * 60_000) continue;
          if (originStopIds.has(from.stopId) && interchangeStopIds.has(to.stopId)) {
            const fromStop = feed.stops.get(from.stopId);
            const coordinates = from.sourceStopCoordinates ?? (fromStop ? [fromStop.lon, fromStop.lat] as [number, number] : null);
            const accessSeconds = coordinates ? Math.ceil(distanceMeters(input.origin, coordinates) / 1.25) : Infinity;
            if (departureAt.getTime() >= input.earliestDeparture.getTime() + accessSeconds * 1000) {
              addRetentionEvent(originReachableArrivalsByNode, seenOriginRetentionEventsByNode, to, arrivalAt, tripId, trip.routeId);
            }
          }
          if (interchangeStopIds.has(from.stopId) && destinationStopIds.has(to.stopId)) {
            addRetentionEvent(destinationReachableDeparturesByNode, seenDestinationRetentionEventsByNode, from, departureAt, tripId, trip.routeId);
          }
          pairOpportunities++;
        }
      }
    }
    if (pairOpportunities === 0) continue;
    const boundedPairOpportunities = Math.min(maximumGraphSegmentsPerRoute, pairOpportunities);
    candidateDemandByRoute.set(trip.routeId,
      (candidateDemandByRoute.get(trip.routeId) ?? 0) + boundedPairOpportunities);
  }
  const graphSegmentBudgetByRoute = allocateBoundedGraphBudgets(
    candidateDemandByRoute, maximumGraphSegments, maximumGraphSegmentsPerRoute,
  );
  const candidateRouteCount = graphSegmentBudgetByRoute.size;
  const estimatedGraphDemand = [...candidateDemandByRoute.values()].reduce((sum, value) => sum + value, 0);
  const graphRoutesBudgetLimited = [...candidateDemandByRoute].filter(([routeId, demand]) =>
    demand > (graphSegmentBudgetByRoute.get(routeId) ?? 0)).length;
  const graphRoutesAtPerRouteCap = [...graphSegmentBudgetByRoute.values()]
    .filter((budget) => budget === maximumGraphSegmentsPerRoute).length;
  const globalGraphBudgetBinding = estimatedGraphDemand > maximumGraphSegments;
  let segmentGraphTruncated = false;
  // A national feed can produce a very large number of stop-pair candidates.
  // Keep only the stop-time indexes during graph construction and materialize
  // route shapes for the small set of itineraries that will actually be shown.
  const shapeIndexesBySegment = new WeakMap<GtfsDirectJourney, { fromIndex: number; toIndex: number; serviceDate: string }>();
  const sortedRetentionEvents = (events: Map<string, QueryReachabilityEvent[]>) => new Map([...events]
    .map(([nodeId, values]) => [nodeId, values.sort((a, b) => a.at - b.at
      || compareStableId(a.tripId, b.tripId) || compareStableId(a.stopId, b.stopId))] as const));
  const originRetentionEvents = sortedRetentionEvents(originReachableArrivalsByNode);
  const destinationRetentionEvents = sortedRetentionEvents(destinationReachableDeparturesByNode);
  const retentionNodesForSegment = (stopId: string) => [stopId];
  const hasPriorEvent = (segment: GtfsDirectJourney, minimumGapSeconds: number) => {
    const latestAllowed = segment.departureAt.getTime() - minimumGapSeconds * 1000;
    const segmentNodes = retentionNodesForSegment(segment.originStop.id);
    const minimumGapForEvent = (event: QueryReachabilityEvent) => {
      const { rule, ambiguous } = retentionRuleFor(event.nodeIds, segment.originTransferNodeIds,
        event.tripId, segment.tripId, event.routeId, segment.routeId);
      if (ambiguous || rule?.transferType === 3) return null;
      // A shared parent station is not proof that a platform-to-platform
      // transfer is walkable; only exact stop identity promotes this hint.
      if (event.stopId !== segment.originStop.id) return null;
      if (rule?.transferType === 4) return 0;
      return Math.max(minimumGapSeconds,
        rule?.transferType === 2 ? rule.minTransferTimeSeconds ?? 0 : 0);
    };
    for (const nodeId of segmentNodes) {
      const events = originRetentionEvents.get(nodeId);
      if (!events?.length) continue;
      let low = 0, high = events.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (events[middle]!.at <= latestAllowed) low = middle + 1;
        else high = middle;
      }
      for (let index = low - 1; index >= 0; index--) {
        const event = events[index]!;
        const availableSeconds = (segment.departureAt.getTime() - event.at) / 1000;
        if (availableSeconds > maximumWaitSeconds) break;
        const requiredSeconds = minimumGapForEvent(event);
        if (requiredSeconds !== null && availableSeconds >= requiredSeconds) return true;
      }
    }
    return false;
  };
  const hasNextEvent = (segment: GtfsDirectJourney, minimumGapSeconds: number) => {
    const earliestAllowed = segment.arrivalAt.getTime() + minimumGapSeconds * 1000;
    const segmentNodes = retentionNodesForSegment(segment.destinationStop.id);
    const minimumGapForEvent = (event: QueryReachabilityEvent) => {
      const { rule, ambiguous } = retentionRuleFor(segment.destinationTransferNodeIds, event.nodeIds,
        segment.tripId, event.tripId, segment.routeId, event.routeId);
      if (ambiguous || rule?.transferType === 3) return null;
      if (event.stopId !== segment.destinationStop.id) return null;
      if (rule?.transferType === 4) return 0;
      return Math.max(minimumGapSeconds,
        rule?.transferType === 2 ? rule.minTransferTimeSeconds ?? 0 : 0);
    };
    for (const nodeId of segmentNodes) {
      const events = destinationRetentionEvents.get(nodeId);
      if (!events?.length) continue;
      let low = 0, high = events.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (events[middle]!.at < earliestAllowed) low = middle + 1;
        else high = middle;
      }
      for (let index = low; index < events.length; index++) {
        const event = events[index]!;
        const availableSeconds = (event.at - segment.arrivalAt.getTime()) / 1000;
        if (availableSeconds > maximumWaitSeconds) break;
        const requiredSeconds = minimumGapForEvent(event);
        if (requiredSeconds !== null && availableSeconds >= requiredSeconds) return true;
      }
    }
    return false;
  };
  let tripsConsidered = 0;
  let tripsWithEligibleStops = 0;
  const stopDetailsCache = new Map<string, { id: string; name: string; coordinates: [number, number] }>();
  const stopContextCache = new Map<string, {
    details: { id: string; name: string; coordinates: [number, number] };
    transferNodeIds: string[];
    distanceToOriginStopMeters: number;
    distanceFromDestinationStopMeters: number;
  }>();
  const transferNodeCache = new Map<string, string[]>();
  const stopDetails = (stopId: string, name: string, coordinates: [number, number]) => {
    const key = `${stopId}\u0000${name}\u0000${coordinates[0]}\u0000${coordinates[1]}`;
    const cached = stopDetailsCache.get(key);
    if (cached) return cached;
    const value = { id: stopId, name, coordinates };
    stopDetailsCache.set(key, value);
    return value;
  };
  const transferNodeList = (entry: NonNullable<GtfsTimetableFeed['stopTimes'] extends Map<string, (infer T)[]> ? T : never>) => {
    const primary = entry.sourceStopId ?? entry.stopId;
    const parent = entry.sourceParentStationId;
    const key = `${primary}\u0000${parent ?? ''}`;
    const cached = transferNodeCache.get(key);
    if (cached) return cached;
    const value = parent && parent !== primary ? [primary, parent] : [primary];
    transferNodeCache.set(key, value);
    return value;
  };
  const stopContext = (entry: NonNullable<GtfsTimetableFeed['stopTimes'] extends Map<string, (infer T)[]> ? T : never>) => {
    const stop = feed.stops.get(entry.stopId);
    if (!stop) return null;
    const coordinates = entry.sourceStopCoordinates ?? [stop.lon, stop.lat] as [number, number];
    const name = entry.sourceStopName ?? stop.name;
    const key = `${entry.stopId}\u0000${entry.sourceStopId ?? ''}\u0000${name}\u0000${coordinates[0]}\u0000${coordinates[1]}`;
    const cached = stopContextCache.get(key);
    if (cached) return cached;
    const value = {
      details: stopDetails(stop.id, name, coordinates),
      transferNodeIds: transferNodeList(entry),
      // These distances are fixed for the queried OD pair. Calculate once per
      // stop context instead of once for every possible boarding/alighting
      // pair on every trip serving this stop.
      distanceToOriginStopMeters: Math.round(distanceMeters(input.origin, coordinates)),
      distanceFromDestinationStopMeters: Math.round(distanceMeters(input.destination, coordinates)),
    };
    stopContextCache.set(key, value);
    return value;
  };
  const emptyTraveledZoneIds: string[] = [];
  const compareTripSegments = (left: RetainedGtfsSegment, right: RetainedGtfsSegment) => {
    const rank = (candidate: RetainedGtfsSegment): [number, number, number, number, number] => {
      if (candidate.sampleRank) return candidate.sampleRank;
      const value = candidate.segment;
      const startsAtOrigin = originStopIds.has(value.originStop.id);
      const endsAtDestination = destinationStopIds.has(value.destinationStop.id);
      const accessSeconds = Math.ceil(value.distanceToOriginStopMeters / 1.25);
      const canCatchOrigin = startsAtOrigin && value.departureAt.getTime()
        >= input.earliestDeparture.getTime() + accessSeconds * 1000;
      const duration = value.arrivalAt.getTime() - value.departureAt.getTime();
      const rankValue: [number, number, number, number, number] = canCatchOrigin && endsAtDestination
        ? [0, value.distanceToOriginStopMeters + value.distanceFromDestinationStopMeters,
          duration, value.departureAt.getTime(), value.arrivalAt.getTime()]
        : canCatchOrigin
          ? [1, value.distanceToOriginStopMeters, value.departureAt.getTime(), duration, value.arrivalAt.getTime()]
          : endsAtDestination
            ? [2, value.distanceFromDestinationStopMeters, value.arrivalAt.getTime(), duration, value.departureAt.getTime()]
            : [3, 0, duration, value.departureAt.getTime(), value.arrivalAt.getTime()];
      if (rankValue[0] === 3) {
        const connectedRoutes = new Set<string>();
        for (const stopId of [...value.originTransferNodeIds, value.destinationStop.id,
          ...value.destinationTransferNodeIds]) {
          for (const routeId of routesByStop.get(stopId) ?? []) connectedRoutes.add(routeId);
          const stop = feed.stops.get(stopId);
          if (stop?.parentStation) {
            for (const routeId of routesByParentStation.get(stop.parentStation) ?? []) connectedRoutes.add(routeId);
          }
        }
        connectedRoutes.delete(value.routeId);
        rankValue[1] = -connectedRoutes.size;
      }
      candidate.sampleRank = rankValue;
      candidate.sampleKey = `${value.providerId}\u0000${value.serviceDate}\u0000${value.tripId}\u0000${value.originStop.id}\u0000${value.destinationStop.id}\u0000${value.departureAt.getTime()}\u0000${value.arrivalAt.getTime()}`;
      return rankValue;
    };
    const leftRank = rank(left);
    const rightRank = rank(right);
    for (let index = 0; index < leftRank.length; index++) {
      if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
    }
    return compareStableId(left.sampleKey ?? '', right.sampleKey ?? '');
  };
  // Feed trip insertion order is not a stable selection policy. Keep graph
  // retention and any bounded overflow fill reproducible across feed encodings.
  for (const [tripId, trip] of [...feed.trips].sort(([left], [right]) => compareStableId(left, right))) {
    tripsConsidered++;
    const route = feed.routes.get(trip.routeId);
    const stops = feed.stopTimes.get(tripId);
    if (!route || !stops || stops.length < 2 || (input.allowedModes && !input.allowedModes.includes(route.mode))) continue;
    const provider = feed.providersByRoute?.get(trip.routeId);
    const providerCity = provider?.city ?? input.providerCity;
    const transportType = route.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route.transportType;
    if (input.allowedTransportTypes && !journeyTransportTypeSelected(transportType, input.allowedTransportTypes)) continue;
    const graphSegmentLimitPerRoute = graphSegmentBudgetByRoute.get(trip.routeId) ?? 0;
    if (graphSegmentLimitPerRoute === 0) continue;
    const localFeedInIntercitySearch = intercitySearch && providerCity !== undefined && providerCity !== 'Україна';
    const eligibleStopIds = localFeedInIntercitySearch ? localCityCatchmentStops : corridorStops;
    const eligibleIndexes = stops.flatMap((stop, index) => eligibleStopIds.has(stop.stopId)
      && interchangeStopIds.has(stop.stopId) ? [index] : []);
    if (eligibleIndexes.length < 2) continue;
    tripsWithEligibleStops++;
    // A trip's stop metadata is shared across its service dates and all
    // downstream stop-pair candidates. Resolve it once before expanding those
    // pairs rather than repeating map lookups, string keys, and haversine
    // calculations for every edge.
    const eligibleContexts = eligibleIndexes.map((index) => stopContext(stops[index]));
    for (const serviceDate of serviceDates) {
      if (!serviceRuns(feed, trip.serviceId, serviceDate)) continue;
      let tripCandidates: RetainedGtfsSegment[] = [];
      let boundedTripCandidates: BoundedBestK<RetainedGtfsSegment> | undefined;
      // Duplicate stop IDs can occur in loop routes; deduplicate only within
      // this trip instance so a citywide set of every candidate key is not
      // retained alongside the graph.
      const seenTripSegments = new Set<string>();
      const realtimeUpdate = feed.realtimeTripUpdates?.get(gtfsRealtimeTripUpdateKey(tripId, serviceDate));
      if (realtimeUpdate?.relationship === 'CANCELED' || realtimeUpdate?.relationship === 'DELETED') continue;
      const dated = realtimeUpdate?.stops.length ? datedTripStops(feed, tripId, serviceDate) : undefined;
      if (dated && dated.stops.length !== stops.length) continue;
      // The same arrival stop-time participates in many upstream stop-pair
      // segments. Resolve its service-date timestamps once instead of creating
      // duplicate Date objects inside every boarding/alighting pair.
      const scheduledTimes = eligibleIndexes.map((index) => ({
        departureAt: serviceTimeToUtc(serviceDate, stops[index].departureSeconds),
        arrivalAt: serviceTimeToUtc(serviceDate, stops[index].arrivalSeconds),
      }));
      for (let fromCursor = 0; fromCursor < eligibleIndexes.length - 1; fromCursor++) {
        const fromIndex = eligibleIndexes[fromCursor];
        const from = stops[fromIndex];
        const fromContext = eligibleContexts[fromCursor];
        if (!fromContext) continue;
        const datedFrom = dated?.stops[fromIndex];
        if (from.pickupType !== 0 || datedFrom?.skipped) continue;
        const scheduledDepartureAt = scheduledTimes[fromCursor].departureAt;
        const departureAt = datedFrom?.departureAt ?? scheduledDepartureAt;
        if (!scheduledDepartureAt || !departureAt || departureAt < input.earliestDeparture || departureAt > journeyEnd) continue;
        for (let toCursor = fromCursor + 1; toCursor < eligibleIndexes.length && toCursor <= fromCursor + 20; toCursor++) {
          const toIndex = eligibleIndexes[toCursor];
          const to = stops[toIndex];
          const toContext = eligibleContexts[toCursor];
          if (!toContext) continue;
          const datedTo = dated?.stops[toIndex];
          if (to.dropOffType !== 0 || datedTo?.skipped || to.arrivalSeconds < from.departureSeconds) continue;
          const scheduledArrivalAt = scheduledTimes[toCursor].arrivalAt;
          const arrivalAt = datedTo?.arrivalAt ?? scheduledArrivalAt;
          if (!scheduledArrivalAt || !arrivalAt || arrivalAt < departureAt || arrivalAt > journeyEnd
            || arrivalAt.getTime() - departureAt.getTime() > 12 * 60 * 60_000) continue;
          // A duplicate loop-route segment is defined by the same stops and
          // departure instant. Avoid formatting an ISO timestamp for every
          // candidate edge; the numeric epoch value is an identical key with
          // substantially less allocation in dense feeds.
          const key = `${from.stopId}:${to.stopId}:${departureAt.getTime()}`;
          if (seenTripSegments.has(key)) continue;
          seenTripSegments.add(key);
          const segment: GtfsDirectJourney = {
            providerId: provider?.id ?? input.providerId, providerName: provider?.name ?? input.providerName,
            providerCity: providerCity ?? input.providerCity, mode: route.mode,
            routeId: trip.routeId, routeName: route.name, headsign: trip.headsign, tripId,
            originStop: fromContext.details,
            destinationStop: toContext.details,
            originTransferNodeIds: fromContext.transferNodeIds,
            destinationTransferNodeIds: toContext.transferNodeIds,
            transportType, scheduleSemantics: route.scheduleSemantics ?? 'published_departures', serviceDate, scheduledDepartureAt, scheduledArrivalAt,
            departureAt, arrivalAt, sourceFreshAt: provider?.fetchedAt ?? feed.fetchedAt,
            ...(dated?.update && dated.stops.slice(fromIndex, toIndex + 1).some((stop) => stop.updated)
              ? { realtimeUpdatedAt: dated.update.updatedAt } : {}),
            distanceToOriginStopMeters: fromContext.distanceToOriginStopMeters,
            distanceFromDestinationStopMeters: toContext.distanceFromDestinationStopMeters,
            ...(from.sourceZoneId ? { originZoneId: from.sourceZoneId } : {}),
            ...(to.sourceZoneId ? { destinationZoneId: to.sourceZoneId } : {}),
            // Candidate segments share these zones lazily; only final results
            // need their complete list for fare calculation.
            traveledZoneIds: emptyTraveledZoneIds,
          };
          const candidate = { segment, fromIndex, toIndex };
          if (!boundedTripCandidates && tripCandidates.length < graphSegmentLimitPerRoute) {
            tripCandidates.push(candidate);
            continue;
          }
          if (!boundedTripCandidates) {
            boundedTripCandidates = new BoundedBestK(graphSegmentLimitPerRoute, compareTripSegments);
            for (const retained of tripCandidates) boundedTripCandidates.consider(retained);
            tripCandidates = [];
          }
          boundedTripCandidates.consider(candidate);
        }
      }
      if (boundedTripCandidates) {
        tripCandidates = boundedTripCandidates.toSortedArray();
        segmentGraphTruncated = true;
      }
      if (tripCandidates.length) {
        const overflowCapacity = Math.min(MAX_ROUTE_OVERFLOW_SEGMENTS, graphSegmentLimitPerRoute);
        const overflow = overflowSegmentsByRoute.get(trip.routeId)
          ?? new BoundedBestK<RetainedGtfsSegment>(overflowCapacity, compareTripSegments);
        for (const candidate of tripCandidates) {
          const startsAtOrigin = originStopIds.has(candidate.segment.originStop.id);
          const canCatchOrigin = startsAtOrigin && candidate.segment.departureAt.getTime()
            >= input.earliestDeparture.getTime()
              + Math.ceil(candidate.segment.distanceToOriginStopMeters / 1.25) * 1000;
          const endsAtDestination = destinationStopIds.has(candidate.segment.destinationStop.id);
          if (canCatchOrigin || endsAtDestination) overflow.consider(candidate);
        }
        overflowSegmentsByRoute.set(trip.routeId, overflow);
        for (const { segment, fromIndex, toIndex } of tripCandidates) {
          shapeIndexesBySegment.set(segment, { fromIndex, toIndex, serviceDate });
          if (dated?.update?.stops.length) {
            segment.stops = stopCallsForTrip(feed, tripId, fromIndex, toIndex, serviceDate, dated.stops);
          }
        }
        segmentGraphTruncated ||= (retainedSegmentCountByRoute.get(trip.routeId) ?? 0) + tripCandidates.length > graphSegmentLimitPerRoute;
        const tripKey = `${trip.routeId}\u0000${tripId}\u0000${serviceDate}`;
        const canBoardFromOrigin = tripCandidates.some(({ segment }) => originStopIds.has(segment.originStop.id)
          && segment.departureAt.getTime() >= input.earliestDeparture.getTime()
            + Math.ceil(segment.distanceToOriginStopMeters / 1.25) * 1000);
        const canAlightAtDestination = tripCandidates.some(({ segment }) => destinationStopIds.has(segment.destinationStop.id));
        // Reserve graph capacity for endpoint-serving trips before sampling
        // transfer-only lines. A uniformly hashed reservoir can otherwise
        // discard a useful first or last leg even when those exact stops are
        // already selected for the query.
        const retentionTier = canBoardFromOrigin && canAlightAtDestination ? 0
          : canBoardFromOrigin ? 1 : canAlightAtDestination ? 2 : 3;
        const temporallyConnectsQueryEnds = tripCandidates.some(({ segment }) =>
          hasPriorEvent(segment, minimumTransferBufferSeconds)
          && hasNextEvent(segment, minimumTransferBufferSeconds));
        const routeCandidates = segmentsByRoute.get(trip.routeId) ?? [];
        const retained = retainBoundedTripGroup(routeCandidates, {
          key: tripKey,
          // Preserve endpoint tiers; within the transfer-only tier prioritize
          // a scheduled segment bracketed by query-reachable first/last legs
          // before using the hash as the stable tie-breaker.
          priority: retentionTier * 0x2_0000_0000
            + (retentionTier === 3 && !temporallyConnectsQueryEnds ? 0x1_0000_0000 : 0)
            + gtfsSegmentRetentionPriority(tripKey),
          segments: tripCandidates,
        }, retainedSegmentCountByRoute.get(trip.routeId) ?? 0, graphSegmentLimitPerRoute);
        if (retained.retained) {
          segmentsByRoute.set(trip.routeId, routeCandidates);
          retainedSegmentCountByRoute.set(trip.routeId, retained.segments);
        }
      }
    }
  }
  const selectedSegmentsByRoute = new Map<string, RetainedGtfsSegment[]>();
  for (const [routeId, trips] of segmentsByRoute) {
    const selected = trips.flatMap((trip) => trip.segments);
    const selectedKeys = new Set(selected.map(({ segment }) =>
      `${segment.providerId}\u0000${segment.serviceDate}\u0000${segment.tripId}\u0000${segment.originStop.id}\u0000${segment.destinationStop.id}\u0000${segment.departureAt.getTime()}\u0000${segment.arrivalAt.getTime()}`));
    const remaining = Math.max(0, (graphSegmentBudgetByRoute.get(routeId) ?? 0) - selected.length);
    const overflow = overflowSegmentsByRoute.get(routeId)?.toSortedArray() ?? [];
    const fill = overflow.filter(({ segment }) => !selectedKeys.has(
      `${segment.providerId}\u0000${segment.serviceDate}\u0000${segment.tripId}\u0000${segment.originStop.id}\u0000${segment.destinationStop.id}\u0000${segment.departureAt.getTime()}\u0000${segment.arrivalAt.getTime()}`))
      .slice(0, remaining);
    selectedSegmentsByRoute.set(routeId, [...selected, ...fill]);
  }
  const segments = [...selectedSegmentsByRoute.values()].flatMap((routeSegments) => routeSegments.map(({ segment }) => segment));
  const perRouteBudgetUsage = [...graphSegmentBudgetByRoute].map(([routeId, budget]) => ({
    budget,
    retained: selectedSegmentsByRoute.get(routeId)?.length ?? 0,
  }));
  const graphRoutesUnderfilled = perRouteBudgetUsage.filter(({ budget, retained }) => retained < budget).length;
  const graphRouteBudgetMaxUnused = Math.max(0, ...perRouteBudgetUsage.map(({ budget, retained }) => budget - retained));
  const overflowReservoirSizes = [...overflowSegmentsByRoute.values()].map((reservoir) => reservoir.toSortedArray().length);
  const routeBudgetUnderfillSample = process.env.MARSHGO_GTFS_SEARCH_DEBUG === '1'
    ? [...graphSegmentBudgetByRoute].map(([routeId, budget]) => {
      const retainedSegments = selectedSegmentsByRoute.get(routeId)?.length ?? 0;
      const wholeTripSegments = (segmentsByRoute.get(routeId) ?? [])
        .reduce((total, trip) => total + trip.segments.length, 0);
      const overflowCandidates = overflowSegmentsByRoute.get(routeId)?.toSortedArray().length ?? 0;
      return {
        routeId, budget, estimatedDemand: candidateDemandByRoute.get(routeId) ?? 0,
        wholeTripSegments, overflowCandidates, overflowAdded: Math.max(0, retainedSegments - wholeTripSegments),
        unused: Math.max(0, budget - retainedSegments),
      };
    }).filter((route) => route.unused > 0)
      .sort((left, right) => right.unused - left.unused || compareStableId(left.routeId, right.routeId))
      .slice(0, 10)
    : undefined;
  debugStage('segments-built', { tripsConsidered, tripsWithEligibleStops, segments: segments.length,
    serviceDates: serviceDates.size, corridorStops: corridorStops.size,
    candidateRouteCount, graphRoutesWithCandidates: segmentsByRoute.size,
    graphRoutesAtLimit: [...selectedSegmentsByRoute].filter(([routeId, routeSegments]) => routeSegments.length === graphSegmentBudgetByRoute.get(routeId)).length,
    graphSegmentBudgetTotal: [...graphSegmentBudgetByRoute.values()].reduce((sum, value) => sum + value, 0),
    graphSegmentBudgetUnused: Math.max(0, [...graphSegmentBudgetByRoute.values()].reduce((sum, value) => sum + value, 0) - segments.length),
    graphSegmentBudgetMax: Math.max(0, ...graphSegmentBudgetByRoute.values()),
    graphRoutesUnderfilled, graphRouteBudgetMaxUnused,
    overflowReservoirRetained: overflowReservoirSizes.reduce((sum, size) => sum + size, 0),
    overflowReservoirsAtCap: overflowReservoirSizes.filter((size) => size >= MAX_ROUTE_OVERFLOW_SEGMENTS).length,
    ...(routeBudgetUnderfillSample ? { routeBudgetUnderfillSample: JSON.stringify(routeBudgetUnderfillSample) } : {}),
    estimatedGraphDemand, graphRoutesBudgetLimited, graphRoutesAtPerRouteCap,
    globalGraphBudgetBinding: Number(globalGraphBudgetBinding),
    segmentGraphTruncated: Number(segmentGraphTruncated) });
  const outgoing = new Map<string, GtfsDirectJourney[]>();
  for (const segment of segments) {
    const choices = outgoing.get(segment.originStop.id) ?? [];
    choices.push(segment);
    outgoing.set(segment.originStop.id, choices);
  }
  for (const choices of outgoing.values()) choices.sort((a, b) => a.departureAt.getTime() - b.departureAt.getTime() || a.arrivalAt.getTime() - b.arrivalAt.getTime());

  // Index transfer endpoints by GTFS node IDs and by nearby stop IDs. The
  // geographic grid contains each stop once; it never stores a copy of every
  // scheduled segment in the cell, which made the old dense-city lookup
  // quadratic on real Lviv data.
  // Each segment is indexed once per distinct canonical boarding node. Store
  // these references in arrays: transferNodeList is already de-duplicated, so
  // a Set per node adds hashing/table overhead without changing membership.
  const outgoingByTransferNodeId = new Map<string, GtfsDirectJourney[]>();
  for (const segment of segments) {
    for (const nodeId of segment.originTransferNodeIds) {
      const choices = outgoingByTransferNodeId.get(nodeId) ?? [];
      choices.push(segment);
      outgoingByTransferNodeId.set(nodeId, choices);
    }
  }
  const outgoingStopCoordinates = new Map<string, [number, number]>();
  const outgoingStopIdsByTransferCell = new Map<string, string[]>();
  for (const [stopId, choices] of outgoing) {
    const coordinates = choices[0]?.originStop.coordinates;
    if (!coordinates) continue;
    outgoingStopCoordinates.set(stopId, coordinates);
    const [x, y] = transferCell(coordinates);
    const key = `${x}:${y}`;
    const ids = outgoingStopIdsByTransferCell.get(key) ?? [];
    ids.push(stopId);
    outgoingStopIdsByTransferCell.set(key, ids);
  }
  const transferTargetsByFromNode = new Map<string, Set<string>>();
  for (const rule of feed.transfers ?? []) {
    const targets = transferTargetsByFromNode.get(rule.fromStopId) ?? new Set<string>();
    targets.add(rule.toStopId);
    transferTargetsByFromNode.set(rule.fromStopId, targets);
  }
  const transferCandidateCache = new Map<string, GtfsDirectJourney[]>();
  const transferCandidateKey = (previous: GtfsDirectJourney) =>
    `${previous.providerId}\u0001${previous.destinationStop.id}`
      + `\u0001${previous.destinationStop.coordinates[0]}:${previous.destinationStop.coordinates[1]}`
      + `\u0001${previous.destinationTransferNodeIds.join('\u0000')}`;
  const transferCandidateViewKey = (previous: GtfsDirectJourney) => `${transferCandidateKey(previous)}\u0001${previous.routeId}`;
  const transferCandidateViewCache = new Map<string, GtfsDirectJourney[]>();
  // At each transfer depth, many scheduled segments lead to stops that cannot
  // reach the destination with the remaining leg budget. Cache a reachability-
  // filtered view once per equivalent transfer state so queue expansion does
  // not spend one search step per known-dead segment on every path.
  const transferCandidateReachableCache = new Map<string, GtfsDirectJourney[]>();

  const walkingSeconds = (meters: number) => Math.ceil(meters / 1.25);
  type TransferMeasure = { walkingMeters: number; walkingSeconds: number; geometry: Array<[number, number]> | null; inSeat: boolean };
  type TransferDecision = {
    feasible: boolean;
    measure: TransferMeasure;
    requiredSeconds: number;
    minimumBufferSeconds: number;
    ruleMinimumSeconds: number | null;
    rule: GtfsTransferRule | null;
  };

  const transferRulesByFromStop = new Map<string, GtfsTransferRule[]>();
  for (const rule of feed.transfers ?? []) {
    const rules = transferRulesByFromStop.get(rule.fromStopId) ?? [];
    rules.push(rule);
    transferRulesByFromStop.set(rule.fromStopId, rules);
  }
  const transferRuleFor = (previous: GtfsDirectJourney, next: GtfsDirectJourney): { rule: GtfsTransferRule | null; ambiguous: boolean } => {
    if (transferRulesByFromStop.size === 0) return { rule: null, ambiguous: false };
    const possibleRules = new Set<GtfsTransferRule>();
    for (const fromStopId of previous.destinationTransferNodeIds) {
      for (const candidate of transferRulesByFromStop.get(fromStopId) ?? []) possibleRules.add(candidate);
    }
    const matches = [...possibleRules].filter((rule) => previous.destinationTransferNodeIds.includes(rule.fromStopId)
      && next.originTransferNodeIds.includes(rule.toStopId)
      && (!rule.fromTripId || rule.fromTripId === previous.tripId)
      && (!rule.toTripId || rule.toTripId === next.tripId)
      && (!rule.fromRouteId || rule.fromRouteId === previous.routeId)
      && (!rule.toRouteId || rule.toRouteId === next.routeId));
    const specificity = (rule: GtfsTransferRule) => {
      if (rule.fromTripId && rule.toTripId) return 6;
      if ((rule.fromTripId && rule.toRouteId) || (rule.fromRouteId && rule.toTripId)) return 5;
      if (rule.fromTripId || rule.toTripId) return 4;
      if (rule.fromRouteId && rule.toRouteId) return 3;
      if (rule.fromRouteId || rule.toRouteId) return 2;
      return 1;
    };
    if (!matches.length) return { rule: null, ambiguous: false };
    const max = Math.max(...matches.map(specificity));
    const best = matches.filter((rule) => specificity(rule) === max);
    const signatures = new Set(best.map((rule) => `${rule.transferType}:${rule.minTransferTimeSeconds ?? ''}`));
    if (signatures.size > 1) return { rule: null, ambiguous: true };
    return { rule: best[0], ambiguous: false };
  };

  const pathwayAdjacency = new Map<string, Array<{
    to: string; seconds: number; meters: number; from: [number, number]; toCoordinates: [number, number];
  }>>();
  const pathwayNodes = new Set<string>();
  const pathwayCoordinates = new Map<string, [number, number]>();
  for (const pathway of feed.pathways ?? []) {
    const meters = pathway.lengthMeters ?? distanceMeters(pathway.fromCoordinates, pathway.toCoordinates);
    // GTFS traversal_time is authoritative when supplied. A walkway without
    // traversal_time is an explicit geometry/length based estimate at the same
    // conservative walking speed used for first/last-mile estimates.
    const seconds = pathway.traversalTimeSeconds ?? walkingSeconds(meters);
    const forward = pathwayAdjacency.get(pathway.fromStopId) ?? [];
    forward.push({ to: pathway.toStopId, seconds, meters, from: pathway.fromCoordinates, toCoordinates: pathway.toCoordinates });
    pathwayAdjacency.set(pathway.fromStopId, forward);
    pathwayNodes.add(pathway.fromStopId); pathwayNodes.add(pathway.toStopId);
    pathwayCoordinates.set(pathway.fromStopId, pathway.fromCoordinates);
    pathwayCoordinates.set(pathway.toStopId, pathway.toCoordinates);
    if (pathway.bidirectional) {
      const reverse = pathwayAdjacency.get(pathway.toStopId) ?? [];
      reverse.push({ to: pathway.fromStopId, seconds, meters, from: pathway.toCoordinates, toCoordinates: pathway.fromCoordinates });
      pathwayAdjacency.set(pathway.toStopId, reverse);
    }
  }

  const pathwayCache = new Map<string, TransferMeasure | null | false>();
  const pathwayConnection = (fromStopId: string, toStopId: string): TransferMeasure | null | false => {
    // false means this provider does not describe a path for these stops,
    // null means both stops are in its pathway graph but no physical path joins them.
    if (fromStopId === toStopId) return { walkingMeters: 0, walkingSeconds: 0, geometry: null, inSeat: false };
    const key = `${fromStopId}\u0000${toStopId}`;
    if (pathwayCache.has(key)) return pathwayCache.get(key)!;
    if (!pathwayNodes.has(fromStopId) || !pathwayNodes.has(toStopId)) {
      // Once either transfer endpoint is modeled by pathways.txt, the feed has
      // opted into station-level topology. Do not fall back to straight-line
      // proximity for a missing/disconnected endpoint.
      const result = pathwayNodes.has(fromStopId) || pathwayNodes.has(toStopId) ? null : false;
      pathwayCache.set(key, result);
      return result;
    }

    const bestSeconds = new Map<string, number>([[fromStopId, 0]]);
    const bestMeters = new Map<string, number>([[fromStopId, 0]]);
    type PathwayEdge = { to: string; seconds: number; meters: number; from: [number, number]; toCoordinates: [number, number] };
    const previous = new Map<string, { node: string; edge: PathwayEdge }>();
    const queue: Array<{ node: string; seconds: number }> = [{ node: fromStopId, seconds: 0 }];
    const visited = new Set<string>();
    while (queue.length) {
      queue.sort((a, b) => a.seconds - b.seconds || compareStableId(a.node, b.node));
      const current = queue.shift()!;
      if (visited.has(current.node)) continue;
      visited.add(current.node);
      if (current.node === toStopId) break;
      for (const edge of pathwayAdjacency.get(current.node) ?? []) {
        const nextSeconds = current.seconds + edge.seconds;
        const nextMeters = (bestMeters.get(current.node) ?? 0) + edge.meters;
        const priorSeconds = bestSeconds.get(edge.to);
        const priorMeters = bestMeters.get(edge.to);
        if (priorSeconds !== undefined && (priorSeconds < nextSeconds || (priorSeconds === nextSeconds && (priorMeters ?? Infinity) <= nextMeters))) continue;
        bestSeconds.set(edge.to, nextSeconds); bestMeters.set(edge.to, nextMeters);
        previous.set(edge.to, { node: current.node, edge });
        queue.push({ node: edge.to, seconds: nextSeconds });
      }
    }
    if (!bestSeconds.has(toStopId)) {
      pathwayCache.set(key, null);
      return null;
    }
    const path: Array<[number, number]> = [];
    let cursor = toStopId;
    while (cursor !== fromStopId) {
      const step = previous.get(cursor);
      if (!step) { pathwayCache.set(key, null); return null; }
      path.push(step.edge.toCoordinates);
      cursor = step.node;
    }
    const fromCoordinates = pathwayCoordinates.get(fromStopId);
    if (fromCoordinates) path.push(fromCoordinates);
    path.reverse();
    const result: TransferMeasure = { walkingMeters: Math.round(bestMeters.get(toStopId) ?? 0),
      walkingSeconds: Math.ceil(bestSeconds.get(toStopId) ?? 0), geometry: path, inSeat: false };
    pathwayCache.set(key, result);
    return result;
  };

  const transferBufferSeconds = (previous: GtfsDirectJourney, next: GtfsDirectJourney) => {
    const isLongDistance = (segment: GtfsDirectJourney) => ['train', 'intercity_bus'].includes(segment.transportType);
    if (isLongDistance(previous) || isLongDistance(next)) return MINIMUM_INTERCITY_TRANSFER_BUFFER_SECONDS;
    if (previous.transportType === 'suburban_train' || next.transportType === 'suburban_train') {
      return MINIMUM_SUBURBAN_TRANSFER_BUFFER_SECONDS;
    }
    return DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS;
  };
  const transferDecision = (previous: GtfsDirectJourney, next: GtfsDirectJourney): TransferDecision => {
    // Most transfer checks do not match a rule; the lookup is indexed by the
    // arriving stop so this path only compares rules relevant to the station.
    const { rule, ambiguous } = transferRuleFor(previous, next);
    if (ambiguous || rule?.transferType === 3) {
      return { feasible: false, measure: { walkingMeters: 0, walkingSeconds: 0, geometry: null, inSeat: false }, requiredSeconds: Infinity,
        minimumBufferSeconds: 0, ruleMinimumSeconds: null, rule };
    }
    const inSeat = rule?.transferType === 4;
    const fromPathwayNodes = previous.destinationTransferNodeIds.filter((id) => pathwayNodes.has(id));
    const toPathwayNodes = next.originTransferNodeIds.filter((id) => pathwayNodes.has(id));
    const candidatePaths: Array<TransferMeasure | null | false> = previous.providerId === next.providerId && (fromPathwayNodes.length || toPathwayNodes.length)
      ? fromPathwayNodes.length && toPathwayNodes.length
        ? fromPathwayNodes.flatMap((fromId) => toPathwayNodes.map((toId) => pathwayConnection(fromId, toId)))
        : [null]
      : [false];
    const routedPath = candidatePaths.filter((candidate): candidate is TransferMeasure => candidate !== null && typeof candidate === 'object')
      .sort((a, b) => a.walkingSeconds - b.walkingSeconds || a.walkingMeters - b.walkingMeters)[0]
      ?? (candidatePaths.includes(null) ? null : false);
    if (routedPath === null) {
      return { feasible: false, measure: { walkingMeters: 0, walkingSeconds: 0, geometry: null, inSeat: false }, requiredSeconds: Infinity,
        minimumBufferSeconds: 0, ruleMinimumSeconds: null, rule };
    }
    const meters = inSeat ? 0 : typeof routedPath === 'object'
      ? routedPath.walkingMeters : Math.round(distanceMeters(previous.destinationStop.coordinates, next.originStop.coordinates));
    const seconds = inSeat ? 0 : typeof routedPath === 'object'
      ? routedPath.walkingSeconds : walkingSeconds(meters);
    const measure: TransferMeasure = inSeat ? { walkingMeters: 0, walkingSeconds: 0, geometry: null, inSeat: true }
      : typeof routedPath === 'object' ? routedPath : { walkingMeters: meters, walkingSeconds: seconds, geometry: null, inSeat: false };
    if (meters > transferRadius) return { feasible: false, measure, requiredSeconds: Infinity,
      minimumBufferSeconds: 0, ruleMinimumSeconds: null, rule };
    const modeBuffer = Math.max(minimumTransferBufferSeconds, transferBufferSeconds(previous, next));
    const ruleMinimumSeconds = rule?.transferType === 2 ? rule.minTransferTimeSeconds ?? null : null;
    // GTFS min_transfer_time covers the complete connection, including the
    // walk and its variance buffer; do not add it twice to the walking time.
    const requiredSeconds = inSeat ? 0 : ruleMinimumSeconds !== null
      ? Math.max(modeBuffer + seconds, ruleMinimumSeconds)
      : modeBuffer + seconds;
    const availableSeconds = Math.floor((next.departureAt.getTime() - previous.arrivalAt.getTime()) / 1000);
    return { feasible: availableSeconds >= requiredSeconds, measure, requiredSeconds,
      minimumBufferSeconds: inSeat ? 0 : modeBuffer, ruleMinimumSeconds, rule };
  };

  const pathwayReachableCache = new Map<string, Set<string>>();
  const reachablePathwayNodes = (fromStopId: string): Set<string> => {
    const cached = pathwayReachableCache.get(fromStopId);
    if (cached) return cached;
    const reachable = new Set<string>([fromStopId]);
    const queue = [fromStopId];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const edge of pathwayAdjacency.get(queue[cursor]) ?? []) {
        if (reachable.has(edge.to)) continue;
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    }
    pathwayReachableCache.set(fromStopId, reachable);
    return reachable;
  };

  const transferCandidatePool = (previous: GtfsDirectJourney) => {
    const stateKey = transferCandidateKey(previous);
    const cached = transferCandidateCache.get(stateKey);
    if (cached) return cached;
    {
      const choices = new Set<GtfsDirectJourney>(outgoing.get(previous.destinationStop.id) ?? []);
      const [centerX, centerY] = transferCell(previous.destinationStop.coordinates);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const stopId of outgoingStopIdsByTransferCell.get(`${centerX + dx}:${centerY + dy}`) ?? []) {
          const coordinates = outgoingStopCoordinates.get(stopId);
          if (!coordinates || distanceMeters(previous.destinationStop.coordinates, coordinates) > transferRadius) continue;
          for (const candidate of outgoing.get(stopId) ?? []) {
            const hasDeclaredCrossProviderTransfer = previous.destinationTransferNodeIds.some((fromNodeId) =>
              candidate.originTransferNodeIds.some((toNodeId) => transferTargetsByFromNode.get(fromNodeId)?.has(toNodeId)));
            // Same-feed platforms may use a bounded walking transfer even when
            // transfers.txt is incomplete. Across independent providers, require
            // a canonical merged stop or a declared transfer edge; coordinate
            // proximity alone can join unrelated nearby systems.
            if (previous.providerId !== candidate.providerId && !hasDeclaredCrossProviderTransfer) continue;
            choices.add(candidate);
          }
        }
      }
      for (const fromNodeId of previous.destinationTransferNodeIds) {
        for (const toNodeId of transferTargetsByFromNode.get(fromNodeId) ?? []) {
          for (const candidate of outgoingByTransferNodeId.get(toNodeId) ?? []) choices.add(candidate);
        }
      }
      if (previous.destinationTransferNodeIds.some((id) => pathwayNodes.has(id))) {
        for (const fromNodeId of previous.destinationTransferNodeIds) {
          if (!pathwayNodes.has(fromNodeId)) continue;
          for (const toNodeId of reachablePathwayNodes(fromNodeId)) {
            for (const candidate of outgoingByTransferNodeId.get(toNodeId) ?? []) {
              if (previous.providerId === candidate.providerId) choices.add(candidate);
            }
          }
        }
      }
      const sorted = [...choices].sort((a, b) => a.departureAt.getTime() - b.departureAt.getTime() || a.arrivalAt.getTime() - b.arrivalAt.getTime());
      transferCandidateCache.set(stateKey, sorted);
      return sorted;
    }
  };
  const transferCandidates = (previous: GtfsDirectJourney) => {
    const viewKey = transferCandidateViewKey(previous);
    const view = transferCandidateViewCache.get(viewKey);
    if (view) return view;
    const sorted = transferCandidatePool(previous);
    const eligible = sorted.filter((candidate) => candidate.routeId !== previous.routeId);
    transferCandidateViewCache.set(viewKey, eligible);
    return eligible;
  };

  // The feed can contain hundreds of thousands of stop-pair segments, but
  // many share the same route, transfer node, and platform coordinates. The
  // reverse reachability pass only needs one representative per equivalent
  // transfer state; indexing those once avoids rebuilding state keys and
  // scanning the full segment array at every transfer depth.
  const transferStateGroups = new Map<string, Map<string, GtfsDirectJourney>>();
  for (const segment of segments) {
    const stateKey = transferCandidateKey(segment);
    const routeStates = transferStateGroups.get(stateKey) ?? new Map<string, GtfsDirectJourney>();
    if (!routeStates.has(segment.routeId)) routeStates.set(segment.routeId, segment);
    transferStateGroups.set(stateKey, routeStates);
  }

  const results = new Map<string, GtfsItinerary>();
  const MAX_SEARCH_RESULTS = limit * 25;
  // Once a leg-count pool is full, keep searching a bounded window so late
  // objective improvements can enter the reservoirs without scanning the
  // entire dense feed. Any remaining work is still reported as truncated.
  const MAX_OBJECTIVE_RESERVOIR_SEARCH_STEPS = 100_000;
  let candidatePoolReachedAtStep: number | null = null;
  const objectiveCandidateSamples = new Map<string, GtfsItinerary[]>();
  const objectiveSampleLimit = Math.max(1, Math.floor(limit / 5));
  const retainObjectiveCandidate = (key: string, candidate: GtfsItinerary,
    compare: (left: GtfsItinerary, right: GtfsItinerary) => number) => {
    const sample = objectiveCandidateSamples.get(key) ?? [];
    if (sample.some((item) => item.id === candidate.id)) return;
    let low = 0, high = sample.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(sample[middle], candidate) <= 0) low = middle + 1;
      else high = middle;
    }
    if (low >= objectiveSampleLimit) return;
    sample.splice(low, 0, candidate);
    if (sample.length > objectiveSampleLimit) sample.pop();
    objectiveCandidateSamples.set(key, sample);
  };
  const retainCandidateObjectives = (candidate: GtfsItinerary) => {
    retainObjectiveCandidate('duration', candidate, (a, b) => a.durationSeconds - b.durationSeconds
      || a.transfers - b.transfers || compareStableId(a.id, b.id));
    if (candidate.fare?.currency === 'UAH') retainObjectiveCandidate('fare', candidate, (a, b) => a.fare!.priceMinor - b.fare!.priceMinor
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
    retainObjectiveCandidate('transfers', candidate, (a, b) => a.transfers - b.transfers
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
    retainObjectiveCandidate('walking', candidate, (a, b) => a.walkingMeters - b.walkingMeters
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  };
  const resultCountByRouteChain = new Map<string, number>();
  const resultIdsByRouteChain = new Map<string, Set<string>>();
  const resultIdsByTripChain = new Map<string, Set<string>>();
  const resultCountByLegCount = new Map<number, number>();
  const candidatePoolReachedAtStepByLegCount = new Map<number, number>();
  const MAX_RESULTS_PER_ROUTE_CHAIN = 8;
  // Keep a few useful boarding/alighting variants for the same scheduled
  // vehicles, selected across time, fare, transfer, and walking objectives.
  const MAX_RESULTS_PER_TRIP_CHAIN = 2;
  const maxTransitLegs = maximumTransfers + 1;
  // Keep the per-leg sampling cap independent of the caller's response-page
  // size so later cross-provider ranking receives a consistent diverse pool.
  // The separate global result cap below still bounds retained path objects.
  const MAX_CANDIDATES_PER_LEG_COUNT = 500;
  // Most city-feed stops cannot lead to this destination. Exclude those dead
  // ends before enumerating timed transfer combinations.
  const reachableWithin = [destinationStopIds];
  for (let legCount = 1; legCount <= maxTransitLegs; legCount++) {
    const reachable = new Set(reachableWithin[legCount - 1]);
    for (const previousByRoute of transferStateGroups.values()) {
      const previous = previousByRoute.values().next().value as GtfsDirectJourney | undefined;
      if (!previous) continue;
      const reachableCandidateRoutes = new Set<string>();
      for (const next of transferCandidatePool(previous)) {
        if (reachable.has(next.destinationStop.id)) reachableCandidateRoutes.add(next.routeId);
        // Two distinct onward routes provide a feasible choice for every
        // previous line, so stop scanning this broad candidate pool early.
        if (reachableCandidateRoutes.size > 1) break;
      }
      // Reachability is queried at the arrival end of the current itinerary
      // leg. Keep that arrival stop reachable when a valid onward segment can
      // reach the destination within the remaining leg budget, including when
      // an explicit GTFS transfer/pathway joins distinct canonical stop IDs.
      if (reachableCandidateRoutes.size > 1) reachable.add(previous.destinationStop.id);
      else if (reachableCandidateRoutes.size === 1) {
        const onlyCandidateRoute = reachableCandidateRoutes.values().next().value as string;
        for (const [previousRoute, routeState] of previousByRoute) {
          if (previousRoute !== onlyCandidateRoute) reachable.add(routeState.destinationStop.id);
        }
      }
    }
    reachableWithin.push(reachable);
  }
  const transferCandidatesWithin = (previous: GtfsDirectJourney, remainingLegs: number) => {
    const cacheKey = `${transferCandidateViewKey(previous)}\u0001${remainingLegs}`;
    const cached = transferCandidateReachableCache.get(cacheKey);
    if (cached) return cached;
    const canReach = reachableWithin[remainingLegs - 1];
    const candidates = transferCandidates(previous).filter((candidate) => canReach.has(candidate.destinationStop.id));
    transferCandidateReachableCache.set(cacheKey, candidates);
    return candidates;
  };
  debugStage('reachability-built', { transferStates: transferCandidateCache.size,
    routeStates: transferCandidateViewCache.size, reachableStops: reachableWithin.at(-1)?.size ?? 0 });
  const maxFirstDeparture = input.latestDeparture.getTime();
  let candidateSamplingTruncated = false;
  const addPath = (path: GtfsDirectJourney[], expectedLegCount: number) => {
    if (path.length !== expectedLegCount) return;
    const first = path[0];
    const last = path.at(-1)!;
    const accessMeters = first.distanceToOriginStopMeters;
    const egressMeters = last.distanceFromDestinationStopMeters;
    const transferDecisions = path.slice(1).map((segment, index) => transferDecision(path[index], segment));
    const transferWalkingMeters = transferDecisions.map(({ measure }) => measure.walkingMeters);
    const transferWalkingSeconds = transferDecisions.map(({ measure }) => measure.walkingSeconds);
    const transferWalkingGeometries = transferDecisions.map(({ measure }) => measure.geometry);
    // Search time means when the passenger is ready to start, so initial access
    // walking and waiting for the first service are part of the door-to-door
    // duration. Ranking only the interval between the first and last vehicle
    // would incorrectly prefer a later departure with an earlier onboard start.
    const departureAt = new Date(input.earliestDeparture);
    const egressSeconds = walkingSeconds(egressMeters);
    const arrivalAt = new Date(last.arrivalAt.getTime() + egressSeconds * 1000);
    const durationSeconds = Math.ceil((arrivalAt.getTime() - departureAt.getTime()) / 1000);
    if (durationSeconds > maximumJourneySeconds) return;
    const initialWaitSeconds = Math.max(0, Math.ceil((first.departureAt.getTime()
      - departureAt.getTime() - walkingSeconds(accessMeters) * 1000) / 1000));
    const transferWaitingSeconds = path.slice(1).reduce((total, segment, index) => {
      const transferWalkSeconds = transferWalkingSeconds[index] ?? 0;
      const readyAt = path[index].arrivalAt.getTime() + transferWalkSeconds * 1000;
      return total + Math.max(0, Math.ceil((segment.departureAt.getTime() - readyAt) / 1000));
    }, 0);
    const id = path.map((segment) => `${segment.providerId}:${segment.serviceDate}:${segment.tripId}:${segment.originStop.id}:${segment.destinationStop.id}:${segment.departureAt.getTime()}:${segment.arrivalAt.getTime()}`).join('|');
    if (results.has(id)) return;
    const routeChain = path.map((segment, index) => index === 0 || path[index - 1].providerId !== segment.providerId
      || path[index - 1].routeId !== segment.routeId ? `${segment.providerId}:${segment.routeId}` : '')
      .filter(Boolean).join('>');
    const routeChainIds = resultIdsByRouteChain.get(routeChain) ?? new Set<string>();
    const tripChain = path.map((segment) => `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>');
    const tripChainIds = resultIdsByTripChain.get(tripChain) ?? new Set<string>();
    const isKnownTripChain = tripChainIds.size > 0;
    const legCount = resultCountByLegCount.get(path.length) ?? 0;
    const canReplaceRouteChainCandidate = routeChainIds.size >= MAX_RESULTS_PER_ROUTE_CHAIN;
    const candidate: GtfsItinerary = {
      id, providerId: first.providerId,
      providerName: [...new Set(path.map((segment) => segment.providerName))].join(' + '),
      segments: path, departureAt, arrivalAt, durationSeconds,
      waitingSeconds: initialWaitSeconds + transferWaitingSeconds,
      transfers: transferDecisions.filter(({ measure }) => !measure.inSeat).length,
      walkingMeters: accessMeters + egressMeters + transferWalkingMeters.reduce((sum, meters) => sum + meters, 0),
      transferWalkingMeters, transferWalkingSeconds, transferWalkingGeometries,
      transferInSeat: transferDecisions.map(({ measure }) => measure.inSeat),
      transferMinimumBufferSeconds: transferDecisions.map(({ minimumBufferSeconds }) => minimumBufferSeconds),
      transferRuleMinimumSeconds: transferDecisions.map(({ ruleMinimumSeconds }) => ruleMinimumSeconds),
      fare: calculateGtfsItineraryFare({ products: feed.fareProducts ?? new Map(), rules: feed.fareRules ?? new Map(), faresV2Present: feed.faresV2Present === true }, path.map((segment) => ({
        providerId: segment.providerId, routeId: segment.routeId,
        ...(feed.routes.get(segment.routeId)?.agencyId ? { agencyId: feed.routes.get(segment.routeId)!.agencyId } : {}),
        departureAt: segment.departureAt, arrivalAt: segment.arrivalAt,
      ...(segment.originZoneId ? { originZoneId: segment.originZoneId } : {}),
      ...(segment.destinationZoneId ? { destinationZoneId: segment.destinationZoneId } : {}),
        traveledZoneIds: (() => {
          const indexes = shapeIndexesBySegment.get(segment);
          const stopTimes = feed.stopTimes.get(segment.tripId) ?? [];
          return indexes
            ? stopTimes.slice(indexes.fromIndex, indexes.toIndex + 1).flatMap((entry) => entry.sourceZoneId ? [entry.sourceZoneId] : [])
            : segment.traveledZoneIds;
        })(),
      }))) ?? calculateCityTariffFare(path.map((segment) => ({
        providerCity: segment.providerCity,
        mode: segment.mode,
        transportType: segment.transportType,
        departureAt: segment.departureAt,
        arrivalAt: segment.arrivalAt,
      }))),
    };
    if ((!isKnownTripChain && !canReplaceRouteChainCandidate
      && (legCount >= MAX_CANDIDATES_PER_LEG_COUNT || results.size >= MAX_SEARCH_RESULTS))) {
      // Keep a small per-objective reservoir after the bounded general pool
      // fills. A late known-cheapest option must remain available to the
      // CHEAPEST response even though the complete search is still flagged as
      // sampled/truncated.
      retainCandidateObjectives(candidate);
      candidateSamplingTruncated = true;
      return;
    }
    const existingVariants = [...tripChainIds].flatMap((existingId) => {
      const existing = results.get(existingId);
      return existing ? [existing] : [];
    });
    const selectedVariants = sampleGtfsTripChainCandidates([...existingVariants, candidate], MAX_RESULTS_PER_TRIP_CHAIN);
    const selectedIds = new Set(selectedVariants.map((itinerary) => itinerary.id));
    if (!selectedIds.has(id)) {
      candidateSamplingTruncated = true;
      return;
    }

    const replacedTripVariants = existingVariants.filter((variant) => !selectedIds.has(variant.id));
    const tripVariantsForRouteSample = [...routeChainIds]
      .filter((existingId) => !replacedTripVariants.some((variant) => variant.id === existingId))
      .flatMap((existingId) => {
        const existing = results.get(existingId);
        return existing ? [existing] : [];
      });
    const selectedRouteVariants = sampleGtfsRouteChainCandidates([...tripVariantsForRouteSample, candidate], MAX_RESULTS_PER_ROUTE_CHAIN);
    const selectedRouteIds = new Set(selectedRouteVariants.map((itinerary) => itinerary.id));
    if (!selectedRouteIds.has(id)) {
      candidateSamplingTruncated = true;
      return;
    }

    const removedIds = new Set([...replacedTripVariants.map((variant) => variant.id),
      ...tripVariantsForRouteSample.filter((variant) => !selectedRouteIds.has(variant.id)).map((variant) => variant.id)]);
    if (results.size - removedIds.size + 1 > MAX_SEARCH_RESULTS) {
      retainCandidateObjectives(candidate);
      candidateSamplingTruncated = true;
      return;
    }

    for (const removedId of removedIds) {
      const removed = results.get(removedId);
      if (!removed) continue;
      results.delete(removedId);
      routeChainIds.delete(removedId);
      const removedTripChain = removed.segments.map((segment) => `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>');
      const removedTripChainIds = resultIdsByTripChain.get(removedTripChain);
      removedTripChainIds?.delete(removedId);
      if (removedTripChainIds?.size === 0) resultIdsByTripChain.delete(removedTripChain);
      resultCountByRouteChain.set(routeChain, Math.max(0, (resultCountByRouteChain.get(routeChain) ?? 1) - 1));
      resultCountByLegCount.set(removed.segments.length,
        Math.max(0, (resultCountByLegCount.get(removed.segments.length) ?? 1) - 1));
    }
    results.set(id, candidate);
    tripChainIds.add(id);
    resultIdsByTripChain.set(tripChain, tripChainIds);
    routeChainIds.add(id);
    resultIdsByRouteChain.set(routeChain, routeChainIds);
    resultCountByRouteChain.set(routeChain, (resultCountByRouteChain.get(routeChain) ?? 0) + 1);
    resultCountByLegCount.set(path.length, (resultCountByLegCount.get(path.length) ?? 0) + 1);
    if ((resultCountByLegCount.get(path.length) ?? 0) >= MAX_CANDIDATES_PER_LEG_COUNT
      && !candidatePoolReachedAtStepByLegCount.has(path.length)) {
      candidatePoolReachedAtStepByLegCount.set(path.length, searchSteps);
    }
    if (results.size >= MAX_SEARCH_RESULTS && candidatePoolReachedAtStep === null) candidatePoolReachedAtStep = searchSteps;
    if (removedIds.size > 0) candidateSamplingTruncated = true;
  };

  // Bound both graph expansion and queued alternatives. Search is round-robin
  // across first-leg route groups: a dense early route cannot spend the whole
  // budget before later lines contribute candidates to fastest/cheapest/balanced.
  let searchSteps = 0;
  // Dense urban feeds can require hundreds of thousands of bounded cursor
  // steps before the diverse 2/3-leg pool is complete. Keep a finite ceiling,
  // but do not cut off ordinary city results at the first-route frontier.
  const MAX_SEARCH_STEPS = 1_000_000;
  let searchBudgetTruncated = false;
  let maximumQueuedSearchWork = 0;

  // Feed/trip insertion order is not a routing priority. In a dense city feed,
  // the bounded DFS could spend its entire budget on late or poorly connected
  // trips before it reached an earlier departure. Search feasible first legs
  // in passenger-ready order so the bounded candidate set is useful even when
  // the graph still needs a stronger search strategy to become exhaustive.
  const firstLegs = segments.filter((segment) => originStopIds.has(segment.originStop.id)
    && segment.departureAt.getTime() <= maxFirstDeparture
    && segment.departureAt.getTime() >= input.earliestDeparture.getTime()
      + walkingSeconds(segment.distanceToOriginStopMeters) * 1000)
    .sort((a, b) => {
      const aReadyAt = a.departureAt.getTime() - walkingSeconds(a.distanceToOriginStopMeters) * 1000;
      const bReadyAt = b.departureAt.getTime() - walkingSeconds(b.distanceToOriginStopMeters) * 1000;
      return aReadyAt - bReadyAt
        || a.departureAt.getTime() - b.departureAt.getTime()
        || a.distanceToOriginStopMeters - b.distanceToOriginStopMeters
        || a.arrivalAt.getTime() - b.arrivalAt.getTime()
        || compareStableId(a.tripId, b.tripId)
        || compareStableId(a.destinationStop.id, b.destinationStop.id);
    });

  type PathWork = { kind: 'path'; path: GtfsDirectJourney[] };
  type ChildWork = {
    kind: 'children';
    path: GtfsDirectJourney[];
    last: GtfsDirectJourney;
    choices: GtfsDirectJourney[];
    nextIndex: number;
    latestNext: number;
    remainingLegs: number;
    previousIds: Set<string>;
    visitedStops: Set<string>;
  };
  type SearchWork = PathWork | ChildWork;
  type RouteSearchQueue = {
    firstLegs: GtfsDirectJourney[];
    firstLegIndex: number;
    work: SearchWork[];
    workIndex: number;
    preferFirstLeg: boolean;
  };
  const enqueueWork = (queue: RouteSearchQueue, work: SearchWork) => {
    queue.work.push(work);
    maximumQueuedSearchWork = Math.max(maximumQueuedSearchWork,
      queuesPendingWork + 1);
    queuesPendingWork++;
  };
  let queuesPendingWork = 0;
  const canContinueCandidateSearch = (legCount: number) => {
    const candidatePoolHasRoom = (resultCountByLegCount.get(legCount) ?? 0) < MAX_CANDIDATES_PER_LEG_COUNT;
    const legReservoirReachedAt = candidatePoolReachedAtStepByLegCount.get(legCount);
    const withinLegObjectiveReservoir = legReservoirReachedAt === undefined
      || searchSteps - legReservoirReachedAt < MAX_OBJECTIVE_RESERVOIR_SEARCH_STEPS;
    const withinGlobalObjectiveReservoir = results.size < MAX_SEARCH_RESULTS
      || candidatePoolReachedAtStep === null
      || searchSteps - candidatePoolReachedAtStep < MAX_OBJECTIVE_RESERVOIR_SEARCH_STEPS;
    return (candidatePoolHasRoom || withinLegObjectiveReservoir) && withinGlobalObjectiveReservoir;
  };
  const takeNextWork = (queue: RouteSearchQueue): SearchWork | undefined => {
    if (queue.preferFirstLeg && queue.firstLegIndex < queue.firstLegs.length) {
      queue.preferFirstLeg = false;
      return { kind: 'path', path: [queue.firstLegs[queue.firstLegIndex++]] };
    }
    if (queue.workIndex < queue.work.length) {
      queue.preferFirstLeg = true;
      const work = queue.work[queue.workIndex++];
      queuesPendingWork--;
      if (queue.workIndex >= 128 && queue.workIndex * 2 >= queue.work.length) {
        queue.work.splice(0, queue.workIndex);
        queue.workIndex = 0;
      }
      return work;
    }
    if (queue.firstLegIndex < queue.firstLegs.length) {
      queue.preferFirstLeg = false;
      return { kind: 'path', path: [queue.firstLegs[queue.firstLegIndex++]] };
    }
    return undefined;
  };
  const hasQueuedWork = (queues: RouteSearchQueue[]) => queues.some((queue) =>
    queue.firstLegIndex < queue.firstLegs.length || queue.workIndex < queue.work.length);
  const expandPath = (path: GtfsDirectJourney[], queue: RouteSearchQueue, maximumLegsForPass: number) => {
    searchSteps++;
    const last = path.at(-1)!;
    if (destinationStopIds.has(last.destinationStop.id) && path.length === maximumLegsForPass) {
      addPath(path, maximumLegsForPass);
    }
    const remainingLegs = maximumLegsForPass - path.length;
    if (remainingLegs <= 0 || !reachableWithin[remainingLegs].has(last.destinationStop.id)) return;
    const previousIds = new Set(path.map((segment) => segment.tripId));
    const visitedStops = new Set(path.map((segment) => segment.originStop.id));
    visitedStops.add(last.destinationStop.id);
    const choices = transferCandidatesWithin(last, remainingLegs);
    const latestNext = Math.min(last.arrivalAt.getTime() + maximumWaitSeconds * 1000, journeyEnd.getTime());
    let low = 0, high = choices.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (choices[middle].departureAt.getTime() < last.arrivalAt.getTime()) low = middle + 1;
      else high = middle;
    }
    if (low >= choices.length || choices[low].departureAt.getTime() > latestNext) return;
    enqueueWork(queue, { kind: 'children', path, last, choices, nextIndex: low, latestNext,
      remainingLegs, previousIds, visitedStops });
  };
  const expandNextChild = (work: ChildWork, queue: RouteSearchQueue) => {
    searchSteps++;
    const next = work.choices[work.nextIndex++];
    if (next.departureAt.getTime() <= work.latestNext
      && reachableWithin[work.remainingLegs - 1].has(next.destinationStop.id)
      && !work.previousIds.has(next.tripId) && !work.visitedStops.has(next.destinationStop.id)
      && transferDecision(work.last, next).feasible) {
      enqueueWork(queue, { kind: 'path', path: [...work.path, next] });
    }
    if (work.nextIndex < work.choices.length
      && work.choices[work.nextIndex].departureAt.getTime() <= work.latestNext) {
      enqueueWork(queue, work);
    }
  };
  // Give each possible chain length an explicit share of the bounded search.
  // A single depth-first pass otherwise fills its candidate pool with the
  // maximum-transfer branches before it has represented useful shorter trips.
  const depthWeights = [0.05, 0.35, 0.27, 0.20, 0.13].slice(0, maxTransitLegs);
  for (let depthIndex = 0; depthIndex < maxTransitLegs; depthIndex++) {
    const maximumLegsForPass = depthIndex + 1;
    if ((resultCountByLegCount.get(maximumLegsForPass) ?? 0) >= limit) continue;
    if (searchSteps >= MAX_SEARCH_STEPS) { searchBudgetTruncated = true; break; }
    const remainingWeight = depthWeights.slice(depthIndex).reduce((sum, weight) => sum + weight, 0);
    const stepLimit = depthIndex === maxTransitLegs - 1
      ? MAX_SEARCH_STEPS
      : Math.min(MAX_SEARCH_STEPS, searchSteps + Math.max(1,
        Math.floor((MAX_SEARCH_STEPS - searchSteps) * depthWeights[depthIndex] / remainingWeight)));
    const firstLegGroups = new Map<string, GtfsDirectJourney[]>();
    for (const segment of firstLegs) {
      const key = `${segment.providerId}:${segment.routeId}`;
      const group = firstLegGroups.get(key) ?? [];
      group.push(segment);
      firstLegGroups.set(key, group);
    }
    queuesPendingWork = 0;
    const queues: RouteSearchQueue[] = [...firstLegGroups.values()].map((group) => ({
      firstLegs: group, firstLegIndex: 0, work: [], workIndex: 0, preferFirstLeg: true,
    }));
    while (searchSteps < stepLimit && searchSteps < MAX_SEARCH_STEPS && canContinueCandidateSearch(maximumLegsForPass)) {
      let processed = false;
      for (const queue of queues) {
        if (searchSteps >= stepLimit || searchSteps >= MAX_SEARCH_STEPS || !canContinueCandidateSearch(maximumLegsForPass)) break;
        const work = takeNextWork(queue);
        if (!work) continue;
        processed = true;
        if (work.kind === 'path') expandPath(work.path, queue, maximumLegsForPass);
        else expandNextChild(work, queue);
      }
      if (!processed) break;
    }
    if (searchSteps >= stepLimit && hasQueuedWork(queues)) searchBudgetTruncated = true;
    if (!canContinueCandidateSearch(maximumLegsForPass) && hasQueuedWork(queues)) searchBudgetTruncated = true;
  }

  const allCandidateIds = new Set(results.keys());
  const rankedResults = [...results.values()];
  for (const sample of objectiveCandidateSamples.values()) {
    for (const candidate of sample) {
      if (allCandidateIds.has(candidate.id)) continue;
      allCandidateIds.add(candidate.id);
      rankedResults.push(candidate);
    }
  }
  rankedResults.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime() || a.transfers - b.transfers || compareStableId(a.id, b.id));
  const byDuration = [...rankedResults].sort((a, b) => a.durationSeconds - b.durationSeconds
    || a.transfers - b.transfers || compareStableId(a.id, b.id));
  const byComparableFare = rankedResults.filter((itinerary) => itinerary.fare?.currency === 'UAH')
    .sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor
      || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byTransfers = [...rankedResults].sort((a, b) => a.transfers - b.transfers
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const byWalking = [...rankedResults].sort((a, b) => a.walkingMeters - b.walkingMeters
    || a.durationSeconds - b.durationSeconds || compareStableId(a.id, b.id));
  const balanced = rankGtfsItinerariesForCandidateSampling(rankedResults);

  // Preserve objective extremes before filling the remaining response with
  // the fastest alternatives. The API scores these candidates again together
  // with carpool and other providers, so the GTFS stage must not discard its
  // only known-cheapest or low-transfer option just because it arrives later.
  const selected = new Map<string, GtfsItinerary>();
  const perObjective = Math.max(1, Math.floor(limit / 5));
  for (const ranking of [byDuration, byComparableFare, byTransfers, byWalking, balanced]) {
    for (const itinerary of ranking.slice(0, perObjective)) {
      if (selected.size >= limit) break;
      selected.set(itinerary.id, itinerary);
    }
  }
  for (const itinerary of rankedResults) {
    if (selected.size >= limit) break;
    selected.set(itinerary.id, itinerary);
  }
  const itineraries = [...selected.values()]
    .sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime() || a.transfers - b.transfers || compareStableId(a.id, b.id));
  for (const itinerary of itineraries) {
    for (const segment of itinerary.segments) {
      const indexes = shapeIndexesBySegment.get(segment);
      if (!indexes) continue;
      segment.routeGeometry ??= routeGeometryForTrip(feed, segment.tripId, indexes.fromIndex, indexes.toIndex);
      segment.stops ??= stopCallsForTrip(feed, segment.tripId, indexes.fromIndex, indexes.toIndex, indexes.serviceDate);
      segment.traveledZoneIds = (feed.stopTimes.get(segment.tripId) ?? [])
        .slice(indexes.fromIndex, indexes.toIndex + 1)
        .flatMap((entry) => entry.sourceZoneId ? [entry.sourceZoneId] : []);
    }
  }
  debugStage('itineraries-ranked', { searchSteps, firstLegs: firstLegs.length, candidateResults: rankedResults.length,
    ...Object.fromEntries(Array.from({ length: maxTransitLegs }, (_, index) =>
      [`candidatesWith${index + 1}Legs`, resultCountByLegCount.get(index + 1) ?? 0])),
    returned: itineraries.length,
    stopSelectionTruncated: Number(stopSelectionTruncated), searchBudgetTruncated: Number(searchBudgetTruncated),
    searchStepLimitReached: Number(searchSteps >= MAX_SEARCH_STEPS), candidateResultLimitReached: Number(results.size >= MAX_SEARCH_RESULTS),
    searchStepLimit: MAX_SEARCH_STEPS, candidatePoolReachedAtStep: candidatePoolReachedAtStep ?? 0,
    candidatePoolReachedAtStepByLegCount: JSON.stringify(Object.fromEntries(candidatePoolReachedAtStepByLegCount)),
    candidateSamplingTruncated: Number(candidateSamplingTruncated), segmentGraphTruncated: Number(segmentGraphTruncated),
    maxQueuedSearchWork: maximumQueuedSearchWork,
    searchTruncated: Number(stopSelectionTruncated || segmentGraphTruncated || searchBudgetTruncated || searchSteps >= MAX_SEARCH_STEPS
      || results.size >= MAX_SEARCH_RESULTS || candidateSamplingTruncated),
    resultLimitReached: Number(rankedResults.length > itineraries.length || candidateSamplingTruncated) });
  return {
    itineraries,
    searchTruncated: stopSelectionTruncated || segmentGraphTruncated || searchBudgetTruncated || searchSteps >= MAX_SEARCH_STEPS
      || results.size >= MAX_SEARCH_RESULTS || candidateSamplingTruncated,
    resultLimitReached: rankedResults.length > itineraries.length || candidateSamplingTruncated,
    candidateGraphTruncated: segmentGraphTruncated,
  };
}

export function findGtfsItineraries(feed: GtfsTimetableFeed, input: GtfsItinerarySearchInput): GtfsItinerary[] {
  return findGtfsItinerariesWithStats(feed, input).itineraries;
}

const feedCache = new BoundedPromiseCache<GtfsTimetableFeed>(
  MAX_CACHED_GTFS_FEEDS,
  MAX_ESTIMATED_GTFS_CACHE_BYTES,
  CACHE_TTL_MS,
  FAILED_FEED_CACHE_TTL_MS,
);

/** Internal worker diagnostics; this is not exposed as a public API route. */
export function getCachedGtfsTimetableStats(): { entries: number; estimatedBytes: number } {
  return { entries: feedCache.size, estimatedBytes: feedCache.weight };
}

// Parsed JS objects use substantially more memory than their source CSV. This
// deliberately conservative estimate accounts for map entries and per-row
// objects; it is a cache bound, not a claim about exact process RSS.
function estimateGtfsFeedCacheBytes(feed: GtfsTimetableFeed): number {
  let stopTimeRows = 0;
  for (const rows of feed.stopTimes.values()) stopTimeRows += rows.length;
  let shapePoints = 0;
  for (const points of feed.shapes?.values() ?? []) shapePoints += points.length;
  const retainedRecords = stopTimeRows * 512
    + feed.stops.size * 768
    + feed.stopTimesByStop.size * 192
    + feed.trips.size * 512
    + shapePoints * 48
    + feed.routes.size * 768
    + feed.calendars.size * 512
    + (feed.transfers?.length ?? 0) * 512;
  const ancillary = (feed.pathways?.length ?? 0) * 512
    + (feed.fareProducts?.size ?? 0) * 512
    + (feed.fareRules?.size ?? 0) * 512
    + (feed.exceptions.size * 256);
  return Math.max(1, retainedRecords + ancillary);
}

export function cachedGtfsTimetable(providerId: string, url: string, now = Date.now()): Promise<GtfsTimetableFeed> {
  return feedCache.getOrLoad(providerId, async () => {
    const { data } = await fetchBinary(url, MAX_FEED_BYTES, 15_000);
    const unzipped = unzipSync(data, { filter: (file) => /(^|\/)(agency|routes|stops|trips|stop_times|calendar|calendar_dates|shapes|transfers|pathways|levels|fare_attributes|fare_rules|fare_media|fare_products|fare_leg_rules|fare_leg_join_rules|fare_transfer_rules|rider_categories|timeframes|networks|route_networks|areas|stop_areas)\.txt$/.test(file.name) && file.originalSize < 200 * 1024 * 1024 });
    const files = Object.fromEntries(Object.entries(unzipped).map(([name, content]) => [name.split('/').pop() as string, content]));
    return parseGtfsTimetable(files);
  }, estimateGtfsFeedCacheBytes, now);
}
