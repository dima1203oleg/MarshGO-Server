import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeSmokeItineraries } from '../scripts/transport-feed-smoke-summary';

test('summarizes every returned itinerary rather than inferring from a small example sample', () => {
  const summary = summarizeSmokeItineraries([
    { segments: [{ transportType: 'tram' }] },
    { segments: [{ transportType: 'bus' }] },
    { segments: [{ transportType: 'walk' }, { transportType: 'tram' }] },
    { segments: [{ transportType: 'tram' }, { transportType: 'train' }, { transportType: 'bus' }] },
  ]);

  assert.deepEqual(summary, {
    returnedItineraryCount: 4,
    multiLegCount: 2,
    maximumLegCount: 3,
    modeChainCounts: [
      { modes: ['bus'], count: 1 },
      { modes: ['tram'], count: 1 },
      { modes: ['tram', 'train', 'bus'], count: 1 },
      { modes: ['walk', 'tram'], count: 1 },
    ],
  });
});

test('empty route results report zero examples and no multi-leg itineraries', () => {
  assert.deepEqual(summarizeSmokeItineraries([]), {
    returnedItineraryCount: 0,
    multiLegCount: 0,
    maximumLegCount: 0,
    modeChainCounts: [],
  });
});
