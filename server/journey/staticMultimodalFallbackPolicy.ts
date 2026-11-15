export interface StaticMultimodalFallbackPolicyInput {
  nodeEnv: string | undefined;
  allowUnverifiedEstimates: string | undefined;
}

/** Static, hard-coded corridor estimates are allowed only in explicit test runs. */
export function isStaticMultimodalFallbackEnabled({
  nodeEnv,
  allowUnverifiedEstimates,
}: StaticMultimodalFallbackPolicyInput): boolean {
  return nodeEnv === 'test' && allowUnverifiedEstimates === '1';
}
