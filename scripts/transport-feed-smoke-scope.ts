import type { CatalogEntry } from '../server/mobility/ukraineCatalog';

export type TransportFeedSmokeScope = 'all' | 'lviv-route' | 'ukraine-rail-route' | 'ukraine-intermodal-route';

export function parseTransportFeedSmokeScope(args: readonly string[]): TransportFeedSmokeScope {
  const values = args.filter((argument) => argument.startsWith('--scope='))
    .map((argument) => argument.slice('--scope='.length));
  if (values.length > 1) throw new Error('Specify --scope only once');
  const value = values[0] ?? 'all';
  if (value !== 'all' && value !== 'lviv-route' && value !== 'ukraine-rail-route' && value !== 'ukraine-intermodal-route') {
    throw new Error(`Unsupported transport feed smoke scope: ${value}`);
  }
  return value;
}

/** Restricts the route acceptance probe to Lviv GTFS schedule and vehicle-position sources. */
export function selectTransportFeedSmokeEntries(
  catalog: readonly CatalogEntry[],
  scope: TransportFeedSmokeScope,
): CatalogEntry[] {
  if (scope === 'all') return [...catalog];
  if (scope === 'ukraine-rail-route') {
    const railFeed = catalog.find((entry) => entry.city === 'Україна' && entry.sourceType === 'gtfs'
      && entry.feedUrl === 'https://jbb.ghsq.de/gtfs/ua-ukrzaliznytsya.gtfs.zip');
    if (!railFeed) throw new Error('Ukraine railway GTFS source is required for --scope=ukraine-rail-route');
    return [railFeed];
  }
  if (scope === 'ukraine-intermodal-route') {
    const sources = [
      'https://jbb.ghsq.de/gtfs/ua-ukrzaliznytsya.gtfs.zip',
      'https://files.mobilitydatabase.org/mdb-2946/latest.zip',
      'https://track.ua-gis.com/gtfs/lviv/static.zip',
      'https://jbb.ghsq.de/gtfs/ua-kyiv.gtfs.zip',
      'https://track.ua-gis.com/gtfs/uzhhorod/static.zip',
      'https://track.ua-gis.com/gtfs/stryi/static.zip',
    ];
    const selected = sources.map((feedUrl) => catalog.find((entry) => entry.sourceType === 'gtfs'
      && entry.access === 'open' && entry.feedUrl === feedUrl));
    if (selected.some((entry) => !entry)) throw new Error('Ukraine intermodal route acceptance requires the open rail, Odesa, Lviv, Kyiv, Uzhhorod and Stryi GTFS feeds');
    return selected as CatalogEntry[];
  }
  const staticFeed = catalog.find((entry) => entry.city === 'Львів'
    && entry.sourceType === 'gtfs' && entry.feedUrl === 'https://track.ua-gis.com/gtfs/lviv/static.zip');
  const vehiclePositions = catalog.find((entry) => entry.city === 'Львів'
    && entry.sourceType === 'gtfs_rt' && entry.feedUrl === 'https://track.ua-gis.com/gtfs/lviv/vehicle_position');
  if (!staticFeed || !vehiclePositions) throw new Error('Lviv static GTFS and vehicle-position sources are required for --scope=lviv-route');
  return [staticFeed, vehiclePositions];
}
