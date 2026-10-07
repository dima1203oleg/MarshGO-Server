import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assetTypeFor, discoverFeeds, normalizeStations, normalizeVehicles } from '../server/mobility/gbfs';
import { assertPublicHttpsUrl, isPrivateAddress, UnsafeUrlError } from '../server/mobility/safeFetch';

describe('GBFS normalisation', () => {
  it('finds feeds in 2.x (per language) and 3.x discovery documents', () => {
    const v2 = { data: { en: { feeds: [{ name: 'free_bike_status', url: 'https://x/fb.json' }] } } };
    const v3 = { data: { feeds: [{ name: 'vehicle_status', url: 'https://x/vs.json' }] } };
    assert.equal(discoverFeeds(v2).get('free_bike_status'), 'https://x/fb.json');
    assert.equal(discoverFeeds(v3).get('vehicle_status'), 'https://x/vs.json');
    assert.equal(discoverFeeds({}).size, 0);
  });

  it('maps form factor and propulsion to MARSHGO asset types', () => {
    assert.equal(assetTypeFor('bicycle', 'human'), 'BIKE');
    assert.equal(assetTypeFor('bicycle', 'electric_assist'), 'EBIKE');
    assert.equal(assetTypeFor('scooter_standing', 'electric'), 'SCOOTER');
    assert.equal(assetTypeFor('moped', 'electric'), 'MOPED');
    assert.equal(assetTypeFor('car', 'electric'), 'CARSHARING');
    assert.equal(assetTypeFor('other', 'electric'), null);
  });

  it('keeps only valid vehicles and counts rejected ones', () => {
    const types = { data: { vehicle_types: [{ vehicle_type_id: 's1', form_factor: 'scooter', propulsion_type: 'electric' }] } };
    const status = { data: { vehicles: [
      { vehicle_id: 'a', vehicle_type_id: 's1', lat: 49.84, lon: 24.03, is_reserved: false, current_range_meters: 12000 },
      { vehicle_id: 'b', vehicle_type_id: 's1', lat: 99, lon: 24.03 },
      { vehicle_id: 'c', vehicle_type_id: 'unknown', lat: 49.84, lon: 24.03 },
      { vehicle_id: 'd', vehicle_type_id: 's1', lat: 49.84, lon: 24.03, is_reserved: true },
    ] } };
    const { assets, rejected } = normalizeVehicles('p1', types, status);
    assert.equal(assets.length, 2);
    assert.equal(rejected, 2);
    assert.deepEqual(assets[0], { id: 'a', providerId: 'p1', type: 'SCOOTER', location: [24.03, 49.84], available: true, rangeMeters: 12000 });
    assert.equal(assets[1].available, false);
  });

  it('joins station information with live status', () => {
    const info = { data: { stations: [{ station_id: 's', name: 'Ринок', lat: 49.84, lon: 24.03, capacity: 10 }, { station_id: 'bad', lat: 200, lon: 0 }] } };
    const status = { data: { stations: [{ station_id: 's', num_bikes_available: 4, is_returning: true }] } };
    const { stations, rejected } = normalizeStations('p1', info, status);
    assert.equal(rejected, 1);
    assert.deepEqual(stations[0], { id: 's', providerId: 'p1', name: 'Ринок', location: [24.03, 49.84], capacity: 10, availableAssets: 4, returnAllowed: true });
  });
});

describe('feed URL safety', () => {
  it('flags private and loopback addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.1.1', '169.254.169.254', '::1', 'fd00::1']) assert.equal(isPrivateAddress(address), true, address);
    assert.equal(isPrivateAddress('8.8.8.8'), false);
  });
  it('rejects non-https, credentials and private hosts', async () => {
    await assert.rejects(assertPublicHttpsUrl('http://example.com/feed'), UnsafeUrlError);
    await assert.rejects(assertPublicHttpsUrl('https://user:pw@example.com/feed'), UnsafeUrlError);
    await assert.rejects(assertPublicHttpsUrl('https://127.0.0.1/feed'), UnsafeUrlError);
    await assert.rejects(assertPublicHttpsUrl('https://169.254.169.254/latest'), UnsafeUrlError);
    await assert.rejects(assertPublicHttpsUrl('not a url'), UnsafeUrlError);
  });
});

import { distanceMeters, selectNearby } from '../server/mobility/nearby';

describe('nearby assets', () => {
  const snapshot = (assets: Array<{ id: string; type: 'BIKE' | 'SCOOTER'; location: [number, number]; available?: boolean }>) => ({
    providerId: 'p', providerName: 'Test', snapshot: { fetchedAt: 0, stations: [], assets: assets.map((asset) => ({ providerId: 'p', available: true, ...asset })) },
  });
  it('computes great-circle distance', () => {
    const km = distanceMeters([24.0297, 49.8397], [30.5234, 50.4501]) / 1000;
    assert.ok(km > 460 && km < 480, String(km));
  });
  it('keeps available assets of the wanted type inside the radius, nearest first', () => {
    const near = [24.0300, 49.8400] as [number, number];
    const result = selectNearby([snapshot([
      { id: 'far', type: 'BIKE', location: [24.0400, 49.8400] },
      { id: 'near', type: 'BIKE', location: [24.0302, 49.8401] },
      { id: 'taken', type: 'BIKE', location: [24.0301, 49.8400], available: false },
      { id: 'scooter', type: 'SCOOTER', location: [24.0301, 49.8400] },
    ])], [24.0297, 49.8397], 500, ['BIKE']);
    assert.deepEqual(result.assets.map((asset) => asset.id), ['near']);
    assert.ok(result.assets[0].distanceM < 100);
    assert.equal(result.totalAssets, 1);
    assert.ok(near);
  });
});

import { strToU8 } from 'fflate';
import { parseCsvLine, routeTypeLabel, summarizeGtfs } from '../server/mobility/gtfs';

describe('GTFS parsing', () => {
  it('parses quoted CSV fields', () => {
    assert.deepEqual(parseCsvLine('1,"Площа Ринок, зупинка","a ""quoted"" word",x'), ['1', 'Площа Ринок, зупинка', 'a "quoted" word', 'x']);
  });
  it('maps route types to transport labels', () => {
    assert.equal(routeTypeLabel(0), 'tram'); assert.equal(routeTypeLabel(1), 'metro'); assert.equal(routeTypeLabel(2), 'train');
    assert.equal(routeTypeLabel(3), 'bus'); assert.equal(routeTypeLabel(11), 'trolleybus'); assert.equal(routeTypeLabel(715), 'bus');
  });
  it('summarises a feed and flags missing files and bad coordinates', () => {
    const files = {
      'agency.txt': strToU8('agency_id,agency_name\n1,Test\n'),
      'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\na,A,49.84,24.03\nb,B,0,0\nc,C,95,24\n'),
      'routes.txt': strToU8('route_id,route_type\nr1,3\nr2,0\n'),
      'trips.txt': strToU8('route_id,trip_id\nr1,t1\nr1,t2\n'),
      'stop_times.txt': strToU8('trip_id,stop_id\nt1,a\nt1,b\n'),
    };
    const summary = summarizeGtfs(files);
    assert.equal(summary.stops, 3); assert.equal(summary.badStops, 2);
    assert.deepEqual(summary.routeTypes, { bus: 1, tram: 1 });
    assert.equal(summary.trips, 2); assert.equal(summary.stopTimeRows, 2);
    assert.deepEqual(summary.missingFiles, ['calendar.txt|calendar_dates.txt']);
  });
});
