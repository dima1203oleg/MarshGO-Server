import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJourneySearchRequest } from '../server/journey/search';

const now = new Date('2026-09-30T08:00:00.000Z');
const request = {
  origin: { name: 'Стрий', coordinates: [23.85, 49.26] },
  destination: { name: 'Львів', coordinates: [24.03, 49.84] },
  departureAt: '2026-09-30T12:00:00+03:00',
  passengers: 2,
  strategy: 'FASTEST',
  preferences: { maxPriceMinor: 50000, maxTransfers: 2, minimumTransferBufferSeconds: 900 },
};

describe('Journey search request validation', () => {
  it('normalizes a timezone-aware journey request and preserves coordinates', () => {
    const parsed = parseJourneySearchRequest(request, now);
    assert.deepEqual(parsed.origin, request.origin);
    assert.equal(parsed.departureAt.toISOString(), '2026-09-30T09:00:00.000Z');
    assert.equal(parsed.passengers, 2);
    assert.equal(parsed.preferences.minimumTransferBufferSeconds, 900);
  });

  it('rejects invalid points, missing time zone, past departure, and unsupported preferences', () => {
    assert.throws(() => parseJourneySearchRequest({ ...request, origin: { ...request.origin, coordinates: [181, 0] } }, now), /valid WGS84/);
    assert.throws(() => parseJourneySearchRequest({ ...request, departureAt: '2026-09-30T11:00:00' }, now), /explicit timezone/);
    assert.throws(() => parseJourneySearchRequest({ ...request, departureAt: '2026-09-30T10:00:00+03:00' }, now), /must be in the future/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { maxTransfers: -1 } }, now), /outside the supported range/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { preferredCarColor: 'blue' } }, now), /unsupported preference/);
    assert.throws(() => parseJourneySearchRequest({ ...request, strategy: 'FAKEST' }, now), /not supported/);
  });
});
