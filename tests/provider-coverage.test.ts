import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bboxIntersectsRouteCorridor, gtfsProvidersInRouteCorridor, selectGtfsProvidersInRouteCorridor } from '../server/journey/providerCoverage';

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

  it('does not let stale cached route counts hide a spatially valid current GTFS feed', () => {
    const provider = {
      id: 'lviv-gtfs',
      last_report: {
        bbox: [23.86, 49.77, 24.17, 49.98] as const,
        // This report predates the current feed/classifier and omits trolleybus.
        counts: { routes_bus: 55, routes_tram: 8, routes_trolleybus: 0 },
      },
    };
    assert.deepEqual(gtfsProvidersInRouteCorridor([provider], lviv, lviv, 2_000), [provider]);
    assert.deepEqual(gtfsProvidersInRouteCorridor([provider], kyiv, kyiv, 2_000), []);
  });

  it('applies the bounded feed budget after corridor filtering', () => {
    const unrelated = Array.from({ length: 101 }, (_, index) => ({
      id: `city-feed-${index}`,
      last_report: { bbox: [26.53, 48.64, 26.63, 48.74] as const },
    }));
    const nationalRail = {
      id: 'national-rail',
      last_report: { bbox: [22, 44, 41, 53] as const },
    };
    const selection = selectGtfsProvidersInRouteCorridor([...unrelated, nationalRail], kyiv, lviv, kyivLvivCorridor);
    assert.deepEqual(selection.providers, [nationalRail]);
    assert.equal(selection.truncated, false);
  });

  it('reports truncation only when relevant feeds exceed the corridor budget', () => {
    const relevant = Array.from({ length: 101 }, (_, index) => ({
      id: `corridor-feed-${index}`,
      last_report: { bbox: [23.86, 49.77, 24.17, 49.98] as const },
    }));
    const selection = selectGtfsProvidersInRouteCorridor(relevant, lviv, lviv, 2_000, 100);
    assert.equal(selection.providers.length, 100);
    assert.equal(selection.truncated, true);
  });
});
