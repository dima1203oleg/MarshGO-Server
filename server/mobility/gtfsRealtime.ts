import bindings from 'gtfs-realtime-bindings';
import { fetchBinary } from './safeFetch';
import { bboxOf, type ConnectionReport } from './types';
import { isFreshMobilityTimestamp, parseMobilityTimestamp } from './timestamps';

const { transit_realtime } = bindings;
type FeedMessage = InstanceType<typeof bindings.transit_realtime.FeedMessage>;
const MAX_RT_BYTES = 10 * 1024 * 1024;

export function summarizeRealtime(message: FeedMessage, now = Date.now()) {
  let vehicles = 0, tripUpdates = 0, alerts = 0;
  for (const entity of message.entity) { if (entity.vehicle) vehicles++; if (entity.tripUpdate) tripUpdates++; if (entity.alert) alerts++; }
  const timestamp = Number(message.header.timestamp ?? 0);
  return { vehicles, tripUpdates, alerts, entities: message.entity.length,
    ageSeconds: timestamp > 0 ? Math.round(now / 1000 - timestamp) : null,
    updatedAt: timestamp > 0 ? new Date(timestamp * 1000) : null };
}

/** Count individually usable VehiclePositions; a fresh feed header does not make stale vehicle entities live. */
export function summarizeRealtimeVehiclePositions(message: FeedMessage, now = Date.now()) {
  let vehicleEntities = 0, positionedVehicles = 0, freshVehicles = 0, staleVehicles = 0, missingTimestamps = 0;
  for (const entity of message.entity) {
    const vehicle = entity.vehicle;
    if (!vehicle) continue;
    vehicleEntities++;
    const position = vehicle.position;
    if (!position || !Number.isFinite(position.latitude) || !Number.isFinite(position.longitude)
      || Math.abs(position.latitude) > 90 || Math.abs(position.longitude) > 180
      || (position.latitude === 0 && position.longitude === 0)) continue;
    positionedVehicles++;
    const timestamp = parseMobilityTimestamp(vehicle.timestamp);
    if (!timestamp) { missingTimestamps++; continue; }
    if (isFreshMobilityTimestamp(timestamp, now)) freshVehicles++;
    else staleVehicles++;
  }
  const missingPositions = vehicleEntities - positionedVehicles;
  return {
    vehicleEntities, positionedVehicles, freshVehicles, staleVehicles, missingTimestamps, missingPositions,
    usable: vehicleEntities === 0 || (positionedVehicles === vehicleEntities
      && freshVehicles === positionedVehicles && staleVehicles === 0 && missingTimestamps === 0),
  };
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
  const checkedAt = Date.now();
  const summary = summarizeRealtime(message, checkedAt);
  const vehiclePositions = summarizeRealtimeVehiclePositions(message, checkedAt);
  const points = message.entity.flatMap((entity): Array<[number, number]> => { const position = entity.vehicle?.position; return position && Number.isFinite(position.latitude) && Number.isFinite(position.longitude) && Math.abs(position.latitude) <= 90 && Math.abs(position.longitude) <= 180 ? [[position.longitude, position.latitude]] : []; });
  checks.push({ name: 'Entities', ok: summary.entities > 0, detail: `${summary.vehicles} vehicles, ${summary.tripUpdates} trip updates, ${summary.alerts} alerts` });
  checks.push({ name: 'Feed timestamp', ok: summary.updatedAt !== null, detail: summary.updatedAt ? 'present' : 'missing' });
  checks.push({ name: 'Freshness', ok: isFreshMobilityTimestamp(summary.updatedAt, checkedAt),
    detail: summary.ageSeconds === null ? 'no feed timestamp; live threshold is 90s' : `${summary.ageSeconds}s old; live threshold is 90s` });
  checks.push({ name: 'Individual vehicle positions', ok: vehiclePositions.usable,
    detail: vehiclePositions.vehicleEntities === 0 ? 'no vehicle entities; feed may contain trip updates or alerts only'
      : `${vehiclePositions.freshVehicles}/${vehiclePositions.vehicleEntities} vehicle entities have valid coordinates and fresh timestamps; ${vehiclePositions.staleVehicles} stale, ${vehiclePositions.missingTimestamps} without timestamp, ${vehiclePositions.missingPositions} without valid coordinates` });
  const counts: Record<string, number> = { vehicles: summary.vehicles, tripUpdates: summary.tripUpdates, alerts: summary.alerts,
    vehicleEntities: vehiclePositions.vehicleEntities, vehiclePositions: vehiclePositions.positionedVehicles,
    freshVehiclePositions: vehiclePositions.freshVehicles, staleVehiclePositions: vehiclePositions.staleVehicles,
    missingVehicleTimestamps: vehiclePositions.missingTimestamps, missingVehiclePositions: vehiclePositions.missingPositions,
    ...(summary.ageSeconds !== null ? { ageSeconds: summary.ageSeconds } : {}) };
  return { health: checks.every((check) => check.ok) ? 'healthy' : 'degraded', checks, counts, responseMs: Date.now() - started, ...(bboxOf(points) ? { bbox: bboxOf(points) } : {}) };
}
