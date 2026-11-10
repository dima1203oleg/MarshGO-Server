import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichMicromobilityLegGeometry, type MicromobilityGeometryDeps, type RoutedPath } from '../server/journey/micromobilityGeometry';
import { trustedRouteGeometry } from '../server/journey/legGeometryProvenance';
import type { RentalRouteLeg } from '../server/journey/micromobilityEstimates';

const ORIGIN: [number, number] = [24.03, 49.84];
const PICKUP: [number, number] = [24.032, 49.841];
const DROPOFF: [number, number] = [24.05, 49.83];
const DEST: [number, number] = [24.052, 49.829];

const leg = (mode: RentalRouteLeg['mode'], from: [number, number], to: [number, number]): RentalRouteLeg => ({
  mode,
  origin: { name: 'from', coordinates: from },
  destination: { name: 'to', coordinates: to },
  distanceMeters: 800,
  durationSeconds: 200,
  providerId: mode === 'WALK' ? null : 'nextbike-lviv',
  providerName: mode === 'WALK' ? null : 'NextBike',
  routeGeometry: [from, to],
  metadata: { routeAccuracy: 'STRAIGHT_LINE_ESTIMATE', geometryMethod: 'great-circle-line' },
});

const deps = (overrides: Partial<MicromobilityGeometryDeps>): MicromobilityGeometryDeps => ({
  routeFoot: async () => null,
  routeBike: async () => null,
  ...overrides,
});

const realBikePath: RoutedPath = { geometry: [PICKUP, [24.041, 49.836], DROPOFF], distanceMeters: 1240, durationSeconds: 305 };

test('a configured cycling router upgrades the bike leg to trusted street geometry', async () => {
  const enriched = await enrichMicromobilityLegGeometry(
    leg('BICYCLE', PICKUP, DROPOFF),
    deps({ routeBike: async (): Promise<RoutedPath | null> => realBikePath }),
  );
  assert.equal(enriched.source, 'osrm-bike-route');
  assert.deepEqual(enriched.routeGeometry, realBikePath.geometry);
  assert.equal(enriched.distanceMeters, 1240);
  assert.equal(enriched.durationSeconds, 305);
  // Provenance now promotes it — the shape is real, not an estimate.
  assert.deepEqual(trustedRouteGeometry({ mode: 'BICYCLE', source: enriched.source, routeGeometry: enriched.routeGeometry }), realBikePath.geometry);
});

test('walk connectors use the foot router when it answers, staying trusted for WALK', async () => {
  const footPath: RoutedPath = { geometry: [ORIGIN, [24.031, 49.8405], PICKUP], distanceMeters: 95, durationSeconds: 76 };
  const enriched = await enrichMicromobilityLegGeometry(
    leg('WALK', ORIGIN, PICKUP),
    deps({ routeFoot: async (): Promise<RoutedPath | null> => footPath }),
  );
  assert.equal(enriched.source, 'osrm-foot-route');
  assert.deepEqual(trustedRouteGeometry({ mode: 'WALK', source: enriched.source, routeGeometry: enriched.routeGeometry }), footPath.geometry);
});

test('scooters have no street graph: never routed, never promoted to real', async () => {
  let bikeCalls = 0;
  let footCalls = 0;
  const scooter = leg('SCOOTER', PICKUP, DROPOFF);
  const enriched = await enrichMicromobilityLegGeometry(scooter, deps({
    routeBike: async (): Promise<RoutedPath | null> => { bikeCalls++; return realBikePath; },
    routeFoot: async (): Promise<RoutedPath | null> => { footCalls++; return { geometry: [PICKUP, DEST], distanceMeters: 1, durationSeconds: 1 }; },
  }));
  assert.equal(bikeCalls, 0);
  assert.equal(footCalls, 0);
  assert.equal(enriched.source, 'gbfs-geofence-scooter-estimate');
  assert.deepEqual(enriched.routeGeometry, [PICKUP, DROPOFF]);
  assert.equal(trustedRouteGeometry({ mode: 'SCOOTER', source: enriched.source, routeGeometry: enriched.routeGeometry }), null);
});

test('no router configured keeps the bike leg an honest estimate (negative control)', async () => {
  const enriched = await enrichMicromobilityLegGeometry(leg('BICYCLE', PICKUP, DROPOFF), deps({}));
  assert.equal(enriched.source, 'static-bike-network-estimate');
  assert.deepEqual(enriched.routeGeometry, [PICKUP, DROPOFF]);
  assert.equal(enriched.distanceMeters, 800);
  assert.equal(enriched.durationSeconds, 200);
  // The API must therefore keep it dashed: provenance refuses to promote the estimate.
  assert.equal(trustedRouteGeometry({ mode: 'BICYCLE', source: enriched.source, routeGeometry: enriched.routeGeometry }), null);
});

test('a router that returns nothing usable degrades to the estimate, never a fabricated line', async () => {
  const enriched = await enrichMicromobilityLegGeometry(leg('BICYCLE', PICKUP, DROPOFF), deps({
    routeBike: async (): Promise<RoutedPath | null> => ({ geometry: [], distanceMeters: 0, durationSeconds: 0 }),
  }));
  assert.equal(enriched.source, 'static-bike-network-estimate');
  assert.deepEqual(enriched.routeGeometry, [PICKUP, DROPOFF]);
});

test('a bike provenance token is not trusted for a walk leg (mode isolation)', () => {
  assert.equal(trustedRouteGeometry({ mode: 'WALK', source: 'osrm-bike-route', routeGeometry: [ORIGIN, PICKUP] }), null);
});

test('a routed zero distance falls back to the estimate distance, not a bogus number', async () => {
  const enriched = await enrichMicromobilityLegGeometry(leg('BICYCLE', PICKUP, DROPOFF), deps({
    routeBike: async (): Promise<RoutedPath | null> => ({ geometry: [PICKUP, [24.041, 49.836], DROPOFF], distanceMeters: 0, durationSeconds: Number.NaN }),
  }));
  assert.equal(enriched.source, 'osrm-bike-route');
  assert.equal(enriched.distanceMeters, 800);
  assert.equal(enriched.durationSeconds, 200);
});
