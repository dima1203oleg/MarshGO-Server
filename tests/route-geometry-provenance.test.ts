import assert from 'node:assert/strict';
import test from 'node:test';
import { legProvenanceMetadata, sanitizePersistedJourney, trustedRouteGeometry } from '../server/journey/legGeometryProvenance';

const shape: Array<[number, number]> = [[24.03, 49.84], [24.05, 49.83], [24.07, 49.82]];

test('keeps explicitly sourced geometry only for a compatible transport mode', () => {
  assert.deepEqual(trustedRouteGeometry({ mode: 'WALK', source: 'osrm-foot-route', routeGeometry: shape }), shape);
  assert.deepEqual(trustedRouteGeometry({ mode: 'BUS', metadata: { routeGeometrySource: 'gtfs_shape' }, routeGeometry: shape }), shape);
  assert.deepEqual(trustedRouteGeometry({ mode: 'METRO', metadata: { routeGeometrySource: 'official_geojson' }, routeGeometry: shape }), shape);
  assert.equal(trustedRouteGeometry({ mode: 'COMMUNITY', source: 'community-offer', routeGeometry: shape }), null,
    'the generic community-offer label does not prove road geometry provenance');
  assert.equal(trustedRouteGeometry({ mode: 'COMMUNITY', metadata: { routeGeometrySource: 'unknown-router' }, routeGeometry: shape }), null);
  assert.deepEqual(trustedRouteGeometry({ mode: 'COMMUNITY', metadata: { routeGeometrySource: 'osrm-car-route' }, routeGeometry: shape }), shape);
  assert.equal(trustedRouteGeometry({ mode: 'RAIL', source: 'uz-timetable', routeGeometry: shape }), null);
  assert.equal(trustedRouteGeometry({ mode: 'WALK', source: 'walking-straight-line-estimate', routeGeometry: shape }), null);
  assert.equal(trustedRouteGeometry({ mode: 'BUS', metadata: { routeGeometrySource: 'official_geojson' }, routeGeometry: shape }), null);
});

test('drops invalid geometry claims but keeps authentic stop waypoints', () => {
  const stops = [
    { id: 'lviv', name: 'Львів', coordinates: [24.03, 49.84] },
    { id: 'kyiv', name: 'Київ', coordinates: [30.52, 50.45] },
  ];
  const metadata = legProvenanceMetadata({
    mode: 'RAIL', source: 'uz-timetable', routeGeometry: shape, stops,
    metadata: { routeGeometrySource: 'legacy-schematic-corridor', routeAccuracy: 'SOURCE_GEOMETRY' },
  });
  assert.equal(metadata.routeGeometry, undefined, 'an operator timetable token does not verify corridor geometry');
  assert.equal(metadata.routeGeometrySource, undefined);
  assert.equal(metadata.routeAccuracy, 'SOURCE_GEOMETRY', 'the write helper leaves unrelated metadata untouched');
  assert.deepEqual(metadata.stops, stops, 'real endpoint stop data survives geometry removal');
  assert.equal(trustedRouteGeometry({ mode: 'BUS', source: 'osrm-foot-route', routeGeometry: [[0, 0], [NaN, 1]] }), null);
});

test('sanitizes immediate journey data and legacy persisted legs consistently', () => {
  const currentResult = sanitizePersistedJourney({ legs: [
    { mode: 'WALK', source: 'walking-straight-line-estimate', routeGeometry: shape,
      metadata: { routeGeometry: shape, routeAccuracy: 'SOURCE_GEOMETRY' } },
    { mode: 'BUS', source: 'gtfs-static', routeGeometry: shape,
      metadata: { routeGeometrySource: 'gtfs_shape', routeGeometry: shape } },
  ] });
  assert.equal((currentResult.legs as Array<Record<string, any>>)[0]?.routeGeometry, undefined);
  assert.equal((currentResult.legs as Array<Record<string, any>>)[0]?.metadata.routeGeometry, undefined);
  assert.equal((currentResult.legs as Array<Record<string, any>>)[0]?.metadata.routeAccuracy, undefined);
  assert.deepEqual((currentResult.legs as Array<Record<string, any>>)[1]?.routeGeometry, shape);

  const legacyRead = sanitizePersistedJourney({ legs: [{
    mode: 'RAIL', source: 'uz-timetable', routeGeometry: shape,
    stops: [{ id: 'lviv', name: 'Львів' }, { id: 'kyiv', name: 'Київ' }],
    metadata: { routeGeometry: shape, routeAccuracy: 'SOURCE_GEOMETRY' },
  }] });
  const leg = (legacyRead.legs as Array<Record<string, any>>)[0]!;
  assert.equal(leg.routeGeometry, undefined);
  assert.equal(leg.metadata.routeGeometry, undefined);
  assert.equal(leg.metadata.routeAccuracy, undefined);
  assert.deepEqual(leg.stops, [{ id: 'lviv', name: 'Львів' }, { id: 'kyiv', name: 'Київ' }]);
  assert.deepEqual(leg.metadata.stops, leg.stops);
});
