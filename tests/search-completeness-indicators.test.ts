// ТЗ-M5-P10: the completeness block must name unavailable categories instead of
// returning a silent empty result set. Fixtures are labelled synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CANONICAL_ROUTE_TYPES, buildSearchCompleteness, routeTypesWithUsableProviderData } from '../server/journey/searchCompleteness';

const LVIV_CORRIDOR = {
  providersQueried: 3,
  providersFailed: 0,
  routeTypesInCorridor: ['bus', 'tram', 'carpool'],
  requestedRouteTypes: ['bus', 'marshrutka', 'tram', 'metro'],
  candidatesGenerated: 42,
  candidatesValidated: 30,
  candidatesDeduplicated: 12,
  resultsReturned: 6,
  searchTruncated: false,
};

describe('search completeness indicators', () => {
  it('reports only categories backed by provider data in the searched corridor', () => {
    const unavailableMicromobility = routeTypesWithUsableProviderData({
      timetableTypes: ['bus_unspecified', 'tram', 'trolleybus', 'unknown'],
      communityOffers: 0, bicycleInventory: 0, scooterProviderInventory: 0,
    });
    assert.deepEqual([...unavailableMicromobility], ['bus', 'tram', 'trolleybus']);
    const supplied = routeTypesWithUsableProviderData({
      timetableTypes: ['bus'], communityOffers: 1, bicycleInventory: 2, scooterProviderInventory: 1,
    });
    assert.deepEqual([...supplied], ['bus', 'carpool', 'bike', 'scooter']);
  });

  it('names a requested category with no routed provider instead of hiding it', () => {
    const result = buildSearchCompleteness(LVIV_CORRIDOR);
    assert.deepEqual(result.modesAvailable, ['bus', 'tram', 'carpool']);
    const marshrutka = result.modesUnavailable.find((entry) => entry.mode === 'marshrutka');
    assert.ok(marshrutka);
    assert.equal(marshrutka.requested, true);
    assert.equal(marshrutka.reason, 'no_routed_provider_in_corridor');
  });

  it('does not claim success when the provider set failed or generation was truncated', () => {
    assert.equal(buildSearchCompleteness({ ...LVIV_CORRIDOR, providersFailed: 1 }).searchComplete, false);
    assert.equal(buildSearchCompleteness({ ...LVIV_CORRIDOR, searchTruncated: true }).searchComplete, false);
    assert.equal(buildSearchCompleteness(LVIV_CORRIDOR).searchComplete, true);
  });

  it('counts rejected candidates as the gap between generated and validated', () => {
    const result = buildSearchCompleteness(LVIV_CORRIDOR);
    assert.equal(result.candidatesRejected, 12);
    assert.equal(result.providersSucceeded, 3);
  });

  it('labels an unrequested missing category as a source gap, not a corridor gap', () => {
    const result = buildSearchCompleteness({ ...LVIV_CORRIDOR, requestedRouteTypes: ['bus'] });
    const taxi = result.modesUnavailable.find((entry) => entry.mode === 'taxi');
    assert.equal(taxi?.requested, false);
    assert.equal(taxi?.reason, 'no_source_declares_this_category');
  });

  it('reports every canonical category exactly once across available and unavailable', () => {
    const result = buildSearchCompleteness(LVIV_CORRIDOR);
    const reported = [...result.modesAvailable, ...result.modesUnavailable.map((entry) => entry.mode)];
    assert.equal(reported.length, CANONICAL_ROUTE_TYPES.length);
    assert.deepEqual(new Set(reported).size, CANONICAL_ROUTE_TYPES.length);
  });

  it('names a thrown transit search as a failure instead of an empty corridor', () => {
    const result = buildSearchCompleteness({
      ...LVIV_CORRIDOR,
      routeTypesInCorridor: ['carpool'],
      candidatesGenerated: 4,
      candidatesValidated: 4,
      candidatesDeduplicated: 4,
      resultsReturned: 2,
      transitSearchFailed: true,
    });
    assert.equal(result.transitSearchFailed, true);
    assert.equal(result.searchComplete, false);
    assert.equal(result.providersFailed, 3);
    assert.equal(result.providersSucceeded, 0);
    assert.deepEqual(result.modesAvailable, ['carpool']);
    for (const mode of ['bus', 'marshrutka', 'metro', 'tram']) {
      assert.equal(result.modesUnavailable.find((entry) => entry.mode === mode)?.reason, 'transit_search_failed', mode);
    }
  });

  it('keeps non-transit categories attributed to their own sources when transit fails', () => {
    const result = buildSearchCompleteness({
      ...LVIV_CORRIDOR, routeTypesInCorridor: [], requestedRouteTypes: ['bus', 'carpool'], transitSearchFailed: true,
    });
    assert.equal(result.modesUnavailable.find((entry) => entry.mode === 'carpool')?.reason, 'no_routed_provider_in_corridor');
    assert.equal(result.modesUnavailable.find((entry) => entry.mode === 'bus')?.reason, 'transit_search_failed');
    assert.equal(result.modesUnavailable.find((entry) => entry.mode === 'taxi')?.reason, 'no_source_declares_this_category');
  });

  it('does not report a complete search when only the metro source was queried and it failed', () => {
    const result = buildSearchCompleteness({
      ...LVIV_CORRIDOR, providersQueried: 0, providersFailed: 0, routeTypesInCorridor: [],
      candidatesGenerated: 4, candidatesValidated: 4, candidatesDeduplicated: 4, resultsReturned: 2,
      transitSearchFailed: true,
    });
    assert.equal(result.providersFailed, 0);
    assert.equal(result.searchComplete, false);
    assert.equal(result.modesAvailable.length, 0);
    assert.equal(result.modesUnavailable.find((entry) => entry.mode === 'metro')?.reason, 'transit_search_failed');
  });

  it('leaves the corridor-gap reading untouched when the search did not fail', () => {
    const result = buildSearchCompleteness({ ...LVIV_CORRIDOR, transitSearchFailed: false });
    assert.equal(result.transitSearchFailed, false);
    assert.equal(result.modesUnavailable.find((entry) => entry.mode === 'marshrutka')?.reason, 'no_routed_provider_in_corridor');
    assert.equal(result.searchComplete, true);
  });
});
