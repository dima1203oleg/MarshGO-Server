type RuntimeEnvironment = NodeJS.ProcessEnv;

const MAX_TRUSTED_PROXY_HOPS = 5;

/** Trust only the explicitly configured reverse-proxy chain; Express's fixed hop count is unsafe across deployments. */
export function getTrustedProxyHops(environment: RuntimeEnvironment): number {
  const raw = environment.TRUST_PROXY_HOPS?.trim();
  if (!raw) {
    if (environment.NODE_ENV === 'production') throw new Error('TRUST_PROXY_HOPS is required in production');
    return 0;
  }
  if (!/^(0|[1-5])$/.test(raw)) throw new Error(`TRUST_PROXY_HOPS must be an integer from 0 to ${MAX_TRUSTED_PROXY_HOPS}`);
  return Number(raw);
}

function requireValue(environment: RuntimeEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required in production`);
  return value;
}

function validateProductionOrigins(value: string): void {
  const origins = value.split(',').map((origin) => origin.trim());
  if (origins.length === 0 || origins.some((origin) => !origin || origin === '*')) {
    throw new Error('CORS_ORIGINS must contain explicit production origins');
  }
  for (const origin of origins) {
    if (origin === 'capacitor://localhost') continue;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('CORS_ORIGINS contains an invalid origin');
    }
    const allowed = parsed.protocol === 'https:'
      || (parsed.protocol === 'capacitor:' && parsed.hostname === 'localhost');
    if (!allowed || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error('CORS_ORIGINS must use HTTPS web origins or capacitor://localhost');
    }
  }
}

function requireHttpsUrl(environment: RuntimeEnvironment, name: string): void {
  const raw = requireValue(environment, name);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} must be a valid HTTPS URL in production`); }
  if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname) || url.username || url.password) {
    throw new Error(`${name} must be a public HTTPS URL in production`);
  }
}

/** Fail closed before listening if production could silently use dev auth or default CORS. */
export function validateRuntimeConfig(environment: RuntimeEnvironment): void {
  getTrustedProxyHops(environment);
  if (environment.NODE_ENV !== 'production') return;

  const secret = requireValue(environment, 'SESSION_SECRET');
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes in production');
  }
  if (environment.AUTH_DEV_BYPASS === 'true' || environment.AUTH_DEV_OTP === 'true') {
    throw new Error('development authentication is forbidden in production');
  }

  validateProductionOrigins(requireValue(environment, 'CORS_ORIGINS'));

  if (environment.SMS_PROVIDER !== 'twilio') {
    throw new Error('SMS_PROVIDER=twilio is required in production');
  }
  requireValue(environment, 'TWILIO_ACCOUNT_SID');
  requireValue(environment, 'TWILIO_AUTH_TOKEN');
  requireValue(environment, 'TWILIO_FROM_NUMBER');

  if (environment.GEOCODING_PROVIDER !== undefined && !['nominatim', 'photon'].includes(environment.GEOCODING_PROVIDER)) {
    throw new Error('GEOCODING_PROVIDER must be nominatim or photon');
  }

  if ((environment.MAP_RENDERER ?? 'maplibre') !== 'maplibre') throw new Error('MAP_RENDERER=maplibre is required');
  if ((environment.MAP_DATA_PROVIDER ?? 'marshgo') !== 'marshgo') throw new Error('MAP_DATA_PROVIDER=marshgo is required');
  if ((environment.ROUTING_PRIMARY ?? 'osrm') !== 'osrm') throw new Error('ROUTING_PRIMARY=osrm is the only configured production routing provider');
  if ((environment.TRAFFIC_PROVIDER ?? 'none') !== 'none') throw new Error('TRAFFIC_PROVIDER=none is the only configured traffic provider');
  requireHttpsUrl({ ...environment, OSRM_URL: environment.OSRM_URL || environment.ROUTING_ENGINE_URL }, 'OSRM_URL');
  requireHttpsUrl(environment, 'GEOCODING_ENGINE_URL');
  requireHttpsUrl(environment, 'GEOCODING_REVERSE_URL');
  requireHttpsUrl(environment, 'MAP_STYLE_MANIFEST_URL');
  requireHttpsUrl(environment, 'MAP_DATA_MANIFEST_URL');
  for (const name of ['HERE_ROUTING_ENABLED', 'HERE_TRAFFIC_ENABLED', 'TOMTOM_ROUTING_ENABLED', 'TOMTOM_TRAFFIC_ENABLED']) {
    if (environment[name] !== undefined && !['true', 'false'].includes(environment[name]!)) throw new Error(`${name} must be true or false`);
    if (environment[name] === 'true') throw new Error(`${name}=true is unsupported until its server-side provider adapter is implemented`);
  }
}
