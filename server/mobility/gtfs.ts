import { unzipSync, strFromU8 } from 'fflate';
import { fetchBinary } from './safeFetch';
import { bboxOf, type ConnectionReport } from './types';

/** GTFS route_type → MARSHGO transport label (basic and extended route types). */
export function routeTypeLabel(routeType: number, routeName = ''): string {
  const name = routeName.normalize('NFKC').toLocaleLowerCase('uk-UA');
  if (name.includes('фунікулер') || name.includes('funicular')) return 'funicular';
  if (name.includes('міська електричка') || name.includes('city train') || name.includes('city express') || name.includes('кільцева')) return 'city_train';
  if (name.includes('маршрутка') || name.includes('маршрутн') || name.includes('minibus')) return 'marshrutka';
  if (routeType === 0 || (routeType >= 900 && routeType < 1000)) return 'tram';
  if (routeType === 1 || (routeType >= 400 && routeType < 500)) return 'metro';
  if (routeType === 106 || routeType === 109) return 'suburban';
  if (routeType === 2 || (routeType >= 100 && routeType < 200)) return 'train';
  if (routeType === 3 || (routeType >= 700 && routeType < 800)) return 'bus';
  if (routeType === 11 || routeType === 800) return 'trolleybus';
  if (routeType === 4) return 'ferry';
  return 'other';
}

/** Minimal CSV line parser that honours quoted fields (GTFS files are RFC 4180 CSV). */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = []; let current = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) { if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; } else if (ch === '"') quoted = false; else current += ch; }
    else if (ch === '"') quoted = true; else if (ch === ',') { fields.push(current); current = ''; } else current += ch;
  }
  fields.push(current);
  return fields;
}

function table(text: string): Array<Record<string, string>> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((name) => name.trim());
  return lines.slice(1).map((line) => { const values = parseCsvLine(line); const row: Record<string, string> = {}; header.forEach((name, index) => { row[name] = values[index] ?? ''; }); return row; });
}

export interface GtfsSummary { stopPoints: Array<[number, number]>; agencies: number; stops: number; routes: number; trips: number; stopTimeRows: number; badStops: number; routeTypes: Record<string, number>; hasCalendar: boolean; hasUpcomingService: boolean; hasShapes: boolean; missingFiles: string[] }

