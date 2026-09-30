import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculatePlatformFee } from '../server/fees';

describe('Community fee engine', () => {
  it('freezes a zero platform fee and preserves the full driver amount', () => {
    assert.deepEqual(calculatePlatformFee(30_001, 'community'), {
      feeClass: 'community', grossAmountMinor: 30_001, platformFeeMinor: 0,
      driverNetMinor: 30_001, ruleVersion: 'community-0pct-v1',
    });
  });

  it('rejects invalid money and an unconfigured commercial fee class', () => {
    assert.throws(() => calculatePlatformFee(-1, 'community'), /non-negative/);
    assert.throws(() => calculatePlatformFee(1.25, 'community'), /non-negative/);
    assert.throws(() => calculatePlatformFee(100, 'commercial' as never), /not configured/);
  });
});
