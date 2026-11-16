import type { CatalogEntry } from '../server/mobility/ukraineCatalog';

export type TransportFeedSmokeScope = 'all' | 'lviv-route' | 'lviv-budget-diagnostic'
  | 'lviv-north-baseline-diagnostic' | 'lviv-north-trip-fairness-diagnostic'
  | 'lviv-north-final-arrival-diagnostic' | 'ukraine-rail-route';

export interface RouteSmokeAcceptanceCase {
  count: number;
  searchTruncated: boolean;
  resultLimitReached?: boolean;
  confirmedShapeGeometry?: boolean;
}

/** Require a real route and its promised evidence for focused transport acceptance scopes. */
export function routeSmokeAcceptancePassed(scope: TransportFeedSmokeScope, cases: readonly RouteSmokeAcceptanceCase[]): boolean {
  if (scope === 'lviv-route') {
    return cases.some((routeCase) => routeCase.count > 0 && !routeCase.searchTruncated);
  }
  if (scope === 'ukraine-rail-route') {
    return cases.some((routeCase) => routeCase.count > 0 && !routeCase.searchTruncated
      && routeCase.resultLimitReached === false && routeCase.confirmedShapeGeometry === true);
  }
  return true;
}

export function parseTransportFeedSmokeScope(args: readonly string[]): TransportFeedSmokeScope {
  const values = args.filter((argument) => argument.startsWith('--scope='))
    .map((argument) => argument.slice('--scope='.length));
  if (values.length > 1) throw new Error('Specify --scope only once');
  const value = values[0] ?? 'all';
  if (value !== 'all' && value !== 'lviv-route' && value !== 'lviv-budget-diagnostic'
    && value !== 'lviv-north-baseline-diagnostic' && value !== 'lviv-north-trip-fairness-diagnostic'
    && value !== 'lviv-north-final-arrival-diagnostic'
    && value !== 'ukraine-rail-route') {
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
  const staticFeed = catalog.find((entry) => entry.city === 'Львів'
    && entry.sourceType === 'gtfs' && entry.feedUrl === 'https://track.ua-gis.com/gtfs/lviv/static.zip');
  const vehiclePositions = catalog.find((entry) => entry.city === 'Львів'
    && entry.sourceType === 'gtfs_rt' && entry.feedUrl === 'https://track.ua-gis.com/gtfs/lviv/vehicle_position');
  if (!staticFeed || !vehiclePositions) throw new Error('Lviv static GTFS and vehicle-position sources are required for --scope=lviv-route');
  return [staticFeed, vehiclePositions];
}
