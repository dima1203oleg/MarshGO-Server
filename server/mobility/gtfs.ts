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

export interface GtfsSummary { stopPoints: Array<[number, number]>; agencies: number; stops: number; routes: number; trips: number; stopTimeRows: number; badStops: number; routeTypes: Record<string, number>; hasCalendar: boolean; hasShapes: boolean; missingFiles: string[] }

export function summarizeGtfs(files: Record<string, Uint8Array>): GtfsSummary {
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
    badStops, routeTypes, hasCalendar: Boolean(files['calendar.txt'] || files['calendar_dates.txt']), hasShapes: Boolean(files['shapes.txt']), missingFiles,
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
  const counts: Record<string, number> = { stops: summary.stops, routes: summary.routes, trips: summary.trips, stopTimes: summary.stopTimeRows, ...Object.fromEntries(Object.entries(summary.routeTypes).map(([type, count]) => [`routes_${type}`, count])) };
  const critical = summary.missingFiles.length === 0 && summary.stops > 0 && summary.routes > 0 && summary.trips > 0;
  return { health: critical && summary.badStops <= stopTolerance && summary.hasCalendar ? 'healthy' : critical ? 'degraded' : 'offline', checks, counts, responseMs: Date.now() - started, ...(bboxOf(summary.stopPoints) ? { bbox: bboxOf(summary.stopPoints) } : {}), ...(critical ? {} : { error: 'GTFS feed is incomplete' }) };
}
