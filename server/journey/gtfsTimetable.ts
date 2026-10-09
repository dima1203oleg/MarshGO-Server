import { unzipSync, strFromU8 } from 'fflate';
import { fetchBinary } from '../mobility/safeFetch';
import { parseCsvLine, routeTypeLabel } from '../mobility/gtfs';

const MAX_FEED_BYTES = 60 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const MAX_STOPS_PER_SIDE = 12;
const MAX_STOPS_PER_TRANSPORT_TYPE = 2;
const EARTH_RADIUS_M = 6_371_000;

type CsvRow = Record<string, string>;
export type TransitJourneyMode = 'BUS' | 'MINIBUS' | 'RAIL' | 'TRAM' | 'TROLLEYBUS' | 'METRO' | 'FERRY' | 'FUNICULAR';
export type GtfsTransportType = 'bus' | 'marshrutka' | 'intercity_bus' | 'train' | 'suburban_train' | 'city_train' | 'tram' | 'trolleybus' | 'metro' | 'ferry' | 'funicular';

export interface GtfsTimetableFeed {
  fetchedAt: Date;
  timezone: string;
  routes: Map<string, { name: string; mode: TransitJourneyMode; transportType: GtfsTransportType }>;
  stops: Map<string, { id: string; name: string; lon: number; lat: number }>;
  trips: Map<string, { routeId: string; serviceId: string; headsign: string }>;
  stopTimes: Map<string, Array<{ stopId: string; sequence: number; arrivalSeconds: number; departureSeconds: number; pickupType: number; dropOffType: number; sourceStopName?: string; sourceStopCoordinates?: [number, number] }>>;
  stopTimesByStop: Map<string, Array<{ tripId: string; index: number }>>;
  calendars: Map<string, { start: string; end: string; weekdays: boolean[] }>;
  exceptions: Map<string, Map<string, number>>;
  providersByRoute?: Map<string, { id: string; name: string; city: string; fetchedAt: Date }>;
}

export interface GtfsTimetableSource {
  providerId: string;
  providerName: string;
  providerCity: string;
  feed: GtfsTimetableFeed;
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
  transportType: GtfsTransportType;
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

export interface GtfsItinerarySearchInput extends SearchInput {
  maximumJourneySeconds?: number;
  maximumTransfers?: number;
  minimumTransferBufferSeconds?: number;
  maximumWaitSeconds?: number;
  allowedModes?: readonly TransitJourneyMode[];
  allowedTransportTypes?: readonly string[];
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
  transfers: number;
  walkingMeters: number;
  transferWalkingMeters: number[];
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

