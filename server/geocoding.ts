export type PlaceSuggestion = {
  label: string;
  latitude: number;
  longitude: number;
  providerId: string;
};

export class GeocodingUnavailableError extends Error {
  constructor(message = 'Geocoding service is not configured') { super(message); }
}

export function parseNominatimSuggestions(payload: unknown): PlaceSuggestion[] {
  if (!Array.isArray(payload)) throw new GeocodingUnavailableError('Geocoder returned an invalid response');
  return payload.flatMap((item): PlaceSuggestion[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const label = typeof record.display_name === 'string' ? record.display_name.trim() : '';
    const latitude = typeof record.lat === 'string' || typeof record.lat === 'number' ? Number(record.lat) : NaN;
    const longitude = typeof record.lon === 'string' || typeof record.lon === 'number' ? Number(record.lon) : NaN;
    const providerId = record.place_id === undefined ? '' : String(record.place_id);
    if (!label || !providerId || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
    return [{ label, latitude, longitude, providerId }];
  });
}

export function parsePhotonSuggestions(payload: unknown): PlaceSuggestion[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).features)) {
    throw new GeocodingUnavailableError('Photon returned an invalid response');
  }
  return (payload as { features: unknown[] }).features.flatMap((item): PlaceSuggestion[] => {
    if (!item || typeof item !== 'object') return [];
    const feature = item as Record<string, unknown>;
    const properties = feature.properties && typeof feature.properties === 'object'
      ? feature.properties as Record<string, unknown>
      : {};
    const geometry = feature.geometry && typeof feature.geometry === 'object'
      ? feature.geometry as Record<string, unknown>
      : {};
    const coordinates = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    const id = properties.osm_type && properties.osm_id ? `${properties.osm_type}:${properties.osm_id}` : '';
    const countryCode = typeof properties.countrycode === 'string' ? properties.countrycode.toUpperCase() : '';
    const label = [properties.name, properties.city, properties.state, properties.country]
      .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
      .filter((part, index, values) => values.indexOf(part) === index)
      .join(', ');
    if (countryCode !== 'UA' || !id || !label || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
    return [{ label, latitude, longitude, providerId: id }];
  });
}

function parseProviderSuggestions(payload: unknown): PlaceSuggestion[] {
  return process.env.GEOCODING_PROVIDER === 'photon'
    ? parsePhotonSuggestions(payload)
    : parseNominatimSuggestions(payload);
}

const reverseCache = new Map<string, { at: number; place: PlaceSuggestion }>();
const reverseCacheTtlMs = 10 * 60_000;

/** Map-picker pans fire many nearby lookups; a ~100 m grid cache keeps providers within their rate limits. */
export async function reverseGeocode(latitude: number, longitude: number): Promise<PlaceSuggestion> {
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
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
  if (process.env.GEOCODING_PROVIDER === 'photon') url.searchParams.set('limit', '1');
  else {
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('accept-language', 'uk');
  }
  const headers = new Headers({ accept: 'application/json', 'user-agent': 'MARSHGO/1.0 (reverse geocoding)' });
  const apiKey = process.env.GEOCODING_API_KEY;
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!response?.ok) throw new GeocodingUnavailableError('Reverse geocoder request failed');
  const record = await response.json().catch(() => { throw new GeocodingUnavailableError('Reverse geocoder returned invalid JSON'); });
  const [place] = parseProviderSuggestions(process.env.GEOCODING_PROVIDER === 'photon' ? record : [record]);
  if (!place) throw new GeocodingUnavailableError('Reverse geocoder returned no valid place');
  return place;
}

export async function suggestPlaces(query: string): Promise<PlaceSuggestion[]> {
  const endpoint = process.env.GEOCODING_ENGINE_URL;
  if (!endpoint) throw new GeocodingUnavailableError();
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new GeocodingUnavailableError('Geocoder endpoint is invalid'); }
  if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new GeocodingUnavailableError('Production geocoder must use HTTPS');
  }
  url.searchParams.set('q', query);
  if (process.env.GEOCODING_PROVIDER === 'photon') {
    url.searchParams.set('limit', '6');
    url.searchParams.set('bbox', '22,44,41,53');
  } else {
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('countrycodes', 'ua');
    url.searchParams.set('accept-language', 'uk');
    url.searchParams.set('limit', '6');
  }

  const headers = new Headers({ accept: 'application/json', 'user-agent': 'MARSHGO/1.0 (place search)' });
  const apiKey = process.env.GEOCODING_API_KEY;
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!response?.ok) throw new GeocodingUnavailableError('Geocoder request failed');
  return parseProviderSuggestions(await response.json());
}
