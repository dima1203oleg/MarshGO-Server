import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializeSmokeJourney, summarizeSmokeItineraries, withOptionalSourceFingerprint } from '../scripts/transport-feed-smoke-summary';

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

test('serializes dated trip, stop, schedule, and transfer facts without losing unknowns', () => {
  const at = (value: string) => new Date(value);
  const evidence = serializeSmokeJourney({
    id: 'provider:20261115:trip-1|provider:20261115:trip-2',
    departureAt: at('2026-11-15T07:00:00.000Z'),
    arrivalAt: at('2026-11-15T08:00:00.000Z'),
    durationSeconds: 3600,
    walkingMeters: 220,
    waitingSeconds: 300,
    transfers: 1,
    transferWalkingMeters: [120],
    transferWalkingSeconds: [180],
    transferMinimumBufferSeconds: [240],
    transferRuleMinimumSeconds: [null],
    transferInSeat: [false],
    segments: [
      {
        providerId: 'provider', routeId: 'route-1', routeName: 'A53', tripId: 'trip-1', serviceDate: '20261115',
        staticFeedSha256: 'c'.repeat(64), transportType: 'bus', scheduleSemantics: 'published_departures',
        scheduledDepartureAt: at('2026-11-15T07:05:00.000Z'), scheduledArrivalAt: at('2026-11-15T07:30:00.000Z'),
        departureAt: at('2026-11-15T07:05:00.000Z'), arrivalAt: at('2026-11-15T07:30:00.000Z'),
        originStop: { id: 'stop-1', name: 'Stop 1', coordinates: [24, 49] },
        destinationStop: { id: 'stop-2', name: 'Stop 2', coordinates: [24.01, 49.01] },
      },
      {
        providerId: 'provider', routeId: 'route-2', routeName: 'T1', tripId: 'trip-2', serviceDate: '20261115',
        transportType: 'tram', scheduleSemantics: 'frequency_estimate',
        scheduledDepartureAt: at('2026-11-15T07:33:00.000Z'), scheduledArrivalAt: at('2026-11-15T08:00:00.000Z'),
        departureAt: at('2026-11-15T07:33:00.000Z'), arrivalAt: at('2026-11-15T08:00:00.000Z'),
        originStop: { id: 'stop-3', name: 'Stop 3', coordinates: [24.02, 49.02] },
        destinationStop: { id: 'stop-4', name: 'Stop 4', coordinates: [24.03, 49.03] },
      },
    ],
  });

  assert.equal(evidence.transfers, 1);
  assert.deepEqual(evidence.transferWalkingMeters, [120]);
  assert.deepEqual(evidence.transferRuleMinimumSeconds, [null]);
  assert.equal(evidence.segments[0]?.staticFeedSha256, 'c'.repeat(64));
  assert.equal(evidence.segments[0]?.tripId, 'trip-1');
  assert.equal(evidence.segments[0]?.originStop.id, 'stop-1');
  assert.equal(evidence.segments[1]?.scheduleSemantics, 'frequency_estimate');
  assert.equal('staticFeedSha256' in (evidence.segments[1] ?? {}), false);
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
