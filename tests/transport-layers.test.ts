import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeoJsonNetwork, buildNetwork, decimate, geoJsonMode, inBbox, intersects, isFreshVehicleTimestamp, networkRoutesForRoute, parseBbox, parseVehicleTimestamp, routeInBbox } from '../server/mobility/transportLayers';
import { isFreshMobilityTimestamp, parseMobilityTimestamp } from '../server/mobility/timestamps';

const files = {
  'routes.txt': 'route_id,route_short_name,route_type\nR1,47,3\nR2,2,0\nR3,M1,1\nR4,X,1700\n',
  'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,Франка,49.84,24.03\nB,Ринок,49.841,24.032\nC,Сихів,49.80,24.07\nD,Bad,0,0\nE,Orphan,49.5,24.5\n',
  'trips.txt': 'route_id,trip_id,direction_id,shape_id\nR1,T1,0,\nR1,T2,0,\nR2,T3,0,S1\nR3,T4,0,\n',
  'stop_times.txt': 'trip_id,stop_id,stop_sequence\nT1,A,1\nT1,B,2\nT2,A,1\nT2,B,2\nT2,C,3\nT3,A,1\nT3,C,2\nT4,B,1\nT4,C,2\n',
  'shapes.txt': 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nS1,49.84,24.03,1\nS1,49.82,24.05,2\nS1,49.80,24.07,3\n',
};

describe('transport layer network', () => {
  const network = buildNetwork(files);
  it('draws a stop-sequence line from the longest trip when a route has no shape', () => {
    const bus = network.routes.find((route) => route.name === '47')!;
    assert.equal(bus.type, 'bus');
    assert.deepEqual(bus.coordinates, [[24.03, 49.84], [24.032, 49.841], [24.07, 49.80]]);
    assert.equal(bus.direction, 'Франка → Сихів');
    assert.equal(bus.stopCount, 3);
  });
  it('uses shapes.txt geometry when present and types tram and metro routes', () => {
    const tram = network.routes.find((route) => route.name === '2')!;
    assert.equal(tram.type, 'tram'); assert.equal(tram.coordinates.length, 3);
    assert.equal(network.routes.find((route) => route.name === 'M1')?.type, 'metro');
  });
  it('selects all actual directions for one exact GTFS route without prefix collisions', () => {
    const route = (id: string, geometrySource: 'gtfs_shape' | 'stop_sequence') => ({ id, name: '47', type: 'bus' as const, direction: id, geometrySource, stopCount: 2, coordinates: [[24, 49], [24.1, 49.1]] as [number, number][] });
    const candidateNetwork = { routes: [route('R1|0', 'gtfs_shape'), route('R1|1', 'gtfs_shape'), route('R1|2', 'stop_sequence'), route('R10|0', 'gtfs_shape')], stops: [], bbox: null };
    assert.deepEqual(networkRoutesForRoute(candidateNetwork, 'R1', 'gtfs_shape').map((item) => item.id), ['R1|0', 'R1|1']);
    assert.deepEqual(networkRoutesForRoute(candidateNetwork, 'R1').map((item) => item.id), ['R1|0', 'R1|1', 'R1|2']);
  });
  it('classifies GTFS routes named as marshrutkas consistently with journey search', () => {
    const network = buildNetwork({
      'routes.txt': 'route_id,route_short_name,route_long_name,route_type\nR1,5,Маршрутка № 5,3\n',
      'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,Львів,49.84,24.03\nB,Стрий,49.25,23.85\n',
      'trips.txt': 'route_id,trip_id,direction_id,shape_id\nR1,T1,0,\n',
      'stop_times.txt': 'trip_id,stop_id,stop_sequence\nT1,A,1\nT1,B,2\n',
    });
    assert.equal(network.routes[0]?.type, 'marshrutka');
  });
  it('keeps only valid stops that a known route serves, with the transport types serving them', () => {
    assert.deepEqual(network.stops.map((stop) => stop.id).sort(), ['A', 'B', 'C']);
    assert.deepEqual([...network.stops.find((stop) => stop.id === 'A')!.types].sort(), ['bus', 'tram']);
    assert.deepEqual(network.stops.find((stop) => stop.id === 'A')!.routes, ['2', '47']);
    assert.ok(network.bbox && network.bbox[0] === 24.03);
  });
  it('validates viewport boxes and limits their size', () => {
    assert.deepEqual(parseBbox('24,49,25,50'), [24, 49, 25, 50]);
    assert.equal(parseBbox('24,49,30,50'), null);
    assert.equal(parseBbox('25,49,24,50'), null);
    assert.equal(parseBbox('a,b,c,d'), null);
    assert.equal(parseBbox(undefined), null);
  });
  it('geometry helpers behave', () => {
    assert.equal(decimate([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4).length, 4);
    assert.equal(inBbox([24, 49, 25, 50], 24.5, 49.5), true);
    assert.equal(intersects([24, 49, 25, 50], [26, 49, 27, 50]), false);
    assert.equal(routeInBbox(network.routes[0], [24, 49, 24.04, 49.85]), true);
  });
});

describe('official GeoJSON network normalization', () => {
  it('keeps city train and funicular as distinct modes and joins ordered route segments', () => {
    const body = { type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[30.1, 50.1], [30.2, 50.2]] }, properties: { num_route: 'E1', napryamok: 'clockwise', order_: 2, from_stop_: 'B', to_stop_: 'C' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[30, 50], [30.1, 50.1]] }, properties: { num_route: 'E1', napryamok: 'clockwise', order_: 1, from_stop_: 'A', to_stop_: 'B' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [30, 50] }, properties: { code1: 'a', name: 'Станція A' } },
    ] };
    const network = buildGeoJsonNetwork(body, 'city_train');
    assert.equal(network.routes.length, 1);
    assert.equal(network.routes[0].type, 'city_train');
    assert.deepEqual(network.routes[0].coordinates, [[30, 50], [30.1, 50.1], [30.2, 50.2]]);
    assert.equal(network.routes[0].direction, 'A → C');
    assert.equal(network.stops[0].types[0], 'city_train');
    assert.equal(geoJsonMode('Київ — фунікулер (геометрія)'), 'funicular');
    assert.equal(geoJsonMode('Київ — міська електричка'), 'city_train');
    assert.equal(geoJsonMode('Київ — маршрутки'), 'marshrutka');
  });
  it('rejects non-FeatureCollection payloads and ignores malformed/invalid coordinates', () => {
    assert.throws(() => buildGeoJsonNetwork({}, 'metro'), /FeatureCollection/);
    const network = buildGeoJsonNetwork({ features: [
      { geometry: { type: 'Point', coordinates: [200, 50] }, properties: { name: 'bad' } },
      { geometry: { type: 'LineString', coordinates: [[30, 50], ['bad', 50], [30.1, 50.1]] }, properties: { name: 'M1' } },
    ] }, 'metro');
    assert.equal(network.stops.length, 0);
    assert.equal(network.routes.length, 1);
  });
});

