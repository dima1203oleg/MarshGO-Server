import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasGtfsRouteEvidence, micromobilityEstimateOptions, parseJourneySearchRequest, shouldSearchGtfsTimetables, transitProviderAllowed } from '../server/journey/search';
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
  it('keeps spatially eligible timetable search enabled for intercity and nationwide distances', () => {
    assert.equal(shouldSearchGtfsTimetables({ routeDistanceMeters: 5_000, eligibleProviderCount: 1, hasMetroSource: false }), true);
    assert.equal(shouldSearchGtfsTimetables({ routeDistanceMeters: 468_000, eligibleProviderCount: 2, hasMetroSource: false }), true);
    assert.equal(shouldSearchGtfsTimetables({ routeDistanceMeters: 0, eligibleProviderCount: 0, hasMetroSource: true }), true);
    assert.equal(shouldSearchGtfsTimetables({ routeDistanceMeters: 468_000, eligibleProviderCount: 0, hasMetroSource: false }), false);
    assert.equal(shouldSearchGtfsTimetables({ routeDistanceMeters: Number.NaN, eligibleProviderCount: 2, hasMetroSource: false }), false);
  });

  it('requires validated route counts for the requested mode before admitting a GTFS provider', () => {
    assert.equal(hasGtfsRouteEvidence('BUS', undefined), false, 'a reachability-only report is not a route');
    assert.equal(hasGtfsRouteEvidence('BUS', { vehicles_bus: 4 }), false, 'live positions alone do not create a timetable route');
    assert.equal(hasGtfsRouteEvidence('BUS', { routes_tram: 2 }), false, 'another mode cannot enable bus search');
    assert.equal(hasGtfsRouteEvidence('BUS', { routes_bus: 3 }), true);
    assert.equal(hasGtfsRouteEvidence('BUS', { routes_intercity_bus: 1 }), true);
    assert.equal(hasGtfsRouteEvidence('RAIL', { routes_train: 12 }), true);
    assert.equal(hasGtfsRouteEvidence('RAIL', { routes_suburban: 2 }), true);
    assert.equal(hasGtfsRouteEvidence('TRAM', { routes_tram: 0 }), false);
  });

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

  it('keeps per-mode rental provider choices separate and preserves the legacy shared allowlist', () => {
    const parsed = parseJourneySearchRequest({ ...request, preferences: {
      allowedProviderIds: ['shared-provider'],
      allowedProviderIdsByType: { bike: ['bike-provider'], scooter: [] },
    } }, now);
    const sharedOptions = { departureAt: now, maxWalkToRentalMeters: 500, allowedProviderIds: ['shared-provider'] };
    assert.deepEqual(micromobilityEstimateOptions(parsed.preferences, 'bike', sharedOptions), {
      ...sharedOptions, allowedProviderIds: ['bike-provider'],
    });
    assert.equal(micromobilityEstimateOptions(parsed.preferences, 'scooter', sharedOptions), null, 'an explicit empty mode selection excludes that mode');

    const legacy = parseJourneySearchRequest({ ...request, preferences: { allowedProviderIds: ['shared-provider'] } }, now);
    assert.deepEqual(micromobilityEstimateOptions(legacy.preferences, 'bike', sharedOptions), sharedOptions);
    assert.deepEqual(micromobilityEstimateOptions(legacy.preferences, 'scooter', sharedOptions), sharedOptions);

    const unfiltered = parseJourneySearchRequest(request, now);
    assert.deepEqual(micromobilityEstimateOptions(unfiltered.preferences, 'bike', sharedOptions), sharedOptions);
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
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { allowedProviderIdsByType: { bus: ['provider'] } } }, now), /allowedProviderIdsByType is invalid/);
    assert.throws(() => parseJourneySearchRequest({ ...request, preferences: { allowedProviderIdsByType: { bike: ['invalid provider'] } } }, now), /allowedProviderIdsByType is invalid/);
    assert.throws(() => parseJourneySearchRequest({ ...request, strategy: 'FAKEST' }, now), /not supported/);
  });
});
