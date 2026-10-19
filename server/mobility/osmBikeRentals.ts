/** OSM bicycle rental parsing and conservative provider normalization. */
export interface OsmBikeRentalFeature {
  type: 'Feature';
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

export interface NormalizedOsmBikeRental {
  source: 'osm';
  externalId: string;
  objectType: 'node' | 'way' | 'relation' | 'unknown';
  providerId: 'bikenow' | 'veliki_ua' | 'nextbike_ua' | 'bicycle_operator_unknown';
  networkId: string | null;
  name: string | null;
  operator: string | null;
  network: string | null;
  brand: string | null;
  reference: string | null;
  refGbfs: string | null;
  rentalModel: 'STATION_BASED' | 'STAFFED' | 'UNKNOWN';
  capacity: number | null;
  openingHours: string | null;
  access: string | null;
  website: string | null;
  phone: string | null;
  city: string | null;
  postcode: string | null;
  region: string | null;
  address: string | null;
  rentalType: 'docking_station' | 'dropoff_point' | 'shop' | 'unknown';
  geometry: Record<string, unknown>;
  rawTags: Record<string, unknown>;
  pickupAllowed: null;
  dropoffAllowed: null;
  availability: 'UNKNOWN';
}

const value = (props: Record<string, unknown>, key: string): string | null => typeof props[key] === 'string' && (props[key] as string).trim() ? (props[key] as string).trim() : null;
const boolishYes = (raw: unknown) => raw === 'yes' || raw === 'designated' || raw === 'official';

export function isBicycleRentalTags(tags: Record<string, unknown>): boolean {
  const amenity = tags.amenity;
  if (amenity === 'bicycle_rental') return true;
  if (['docking_station', 'dropoff_point', 'shop'].includes(String(tags.bicycle_rental))) return true;
  if (tags.shop === 'rental' && ['bicycle', 'bicycles', 'bike'].includes(String(tags.rental))) return true;
  return tags.shop === 'bicycle' && boolishYes(tags['service:bicycle:rental']);
}

export function resolveBicycleProvider(tags: Record<string, unknown>): { providerId: NormalizedOsmBikeRental['providerId']; networkId: string | null } {
  const aliases = [tags.network, tags.operator, tags.brand]
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/giu, ' ').trim());
  const website = typeof tags.website === 'string' ? tags.website : tags['contact:website'];
  const host = typeof website === 'string' ? (() => { try { const raw = website.trim(); return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } })() : '';
  const matchesDomain = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (aliases.some((alias) => ['bikenow', 'bike now', 'bikenow ukraine', 'байкноу', 'байк нау'].includes(alias)) || matchesDomain('bikenow.com.ua')) {
    return { providerId: 'bikenow', networkId: null };
  }
  if (aliases.some((alias) => ['veliki', 'veliki ua', 'велики ua'].includes(alias)) || matchesDomain('veliki.ua')) {
    return { providerId: 'veliki_ua', networkId: null };
  }
  if (aliases.some((alias) => ['nextbike', 'next bike', 'nextbike ua', 'nextbike ukraine', 'тов некстбайк україна', 'тов nextbike україна'].includes(alias))) {
    return { providerId: 'nextbike_ua', networkId: null };
  }
  // Provider identity alone does not prove station-to-station return compatibility.
  return { providerId: 'bicycle_operator_unknown', networkId: null };
}

function pointOf(geometry: OsmBikeRentalFeature['geometry']): boolean {
  return Boolean(geometry && ['Point', 'Polygon', 'MultiPolygon', 'LineString', 'MultiLineString'].includes(String(geometry.type)) && Array.isArray(geometry.coordinates));
}

export function normalizeOsmBikeRental(feature: OsmBikeRentalFeature): NormalizedOsmBikeRental | null {
  const tags = feature.properties;
  if (!tags || !isBicycleRentalTags(tags) || !pointOf(feature.geometry)) return null;
  const rawId = String(feature.id ?? tags['@id'] ?? '');
  if (!rawId) return null;
  const match = /^(node|way|relation)[/:](\d+)$/.exec(rawId);
  const compactMatch = /^([nwr])(\d+)$/.exec(rawId);
  const compactType = compactMatch?.[1] === 'n' ? 'node' : compactMatch?.[1] === 'w' ? 'way' : compactMatch?.[1] === 'r' ? 'relation' : undefined;
  const objectType = (match?.[1] ?? compactType) as NormalizedOsmBikeRental['objectType'] | undefined;
  const externalId = match ? `${match[1]}/${match[2]}` : compactMatch && compactType ? `${compactType}/${compactMatch[2]}` : rawId;
  const provider = resolveBicycleProvider(tags);
  const rawCapacity = Number(tags.capacity);
  const rentalType = tags.bicycle_rental === 'docking_station' ? 'docking_station'
    : tags.bicycle_rental === 'dropoff_point' ? 'dropoff_point'
      : tags.bicycle_rental === 'shop' || tags.shop === 'rental' || tags.shop === 'bicycle' ? 'shop'
        : 'unknown';
  const rentalModel = rentalType === 'docking_station' ? 'STATION_BASED'
    : rentalType === 'shop' ? 'STAFFED' : 'UNKNOWN';
  const address = [tags['addr:street'], tags['addr:housenumber'], tags['addr:unit']].filter((part) => typeof part === 'string').join(', ') || null;
  const geometry = feature.geometry as Record<string, unknown>;
  return {
    source: 'osm', externalId, objectType: objectType ?? 'unknown', ...provider,
    name: value(tags, 'name'), operator: value(tags, 'operator'), network: value(tags, 'network'), brand: value(tags, 'brand'),
    reference: value(tags, 'ref'), refGbfs: value(tags, 'ref:gbfs'), rentalModel,
    capacity: Number.isInteger(rawCapacity) && rawCapacity >= 0 ? rawCapacity : null,
    openingHours: value(tags, 'opening_hours'), access: value(tags, 'access'), website: value(tags, 'website') ?? value(tags, 'contact:website'),
    phone: value(tags, 'contact:phone') ?? value(tags, 'phone'), city: value(tags, 'addr:city') ?? value(tags, 'addr:town') ?? value(tags, 'addr:village'),
    postcode: value(tags, 'addr:postcode'), region: value(tags, 'addr:state') ?? value(tags, 'addr:region'), address,
    rentalType, geometry, rawTags: { ...tags }, pickupAllowed: null, dropoffAllowed: null, availability: 'UNKNOWN',
  };
}

/** GeoJSON Text Sequence (one Feature per line), emitted by `osmium export -f geojsonseq`. */
export function parseOsmFeatureSequence(text: string): OsmBikeRentalFeature[] {
  const features: OsmBikeRentalFeature[] = [];
  const recordSeparator = String.fromCharCode(0x1e);
  for (const line of text.split(/\r?\n/)) {
    const json = (line.startsWith(recordSeparator) ? line.slice(1) : line).trim();
    if (!json) continue;
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { continue; }
    if (!raw || typeof raw !== 'object' || (raw as OsmBikeRentalFeature).type !== 'Feature') continue;
    features.push(raw as OsmBikeRentalFeature);
  }
  return features;
}

export function parseOsmGeoJsonSequence(text: string): NormalizedOsmBikeRental[] {
  return parseOsmFeatureSequence(text).flatMap((feature) => {
    const normalized = normalizeOsmBikeRental(feature);
    return normalized ? [normalized] : [];
  });
}
