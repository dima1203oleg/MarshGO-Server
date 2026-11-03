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
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'uk');
  const headers = new Headers({ accept: 'application/json', 'user-agent': 'MARSHGO/1.0 (reverse geocoding)' });
  const apiKey = process.env.GEOCODING_API_KEY;
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!response?.ok) throw new GeocodingUnavailableError('Reverse geocoder request failed');
  const record = await response.json().catch(() => { throw new GeocodingUnavailableError('Reverse geocoder returned invalid JSON'); });
  const [place] = parseNominatimSuggestions([record]);
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
  if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new GeocodingUnavailableError('Production geocoder must use HTTPS');
  }
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'ua');
  url.searchParams.set('accept-language', 'uk');
  url.searchParams.set('limit', '6');
  if (bias) url.searchParams.set('viewbox', biasViewbox(bias));

  const headers = new Headers({ accept: 'application/json', 'user-agent': 'MARSHGO/1.0 (place search)' });
  const apiKey = process.env.GEOCODING_API_KEY;
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!response?.ok) throw new GeocodingUnavailableError('Geocoder request failed');
  return parseNominatimSuggestions(await response.json());
}
