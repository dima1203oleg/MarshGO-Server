import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteTypeEntries, isRequestedVehicleType, mergeRouteTypeEntries, selectFreshVehicles, type LiveVehicle } from '../server/mobility/transportLayers';
import type { Bbox } from '../server/mobility/types';

const box: Bbox = [23.85, 49.75, 24.16, 49.98];
const now = Date.now();

const vehicle = (id: string, type: LiveVehicle['type'], lon = 24.0, lat = 49.84, ageSeconds = 5): LiveVehicle => ({
  id, lon, lat, type, route: id, bearing: null, speed: null, providerId: 'p1',
  timestamp: new Date(now - ageSeconds * 1000),
});

describe('live vehicle type filter', () => {
  it('accepts the explicit unclassified bucket and rejects unknown categories', () => {
    assert.ok(isRequestedVehicleType('other'));
    assert.ok(isRequestedVehicleType('tram'));
    assert.equal(isRequestedVehicleType('scooter'), false);
  });

  it('returns only the requested categories instead of every unclassified vehicle', () => {
    const received = [vehicle('t1', 'tram'), vehicle('b1', 'bus'), vehicle('x1', 'other'), vehicle('x2', 'other')];
    const tramOnly = selectFreshVehicles(received, box, ['tram']);
    assert.deepEqual(tramOnly.vehicles.map((row) => row.id), ['t1']);
    assert.equal(tramOnly.unclassified, 2);

    const trolleybusOnly = selectFreshVehicles(received, box, ['trolleybus']);
    assert.equal(trolleybusOnly.vehicles.length, 0);

    const explicitOther = selectFreshVehicles(received, box, ['other']);
    assert.deepEqual(explicitOther.vehicles.map((row) => row.id), ['x1', 'x2']);
  });

  it('drops stale positions and positions outside the viewport but still counts them', () => {
    const received = [vehicle('fresh', 'bus'), vehicle('stale', 'bus', 24.0, 49.84, 600), vehicle('elsewhere', 'bus', 30.5, 50.45)];
    const result = selectFreshVehicles(received, box, ['bus']);
    assert.deepEqual(result.vehicles.map((row) => row.id), ['fresh']);
    assert.equal(result.stale, 1);
  });

  it('rejects a position dated further in the future than the allowed clock skew', () => {
    const result = selectFreshVehicles([vehicle('fast-clock', 'bus', 24.0, 49.84, -300)], box, ['bus']);
    assert.equal(result.vehicles.length, 0);
    assert.equal(result.stale, 1);
  });
});

describe('route type index', () => {
  const routesTxt = [
    'route_id,route_short_name,route_long_name,route_type',
    'R_BUS,18,Автобус до аеропорту,3',
    'R_TROLLEY,Тр22, Тролейбус,11',
    'R_FERRY,Ф1,Пором,4',
    'NOROUTE,,Без ідентифікатора,3',
  ].join('\n');

  it('keeps only classifiable routes with an ID, using the city naming rules', () => {
    assert.deepEqual(buildRouteTypeEntries(routesTxt), [
      ['NOROUTE', 'Без ідентифікатора', 'bus'],
      ['R_BUS', '18', 'bus'],
      ['R_TROLLEY', 'Тр22', 'trolleybus'],
    ]);
    assert.deepEqual(buildRouteTypeEntries(undefined), []);
  });

  it('lets the last loaded feed win so a municipal feed overrides a national mirror', () => {
    const national = buildRouteTypeEntries('route_id,route_short_name,route_long_name,route_type\nR_BUS,18,УЗ автобус,3\n');
    const municipal = buildRouteTypeEntries('route_id,route_short_name,route_long_name,route_type\nR_BUS,T22,Міський тролейбус,11\n');
    const merged = mergeRouteTypeEntries([national, municipal]);
    assert.deepEqual(merged.get('R_BUS'), { name: 'T22', type: 'trolleybus' });
    assert.equal(merged.get('R_TROLLEY'), undefined);
  });
});
