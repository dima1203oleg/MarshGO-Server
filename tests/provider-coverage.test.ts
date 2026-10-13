import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bboxIntersectsRouteCorridor } from '../server/journey/providerCoverage';

const kyiv: [number, number] = [30.5234, 50.4501];
const lviv: [number, number] = [24.031, 49.842];
const kyivLvivCorridor = 60_000;

describe('GTFS provider corridor selection', () => {
  it('keeps provider feeds at either endpoint', () => {
    assert.equal(bboxIntersectsRouteCorridor([23.86, 49.77, 24.17, 49.98], kyiv, lviv, kyivLvivCorridor), true);
    assert.equal(bboxIntersectsRouteCorridor([30.28, 50.22, 30.78, 50.57], kyiv, lviv, kyivLvivCorridor), true);
  });

  it('excludes city feeds that only fall inside the route bounding rectangle', () => {
    assert.equal(bboxIntersectsRouteCorridor([26.53, 48.64, 26.63, 48.74], kyiv, lviv, kyivLvivCorridor), false);
    assert.equal(bboxIntersectsRouteCorridor([30.68, 46.35, 30.82, 46.55], kyiv, lviv, kyivLvivCorridor), false);
  });

  it('includes a broad intercity feed whose declared coverage crosses the corridor', () => {
    assert.equal(bboxIntersectsRouteCorridor([11.3, 43.8, 33.5, 49.9], kyiv, lviv, kyivLvivCorridor), true);
  });

  it('rejects invalid provider coverage boxes', () => {
    assert.equal(bboxIntersectsRouteCorridor([24, 50, 23, 49], kyiv, lviv, kyivLvivCorridor), false);
    assert.equal(bboxIntersectsRouteCorridor([24, 49, 25, 91], kyiv, lviv, kyivLvivCorridor), false);
  });
});
