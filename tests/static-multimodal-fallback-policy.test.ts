import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isStaticMultimodalFallbackEnabled } from '../server/journey/staticMultimodalFallbackPolicy';

describe('static multimodal estimate fallback policy', () => {
  it('is disabled by default in development and test', () => {
    assert.equal(isStaticMultimodalFallbackEnabled({ nodeEnv: 'development', allowUnverifiedEstimates: undefined }), false);
    assert.equal(isStaticMultimodalFallbackEnabled({ nodeEnv: 'test', allowUnverifiedEstimates: undefined }), false);
  });

  it('requires an explicit opt-in and test mode', () => {
    assert.equal(isStaticMultimodalFallbackEnabled({ nodeEnv: 'development', allowUnverifiedEstimates: '1' }), false);
    assert.equal(isStaticMultimodalFallbackEnabled({ nodeEnv: 'test', allowUnverifiedEstimates: '1' }), true);
    assert.equal(isStaticMultimodalFallbackEnabled({ nodeEnv: 'production', allowUnverifiedEstimates: '1' }), false);
    assert.equal(isStaticMultimodalFallbackEnabled({ nodeEnv: 'development', allowUnverifiedEstimates: 'true' }), false);
  });
});
