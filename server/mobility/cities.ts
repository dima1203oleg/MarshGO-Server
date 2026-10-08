import type { Bbox } from './types';

export interface TransportCityProvider {
  name: string;
  city: string;
  source_type: string;
  license: string | null;
  source_ref: string | null;
  last_report: { bbox?: Bbox; counts?: Record<string, number> } | null;
}

const CITY_METADATA: Record<string, { id: string; timezone: string; sourceUrl: string }> = {
  Львів: { id: 'lviv', timezone: 'Europe/Kyiv', sourceUrl: 'https://opendata.city-adm.lviv.ua/en/dataset/lviv-public-transport-gtfs-real-time' },
  Київ: { id: 'kyiv', timezone: 'Europe/Kyiv', sourceUrl: 'https://data.gov.ua/dataset/96128887-4f36-4c19-a96e-5d4765fade16' },
};

function cityId(name: string): string {
  return (CITY_METADATA[name]?.id ?? name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) || 'unknown';
}

export function buildTransportCities(providers: TransportCityProvider[]) {
  const cities = new Map<string, {
    id: string; name: string; timezone: string; bbox: Bbox | null; modes: Set<string>;
    routeCount: number; stopCount: number; providers: Map<string, { name: string; sourceType: string; license: string | null; sourceRef: string | null }>;
    realtimeAvailable: boolean;
  }>();

  for (const provider of providers) {
    const meta = CITY_METADATA[provider.city];
    const id = cityId(provider.city);
    const city = cities.get(id) ?? {
      id, name: provider.city, timezone: meta?.timezone ?? 'Europe/Kyiv', bbox: null, modes: new Set<string>(),
      routeCount: 0, stopCount: 0, providers: new Map(), realtimeAvailable: false,
    };
    const report = provider.last_report;
    const bbox = report?.bbox;
    if (bbox) city.bbox = city.bbox ? [Math.min(city.bbox[0], bbox[0]), Math.min(city.bbox[1], bbox[1]), Math.max(city.bbox[2], bbox[2]), Math.max(city.bbox[3], bbox[3])] : [...bbox];
    if (provider.source_type === 'gtfs' || provider.source_type === 'geojson') {
      city.routeCount += report?.counts?.routes ?? Object.entries(report?.counts ?? {}).filter(([key]) => key.startsWith('routes_')).reduce((sum, [, count]) => sum + count, 0);
      city.stopCount += report?.counts?.stops ?? Object.entries(report?.counts ?? {}).filter(([key]) => key.startsWith('stops_')).reduce((sum, [, count]) => sum + count, 0);
      for (const [key, count] of Object.entries(report?.counts ?? {})) {
        const match = /^routes_(bus|marshrutka|trolleybus|tram|metro|train|suburban|city_train|funicular|ferry)$/.exec(key);
        if (match && count > 0) city.modes.add(match[1]);
      }
    }
    if (provider.source_type === 'gtfs_rt') city.realtimeAvailable = true;
    city.providers.set(`${provider.name}:${provider.source_type}`, {
      name: provider.name.split(' — ')[0], sourceType: provider.source_type, license: provider.license, sourceRef: provider.source_ref,
    });
    cities.set(id, city);
  }

  return [...cities.values()].filter((city) => city.bbox).map((city) => ({
    id: city.id, name: city.name, timezone: city.timezone, bbox: city.bbox, modes: [...city.modes].sort(),
    routeCount: city.routeCount, stopCount: city.stopCount, realtimeAvailable: city.realtimeAvailable,
    sourceUrl: CITY_METADATA[city.name]?.sourceUrl ?? null, licenses: [...new Set([...city.providers.values()].map((provider) => provider.license).filter((license): license is string => Boolean(license)))], providers: [...city.providers.values()],
  })).sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}
