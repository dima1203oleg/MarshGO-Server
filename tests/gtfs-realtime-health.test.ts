import assert from 'node:assert/strict';
import test from 'node:test';
import type bindings from 'gtfs-realtime-bindings';
import { summarizeRealtimeVehiclePositions } from '../server/mobility/gtfsRealtime';

const asFeedMessage = (entity: unknown[]) => ({ entity }) as unknown as InstanceType<typeof bindings.transit_realtime.FeedMessage>;

test('GTFS-RT health distinguishes fresh, stale, missing-time and invalid vehicle positions', () => {
  const now = Date.parse('2026-10-23T00:00:00.000Z');
  const seconds = Math.floor(now / 1000);
  const result = summarizeRealtimeVehiclePositions(asFeedMessage([
    { vehicle: { position: { latitude: 49.84, longitude: 24.03 }, timestamp: seconds - 20 } },
    { vehicle: { position: { latitude: 49.85, longitude: 24.04 }, timestamp: seconds - 91 } },
    { vehicle: { position: { latitude: 49.86, longitude: 24.05 } } },
    { vehicle: { position: { latitude: 100, longitude: 24.06 }, timestamp: seconds - 5 } },
  ]), now);

  assert.deepEqual(result, {
    vehicleEntities: 4,
    positionedVehicles: 3,
    freshVehicles: 1,
    staleVehicles: 1,
    missingTimestamps: 1,
    missingPositions: 1,
    usable: false,
  });
});

test('GTFS-RT trip-update-only feeds are not degraded by having no vehicle positions', () => {
  const result = summarizeRealtimeVehiclePositions(asFeedMessage([{ tripUpdate: {} }]), Date.now());
  assert.equal(result.vehicleEntities, 0);
  assert.equal(result.usable, true);
});

test('GTFS-RT vehicle feeds are usable only when every vehicle entity is fresh and positioned', () => {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const result = summarizeRealtimeVehiclePositions(asFeedMessage([
    { vehicle: { position: { latitude: 49.84, longitude: 24.03 }, timestamp: seconds } },
    { vehicle: { position: { latitude: 49.85, longitude: 24.04 }, timestamp: seconds - 45 } },
  ]), now);
  assert.equal(result.positionedVehicles, 2);
  assert.equal(result.freshVehicles, 2);
  assert.equal(result.usable, true);
});
