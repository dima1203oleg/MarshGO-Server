import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasAcceptableCountryCoverage, summarizeVehicles } from '../server/mobility/jsonVehicles';
import { filterVehiclesToCountry, type LiveVehicle } from '../server/mobility/transportLayers';

const vehicle = (id: string, lon: number, lat: number): LiveVehicle => ({
  id, lon, lat, type: 'bus', route: '1', bearing: null, speed: null, timestamp: new Date(), providerId: 'provider',
});

test('Ukraine JSON feed summaries exclude valid but foreign positions from coverage and bbox', () => {
  const now = Date.now();
  const summary = summarizeVehicles([
    { id: 'ua', longitude: 26.25, latitude: 50.60, timestamp: now },
    { id: 'foreign', longitude: -77.061931, latitude: -12.039603, timestamp: now },
  ], now, 'UA');

  assert.equal(summary.valid, 1);
  assert.equal(summary.outsideCountry, 1);
  assert.deepEqual(summary.points, [[26.25, 50.60]]);
  assert.equal(hasAcceptableCountryCoverage(157, 2), true);
  assert.equal(hasAcceptableCountryCoverage(51, 5), false);
});

test('live positions from a UA-only provider cannot leak to foreign map viewports', () => {
  const mixed = [vehicle('ua', 26.25, 50.60), vehicle('foreign', -77.061931, -12.039603)];
  assert.deepEqual(filterVehiclesToCountry(mixed, 'UA').map(({ id }) => id), ['ua']);
  assert.equal(filterVehiclesToCountry(mixed, undefined).length, 2);
});
