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
import { buildTransportCities } from '../server/mobility/cities';

it('derives transport cities from healthy provider coverage with mode counts and source attribution', () => {
  const cities = buildTransportCities([
    { name: 'Львівавтодор — розклад', city: 'Львів', source_type: 'gtfs', license: 'CC BY 4.0', source_ref: 'mdb:lviv', last_report: { bbox: [23.86, 49.77, 24.16, 49.98], counts: { stops: 1071, routes: 72, routes_bus: 64, routes_tram: 8 } } },
    { name: 'Львівавтодор — realtime', city: 'Львів', source_type: 'gtfs_rt', license: 'CC BY 4.0', source_ref: 'mdb:lviv-rt', last_report: { bbox: [23.86, 49.77, 24.16, 49.98] } },
    { name: 'Київпастранс — розклад', city: 'Київ', source_type: 'gtfs', license: 'CC BY 4.0', source_ref: 'data.gov.ua:kyiv', last_report: { bbox: [30.28, 50.22, 30.78, 50.57], counts: { stops: 1492, routes: 162, routes_bus: 102, routes_tram: 17, routes_trolleybus: 43 } } },
  ]);
  assert.deepEqual(cities.map(({ id }) => id), ['kyiv', 'lviv']);
  assert.deepEqual(cities[0].modes, ['bus', 'tram', 'trolleybus']);
  assert.equal(cities[0].stopCount, 1492);
  assert.equal(cities[1].realtimeAvailable, true);
  assert.equal(cities[1].providers.length, 2);
  assert.equal(cities[1].sourceUrl, 'https://opendata.city-adm.lviv.ua/en/dataset/lviv-public-transport-gtfs-real-time');
});

describe('GTFS parsing', () => {
  it('parses quoted CSV fields', () => {
    assert.deepEqual(parseCsvLine('1,"Площа Ринок, зупинка","a ""quoted"" word",x'), ['1', 'Площа Ринок, зупинка', 'a "quoted" word', 'x']);
  });
  it('maps route types to transport labels', () => {
    assert.equal(routeTypeLabel(0), 'tram'); assert.equal(routeTypeLabel(1), 'metro'); assert.equal(routeTypeLabel(2), 'train');
    assert.equal(routeTypeLabel(3), 'bus'); assert.equal(routeTypeLabel(11), 'trolleybus'); assert.equal(routeTypeLabel(715), 'bus');
    assert.equal(routeTypeLabel(102), 'train'); assert.equal(routeTypeLabel(106), 'suburban');
    assert.equal(routeTypeLabel(3, 'Маршрутка № 5'), 'marshrutka');
    assert.equal(routeTypeLabel(2, 'Київська міська електричка'), 'city_train');
    assert.equal(routeTypeLabel(0, 'Фунікулер'), 'funicular');
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
  it('only treats GTFS schedules with a trip in the next seven local days as usable', () => {
    const base = {
      'agency.txt': strToU8('agency_id,agency_name,agency_timezone\na,Test,Europe/Kyiv\n'),
      'routes.txt': strToU8('route_id,route_type\nr,3\n'),
      'trips.txt': strToU8('route_id,service_id,trip_id\nr,weekday,t1\n'),
      'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\ns,Stop,49.84,24.03\n'),
      'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,s,1\n'),
    };
    const now = new Date('2026-10-09T09:00:00.000Z');
    const upcoming = { ...base, 'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,1,1,1,1,0,0,20261005,20261012\n') };
    assert.equal(summarizeGtfs(upcoming, now).hasUpcomingService, true);
    const expired = { ...base, 'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,1,1,1,1,0,0,20261001,20261008\n') };
    assert.equal(summarizeGtfs(expired, now).hasUpcomingService, false);
    const dateAdded = { ...base, 'calendar_dates.txt': strToU8('service_id,date,exception_type\nweekday,20261012,1\n') };
    assert.equal(summarizeGtfs(dateAdded, now).hasUpcomingService, true);
  });
});

import { extractVehicleList, summarizeVehicles, vehicleTransportLabel } from '../server/mobility/jsonVehicles';

describe('JSON vehicle feeds', () => {
  it('finds the vehicle list in Dozor, EasyWay and iCity shapes', () => {
    assert.equal(extractVehicleList([{ latitude: 1, longitude: 2 }]).length, 1);
    assert.equal(extractVehicleList({ positions: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] }).length, 2);
    assert.equal(extractVehicleList({ nothing: true }).length, 0);
  });
  it('maps transport spellings', () => {
    assert.equal(vehicleTransportLabel({ route_type: 11 }), 'trolleybus');
    assert.equal(vehicleTransportLabel({ transport_type: 'marshrutka' }), 'marshrutka');
    assert.equal(vehicleTransportLabel({ type: 'bus' }), 'bus');
    assert.equal(vehicleTransportLabel({ type: 'tram' }), 'tram');
  });
  it('counts valid vehicles per type and rejects bad coordinates', () => {
    const list = [{ latitude: 49.8, longitude: 24, type: 'bus', timestamp: Math.floor(Date.now() / 1000) - 30 }, { lat: 49.9, lon: 24.1, type: 'tram' }, { lat: 0, lon: 0, type: 'bus' }, { lat: 'x', lon: 1 }];
    const summary = summarizeVehicles(list);
    assert.equal(summary.valid, 2); assert.equal(summary.invalid, 2);
    assert.deepEqual(summary.byType, { bus: 1, tram: 1 });
    assert.ok(summary.ageSeconds !== null && summary.ageSeconds < 120);
  });
});
