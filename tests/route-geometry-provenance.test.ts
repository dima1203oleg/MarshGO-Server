import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceRouteGeometry } from '../server/journey/routeGeometryProvenance';

test('keeps explicit provider/feed shapes unchanged', () => {
  const shape: [number, number][] = [[24.02, 49.84], [24.03, 49.85], [24.04, 49.86]];
  assert.equal(sourceRouteGeometry(shape), shape);
});

test('omits missing, too-short, or invalid geometry instead of inventing a route line', () => {
  assert.equal(sourceRouteGeometry(undefined), undefined);
  assert.equal(sourceRouteGeometry(null), undefined);
  assert.equal(sourceRouteGeometry([]), undefined);
  assert.equal(sourceRouteGeometry([[24.02, 49.84]]), undefined);
  assert.equal(sourceRouteGeometry([[24.02, 49.84], [181, 49.85]]), undefined);
  assert.equal(sourceRouteGeometry([[24.02, 49.84], [24.03, Number.NaN]]), undefined);
});