function dateStringAfter(date: string, days: number): string {
  const value = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)) + days));
  return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}`;
}

function hasUpcomingService(files: Record<string, Uint8Array>, now: Date, days = 7): boolean {
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : '');
  const agencies = table(text('agency.txt'));
  const calendars = table(text('calendar.txt'));
  const exceptions = table(text('calendar_dates.txt'));
  const trips = table(text('trips.txt'));
  const timezone = agencies[0]?.agency_timezone?.trim() || 'UTC';
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch { return false; }
  const dateParts = formatter.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => dateParts.find((value) => value.type === type)?.value ?? '';
  const firstDate = `${part('year')}${part('month')}${part('day')}`;
  const serviceIds = new Set(trips.map((trip) => trip.service_id).filter(Boolean));
  const calendarByService = new Map(calendars.map((calendar) => [calendar.service_id, calendar]));
  const exceptionsByService = new Map<string, Map<string, string>>();
  for (const exception of exceptions) {
    if (!exception.service_id || !exception.date) continue;
    const byDate = exceptionsByService.get(exception.service_id) ?? new Map<string, string>();
    byDate.set(exception.date, exception.exception_type);
    exceptionsByService.set(exception.service_id, byDate);
  }

  for (let offset = 0; offset < days; offset++) {
    const date = dateStringAfter(firstDate, offset);
    const weekday = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)))).getUTCDay();
    const calendarWeekdayIndex = (weekday + 6) % 7;
    for (const serviceId of serviceIds) {
      const exception = exceptionsByService.get(serviceId)?.get(date);
      if (exception === '1') return true;
      if (exception === '2') continue;
      const calendar = calendarByService.get(serviceId);
      if (!calendar || date < calendar.start_date || date > calendar.end_date) continue;
      if (calendar[['monday','tuesday','wednesday','thursday','friday','saturday','sunday'][calendarWeekdayIndex]] === '1') return true;
    }
  }
  return false;
}

export function summarizeGtfs(files: Record<string, Uint8Array>, now = new Date()): GtfsSummary {
  const text = (name: string) => (files[name] ? strFromU8(files[name]) : '');
  const required = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'];
  const missingFiles = required.filter((name) => !files[name]);
  if (!files['calendar.txt'] && !files['calendar_dates.txt']) missingFiles.push('calendar.txt|calendar_dates.txt');
  const stops = table(text('stops.txt'));
  const badStops = stops.filter((stop) => { const lat = Number(stop.stop_lat), lon = Number(stop.stop_lon); return !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0); }).length;
  const stopPoints = stops.flatMap((stop): Array<[number, number]> => { const lat = Number(stop.stop_lat), lon = Number(stop.stop_lon); return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0) ? [[lon, lat]] : []; });
  const routes = table(text('routes.txt'));
  const routeTypes: Record<string, number> = {};
  for (const route of routes) { const label = routeTypeLabel(Number(route.route_type), `${route.route_short_name ?? ''} ${route.route_long_name ?? ''} ${route.route_desc ?? ''}`); routeTypes[label] = (routeTypes[label] ?? 0) + 1; }
  const stopTimeText = text('stop_times.txt');
  return {
    stopPoints, agencies: table(text('agency.txt')).length, stops: stops.length, routes: routes.length,
    trips: Math.max(0, text('trips.txt').split(/\r?\n/).filter(Boolean).length - 1),
    stopTimeRows: Math.max(0, stopTimeText.split('\n').filter((line) => line.length > 1).length - 1),
    badStops, routeTypes, hasCalendar: Boolean(files['calendar.txt'] || files['calendar_dates.txt']),
    hasUpcomingService: hasUpcomingService(files, now), hasShapes: Boolean(files['shapes.txt']), missingFiles,
  };
}

const MAX_GTFS_BYTES = 60 * 1024 * 1024;

export async function testGtfsConnection(url: string): Promise<ConnectionReport> {
  const checks: ConnectionReport['checks'] = [];
  const started = Date.now();
  let data: Uint8Array;
  try { data = (await fetchBinary(url, MAX_GTFS_BYTES)).data; checks.push({ name: 'Feed accessible', ok: true, detail: `${(data.byteLength / 1024).toFixed(0)} KB` }); }
  catch (error) { const detail = error instanceof Error ? error.message : 'unknown'; checks.push({ name: 'Feed accessible', ok: false, detail }); return { health: 'offline', checks, counts: {}, responseMs: Date.now() - started, error: detail }; }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, { filter: (file) => /(^|\/)(agency|stops|routes|trips|stop_times|calendar|calendar_dates|shapes)\.txt$/.test(file.name) && file.originalSize < 200 * 1024 * 1024 });
    // Feeds sometimes nest files in a folder; flatten to base names.
    files = Object.fromEntries(Object.entries(files).map(([name, content]) => [name.split('/').pop() as string, content]));
    checks.push({ name: 'Valid GTFS zip', ok: true });
  } catch { checks.push({ name: 'Valid GTFS zip', ok: false, detail: 'Not a zip archive' }); return { health: 'offline', checks, counts: {}, responseMs: Date.now() - started, error: 'Feed is not a valid GTFS zip' }; }
  const summary = summarizeGtfs(files);
  checks.push({ name: 'Required files', ok: summary.missingFiles.length === 0, detail: summary.missingFiles.length ? `missing: ${summary.missingFiles.join(', ')}` : 'all present' });
  const stopTolerance = Math.max(2, Math.floor(summary.stops * 0.02));
  checks.push({ name: 'Stops', ok: summary.stops > 0 && summary.badStops <= stopTolerance, detail: `${summary.stops} stops, ${summary.badStops} with invalid coordinates` });
  checks.push({ name: 'Routes and trips', ok: summary.routes > 0 && summary.trips > 0, detail: `${summary.routes} routes, ${summary.trips} trips` });
  checks.push({ name: 'Calendar', ok: summary.hasCalendar });
  checks.push({ name: 'Scheduled service in next 7 days', ok: summary.hasUpcomingService,
    detail: summary.hasUpcomingService ? 'at least one trip is scheduled' : 'no active trip service in the next 7 days' });
  const counts: Record<string, number> = { stops: summary.stops, routes: summary.routes, trips: summary.trips, stopTimes: summary.stopTimeRows, ...Object.fromEntries(Object.entries(summary.routeTypes).map(([type, count]) => [`routes_${type}`, count])) };
  const critical = summary.missingFiles.length === 0 && summary.stops > 0 && summary.routes > 0 && summary.trips > 0;
  const healthy = critical && summary.badStops <= stopTolerance && summary.hasCalendar && summary.hasUpcomingService;
  return { health: healthy ? 'healthy' : !summary.hasUpcomingService ? 'offline' : critical ? 'degraded' : 'offline', checks, counts, responseMs: Date.now() - started, ...(bboxOf(summary.stopPoints) ? { bbox: bboxOf(summary.stopPoints) } : {}), ...(critical && summary.hasUpcomingService ? {} : { error: !summary.hasUpcomingService ? 'GTFS feed has no service scheduled in the next 7 days' : 'GTFS feed is incomplete' }) };
}
