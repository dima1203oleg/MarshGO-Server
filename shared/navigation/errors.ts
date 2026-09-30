export const errorCodes = [
  'GPS_PERMISSION_DENIED','GPS_UNAVAILABLE','GPS_LOW_ACCURACY','GPS_STALE','GPS_INVALID_FIX','GPS_TELEPORT_DETECTED','CLOCK_SKEW_WARNING',
  'ROUTING_NO_ROUTE','ROUTING_TIMEOUT','ROUTING_PROVIDER_UNAVAILABLE','ROUTING_RATE_LIMITED','ROUTING_INVALID_RESPONSE','ROUTING_UNSUPPORTED_PROFILE',
  'MAP_MATCH_FAILED','MAP_MATCH_LOW_CONFIDENCE','TRAFFIC_UNAVAILABLE','TRAFFIC_STALE','REROUTE_FAILED','REROUTE_LOOP_DETECTED',
  'MATCHING_NO_FEASIBLE_INSERTION','MATCHING_CAPACITY_EXCEEDED','MATCHING_TIME_WINDOW_FAILED','OFFLINE_ROUTE_NOT_CACHED','NAVIGATION_STATE_CONFLICT','API_VERSION_UNSUPPORTED',
] as const;
export type ErrorCode = typeof errorCodes[number];
export interface MarshGoError { code: ErrorCode; category: 'LOCATION'|'ROUTING'|'TRAFFIC'|'MATCHING'|'OFFLINE'|'PROVIDER'|'AUTH'|'NAVIGATION'; retryable: boolean; userActionRequired: boolean; provider?: string; safeMessageKey: string; details?: Record<string, unknown> }
export type NavigationError = MarshGoError;
export function navigationError(code: ErrorCode, provider?: string): MarshGoError {
  const category = code.startsWith('GPS') || code === 'CLOCK_SKEW_WARNING' ? 'LOCATION' : code.startsWith('ROUTING') ? 'ROUTING' : code.startsWith('TRAFFIC') ? 'TRAFFIC' : code.startsWith('MATCH') ? 'MATCHING' : code.startsWith('OFFLINE') ? 'OFFLINE' : 'NAVIGATION';
  return { code, category, retryable: !['GPS_PERMISSION_DENIED','API_VERSION_UNSUPPORTED','ROUTING_UNSUPPORTED_PROFILE'].includes(code), userActionRequired: ['GPS_PERMISSION_DENIED','API_VERSION_UNSUPPORTED'].includes(code), safeMessageKey: `errors.${code}`, ...(provider ? { provider } : {}) };
}
export class NavigationProviderError extends Error {
  readonly detail: MarshGoError;
  constructor(code: ErrorCode, provider?: string) { super(code); this.detail = navigationError(code, provider); }
}
