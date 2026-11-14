import type { CatalogEntry } from './ukraineCatalog';

export type MobilitySeedScope = 'all' | '--kyiv-metro' | '--kyiv-route-taxi-zelectra' | '--lviv' | '--regional-mirrors';

const regionalMirrorFeeds = new Set([
  'https://files.mobilitydatabase.org/mdb-2946/latest.zip',
  'https://files.mobilitydatabase.org/mdb-2945/latest.zip',
  'https://public.easyway.info/gps/rivne.json',
  'https://public.easyway.info/gps/chernivtsi.json',
  'https://public.easyway.info/gps/korosten.json',
]);
export type MobilityProviderStatus = 'enabled' | 'disabled' | 'paused';

/** New rows may be considered by the health monitor only after commercial access is validated. */
export function initialMobilityProviderStatus(accessValidated: boolean): MobilityProviderStatus {
  return accessValidated ? 'enabled' : 'disabled';
}

/** Select a narrow provider catalog before probing or updating the database. */
export function selectMobilitySeedEntries<T extends Pick<CatalogEntry, 'city' | 'name' | 'feedUrl'>>(
  catalog: readonly T[],
  scope: string,
): T[] | null {
  if (scope === 'all') return [...catalog];
  if (scope === '--kyiv-metro') {
    return catalog.filter((entry) => entry.city === 'Київ' && entry.name.toLocaleLowerCase('uk-UA').includes('метро'));
  }
  if (scope === '--kyiv-route-taxi-zelectra') {
    return catalog.filter((entry) => entry.city === 'Київ'
      && (entry.name === 'Київ — маршрутки (офіційна геометрія)'
        || entry.name === 'Zelectra — е-самокати (GBFS 3.0)'));
  }
  if (scope === '--lviv') return catalog.filter((entry) => entry.city === 'Львів');
  if (scope === '--regional-mirrors') return catalog.filter((entry) => regionalMirrorFeeds.has(entry.feedUrl));
  return null;
}
