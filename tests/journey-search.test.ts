import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJourneySearchRequest, transitProviderAllowed } from '../server/journey/search';
import { JOURNEY_TRANSPORT_TYPES } from '../server/journey/types';

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
  it('exposes only the twelve canonical categories and normalizes legacy transit subtypes', () => {
    assert.deepEqual(JOURNEY_TRANSPORT_TYPES, ['bus','marshrutka','trolleybus','tram','metro','carpool','taxi','train','bike','scooter','carsharing','transfer']);
    const parsed = parseJourneySearchRequest({ ...request, preferences: { allowedTransportTypes: ['intercity_bus', 'city_train'] } }, now);
    assert.deepEqual(parsed.preferences.allowedTransportTypes, ['bus', 'train']);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { allowedTransportTypes: ['plane'] } }, now), /allowedTransportTypes is invalid/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { allowedTransportTypes: ['ferry'] } }, now), /allowedTransportTypes is invalid/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { allowedTransportTypes: ['funicular'] } }, now), /allowedTransportTypes is invalid/);
  });

  it('normalizes a timezone-aware journey request and preserves coordinates', () => {
    const parsed = parseJourneySearchRequest(request, now);
    assert.deepEqual(parsed.origin, request.origin);
    assert.equal(parsed.departureAt.toISOString(), '2026-09-30T09:00:00.000Z');
    assert.equal(parsed.passengers, 2);
    assert.equal(parsed.preferences.minimumTransferBufferSeconds, 900);
    const tramOnly = parseJourneySearchRequest({ ...request, preferences: { allowedTransportTypes: ['tram'] } }, now);
    assert.deepEqual(tramOnly.preferences.allowedTransportTypes, ['tram']);
    const cityModes = parseJourneySearchRequest({ ...request, preferences: { allowedTransportTypes: ['city_train'] } }, now);
    assert.deepEqual(cityModes.preferences.allowedTransportTypes, ['train']);
    const chosenProvider = parseJourneySearchRequest({ ...request, preferences: { allowedTransitProviders: ['Львівавтодор'] } }, now);
    assert.deepEqual(chosenProvider.preferences.allowedTransitProviders, ['Львівавтодор']);
    const providersByType = parseJourneySearchRequest({ ...request, preferences: { allowedTransitProvidersByType: { bus: ['Львівавтодор'], tram: ['Інший провайдер'] } } }, now);
    assert.equal(transitProviderAllowed(providersByType.preferences, 'bus', 'Львівавтодор — автобуси'), true);
    assert.equal(transitProviderAllowed(providersByType.preferences, 'tram', 'Львівавтодор — трамваї'), false);
    assert.equal(transitProviderAllowed(providersByType.preferences, 'tram', 'Інший провайдер — трамваї'), true);
    const canonicalRailProvider = parseJourneySearchRequest({ ...request, preferences: { allowedTransitProvidersByType: { train: ['УЗ'] } } }, now);
    assert.equal(transitProviderAllowed(canonicalRailProvider.preferences, 'city_train', 'УЗ — міська електричка'), true);
  });

  it('rejects invalid points, missing time zone, past departure, and unsupported preferences', () => {
    assert.throws(() => parseJourneySearchRequest({ ...request, origin: { ...request.origin, coordinates: [181, 0] } }, now), /valid WGS84/);
    assert.throws(() => parseJourneySearchRequest({ ...request, departureAt: '2026-09-30T11:00:00' }, now), /explicit timezone/);
    assert.throws(() => parseJourneySearchRequest({ ...request, departureAt: '2026-09-30T10:00:00+03:00' }, now), /must be in the future/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { maxTransfers: -1 } }, now), /outside the supported range/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { preferredCarColor: 'blue' } }, now), /unsupported preference/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { allowedTransportTypes: ['ufo'] } }, now), /allowedTransportTypes is invalid/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { allowedTransitProviders: [''] } }, now), /allowedTransitProviders is invalid/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { allowedTransitProvidersByType: { ufo: ['Provider'] } } }, now), /allowedTransitProvidersByType is invalid/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { allowedTransitProvidersByType: { plane: ['Provider'] } } }, now), /allowedTransitProvidersByType is invalid/);
    assert.throws(() => parseJourneySearchRequest({ ...request, strategy: 'FAKEST' }, now), /not supported/);
  });
});
