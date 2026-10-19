import bindings from 'gtfs-realtime-bindings';
import { fetchBinary } from './safeFetch';
import { bboxOf, type ConnectionReport } from './types';

const { transit_realtime } = bindings;
type FeedMessage = InstanceType<typeof bindings.transit_realtime.FeedMessage>;
const MAX_RT_BYTES = 10 * 1024 * 1024;

export function summarizeRealtime(message: FeedMessage) {
  let vehicles = 0, tripUpdates = 0, alerts = 0;
  for (const entity of message.entity) { if (entity.vehicle) vehicles++; if (entity.tripUpdate) tripUpdates++; if (entity.alert) alerts++; }
  const timestamp = Number(message.header.timestamp ?? 0);
  return { vehicles, tripUpdates, alerts, entities: message.entity.length, ageSeconds: timestamp > 0 ? Math.round(Date.now() / 1000 - timestamp) : null };
}

export async function testGtfsRealtimeConnection(url: string): Promise<ConnectionReport> {
  const checks: ConnectionReport['checks'] = [];
  const started = Date.now();
  let data: Uint8Array;
  try { data = (await fetchBinary(url, MAX_RT_BYTES)).data; checks.push({ name: 'Feed accessible', ok: true }); }
  catch (error) { const detail = error instanceof Error ? error.message : 'unknown'; checks.push({ name: 'Feed accessible', ok: false, detail }); return { health: 'offline', checks, counts: {}, responseMs: Date.now() - started, error: detail }; }
  let message: FeedMessage;
  try { message = transit_realtime.FeedMessage.decode(data); checks.push({ name: 'Valid GTFS-Realtime protobuf', ok: true }); }
  catch { checks.push({ name: 'Valid GTFS-Realtime protobuf', ok: false }); return { health: 'offline', checks, counts: {}, responseMs: Date.now() - started, error: 'Not a GTFS-Realtime feed' }; }
  const summary = summarizeRealtime(message);
  const points = message.entity.flatMap((entity): Array<[number, number]> => { const position = entity.vehicle?.position; return position && Number.isFinite(position.latitude) && Number.isFinite(position.longitude) && Math.abs(position.latitude) <= 90 && Math.abs(position.longitude) <= 180 ? [[position.longitude, position.latitude]] : []; });
  checks.push({ name: 'Entities', ok: summary.entities > 0, detail: `${summary.vehicles} vehicles, ${summary.tripUpdates} trip updates, ${summary.alerts} alerts` });
  if (summary.ageSeconds !== null) checks.push({ name: 'Freshness', ok: summary.ageSeconds < 300, detail: `${summary.ageSeconds}s old` });
  const counts: Record<string, number> = { vehicles: summary.vehicles, tripUpdates: summary.tripUpdates, alerts: summary.alerts, ...(summary.ageSeconds !== null ? { ageSeconds: summary.ageSeconds } : {}) };
  return { health: checks.every((check) => check.ok) ? 'healthy' : 'degraded', checks, counts, responseMs: Date.now() - started, ...(bboxOf(points) ? { bbox: bboxOf(points) } : {}) };
}
