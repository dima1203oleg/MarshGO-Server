import assert from 'node:assert/strict';
import test from 'node:test';
import { matchJsonVehicleRoute, vehicleTransportLabel } from '../server/mobility/jsonVehicles';
import { parseJsonVehicles, selectFreshVehicles } from '../server/mobility/transportLayers';

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

for (const axis of ['latitude', 'lat', 'longitude', 'lon', 'lng'] as const) {
  test(`JSON feed adapter rejects malformed ${axis} instead of coercing it to a coordinate`, () => {
    const otherAxis = axis === 'latitude' || axis === 'lat' ? { lon: 24.12 } : { lat: 49.95 };
    for (const raw of ['', ' \t\n ', true, false, [], [0], [49.95], ['24.12'], {}, { value: 24.12 }]) {
      assert.deepEqual(parseJsonVehicles('fixture', [{ id: 'invalid', ...otherAxis, [axis]: raw }], new Map()), [],
        `${axis}=${JSON.stringify(raw)} must be rejected`);
    }
  });
}

test('JSON feed adapter retains numeric coordinates, aliases, global single zeros and range boundaries', () => {
  const vehicles = parseJsonVehicles('fixture', [
    { id: 'numbers', lat: 49.95, lon: 24.12 },
    { id: 'strings', latitude: ' 49.95 ', longitude: '24.12' },
    { id: 'lng-alias', lat: '-33.9', lng: ' 151.2 ' },
    { id: 'equator', lat: 0, lon: -78.5 },
    { id: 'meridian', latitude: 51.5, longitude: 0 },
    { id: 'equator-string', latitude: '0', longitude: '-78.5' },
    { id: 'meridian-string', lat: '-34.9', lng: '0' },
    { id: 'minimum', latitude: -90, longitude: -180 },
    { id: 'maximum', lat: '90', lon: '180' },
  ], new Map());
  assert.deepEqual(vehicles.map(({ id, lat, lon }) => [id, lat, lon]), [
    ['fixture:numbers', 49.95, 24.12],
    ['fixture:strings', 49.95, 24.12],
    ['fixture:lng-alias', -33.9, 151.2],
    ['fixture:equator', 0, -78.5],
    ['fixture:meridian', 51.5, 0],
    ['fixture:equator-string', 0, -78.5],
    ['fixture:meridian-string', -34.9, 0],
    ['fixture:minimum', -90, -180],
    ['fixture:maximum', 90, 180],
  ]);
});

test('JSON feed adapter preserves finite, coordinate range and zero-pair guards', () => {
  for (const axis of ['lat', 'lon'] as const) {
    const limit = axis === 'lat' ? 90 : 180;
    for (const raw of [NaN, Infinity, -Infinity, 'NaN', 'Infinity', '-Infinity', 'not-a-number', null, undefined,
      limit + 1, -limit - 1, String(limit + 0.01), String(-limit - 0.01)]) {
      assert.deepEqual(parseJsonVehicles('fixture', [{ lat: 49.95, lon: 24.12, [axis]: raw }], new Map()), [],
        `${axis}=${String(raw)} must be rejected`);
    }
  }
  for (const [lat, lon] of [[0, 0], ['0', '0'], [0, '0'], ['0', 0], [-0, -0]]) {
    assert.deepEqual(parseJsonVehicles('fixture', [{ lat, lon }], new Map()), []);
  }
});

test('parsed JSON positions keep only fresh in-viewport vehicles with the 90s and future 30s boundaries', (t) => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const parsed = parseJsonVehicles('fixture', [
    { id: 'fresh', lat: '49.95', lon: '24.12', timestamp: now - 5_000 },
    { id: 'age-boundary', lat: 49.95, lon: 24.12, timestamp: now - 90_000 },
    { id: 'future-boundary', lat: 49.95, lon: 24.12, timestamp: now + 30_000 },
    { id: 'equator', lat: 0, lon: 24.12, timestamp: now },
    { id: 'meridian', lat: 49.95, lon: 0, timestamp: now },
    { id: 'stale', lat: 49.95, lon: 24.12, timestamp: now - 90_001 },
    { id: 'future', lat: 49.95, lon: 24.12, timestamp: now + 30_001 },
    { id: 'unstamped', lat: 49.95, lon: 24.12 },
    { id: 'invalid-stamp', lat: 49.95, lon: 24.12, timestamp: 'invalid' },
    { id: 'outside', lat: 65, lon: 24.12, timestamp: now },
    { id: 'malformed', lat: [], lon: 24.12, timestamp: now },
  ], new Map());
  assert.equal(parsed.length, 10);
  const selected = selectFreshVehicles(parsed, [-1, -1, 60, 60], ['other']);
  assert.deepEqual(selected.vehicles.map(({ id }) => id), [
    'fixture:fresh', 'fixture:age-boundary', 'fixture:future-boundary', 'fixture:equator', 'fixture:meridian',
  ]);
  assert.equal(selected.stale, 4);
  assert.equal(selected.unclassified, 5);
});
