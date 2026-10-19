import bindings from 'gtfs-realtime-bindings';
import { fetchBinary } from '../mobility/safeFetch';

const { transit_realtime } = bindings;
type FeedMessage = InstanceType<typeof bindings.transit_realtime.FeedMessage>;
const MAX_FEED_BYTES = 10 * 1024 * 1024;
const MAX_FEED_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const CACHE_TTL_MS = 15_000;

export interface GtfsRealtimeEvent {
  time?: Date;
  delaySeconds?: number;
}

export interface GtfsRealtimeStopUpdate {
  stopSequence: number;
  stopId?: string;
  arrival?: GtfsRealtimeEvent;
  departure?: GtfsRealtimeEvent;
  relationship: 'SCHEDULED' | 'SKIPPED' | 'NO_DATA' | 'UNSCHEDULED';
}

export interface GtfsRealtimeTripUpdate {
  tripId: string;
  routeId?: string;
  startDate: string;
  relationship: 'SCHEDULED' | 'CANCELED' | 'DELETED' | 'OTHER';
  stops: GtfsRealtimeStopUpdate[];
  /** Timestamp declared by this TripUpdate, or by its enclosing feed. */
  updatedAt: Date;
  /** The validated source timestamp used for the freshness decision. */
  feedTimestamp: Date;
}

export interface GtfsRealtimeTripUpdates {
  feedTimestamp: Date;
  fresh: boolean;
  reason?: 'MISSING_TIMESTAMP' | 'STALE' | 'FUTURE_TIMESTAMP' | 'DIFFERENTIAL_UNSUPPORTED';
  updates: Map<string, GtfsRealtimeTripUpdate>;
}

function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateFromSeconds(value: unknown): Date | undefined {
  const seconds = numeric(value);
  if (seconds <= 0) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function boundedDelay(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 24 * 60 * 60) return undefined;
  return value;
}

function realtimeKey(tripId: string, startDate: string): string {
  return `${tripId}\u0000${startDate}`;
}

/** Parse only a complete, fresh GTFS-RT snapshot. Differential feeds need a persisted base snapshot and are ignored. */
export function parseGtfsRealtimeTripUpdates(data: Uint8Array, now = new Date()): GtfsRealtimeTripUpdates {
  const message: FeedMessage = transit_realtime.FeedMessage.decode(data);
  const timestamp = dateFromSeconds(message.header.timestamp);
  const empty = (feedTimestamp: Date, reason: GtfsRealtimeTripUpdates['reason']): GtfsRealtimeTripUpdates => ({
    feedTimestamp,
    fresh: false,
    ...(reason ? { reason } : {}),
    updates: new Map(),
  });
  if (!timestamp) return empty(new Date(0), 'MISSING_TIMESTAMP');
  const age = now.getTime() - timestamp.getTime();
  if (age < -MAX_FUTURE_SKEW_MS) return empty(timestamp, 'FUTURE_TIMESTAMP');
  if (age > MAX_FEED_AGE_MS) return empty(timestamp, 'STALE');
  if (message.header.incrementality === transit_realtime.FeedHeader.Incrementality.DIFFERENTIAL) {
    return empty(timestamp, 'DIFFERENTIAL_UNSUPPORTED');
  }

  const updates = new Map<string, GtfsRealtimeTripUpdate>();
  for (const entity of message.entity) {
    const tripUpdate = entity.tripUpdate;
    const descriptor = tripUpdate?.trip;
    const tripId = descriptor?.tripId?.trim();
    const startDate = descriptor?.startDate ?? '';
    if (!tripUpdate || !descriptor || !tripId || !/^\d{8}$/.test(startDate)) continue;
    const relationship = descriptor.scheduleRelationship === transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED
      ? 'CANCELED'
      : descriptor.scheduleRelationship === transit_realtime.TripDescriptor.ScheduleRelationship.DELETED ? 'DELETED'
        : descriptor.scheduleRelationship === undefined || descriptor.scheduleRelationship === transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED
          ? 'SCHEDULED' : 'OTHER';
    const stops = (tripUpdate.stopTimeUpdate ?? []).flatMap((stop): GtfsRealtimeStopUpdate[] => {
      const stopSequence = stop.stopSequence;
      if (stopSequence === undefined || stopSequence === null || !Number.isSafeInteger(stopSequence) || stopSequence < 0) return [];
      const event = (value: typeof stop.arrival): GtfsRealtimeEvent | undefined => {
        if (!value) return undefined;
        const time = dateFromSeconds(value.time);
        const delaySeconds = boundedDelay(value.delay);
        return time || delaySeconds !== undefined ? { ...(time ? { time } : {}), ...(delaySeconds !== undefined ? { delaySeconds } : {}) } : undefined;
      };
      const stopRelationship = stop.scheduleRelationship === transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED
        ? 'SKIPPED'
        : stop.scheduleRelationship === transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA ? 'NO_DATA'
          : stop.scheduleRelationship === transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.UNSCHEDULED ? 'UNSCHEDULED' : 'SCHEDULED';
      return [{ stopSequence, ...(stop.stopId ? { stopId: stop.stopId } : {}),
        ...(event(stop.arrival) ? { arrival: event(stop.arrival) } : {}),
        ...(event(stop.departure) ? { departure: event(stop.departure) } : {}), relationship: stopRelationship }];
    }).sort((a, b) => a.stopSequence - b.stopSequence);
    const updateTimestamp = dateFromSeconds(tripUpdate.timestamp) ?? timestamp;
    const updateAge = now.getTime() - updateTimestamp.getTime();
    if (updateAge < -MAX_FUTURE_SKEW_MS || updateAge > MAX_FEED_AGE_MS) continue;
    updates.set(realtimeKey(tripId, startDate), {
      tripId, ...(descriptor.routeId ? { routeId: descriptor.routeId } : {}), startDate, relationship, stops,
      updatedAt: updateTimestamp, feedTimestamp: timestamp,
    });
  }
  return { feedTimestamp: timestamp, fresh: true, updates };
}

const cache = new Map<string, { cachedAt: number; promise: Promise<GtfsRealtimeTripUpdates> }>();

/** Short-lived in-memory cache prevents a route search from refetching the same live snapshot. */
export function cachedGtfsRealtimeTripUpdates(providerId: string, url: string, now = Date.now()): Promise<GtfsRealtimeTripUpdates> {
  const cached = cache.get(providerId);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) return cached.promise;
  const promise = (async () => {
    const { data } = await fetchBinary(url, MAX_FEED_BYTES, 8_000);
    return parseGtfsRealtimeTripUpdates(data, new Date(now));
  })();
  cache.set(providerId, { cachedAt: now, promise });
  promise.catch(() => { if (cache.get(providerId)?.promise === promise) cache.delete(providerId); });
  return promise;
}

export function gtfsRealtimeTripUpdateKey(tripId: string, serviceDate: string): string {
  return realtimeKey(tripId, serviceDate.replaceAll('-', ''));
}