  const routes = new Map<string, { name: string; mode: TransitJourneyMode; transportType: GtfsTransportType }>();
  for (const row of csvRows(text('routes.txt'))) {
    const name = row.route_short_name?.trim() || row.route_long_name?.trim() || row.route_id;
    const route = routeMode(integer(row.route_type, -1), `${row.route_short_name ?? ''} ${row.route_long_name ?? ''} ${row.route_desc ?? ''}`);
    if (!route || !row.route_id) continue;
    routes.set(row.route_id, { name, ...route });
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

  const stopTimes: GtfsTimetableFeed['stopTimes'] = new Map();
  for (const row of csvRows(text('stop_times.txt'))) {
    if (!trips.has(row.trip_id) || !stops.has(row.stop_id)) continue;
    const arrivalSeconds = gtfsTime(row.arrival_time), departureSeconds = gtfsTime(row.departure_time);
    if (arrivalSeconds === null || departureSeconds === null) continue;
    const list = stopTimes.get(row.trip_id) ?? [];
    const sourceStop = stops.get(row.stop_id);
    list.push({ stopId: row.stop_id, sequence: integer(row.stop_sequence, -1), arrivalSeconds, departureSeconds,
      pickupType: integer(row.pickup_type), dropOffType: integer(row.drop_off_type),
      ...(sourceStop ? { sourceStopName: sourceStop.name, sourceStopCoordinates: [sourceStop.lon, sourceStop.lat] as [number, number] } : {}) });
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

/**
 * Combines compatible static feeds so transfers can cross provider boundaries.
 * Stops join by matching normalized names and close coordinates. A named city
 * railway-station stop may also join a nearby stop served by a national rail
 * timetable, despite operator-specific names; the transfer remains an
 * explicit, timed walking leg in the itinerary.
 */
export function mergeGtfsTimetables(sources: readonly GtfsTimetableSource[]): GtfsTimetableFeed | null {
  if (sources.length === 0) return null;
  const ordered = [...sources].sort((a, b) => a.providerId.localeCompare(b.providerId));
  const timezone = ordered[0].feed.timezone;
  if (ordered.some((source) => source.feed.timezone !== timezone)) throw new TypeError('GTFS feeds with different timezones cannot be combined');

  const routes: GtfsTimetableFeed['routes'] = new Map();
  const stops: GtfsTimetableFeed['stops'] = new Map();
  const trips: GtfsTimetableFeed['trips'] = new Map();
  const stopTimes: GtfsTimetableFeed['stopTimes'] = new Map();
  const calendars: GtfsTimetableFeed['calendars'] = new Map();
  const exceptions: GtfsTimetableFeed['exceptions'] = new Map();
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
        const canonical = { id, name: stop.name, lon: stop.lon, lat: stop.lat };
        stops.set(id, canonical);
        candidates.push({ id, lon: stop.lon, lat: stop.lat });
        stopsByName.set(nameKey, candidates);
      }
      remappedStops.set(stop.id, id);
    }

    for (const [routeId, route] of source.feed.routes) {
      const mergedRouteId = `${prefix}${routeId}`;
      routes.set(mergedRouteId, route);
      providersByRoute.set(mergedRouteId, { id: source.providerId, name: source.providerName, city: source.providerCity, fetchedAt: source.feed.fetchedAt });
    }
    for (const [serviceId, calendar] of source.feed.calendars) calendars.set(`${prefix}${serviceId}`, calendar);
    for (const [serviceId, byDate] of source.feed.exceptions) exceptions.set(`${prefix}${serviceId}`, new Map(byDate));
    for (const [tripId, trip] of source.feed.trips) {
      const mergedTripId = `${prefix}${tripId}`;
      const mergedRouteId = `${prefix}${trip.routeId}`;
      const mergedServiceId = `${prefix}${trip.serviceId}`;
      if (!routes.has(mergedRouteId)) continue;
      trips.set(mergedTripId, { ...trip, routeId: mergedRouteId, serviceId: mergedServiceId });
      const entries = source.feed.stopTimes.get(tripId)?.flatMap((entry) => {
        const stopId = remappedStops.get(entry.stopId);
        return stopId ? [{ ...entry, stopId }] : [];
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
  return { fetchedAt, timezone, routes, stops, trips, stopTimes, stopTimesByStop, calendars, exceptions, providersByRoute };
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
  const serviceTimeToUtc = createServiceTimeConverter(feed.timezone);
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
        const departureAt = serviceTimeToUtc(serviceDate, from.departureSeconds);
        if (!departureAt || departureAt < input.earliestDeparture || departureAt > input.latestDeparture) continue;
        for (let toIndex = fromIndex + 1; toIndex < stops.length; toIndex++) {
          const to = stops[toIndex];
          const destinationMatch = destinationById.get(to.stopId);
          if (!destinationMatch || to.dropOffType !== 0 || to.arrivalSeconds < from.departureSeconds) continue;
          const arrivalAt = serviceTimeToUtc(serviceDate, to.arrivalSeconds);
          if (!arrivalAt || arrivalAt < departureAt) continue;
          const resultKey = `${tripId}:${from.stopId}:${to.stopId}:${departureAt.toISOString()}`;
          if (searched.has(resultKey)) break;
          searched.add(resultKey);
          const originCoordinates = from.sourceStopCoordinates ?? [originMatch.stop.lon, originMatch.stop.lat] as [number, number];
          const destinationCoordinates = to.sourceStopCoordinates ?? [destinationMatch.stop.lon, destinationMatch.stop.lat] as [number, number];
          results.push({ providerId: input.providerId, providerName: input.providerName, mode: route.mode,
            routeId: trip.routeId, routeName: route.name, headsign: trip.headsign, tripId,
            originStop: { id: originMatch.stop.id, name: from.sourceStopName ?? originMatch.stop.name, coordinates: originCoordinates },
            destinationStop: { id: destinationMatch.stop.id, name: to.sourceStopName ?? destinationMatch.stop.name, coordinates: destinationCoordinates },
            transportType: route.transportType,
            departureAt, arrivalAt, sourceFreshAt: feed.fetchedAt,
            distanceToOriginStopMeters: Math.round(distanceMeters(input.origin, originCoordinates)),
            distanceFromDestinationStopMeters: Math.round(distanceMeters(input.destination, destinationCoordinates)) });
          break;
        }
      }
    }
  }
  return [...new Map(results.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime() || a.departureAt.getTime() - b.departureAt.getTime())
    .map((journey) => [`${journey.providerId}:${journey.tripId}:${journey.originStop.id}:${journey.destinationStop.id}:${journey.departureAt.toISOString()}`, journey])).values()].slice(0, limit);
}

/**
 * Build scheduled itineraries with up to three transit legs. Transfers are
 * composed at the same stop, including conservatively matched stops across
 * feeds. Walking to and from the first/last stop uses a conservative straight-
 * line estimate and is surfaced separately in the result.
 */
export function findGtfsItineraries(feed: GtfsTimetableFeed, input: GtfsItinerarySearchInput): GtfsItinerary[] {
  const now = input.now ?? new Date();
  const maximumJourneySeconds = input.maximumJourneySeconds ?? 24 * 60 * 60;
  const maximumTransfers = input.maximumTransfers ?? 2;
  const minimumTransferBufferSeconds = input.minimumTransferBufferSeconds ?? 600;
  const maximumWaitSeconds = input.maximumWaitSeconds ?? 4 * 60 * 60;
  const radius = input.maximumStopDistanceMeters ?? 2000;
  const limit = input.limit ?? 20;
  if (!Number.isFinite(input.earliestDeparture.getTime()) || !Number.isFinite(input.latestDeparture.getTime())
    || input.latestDeparture < input.earliestDeparture || input.earliestDeparture < now
    || !Number.isInteger(maximumJourneySeconds) || maximumJourneySeconds < 60 || maximumJourneySeconds > 7 * 24 * 60 * 60
    || !Number.isInteger(maximumTransfers) || maximumTransfers < 0 || maximumTransfers > 2
    || !Number.isInteger(minimumTransferBufferSeconds) || minimumTransferBufferSeconds < 0 || minimumTransferBufferSeconds > 7200
    || !Number.isInteger(maximumWaitSeconds) || maximumWaitSeconds < 0 || maximumWaitSeconds > maximumJourneySeconds
    || !Number.isFinite(radius) || radius < 100 || radius > 10_000
    || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('GTFS itinerary search bounds are invalid');
  }

  const closestStops = (point: [number, number]) => {
    const ranked = [...feed.stops.values()]
      .filter((stop) => feed.stopTimesByStop.has(stop.id))
      .map((stop) => ({ stop, distance: distanceMeters(point, [stop.lon, stop.lat]), types: new Set<GtfsTransportType>() }))
      .filter(({ distance }) => distance <= radius)
      .sort((a, b) => a.distance - b.distance);
    const selected = new Map<string, typeof ranked[number]>();
    for (const item of ranked.slice(0, MAX_STOPS_PER_SIDE)) selected.set(item.stop.id, item);
    const selectedByType = new Map<GtfsTransportType, number>();
    for (const item of ranked) {
      for (const entry of feed.stopTimesByStop.get(item.stop.id) ?? []) {
        const trip = feed.trips.get(entry.tripId);
        const route = trip ? feed.routes.get(trip.routeId) : undefined;
        if (!route) continue;
        const providerCity = feed.providersByRoute?.get(trip!.routeId)?.city ?? input.providerCity;
        const type = route.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route.transportType;
        item.types.add(type);
      }
      for (const type of item.types) {
        const count = selectedByType.get(type) ?? 0;
        if (count >= MAX_STOPS_PER_TRANSPORT_TYPE) continue;
        if (!selected.has(item.stop.id)) selected.set(item.stop.id, item);
        selectedByType.set(type, count + 1);
      }
    }
    return [...selected.values()];
  };
  const originStops = closestStops(input.origin);
  const destinationStops = closestStops(input.destination);
  if (!originStops.length || !destinationStops.length) return [];

  const routeDistance = distanceMeters(input.origin, input.destination);
  const corridorWidth = Math.max(12_000, Math.min(60_000, routeDistance * 0.2));
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

  const segments: GtfsDirectJourney[] = [];
  const seenSegments = new Set<string>();
  for (const [tripId, trip] of feed.trips) {
    const route = feed.routes.get(trip.routeId);
    const stops = feed.stopTimes.get(tripId);
    if (!route || !stops || stops.length < 2 || (input.allowedModes && !input.allowedModes.includes(route.mode))) continue;
    const provider = feed.providersByRoute?.get(trip.routeId);
    const providerCity = provider?.city ?? input.providerCity;
    const transportType = route.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route.transportType;
    if (input.allowedTransportTypes && !input.allowedTransportTypes.includes(transportType)) continue;
    const eligibleIndexes = stops.flatMap((stop, index) => corridorStops.has(stop.stopId) ? [index] : []);
    if (eligibleIndexes.length < 2) continue;
    for (const serviceDate of serviceDates) {
      if (!serviceRuns(feed, trip.serviceId, serviceDate)) continue;
      for (let fromCursor = 0; fromCursor < eligibleIndexes.length - 1; fromCursor++) {
        const fromIndex = eligibleIndexes[fromCursor];
        const from = stops[fromIndex];
        if (from.pickupType !== 0) continue;
        const departureAt = serviceTimeToUtc(serviceDate, from.departureSeconds);
        if (!departureAt || departureAt < input.earliestDeparture || departureAt > journeyEnd) continue;
        for (let toCursor = fromCursor + 1; toCursor < eligibleIndexes.length && toCursor <= fromCursor + 20; toCursor++) {
          const toIndex = eligibleIndexes[toCursor];
          const to = stops[toIndex];
          if (to.dropOffType !== 0 || to.arrivalSeconds < from.departureSeconds) continue;
          const arrivalAt = serviceTimeToUtc(serviceDate, to.arrivalSeconds);
          if (!arrivalAt || arrivalAt < departureAt || arrivalAt > journeyEnd
            || arrivalAt.getTime() - departureAt.getTime() > 12 * 60 * 60_000) continue;
          const originStop = feed.stops.get(from.stopId), destinationStop = feed.stops.get(to.stopId);
          if (!originStop || !destinationStop) continue;
          const key = `${tripId}:${from.stopId}:${to.stopId}:${departureAt.toISOString()}`;
          if (seenSegments.has(key)) continue;
          seenSegments.add(key);
          segments.push({
            providerId: provider?.id ?? input.providerId, providerName: provider?.name ?? input.providerName, mode: route.mode,
            routeId: trip.routeId, routeName: route.name, headsign: trip.headsign, tripId,
            originStop: { id: originStop.id, name: from.sourceStopName ?? originStop.name,
              coordinates: from.sourceStopCoordinates ?? [originStop.lon, originStop.lat] },
            destinationStop: { id: destinationStop.id, name: to.sourceStopName ?? destinationStop.name,
              coordinates: to.sourceStopCoordinates ?? [destinationStop.lon, destinationStop.lat] },
            transportType,
            departureAt, arrivalAt, sourceFreshAt: provider?.fetchedAt ?? feed.fetchedAt,
            distanceToOriginStopMeters: Math.round(distanceMeters(input.origin, from.sourceStopCoordinates ?? [originStop.lon, originStop.lat])),
            distanceFromDestinationStopMeters: Math.round(distanceMeters(input.destination, to.sourceStopCoordinates ?? [destinationStop.lon, destinationStop.lat])),
          });
        }
      }
    }
  }
  const originStopIds = new Set(originStops.map(({ stop }) => stop.id));
  const destinationStopIds = new Set(destinationStops.map(({ stop }) => stop.id));
  const outgoing = new Map<string, GtfsDirectJourney[]>();
  for (const segment of segments) {
    const choices = outgoing.get(segment.originStop.id) ?? [];
    choices.push(segment);
    outgoing.set(segment.originStop.id, choices);
  }
  for (const choices of outgoing.values()) choices.sort((a, b) => a.departureAt.getTime() - b.departureAt.getTime() || a.arrivalAt.getTime() - b.arrivalAt.getTime());

  const walkingSeconds = (meters: number) => Math.ceil(meters / 1.25);
  const results = new Map<string, GtfsItinerary>();
  const maxTransitLegs = maximumTransfers + 1;
  // Most city-feed stops cannot lead to this destination. Exclude those dead
  // ends before enumerating timed transfer combinations.
  const reachableWithin = [destinationStopIds];
  for (let legCount = 1; legCount <= maxTransitLegs; legCount++) {
    const reachable = new Set(reachableWithin[legCount - 1]);
    for (const segment of segments) if (reachable.has(segment.destinationStop.id)) reachable.add(segment.originStop.id);
    reachableWithin.push(reachable);
  }
  const maxFirstDeparture = input.latestDeparture.getTime();
  const addPath = (path: GtfsDirectJourney[]) => {
    const first = path[0];
    const last = path.at(-1)!;
    const accessMeters = first.distanceToOriginStopMeters;
    const egressMeters = last.distanceFromDestinationStopMeters;
    const transferWalkingMeters = path.slice(1).map((segment, index) =>
      Math.round(distanceMeters(path[index].destinationStop.coordinates, segment.originStop.coordinates)));
    const departureAt = new Date(first.departureAt.getTime() - walkingSeconds(accessMeters) * 1000);
    const egressSeconds = walkingSeconds(egressMeters);
    const arrivalAt = new Date(last.arrivalAt.getTime() + egressSeconds * 1000);
    const durationSeconds = Math.ceil((arrivalAt.getTime() - departureAt.getTime()) / 1000);
    if (durationSeconds > maximumJourneySeconds) return;
    const id = path.map((segment) => `${segment.providerId}:${segment.tripId}:${segment.originStop.id}:${segment.destinationStop.id}`).join('|');
    if (!results.has(id)) results.set(id, {
      id, providerId: first.providerId,
      providerName: [...new Set(path.map((segment) => segment.providerName))].join(' + '),
      segments: path, departureAt, arrivalAt, durationSeconds,
      transfers: Math.max(0, path.length - 1), walkingMeters: accessMeters + egressMeters + transferWalkingMeters.reduce((sum, meters) => sum + meters, 0),
      transferWalkingMeters,
    });
  };

  const walk = (path: GtfsDirectJourney[]) => {
    const last = path.at(-1)!;
    if (destinationStopIds.has(last.destinationStop.id)) addPath(path);
    const remainingLegs = maxTransitLegs - path.length;
    if (remainingLegs <= 0 || !reachableWithin[remainingLegs].has(last.destinationStop.id)) return;
    const previousIds = new Set(path.map((segment) => segment.tripId));
    const visitedStops = new Set(path.map((segment) => segment.originStop.id));
    visitedStops.add(last.destinationStop.id);
    const choices = outgoing.get(last.destinationStop.id) ?? [];
    const earliestNext = last.arrivalAt.getTime() + minimumTransferBufferSeconds * 1000;
    const latestNext = Math.min(last.arrivalAt.getTime() + maximumWaitSeconds * 1000, journeyEnd.getTime());
    let low = 0, high = choices.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (choices[middle].departureAt.getTime() < earliestNext) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < choices.length; index++) {
      const next = choices[index];
      if (next.departureAt.getTime() > latestNext) break;
      if (!reachableWithin[remainingLegs - 1].has(next.destinationStop.id)) continue;
      if (previousIds.has(next.tripId) || visitedStops.has(next.destinationStop.id)) continue;
      const transferWalkSeconds = walkingSeconds(distanceMeters(last.destinationStop.coordinates, next.originStop.coordinates));
      const waitSeconds = (next.departureAt.getTime() - last.arrivalAt.getTime()) / 1000;
      if (waitSeconds < minimumTransferBufferSeconds + transferWalkSeconds) continue;
      walk([...path, next]);
    }
  };

  for (const segment of segments) {
      if (!originStopIds.has(segment.originStop.id) || segment.departureAt.getTime() > maxFirstDeparture) continue;
      if (segment.departureAt.getTime() < input.earliestDeparture.getTime() + walkingSeconds(segment.distanceToOriginStopMeters) * 1000) continue;
      walk([segment]);
  }

  return [...results.values()]
    .sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime() || a.transfers - b.transfers || a.id.localeCompare(b.id))
    .slice(0, limit);
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
