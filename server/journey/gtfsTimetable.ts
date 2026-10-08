import { unzipSync, strFromU8 } from 'fflate';
import { fetchBinary } from '../mobility/safeFetch';
import { parseCsvLine, routeTypeLabel } from '../mobility/gtfs';

const MAX_FEED_BYTES = 60 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const MAX_STOPS_PER_SIDE = 12;
const EARTH_RADIUS_M = 6_371_000;

type CsvRow = Record<string, string>;
export type TransitJourneyMode = 'BUS' | 'MINIBUS' | 'RAIL' | 'TRAM' | 'TROLLEYBUS' | 'METRO' | 'FERRY';

export interface GtfsTimetableFeed {
  fetchedAt: Date;
  timezone: string;
  routes: Map<string, { name: string; mode: TransitJourneyMode }>;
  stops: Map<string, { id: string; name: string; lon: number; lat: number }>;
  trips: Map<string, { routeId: string; serviceId: string; headsign: string }>;
  stopTimes: Map<string, Array<{ stopId: string; sequence: number; arrivalSeconds: number; departureSeconds: number; pickupType: number; dropOffType: number }>>;
  stopTimesByStop: Map<string, Array<{ tripId: string; index: number }>>;
  calendars: Map<string, { start: string; end: string; weekdays: boolean[] }>;
  exceptions: Map<string, Map<string, number>>;
}

export interface GtfsDirectJourney {
  providerId: string;
  providerName: string;
  mode: TransitJourneyMode;
  routeId: string;
  routeName: string;
  headsign: string;
  tripId: string;
  originStop: { id: string; name: string; coordinates: [number, number] };
  destinationStop: { id: string; name: string; coordinates: [number, number] };
  departureAt: Date;
  arrivalAt: Date;
  sourceFreshAt: Date;
  distanceToOriginStopMeters: number;
  distanceFromDestinationStopMeters: number;
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

function modeForRouteType(routeType: number): TransitJourneyMode | null {
  const label = routeTypeLabel(routeType);
  if (label === 'bus') return 'BUS';
  if (label === 'marshrutka') return 'MINIBUS';
  if (label === 'train' || label === 'suburban') return 'RAIL';
  if (label === 'tram') return 'TRAM';
  if (label === 'trolleybus') return 'TROLLEYBUS';
  if (label === 'metro') return 'METRO';
  if (label === 'ferry') return 'FERRY';
  return null;
}

export function parseGtfsTimetable(files: Record<string, Uint8Array>, fetchedAt = new Date()): GtfsTimetableFeed {
  const text = (name: string) => files[name] ? strFromU8(files[name]) : '';
  const timezone = csvRows(text('agency.txt'))[0]?.agency_timezone;
  if (!timezone || !isValidTimezone(timezone)) throw new Error('GTFS feed must include a valid agency_timezone');

  const routes = new Map<string, { name: string; mode: TransitJourneyMode }>();
  for (const row of csvRows(text('routes.txt'))) {
    const mode = modeForRouteType(integer(row.route_type, -1));
    if (!mode || !row.route_id) continue;
    routes.set(row.route_id, { name: row.route_short_name?.trim() || row.route_long_name?.trim() || row.route_id, mode });
  }

  const stops = new Map<string, { id: string; name: string; lon: number; lat: number }>();
  for (const row of csvRows(text('stops.txt'))) {
    const lon = Number(row.stop_lon), lat = Number(row.stop_lat);
    if (!row.stop_id || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90 || (lon === 0 && lat === 0)) continue;
    stops.set(row.stop_id, { id: row.stop_id, name: row.stop_name?.trim() || row.stop_id, lon, lat });
  }

  const trips = new Map<string, { routeId: string; serviceId: string; headsign: string }>();
  for (const row of csvRows(text('trips.txt'))) {
    if (!row.trip_id || !row.service_id || !routes.has(row.route_id)) continue;
    trips.set(row.trip_id, { routeId: row.route_id, serviceId: row.service_id, headsign: row.trip_headsign?.trim() || '' });
  }

  const stopTimes = new Map<string, Array<{ stopId: string; sequence: number; arrivalSeconds: number; departureSeconds: number; pickupType: number; dropOffType: number }>>();
  for (const row of csvRows(text('stop_times.txt'))) {
    if (!trips.has(row.trip_id) || !stops.has(row.stop_id)) continue;
    const arrivalSeconds = gtfsTime(row.arrival_time), departureSeconds = gtfsTime(row.departure_time);
    if (arrivalSeconds === null || departureSeconds === null) continue;
    const list = stopTimes.get(row.trip_id) ?? [];
    list.push({ stopId: row.stop_id, sequence: integer(row.stop_sequence, -1), arrivalSeconds, departureSeconds, pickupType: integer(row.pickup_type), dropOffType: integer(row.drop_off_type) });
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

  return { fetchedAt, timezone, routes, stops, trips, stopTimes, stopTimesByStop, calendars, exceptions };
}

function isValidTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); return true; } catch { return false; }
}

function localDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
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
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    guess += target - represented;
  }
  const result = new Date(guess);
  if (localDate(result, timezone) !== dateStringAfter(serviceDate, dayOffset)) return null;
  return result;
}

function dateStringAfter(date: string, days: number): string {
  const value = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)) + days));
  return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}`;
}

function distanceMeters(a: [number, number], b: [number, number]): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(b[1] - a[1]), dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
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
    .filter(({ distance }) => distance <= radius).sort((a, b) => a.distance - b.distance).slice(0, MAX_STOPS_PER_SIDE);
  const destinationStops = [...feed.stops.values()].map((stop) => ({ stop, distance: distanceMeters(input.destination, [stop.lon, stop.lat]) }))
    .filter(({ distance }) => distance <= radius).sort((a, b) => a.distance - b.distance).slice(0, MAX_STOPS_PER_SIDE);
  if (originStops.length === 0 || destinationStops.length === 0) return [];
  const originById = new Map(originStops.map((item) => [item.stop.id, item]));
  const destinationById = new Map(destinationStops.map((item) => [item.stop.id, item]));
  const firstDate = localDate(input.earliestDeparture, feed.timezone);
  const lastDate = localDate(input.latestDeparture, feed.timezone);
  // GTFS permits stop times beyond 24:00. Include the prior service day so
  // trips such as Monday 24:15 can be found for a Tuesday 00:15 departure.
  const serviceDates = [...new Set([dateStringAfter(firstDate, -1), firstDate, lastDate])];
  const results: GtfsDirectJourney[] = [];
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
        const departureAt = localServiceTimeToUtc(serviceDate, from.departureSeconds, feed.timezone);
        if (!departureAt || departureAt < input.earliestDeparture || departureAt > input.latestDeparture) continue;
        for (let toIndex = fromIndex + 1; toIndex < stops.length; toIndex++) {
          const to = stops[toIndex];
          const destinationMatch = destinationById.get(to.stopId);
          if (!destinationMatch || to.dropOffType !== 0 || to.arrivalSeconds < from.departureSeconds) continue;
          const arrivalAt = localServiceTimeToUtc(serviceDate, to.arrivalSeconds, feed.timezone);
          if (!arrivalAt || arrivalAt < departureAt) continue;
          const resultKey = `${tripId}:${from.stopId}:${to.stopId}:${departureAt.toISOString()}`;
          if (searched.has(resultKey)) break;
          searched.add(resultKey);
          results.push({ providerId: input.providerId, providerName: input.providerName, mode: route.mode,
            routeId: trip.routeId, routeName: route.name, headsign: trip.headsign, tripId,
            originStop: { id: originMatch.stop.id, name: originMatch.stop.name, coordinates: [originMatch.stop.lon, originMatch.stop.lat] },
            destinationStop: { id: destinationMatch.stop.id, name: destinationMatch.stop.name, coordinates: [destinationMatch.stop.lon, destinationMatch.stop.lat] },
            departureAt, arrivalAt, sourceFreshAt: feed.fetchedAt,
            distanceToOriginStopMeters: Math.round(originMatch.distance), distanceFromDestinationStopMeters: Math.round(destinationMatch.distance) });
          break;
        }
      }
    }
  }
  return [...new Map(results.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime() || a.departureAt.getTime() - b.departureAt.getTime())
    .map((journey) => [`${journey.providerId}:${journey.tripId}:${journey.originStop.id}:${journey.destinationStop.id}:${journey.departureAt.toISOString()}`, journey])).values()].slice(0, limit);
}

const feedCache = new Map<string, { cachedAt: number; promise: Promise<GtfsTimetableFeed> }>();

export function cachedGtfsTimetable(providerId: string, url: string, now = Date.now()): Promise<GtfsTimetableFeed> {
  const hit = feedCache.get(providerId);
  if (hit && now - hit.cachedAt < CACHE_TTL_MS) return hit.promise;
  const promise = (async () => {
    const { data } = await fetchBinary(url, MAX_FEED_BYTES, 30_000);
    const unzipped = unzipSync(data, { filter: (file) => /(^|\/)(agency|routes|stops|trips|stop_times|calendar|calendar_dates)\.txt$/.test(file.name) && file.originalSize < 200 * 1024 * 1024 });
    const files = Object.fromEntries(Object.entries(unzipped).map(([name, content]) => [name.split('/').pop() as string, content]));
    return parseGtfsTimetable(files);
  })();
  feedCache.set(providerId, { cachedAt: now, promise });
  promise.catch(() => { if (feedCache.get(providerId)?.promise === promise) feedCache.delete(providerId); });
  return promise;
}
