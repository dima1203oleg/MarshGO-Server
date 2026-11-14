import assert from 'node:assert/strict';
import test from 'node:test';
import { matchJsonVehicleRoute, vehicleTransportLabel } from '../server/mobility/jsonVehicles';
import { parseJsonVehicles } from '../server/mobility/transportLayers';

test('a unique JSON vehicle label resolves to the loaded static route and its class', () => {
  const routes = new Map([['gtfs-29', { name: '29', type: 'marshrutka' }]]);
  assert.deepEqual(matchJsonVehicleRoute({ route_id: 'gtfs-29', route_short_name: '29', route_type: 3 }, routes), {
    routeId: 'gtfs-29', route: '29', type: 'marshrutka',
  });
});

test('unique route short name safely maps a JSON namespace to its static route ID', () => {
  const routes = new Map([['gtfs-61', { name: '61', type: 'bus' }]]);
  assert.deepEqual(matchJsonVehicleRoute({ route_id: 'dozor-61', route_short_name: '61', route_type: 3 }, routes), {
    routeId: 'gtfs-61', route: '61', type: 'bus',
  });
});

test('ambiguous or unmatched route labels never acquire a guessed static route ID', () => {
  const routes = new Map([
    ['gtfs-1', { name: '1', type: 'bus' }],
    ['gtfs-1-alt', { name: '1', type: 'tram' }],
  ]);
  assert.deepEqual(matchJsonVehicleRoute({ route_id: 'unknown-1', route_short_name: '1', route_type: 3 }, routes), {
    route: '1', type: 'bus',
  });
  assert.deepEqual(matchJsonVehicleRoute({ route_id: 'unknown-2', route_short_name: '2', route_type: 3 }, routes), {
    route: '2', type: 'bus',
  });
  assert.deepEqual(matchJsonVehicleRoute({ route_id: 'gtfs-1', route_type: 3 }, routes), {
    route: '', type: 'bus',
  });
});

test('explicit provider vehicle class takes priority over generic route_type', () => {
  assert.equal(vehicleTransportLabel({ route_type: 3, transport_type: 'marshrutka' }), 'marshrutka');
  assert.equal(vehicleTransportLabel({ route_type: 3, transport_type: 'trolleybus' }), 'trolleybus');
});

test('an explicit mode conflict preserves the feed class without attaching another mode route ID', () => {
  const routes = new Map([['gtfs-12', { name: '12', type: 'bus' }]]);
  assert.deepEqual(matchJsonVehicleRoute({ route_short_name: '12', transport_type: 'trolleybus', route_type: 3 }, routes), {
    route: '12', type: 'trolleybus',
  });
});

test('JSON feed adapter emits the confirmed static route ID and route class for map matching', () => {
  const vehicles = parseJsonVehicles('sheptytskyi-easyway', { vehicles: [
    { vehicle_id: 'opaque-1', route_id: 'source-61', route_short_name: '61', route_type: 3, lat: 49.95, lon: 24.12, timestamp: '2026-11-14T05:00:00Z' },
  ] }, new Map([['gtfs-61', { name: '61', type: 'marshrutka' as const }]]));
  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].providerId, 'sheptytskyi-easyway');
  assert.equal(vehicles[0].routeId, 'gtfs-61');
  assert.equal(vehicles[0].route, '61');
  assert.equal(vehicles[0].type, 'marshrutka');
});

test('JSON feed adapter leaves ambiguous identities unmatched and drops invalid positions', () => {
  const vehicles = parseJsonVehicles('provider', [
    { id: 'ambiguous', route_short_name: '1', route_type: 3, lat: 49.95, lon: 24.12 },
    { id: 'invalid', route_short_name: '2', route_type: 3, lat: 91, lon: 24.12 },
  ], new Map([
    ['route-a', { name: '1', type: 'bus' as const }],
    ['route-b', { name: '1', type: 'tram' as const }],
  ]));
  assert.equal(vehicles.length, 1);
  assert.equal(vehicles[0].routeId, undefined);
  assert.equal(vehicles[0].route, '1');
  assert.equal(vehicles[0].type, 'bus');
});
