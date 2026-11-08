import { createHash } from 'node:crypto';

export type PlaceSuggestion = {
  label: string;
  latitude: number;
  longitude: number;
  providerId: string;
};

export type PlaceBias = { latitude: number; longitude: number };

export class GeocodingUnavailableError extends Error {
  constructor(message = 'Geocoding service is not configured') { super(message); }
}

/**
 * Nominatim `display_name` is a postal dump ("…міська громада, …район, …область, 58002, Україна").
 * A passenger compares six of those in a second, so the picker shows only the place itself plus the
 * one region that separates equally named places (Львів the city from Львів the Crimean village).
 */
const MAX_SUGGESTION_LABEL_LENGTH = 64;
const UKRAINE_BOUNDS = '22.137,44.386,40.228,52.379';
const SETTLEMENT_KEYS = ['city', 'town', 'village', 'municipality', 'hamlet'] as const;
const CITY_KEYS = ['city', 'town'] as const;
const LOCALITY_KEYS = ['suburb', 'neighbourhood', 'quarter', 'county'] as const;

function shortLabel(record: Record<string, unknown>): string | null {
  const source = record.address;
  if (!source || typeof source !== 'object') return null;
  const address = source as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const road = text(address.road) || text(address.pedestrian) || text(address.footway);
  const houseNumber = text(address.house_number);
  const name = text(record.name);
  // Nominatim files the containing hromada under `city`, so for a village or hamlet the settlement the
  // record is about is `address[addresstype]`, not the first settlement key.
  const addresstype = text(record.addresstype);
  const ownSettlement = (SETTLEMENT_KEYS as readonly string[]).includes(addresstype) ? text(address[addresstype]) : '';
  const settlement = ownSettlement || SETTLEMENT_KEYS.map((key) => text(address[key])).find(Boolean) || '';
  const city = CITY_KEYS.map((key) => text(address[key])).find(Boolean) ?? '';
  const locality = LOCALITY_KEYS.map((key) => text(address[key])).find(Boolean) ?? '';
  const state = text(address.state);

  const isStreet = record.addresstype === 'road';
  const main = isStreet ? (road || name)
    : name || (road ? `${road}${houseNumber ? `, ${houseNumber}` : ''}` : '') || settlement || locality || state;
  if (!main) return null;
  // For a settlement the region that separates equally named places is the oblast ("Львів, Автономна
  // Республіка Крим"); Nominatim's `city` field is unreliable there — it carries hromadas such as
  // "Семисотське сільське поселення". Inside a settlement, the city is what pins the address down.
  const isSettlement = SETTLEMENT_KEYS.some((key) => text(address[key]) === main);
  const region = (isSettlement ? '' : city) || (state !== main ? state : '');
  const tail = region !== main ? region : '';
  const label = tail ? `${main}, ${tail}` : main;
  if (label.length <= MAX_SUGGESTION_LABEL_LENGTH) return label;
  // Cut the place name, never the city: without the city two equally named places look identical again.
  if (!tail) return `${main.slice(0, MAX_SUGGESTION_LABEL_LENGTH - 1)}…`;
  const overflow = label.length - MAX_SUGGESTION_LABEL_LENGTH;
  return `${main.slice(0, Math.max(1, main.length - overflow - 1))}…, ${tail}`;
}