describe('realtime vehicle freshness', () => {
  it('accepts Unix seconds, milliseconds and ISO timestamps', () => {
    assert.equal(parseVehicleTimestamp('1700000000')?.getTime(), 1_700_000_000_000);
    assert.equal(parseVehicleTimestamp('1700000000000')?.getTime(), 1_700_000_000_000);
    assert.equal(parseVehicleTimestamp('2026-10-08T12:00:00.000Z')?.toISOString(), '2026-10-08T12:00:00.000Z');
    assert.equal(parseVehicleTimestamp('2026-10-19 12:00:00')?.toISOString(), '2026-10-19T09:00:00.000Z');
    assert.equal(parseVehicleTimestamp({ toNumber: () => 1_700_000_000 })?.getTime(), 1_700_000_000_000);
    assert.equal(parseVehicleTimestamp('not a timestamp'), null);
  });
  it('parses Ukraine wall time across DST and rejects nonexistent local times', () => {
    assert.equal(parseVehicleTimestamp('2026-01-15 12:00:00')?.toISOString(), '2026-01-15T10:00:00.000Z');
    assert.equal(parseVehicleTimestamp('2026-03-29 03:30:00'), null);
    const beforeFold = Date.parse('2026-10-25T00:31:00.000Z');
    const afterFold = Date.parse('2026-10-25T01:31:00.000Z');
    assert.equal(parseMobilityTimestamp('2026-10-25 03:30:00', 'Europe/Kyiv', beforeFold)?.toISOString(), '2026-10-25T00:30:00.000Z');
    assert.equal(parseMobilityTimestamp('2026-10-25 03:30:00', 'Europe/Kyiv', afterFold)?.toISOString(), '2026-10-25T01:30:00.000Z');
  });
  it('uses the same 90-second freshness gate for every live mobility source', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    assert.equal(isFreshMobilityTimestamp(new Date(now - 90_000), now), true);
    assert.equal(isFreshMobilityTimestamp(new Date(now - 90_001), now), false);
    assert.equal(isFreshMobilityTimestamp(new Date(now + 30_000), now), true);
    assert.equal(isFreshMobilityTimestamp(new Date(now + 30_001), now), false);
    assert.equal(isFreshMobilityTimestamp(null, now), false);
  });
  it('hides missing, stale, or implausibly future timestamps', () => {
    const now = Date.parse('2026-10-08T12:00:00.000Z');
    assert.equal(isFreshVehicleTimestamp(new Date(now - 90_000), now), true);
    assert.equal(isFreshVehicleTimestamp(new Date(now - 90_001), now), false);
    assert.equal(isFreshVehicleTimestamp(new Date(now + 30_000), now), true);
    assert.equal(isFreshVehicleTimestamp(new Date(now + 30_001), now), false);
    assert.equal(isFreshVehicleTimestamp(null, now), false);
  });
});
