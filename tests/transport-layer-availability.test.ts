import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTransportLayerAvailability } from '../server/mobility/transportLayerAvailability';

test('map layer availability separates buses and trains and fails closed for unsupported categories', () => {
  const data = buildTransportLayerAvailability({
    lines: new Set(['bus', 'train']),
    micro: new Set(['scooter']),
    stationsAvailable: false,
    staticBikeLocationsAvailable: false,
  });
  const byId = Object.fromEntries(data.map((item) => [item.id, item.available]));
  assert.equal(byId.BUS, true);
  assert.equal(byId.MINIBUS, false);
  assert.equal(byId.TRAIN, true);
  assert.equal(byId.SCOOTER, true);
  assert.equal(byId.BICYCLE, false);
  assert.equal(byId.CARPOOL, false);
  assert.equal(byId.TAXI, false);
  assert.equal(byId.TRANSFER, false);
  assert.equal(byId.RENTAL_POINTS, false);
});

test('static bike rental locations enable map discovery without claiming live rental points', () => {
  const data = buildTransportLayerAvailability({
    lines: new Set(),
    micro: new Set(),
    stationsAvailable: false,
    staticBikeLocationsAvailable: true,
  });
  const byId = Object.fromEntries(data.map((item) => [item.id, item.available]));
  assert.equal(byId.BICYCLE, true);
  assert.equal(byId.RENTAL_POINTS, false);
  assert.equal(byId.SCOOTER, false);
});
