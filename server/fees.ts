export type FeeClass = 'community';

export interface FeeSnapshot {
  feeClass: FeeClass;
  grossAmountMinor: number;
  platformFeeMinor: number;
  driverNetMinor: number;
  ruleVersion: string;
}

/**
 * MARSHGO Community has a contractual product rule of 0% platform commission.
 * Commercial fee classes are deliberately unsupported until an approved fee
 * agreement is stored and versioned; never infer a percentage from the client.
 */
export function calculatePlatformFee(grossAmountMinor: number, feeClass: FeeClass): FeeSnapshot {
  if (!Number.isSafeInteger(grossAmountMinor) || grossAmountMinor < 0) {
    throw new TypeError('grossAmountMinor must be a non-negative safe integer');
  }
  if (feeClass !== 'community') throw new TypeError('fee class is not configured');

  const platformFeeMinor = 0;
  return {
    feeClass,
    grossAmountMinor,
    platformFeeMinor,
    driverNetMinor: grossAmountMinor - platformFeeMinor,
    ruleVersion: 'community-0pct-v1',
  };
}