export function parseNominatimSuggestions(payload: unknown): PlaceSuggestion[] {
  if (!Array.isArray(payload)) throw new GeocodingUnavailableError('Geocoder returned an invalid response');
  const suggestions = payload.flatMap((item): PlaceSuggestion[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const displayName = typeof record.display_name === 'string' ? record.display_name.trim() : '';
    const label = shortLabel(record) ?? displayName;
    const latitude = typeof record.lat === 'string' || typeof record.lat === 'number' ? Number(record.lat) : NaN;
    const longitude = typeof record.lon === 'string' || typeof record.lon === 'number' ? Number(record.lon) : NaN;
    const providerId = record.place_id === undefined ? '' : String(record.place_id);
    if (!label || !providerId || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
    return [{ label, latitude, longitude, providerId }];
  });
  // One address often resolves to several OSM elements whose labels collapse to the same text, and the
  // picker compares rows by eye: two identical strings are not two choices, so keep the provider's best hit.
  const seen = new Set<string>();
  return suggestions.filter((place) => {
    const key = place.label.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Photon returns GeoJSON, with OSM provenance in `properties` and WGS84 [lon, lat] geometry. */
export function parsePhotonSuggestions(payload: unknown): PlaceSuggestion[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { features?: unknown }).features)) {
    throw new GeocodingUnavailableError('Geocoder returned an invalid response');
  }
  const features = (payload as { features: unknown[] }).features;
  const suggestions = features.flatMap((feature): PlaceSuggestion[] => {
    if (!feature || typeof feature !== 'object') return [];
    const item = feature as Record<string, unknown>;
    const rawProperties = item.properties;
    const rawGeometry = item.geometry;
    if (!rawProperties || typeof rawProperties !== 'object' || !rawGeometry || typeof rawGeometry !== 'object') return [];
    const properties = rawProperties as Record<string, unknown>;
    const geometry = rawGeometry as Record<string, unknown>;
    const coordinates = geometry.coordinates;
    const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
    if (text(properties.countrycode).toLowerCase() !== 'ua' || geometry.type !== 'Point'
      || !Array.isArray(coordinates) || coordinates.length < 2) return [];
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    const osmType = text(properties.osm_type);
    const osmId = properties.osm_id;
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(latitude) || Math.abs(latitude) > 90
      || !osmType || (typeof osmId !== 'string' && typeof osmId !== 'number')) return [];

    const name = text(properties.name);
    const street = text(properties.street);
    const houseNumber = text(properties.housenumber);
    const city = text(properties.city) || text(properties.town) || text(properties.village);
    const district = text(properties.district);
    const state = text(properties.state);
    const main = street ? `${street}${houseNumber ? `, ${houseNumber}` : ''}` : name || city || district || state;
    if (!main) return [];
    const locality = city && city.toLowerCase() !== main.toLowerCase() ? city : '';
    const region = locality || (state && state.toLowerCase() !== main.toLowerCase() ? state : '');
    const labelParts = [main, region].filter((part, index, all) => part && all.findIndex((other) => other.toLowerCase() === part.toLowerCase()) === index);
    let label = labelParts.join(', ');
    if (label.length > MAX_SUGGESTION_LABEL_LENGTH) {
      const tail = region ? `, ${region}` : '';
      label = `${main.slice(0, Math.max(1, MAX_SUGGESTION_LABEL_LENGTH - tail.length - 1))}…${tail}`;
    }
    return [{ label, latitude, longitude, providerId: `${osmType.toLowerCase()}:${String(osmId)}` }];
  });
  const seen = new Set<string>();
  return suggestions.filter((place) => {
    const key = place.label.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const reverseCache = new Map<string, { at: number; place: PlaceSuggestion }>();
const reverseCacheTtlMs = 10 * 60_000;

/** Map-picker pans fire many nearby lookups; a ~100 m grid cache keeps providers within their rate limits. */
export async function reverseGeocode(latitude: number, longitude: number): Promise<PlaceSuggestion> {
  // Provider/endpoint/auth configuration can change during a process lifetime (and tests can switch
  // adapters); never serve a cached place from a different geocoder configuration. Hash the scope so
  // credentials in URL parameters or headers are not retained verbatim as Map keys.
  const scope = createHash('sha256').update(JSON.stringify([
    process.env.GEOCODING_PROVIDER ?? 'nominatim',
    process.env.GEOCODING_REVERSE_URL ?? '',
    process.env.GEOCODING_API_KEY ?? '',
  ])).digest('hex');
  const key = `${scope}:${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const hit = reverseCache.get(key);
  if (hit && Date.now() - hit.at < reverseCacheTtlMs) return hit.place;
  const place = await reverseGeocodeUncached(latitude, longitude);
  if (reverseCache.size > 500) reverseCache.delete(reverseCache.keys().next().value as string);
  reverseCache.set(key, { at: Date.now(), place });
  return place;
}

async function reverseGeocodeUncached(latitude: number, longitude: number): Promise<PlaceSuggestion> {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    throw new GeocodingUnavailableError('Reverse geocoding coordinates are invalid');
  }
  const endpoint = process.env.GEOCODING_REVERSE_URL;
  if (!endpoint) throw new GeocodingUnavailableError('Reverse geocoder is not configured');
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new GeocodingUnavailableError('Reverse geocoder endpoint is invalid'); }
  if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new GeocodingUnavailableError('Production geocoder must use HTTPS');
  }
  url.searchParams.set('lat', String(latitude));
  url.searchParams.set('lon', String(longitude));
  const photon = process.env.GEOCODING_PROVIDER === 'photon';
  if (!photon) {
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('accept-language', 'uk');
  }
  const headers = new Headers({ accept: 'application/json', 'user-agent': 'MARSHGO/1.0 (reverse geocoding)' });
  const apiKey = process.env.GEOCODING_API_KEY;
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!response?.ok) throw new GeocodingUnavailableError('Reverse geocoder request failed');
  const record = await response.json().catch(() => { throw new GeocodingUnavailableError('Reverse geocoder returned invalid JSON'); });
  const [place] = photon ? parsePhotonSuggestions(record) : parseNominatimSuggestions([record]);
  if (!place) throw new GeocodingUnavailableError('Reverse geocoder returned no valid place');
  return place;
}

/** Nominatim reads viewbox as left,top,right,bottom; without `bounded` it prefers rather than filters, so distant famous places survive. */
function biasViewbox({ latitude, longitude }: PlaceBias): string {
  const halfLatitude = 0.09;
  const halfLongitude = 0.13;
  return [longitude - halfLongitude, latitude + halfLatitude, longitude + halfLongitude, latitude - halfLatitude]
    .map((value) => value.toFixed(4))
    .join(',');
}

export async function suggestPlaces(query: string, bias?: PlaceBias): Promise<PlaceSuggestion[]> {
  const endpoint = process.env.GEOCODING_ENGINE_URL;
  if (!endpoint) throw new GeocodingUnavailableError();
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new GeocodingUnavailableError('Geocoder endpoint is invalid'); }
  const photon = process.env.GEOCODING_PROVIDER === 'photon';
  const forwardLocationBias = process.env.GEOCODING_FORWARD_LOCATION_BIAS === 'true';
  if (!photon && url.hostname === 'nominatim.openstreetmap.org') {
    throw new GeocodingUnavailableError('Public Nominatim does not support place autocomplete; configure Photon or an approved geocoder');
  }
  if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new GeocodingUnavailableError('Production geocoder must use HTTPS');
  }
  url.searchParams.set('q', query);
  if (photon) {
    url.searchParams.set('countrycode', 'UA');
    url.searchParams.set('bbox', UKRAINE_BOUNDS);
    url.searchParams.set('limit', '6');
  } else {
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('countrycodes', 'ua');
    url.searchParams.set('accept-language', 'uk');
    url.searchParams.set('limit', '6');
  }
  // Forwarding a user's location to a third-party autocomplete provider is optional.
  // Keep it disabled unless the deployment explicitly accepts that data flow.
  if (bias && forwardLocationBias) {
    if (photon) {
      url.searchParams.set('lat', String(bias.latitude));
      url.searchParams.set('lon', String(bias.longitude));
      url.searchParams.set('zoom', '12');
    } else {
      url.searchParams.set('viewbox', biasViewbox(bias));
    }
  }

  const headers = new Headers({ accept: 'application/json', 'user-agent': 'MARSHGO/1.0 (place search)' });
  const apiKey = process.env.GEOCODING_API_KEY;
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!response?.ok) throw new GeocodingUnavailableError('Geocoder request failed');
  // A truncated/garbage body is a provider failure, not a server bug: an uncaught
  // SyntaxError here would surface as HTTP 500 and hide the real outage.
  const payload = await response.json().catch(() => {
    throw new GeocodingUnavailableError('Geocoder returned invalid JSON');
  });
  return photon ? parsePhotonSuggestions(payload) : parseNominatimSuggestions(payload);
}

export type GeocoderReadiness =
  | { state: 'ok'; checkedAt: string; latencyMs: number; results: number }
  | { state: 'unreachable'; checkedAt: string; reason: string }
  | { state: 'misconfigured'; checkedAt: string; reason: string }
  | { state: 'unconfigured'; checkedAt: string };

/** A geocoder outage blocks API readiness only when the deployment requires autocomplete. */
export function isGeocoderReady(required: boolean, state: GeocoderReadiness['state']): boolean {
  return !required || state === 'ok';
}

const GEOCODER_READINESS_TTL_MS = 60_000;
let geocoderReadinessCache: { at: number; value: GeocoderReadiness } | undefined;

/** Tests and config reloads need a fresh probe instead of a cached answer. */
export function resetGeocoderReadinessCache(): void {
  geocoderReadinessCache = undefined;
}

/**
 * Health probe for a geocoder this deployment is expected to operate. It is
 * cached because container health checks run far more often than the provider
 * tolerates; a cached answer still turns any prolonged outage into a visible
 * `unreachable` state within a minute.
 */
export async function probeGeocoder(now = Date.now()): Promise<GeocoderReadiness> {
  if (geocoderReadinessCache && now - geocoderReadinessCache.at < GEOCODER_READINESS_TTL_MS) {
    return geocoderReadinessCache.value;
  }
  const checkedAt = new Date(now).toISOString();
  if (!process.env.GEOCODING_ENGINE_URL) {
    return { state: 'unconfigured', checkedAt };
  }
  const startedAt = Date.now();
  let value: GeocoderReadiness;
  try {
    // Container health checks allow 3 s; the provider itself may hang for the
    // full 5 s request timeout, so the readiness answer is bounded separately.
    const places = await Promise.race([
      suggestPlaces('Львів'),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new GeocodingUnavailableError('Geocoder probe timed out')), 1_500).unref()),
    ]);
    value = { state: 'ok', checkedAt, latencyMs: Date.now() - startedAt, results: places.length };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'geocoder probe failed';
    const misconfigured = !(error instanceof GeocodingUnavailableError)
      || /Public Nominatim|must use HTTPS|endpoint is invalid|not configured/i.test(reason);
    value = misconfigured
      ? { state: 'misconfigured', checkedAt, reason }
      : { state: 'unreachable', checkedAt, reason };
  }
  geocoderReadinessCache = { at: now, value };
  return value;
}
