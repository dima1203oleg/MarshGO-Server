import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { normalizeStations, normalizeVehicles, testGbfsConnection } from '../server/mobility/gbfs';

const BASE = 'https://gbfs-country-fixture.invalid';
const now = Math.floor(Date.now() / 1000);
const vehicleTypes = { data: { vehicle_types: [{ vehicle_type_id: 'scooter', form_factor: 'scooter_standing', propulsion_type: 'electric' }] } };
const kyivVehicle = { vehicle_id: 'kyiv-1', vehicle_type_id: 'scooter', lon: 30.52, lat: 50.45 };
const limaVehicle = { vehicle_id: 'lima-1', vehicle_type_id: 'scooter', lon: -77.04, lat: -12.04 };
const malformedVehicle = { vehicle_id: 'bad-coords', vehicle_type_id: 'scooter', lon: 200, lat: 50.45 };

let statusPayload: unknown = { last_updated: now, data: { vehicles: [kyivVehicle] } };

const documents: Record<string, () => unknown> = {
  '/gbfs': () => ({ data: { feeds: [
    { name: 'vehicle_types', url: `${BASE}/vehicle_types` },
    { name: 'vehicle_status', url: `${BASE}/vehicle_status` },
  ] } }),
  '/vehicle_types': () => vehicleTypes,
  '/vehicle_status': () => statusPayload,
};

describe('GBFS health verdict distinguishes coverage exclusions from malformed data', () => {
  before(() => {
    mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
    mock.method(globalThis, 'fetch', async (input: unknown) => {
      const url = new URL(String(input));
      const doc = documents[url.pathname]?.();
      if (!doc) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  after(() => mock.restoreAll());

  it('a UA feed whose only rejections are out-of-country vehicles is healthy', async () => {
    statusPayload = { last_updated: now, data: { vehicles: [kyivVehicle, limaVehicle] } };
    const report = await testGbfsConnection('zelectra', `${BASE}/gbfs`, 'UA');
    assert.equal(report.health, 'healthy', 'intentional country filtering must not degrade a fully valid live feed');
    assert.ok(report.checks.every((check) => check.ok));
    assert.equal(report.counts.vehicles, 1);
    assert.equal(report.counts.outOfCountryVehicles, 1);
    assert.equal(report.counts.pointsInDeclaredCountry, 1);
  });

  it('malformed records still degrade health even when coverage and freshness pass', async () => {
    statusPayload = { last_updated: now, data: { vehicles: [kyivVehicle, malformedVehicle] } };
    const report = await testGbfsConnection('zelectra', `${BASE}/gbfs`, 'UA');
    assert.equal(report.health, 'degraded');
    assert.equal(report.counts.vehicles, 1);
    assert.equal(report.counts.outOfCountryVehicles, undefined);
  });

  it('a clean UA feed without any rejection stays healthy', async () => {
    statusPayload = { last_updated: now, data: { vehicles: [kyivVehicle] } };
    const report = await testGbfsConnection('zelectra', `${BASE}/gbfs`, 'UA');
    assert.equal(report.health, 'healthy');
    assert.equal(report.counts.outOfCountryVehicles, undefined);
  });
});

describe('normalize counters keep rejected inclusive of country exclusions', () => {
  it('normalizeVehicles reports outOfCountry separately while rejected stays inclusive', () => {
    const status = { last_updated: now, data: { vehicles: [kyivVehicle, limaVehicle, malformedVehicle] } };
    const result = normalizeVehicles('zelectra', vehicleTypes, status, 'UA');
    assert.deepEqual(result.assets.map((asset) => asset.id), ['kyiv-1']);
    assert.equal(result.rejected, 2, 'existing consumers still see every excluded record in rejected');
    assert.equal(result.outOfCountry, 1, 'only the structurally valid Lima record is a coverage exclusion');
  });

  it('normalizeStations reports outOfCountry separately while rejected stays inclusive', () => {
    const info = { data: { stations: [
      { station_id: 'kyiv-station', name: 'Київ', lon: 30.52, lat: 50.45 },
      { station_id: 'lima-station', name: 'Lima', lon: -77.04, lat: -12.04 },
    ] } };
    const result = normalizeStations('zelectra', info, { last_updated: now, data: { stations: [] } }, 'UA');
    assert.deepEqual(result.stations.map((station) => station.id), ['kyiv-station']);
    assert.equal(result.rejected, 1);
    assert.equal(result.outOfCountry, 1);
  });

  it('without a declared country nothing is counted as a coverage exclusion', () => {
    const status = { last_updated: now, data: { vehicles: [kyivVehicle, limaVehicle] } };
    const result = normalizeVehicles('international-provider', vehicleTypes, status);
    assert.equal(result.assets.length, 2);
    assert.equal(result.rejected, 0);
    assert.equal(result.outOfCountry, 0);
  });
});