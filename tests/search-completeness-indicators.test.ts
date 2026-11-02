// ТЗ-M5-P10: the completeness block must name unavailable categories instead of
// returning a silent empty result set. Fixtures are labelled synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CANONICAL_ROUTE_TYPES, buildSearchCompleteness } from '../server/journey/searchCompleteness';

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
});
