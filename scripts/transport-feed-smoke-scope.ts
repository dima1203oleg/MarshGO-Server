import type { CatalogEntry } from '../server/mobility/ukraineCatalog';

export type TransportFeedSmokeScope = 'all' | 'lviv-route';

export function parseTransportFeedSmokeScope(args: readonly string[]): TransportFeedSmokeScope {
  const values = args.filter((argument) => argument.startsWith('--scope='))
    .map((argument) => argument.slice('--scope='.length));
  if (values.length > 1) throw new Error('Specify --scope only once');
  const value = values[0] ?? 'all';
  if (value !== 'all' && value !== 'lviv-route') throw new Error(`Unsupported transport feed smoke scope: ${value}`);
  return value;
}

/** Restricts the route acceptance probe to Lviv GTFS schedule and vehicle-position sources. */
export function selectTransportFeedSmokeEntries(
  catalog: readonly CatalogEntry[],
  scope: TransportFeedSmokeScope,
): CatalogEntry[] {
  if (scope === 'all') return [...catalog];
  const staticFeed = catalog.find((entry) => entry.city === 'Львів'
    && entry.sourceType === 'gtfs' && entry.feedUrl === 'https://track.ua-gis.com/gtfs/lviv/static.zip');
  const vehiclePositions = catalog.find((entry) => entry.city === 'Львів'
    && entry.sourceType === 'gtfs_rt' && entry.feedUrl === 'https://track.ua-gis.com/gtfs/lviv/vehicle_position');
  if (!staticFeed || !vehiclePositions) throw new Error('Lviv static GTFS and vehicle-position sources are required for --scope=lviv-route');
  return [staticFeed, vehiclePositions];
}
