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

/** Fail closed on public demo geocoders that cannot sustain production autocomplete traffic. */
function validateProductionGeocoder(environment: RuntimeEnvironment): void {
  const engine = new URL(requireValue(environment, 'GEOCODING_ENGINE_URL'));
  const reverse = new URL(requireValue(environment, 'GEOCODING_REVERSE_URL'));
  const publicPhotonHosts = [engine.hostname, reverse.hostname].map((hostname) => hostname.toLowerCase());
  if (publicPhotonHosts.some((hostname) => hostname === 'photon.komoot.io' || hostname.endsWith('.photon.komoot.io'))) {
    throw new Error('Production geocoder endpoints must not use the public Photon demo');
  }
  if (engine.hostname.toLowerCase() === 'nominatim.openstreetmap.org') {
    throw new Error('Public Nominatim does not support place autocomplete; configure Photon or an approved geocoder');
  }
}

/**
 * A pedestrian graph MARSHGO operates itself is reached over the private
 * container network, where routing is the edge proxy's job. Every other
 * hostname still has to speak HTTPS, and credentials never belong in a URL.
 */
function requireWalkingRoutingUrl(environment: RuntimeEnvironment, name: string): void {
  const raw = requireValue(environment, name);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} must be a valid URL in production`); }
  if (url.username || url.password) throw new Error(`${name} must not embed credentials`);
  if (url.protocol === 'https:') return;
  if (url.protocol !== 'http:') throw new Error(`${name} must use HTTP or HTTPS`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const privateAddress = host === 'localhost' || host === 'ip6-localhost' || host === '::1'
    || !host.includes('.') || /^(10\.|192\.168\.|169\.254\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    || /^(fc|fd)/i.test(host);
  if (!privateAddress) throw new Error(`${name} must use HTTPS unless it points at a private-network service`);
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

  const smsProvider = environment.SMS_PROVIDER;
  if (smsProvider === 'twilio') {
    requireValue(environment, 'TWILIO_ACCOUNT_SID');
    requireValue(environment, 'TWILIO_AUTH_TOKEN');
    requireValue(environment, 'TWILIO_FROM_NUMBER');
  } else if (smsProvider !== 'disabled') {
    throw new Error('SMS_PROVIDER must be explicitly set to disabled or twilio in production');
  }

  if (environment.GEOCODING_PROVIDER !== undefined && !['nominatim', 'photon'].includes(environment.GEOCODING_PROVIDER)) {
    throw new Error('GEOCODING_PROVIDER must be nominatim or photon');
  }

  if ((environment.MAP_RENDERER ?? 'maplibre') !== 'maplibre') throw new Error('MAP_RENDERER=maplibre is required');
  if ((environment.MAP_DATA_PROVIDER ?? 'marshgo') !== 'marshgo') throw new Error('MAP_DATA_PROVIDER=marshgo is required');
  if ((environment.ROUTING_PRIMARY ?? 'osrm') !== 'osrm') throw new Error('ROUTING_PRIMARY=osrm is the only configured production routing provider');
  if ((environment.TRAFFIC_PROVIDER ?? 'none') !== 'none') throw new Error('TRAFFIC_PROVIDER=none is the only configured traffic provider');
  requireHttpsUrl({ ...environment, OSRM_URL: environment.OSRM_URL || environment.ROUTING_ENGINE_URL }, 'OSRM_URL');
  if (environment.WALKING_ROUTING_URL?.trim()) requireWalkingRoutingUrl(environment, 'WALKING_ROUTING_URL');
  // A cycling graph is operated the same way as a foot graph: private network or HTTPS, never a
  // public demo router, and no default is invented when the operator leaves it unset.
  if (environment.BIKING_ROUTING_URL?.trim()) requireWalkingRoutingUrl(environment, 'BIKING_ROUTING_URL');
  if (environment.WALKING_ROUTING_URLS?.trim()) {
    let rules: unknown;
    try {
      rules = JSON.parse(environment.WALKING_ROUTING_URLS);
    } catch {
      throw new Error('WALKING_ROUTING_URLS must be a JSON array of {bbox,url} entries');
    }
    if (!Array.isArray(rules) || rules.length === 0) throw new Error('WALKING_ROUTING_URLS must be a non-empty JSON array');
    for (const rule of rules) {
      const bbox = (rule as { bbox?: unknown } | null)?.bbox;
      const url = (rule as { url?: unknown } | null)?.url;
      if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error('WALKING_ROUTING_URLS entries need a numeric [minLon,minLat,maxLon,maxLat] bbox');
      }
      if (typeof url !== 'string' || !url.trim()) throw new Error('WALKING_ROUTING_URLS entries need a url');
      try {
        requireWalkingRoutingUrl({ ...environment, WALKING_ROUTING_URL: url }, 'WALKING_ROUTING_URL');
      } catch (error) {
        throw new Error(`WALKING_ROUTING_URLS: ${error instanceof Error ? error.message : 'invalid url'}`, { cause: error });
      }
    }
  }
  requireHttpsUrl(environment, 'GEOCODING_ENGINE_URL');
  requireHttpsUrl(environment, 'GEOCODING_REVERSE_URL');
  validateProductionGeocoder(environment);
  requireHttpsUrl(environment, 'MAP_STYLE_MANIFEST_URL');
  requireHttpsUrl(environment, 'MAP_DATA_MANIFEST_URL');
  for (const name of ['HERE_ROUTING_ENABLED', 'HERE_TRAFFIC_ENABLED', 'TOMTOM_ROUTING_ENABLED', 'TOMTOM_TRAFFIC_ENABLED']) {
    if (environment[name] !== undefined && !['true', 'false'].includes(environment[name]!)) throw new Error(`${name} must be true or false`);
    if (environment[name] === 'true') throw new Error(`${name}=true is unsupported until its server-side provider adapter is implemented`);
  }
}
