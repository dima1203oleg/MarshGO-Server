import { bboxContains, type Bbox } from './types';

/** Transport modes a feed can actually evidence through `last_report.counts`. */
export type TileServiceKind = 'bus' | 'marshrutka' | 'tram' | 'trolleybus' | 'metro' | 'suburban' | 'train' | 'city_train' | 'funicular' | 'ferry';

export interface TransportTileDefinition {
  id: string;
  /** `mobility_providers.provider_type` values that can serve this tile. */
  providerTypes: string[];
  /** Narrows public-transit providers by what their feeds actually contain. */
  service?: TileServiceKind;
  /** Nationwide tiles match sources whose city is exactly "Україна"; scoped tiles must not. */
  nationwide?: boolean;
}

/** A registry row as read by the provider-tile endpoint (health is resolved by the caller). */
export interface TransportTileProviderRow {
  name: string;
  city: string;
  provider_type: string;
  source_type: string;
  last_report: { bbox?: Bbox; counts?: Record<string, number> } | null;
}

export interface TransportTileProvider {
  id: string;
  name: string;
  available: true;
  cities: string[];
  sources: string[];
  services: string[];
}

/** Tiles shown to a passenger. A tile with no serving source stays in the list with an empty provider array. */
export const transportTileDefinitions: readonly TransportTileDefinition[] = [
  { id: 'carpool', providerTypes: ['carpool'] }, { id: 'taxi', providerTypes: ['taxi'] }, { id: 'carsharing', providerTypes: ['carsharing'] },
  { id: 'car_rental', providerTypes: [] }, { id: 'transfer', providerTypes: [] },
  { id: 'bus', providerTypes: ['public_transit'], service: 'bus', nationwide: false }, { id: 'marshrutka', providerTypes: ['public_transit'], service: 'marshrutka', nationwide: false },
  { id: 'trolleybus', providerTypes: ['public_transit'], service: 'trolleybus', nationwide: false }, { id: 'tram', providerTypes: ['public_transit'], service: 'tram', nationwide: false }, { id: 'metro', providerTypes: ['public_transit'], service: 'metro', nationwide: false },
  { id: 'train', providerTypes: ['public_transit'], service: 'train', nationwide: true }, { id: 'suburban_train', providerTypes: ['public_transit'], service: 'suburban', nationwide: true },
  { id: 'city_train', providerTypes: ['public_transit'], service: 'city_train', nationwide: false }, { id: 'funicular', providerTypes: ['public_transit'], service: 'funicular', nationwide: false },
  { id: 'intercity_bus', providerTypes: ['public_transit'], service: 'bus', nationwide: true },
  { id: 'bike', providerTypes: ['bike', 'ebike'] }, { id: 'scooter', providerTypes: ['scooter'] }, { id: 'moped', providerTypes: ['moped'] },
  { id: 'plane', providerTypes: [] }, { id: 'ferry', providerTypes: ['public_transit'], service: 'ferry', nationwide: false }, { id: 'walk', providerTypes: [] },
];

const serviceCountKey = /^(routes|vehicles)_(bus|marshrutka|tram|trolleybus|metro|suburban|train|city_train|funicular|ferry)$/;

/**
 * Services a feed has actually been observed to contain. Only a validated probe count counts as evidence:
 * a source name, an adapter, or a URL is not availability, so an unprobed or unreachable feed yields no service.
 */
export function providerServices(report: { counts?: Record<string, number> } | null | undefined): Set<TileServiceKind> {
  return new Set(Object.entries(report?.counts ?? {})
    .filter(([key, count]) => count > 0 && serviceCountKey.test(key))
    .map(([key]) => key.slice(key.indexOf('_') + 1) as TileServiceKind));
}

/**
 * Registry rows → providers per transport tile for one optional search point.
 * Connection state is the caller's decision; every row here must already be usable (enabled and healthy/degraded).
 * Grouping is by operator name so several feeds of one city operator stay a single entry.
 */
export function selectTileProviders(input: {
  tile: TransportTileDefinition;
  rows: readonly TransportTileProviderRow[];
  lat: number | null;
  lon: number | null;
}): TransportTileProvider[] {
  const { tile, rows, lat, lon } = input;
  const entries = new Map<string, { id: string; name: string; available: true; cities: Set<string>; sources: Set<string>; services: Set<string> }>();
  for (const row of rows) {
    if (!tile.providerTypes.includes(row.provider_type)) continue;
    const services = providerServices(row.last_report);
    if (tile.service && !services.has(tile.service)) continue;
    const nationwide = row.city === 'Україна';
    if (tile.nationwide !== undefined && tile.nationwide !== nationwide) continue;
    const box = row.last_report?.bbox;
    if (lat !== null && lon !== null && !nationwide && (!box || !bboxContains(box, lon, lat))) continue;
    const operator = row.name.split(' — ')[0];
    const entry = entries.get(operator) ?? { id: `${tile.id}:${operator}`, name: operator, available: true as const, cities: new Set<string>(), sources: new Set<string>(), services: new Set<string>() };
    entry.cities.add(row.city); entry.sources.add(row.source_type); services.forEach((service) => entry.services.add(service));
    entries.set(operator, entry);
  }
  return [...entries.values()].map((entry) => ({ id: entry.id, name: entry.name, available: entry.available, cities: [...entry.cities], sources: [...entry.sources], services: [...entry.services] }));
}
