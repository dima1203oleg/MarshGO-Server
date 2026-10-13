import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getJourneySearchPartialReasons } from '../server/journey/search';

describe('journey search completeness', () => {
  const complete = {
    candidateGenerationTruncated: false,
    providerErrorCount: 0,
    unsupportedPreferenceCount: 0,
    scheduledCandidatesNeedWalkingRouting: false,
  };

  it('reports no limitation when the search had no truncation, errors, unsupported preferences, or unrouted walks', () => {
    assert.deepEqual(getJourneySearchPartialReasons(complete), []);
  });

  it('reports each concrete limitation independently', () => {
    assert.deepEqual(getJourneySearchPartialReasons({
      candidateGenerationTruncated: true,
      providerErrorCount: 1,
      unsupportedPreferenceCount: 2,
      scheduledCandidatesNeedWalkingRouting: true,
    }), [
      'candidate_generation_truncated',
      'provider_error',
      'unsupported_preference',
      'walking_routing_unavailable',
    ]);
  });
});
