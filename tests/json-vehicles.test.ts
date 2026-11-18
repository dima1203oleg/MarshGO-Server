import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractVehicleList, hasAcceptableFreshVehicleCoverage, hasFullyFreshVehiclePositions, summarizeVehicles } from '../server/mobility/jsonVehicles';
import { publicJsonVehicleId } from '../server/mobility/transportLayers';

test('vehicle list adapter decodes one JSON-encoded JSON layer used by Korosten', () => {
  const rows = [{ route_type: 3, route_id: 'route-private', latitude: 50.95, longitude: 28.65, time: '2026-11-13 06:40:00' }];
  // fetchJson parses the outer HTTP JSON document before this adapter receives
  // its string-valued payload, so the adapter gets one encoded array layer.
  assert.deepEqual(extractVehicleList(JSON.stringify(rows)), rows);
});

test('malformed or non-vehicle JSON strings fail closed', () => {
  assert.deepEqual(extractVehicleList('{broken'), []);
  assert.deepEqual(extractVehicleList(JSON.stringify({ status: 'ok' })), []);
});

test('JSON vehicle feed summaries count each fresh, stale and missing timestamp independently', () => {
  const now = Date.parse('2026-11-13T12:00:00.000Z');
  const summary = summarizeVehicles([
    { lat: 49.84, lon: 24.03, timestamp: new Date(now - 20_000).toISOString() },
    { lat: 49.85, lon: 24.04, timestamp: new Date(now - 91_000).toISOString() },
    { lat: 49.86, lon: 24.05 },
  ], now);

  assert.equal(summary.valid, 3);
  assert.equal(summary.timestamped, 2);
  assert.equal(summary.fresh, 1);
  assert.equal(summary.stale, 1);
  assert.equal(summary.missingTimestamps, 1);
});

test('a JSON vehicle feed is not fully fresh when even one accepted vehicle is stale', () => {
  assert.equal(hasFullyFreshVehiclePositions(80, 47), false);
  assert.equal(hasFullyFreshVehiclePositions(80, 80), true);
  assert.equal(hasFullyFreshVehiclePositions(0, 0), false);
});

test('a JSON live feed tolerates a stale tail only when at least 70% of its valid fleet is fresh', () => {
  assert.equal(hasAcceptableFreshVehicleCoverage(174, 145), true);
  assert.equal(hasAcceptableFreshVehicleCoverage(161, 125), true);
  assert.equal(hasAcceptableFreshVehicleCoverage(4, 3), true);
  assert.equal(hasAcceptableFreshVehicleCoverage(10, 7), true);
  assert.equal(hasAcceptableFreshVehicleCoverage(4, 2), false);
  assert.equal(hasAcceptableFreshVehicleCoverage(4, 0), false);
  assert.equal(hasAcceptableFreshVehicleCoverage(0, 0), false);
  assert.equal(hasAcceptableFreshVehicleCoverage(4, 5), false);
});

test('public JSON vehicle IDs stay stable without exposing registration or device identifiers', () => {
  const vehicle = { gov_number: 'TEST-PLATE-PRIVATE', imei: 'TEST-IMEI-PRIVATE' };
  const first = publicJsonVehicleId('korosten-provider', vehicle);
  assert.ok(first);
  assert.equal(first, publicJsonVehicleId('korosten-provider', vehicle));
  assert.ok(!first!.includes('TEST-PLATE-PRIVATE'));
  assert.ok(!first!.includes('TEST-IMEI-PRIVATE'));
  assert.notEqual(first, publicJsonVehicleId('another-provider', vehicle));
});
