import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeSmokeItineraries, withOptionalSourceFingerprint } from '../scripts/transport-feed-smoke-summary';

test('preserves source fingerprints in acceptance evidence without inventing missing values', () => {
  assert.deepEqual(withOptionalSourceFingerprint({ name: 'Lviv static GTFS' }, 'sourceVersion', 'a'.repeat(64)), {
    name: 'Lviv static GTFS',
    sourceVersion: 'a'.repeat(64),
  });
  assert.deepEqual(withOptionalSourceFingerprint({ stops: 1 }, 'staticFeedSha256', 'b'.repeat(64)), {
    stops: 1,
    staticFeedSha256: 'b'.repeat(64),
  });
  assert.deepEqual(withOptionalSourceFingerprint({ name: 'Unknown feed' }, 'sourceVersion'), { name: 'Unknown feed' });
});

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
