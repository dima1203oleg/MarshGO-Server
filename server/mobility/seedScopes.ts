import type { CatalogEntry } from './ukraineCatalog';

/** Narrow, auditable scope for activating only currently verified municipal live feeds. */
const VERIFIED_LIVE_SOURCE_REFS = new Set([
  'https://data.gov.ua/dataset/real-transport-dnipro', // Dnipro iCity JSON; strict health gate disables malformed-coordinate tails
  'https://data.gov.ua/dataset/00d2939e-fe96-4099-9b0d-b8f6f9ce1399', // Uzhhorod Dozor
  'https://data.gov.ua/dataset/1ba10dca-79f2-4dc1-92c4-2e92ee61df12', // Kamianske Dozor
  'https://data.gov.ua/dataset/a41488fb-bf97-4f12-8ee3-87817a4c50bd', // Rivne live vehicle positions
]);

/** Exact official GTFS-RT source whose endpoint currently includes a small stale tail. */
const VERIFIED_GTFS_RT_SOURCE_REFS = new Set([
  'https://data.gov.ua/dataset/508a77c2-c233-4e09-92ba-f3976d545822', // Ivano-Frankivsk
]);

/** Exact municipal static GTFS source with current service and official CC-BY evidence. */
const VERIFIED_GTFS_SCHEDULE_SOURCE_REFS = new Set([
  'https://data.gov.ua/dataset/lviv-public-transport-gtfs-real-time/resource/eb31a65b-a22b-44b1-83ce-41add24ae652; https://mobilitydatabase.org/feeds/gtfs/mdb-2374', // Lviv, official CC BY 4.0 static resource
  'https://data.gov.ua/dataset/ac81e2c1-5ea9-4512-811f-2b3d377fd527; https://data.gov.ua/dataset/7870b358-f285-4c60-a29e-574a44e4a728', // Ivano-Frankivsk
  'https://data.gov.ua/dataset/37-111; https://mobilitydatabase.org/feeds/gtfs/mdb-2931', // Uzhhorod
  'https://data.loda.gov.ua/dataset/7b9ddbc6-df4b-4d2e-9567-af66ede840cc; https://mobilitydatabase.org/feeds/gtfs/mdb-2932', // Stryi
  'https://data.gov.ua/dataset/96128887-4f36-4c19-a96e-5d4765fade16; https://mobilitydatabase.org/feeds/gtfs/mdb-3230; https://transit.land/data/feeds/f-u8v-kyivpastrans', // Kyivpastrans, licensed official daily mirror
]);
const VERIFIED_KYIV_GTFS_SOURCE_REF = 'https://data.gov.ua/dataset/96128887-4f36-4c19-a96e-5d4765fade16; https://mobilitydatabase.org/feeds/gtfs/mdb-3230; https://transit.land/data/feeds/f-u8v-kyivpastrans';
const VERIFIED_LVIV_GTFS_SOURCE_REF = 'https://data.gov.ua/dataset/lviv-public-transport-gtfs-real-time/resource/eb31a65b-a22b-44b1-83ce-41add24ae652; https://mobilitydatabase.org/feeds/gtfs/mdb-2374';
const VERIFIED_IVANO_FRANKIVSK_GTFS_SOURCE_REF = 'https://data.gov.ua/dataset/ac81e2c1-5ea9-4512-811f-2b3d377fd527; https://data.gov.ua/dataset/7870b358-f285-4c60-a29e-574a44e4a728';
const VERIFIED_STRYI_UZHHOROD_GTFS_SOURCE_REFS = new Set([
  'https://data.loda.gov.ua/dataset/7b9ddbc6-df4b-4d2e-9567-af66ede840cc; https://mobilitydatabase.org/feeds/gtfs/mdb-2932',
  'https://data.gov.ua/dataset/37-111; https://mobilitydatabase.org/feeds/gtfs/mdb-2931',
]);

/** Published snapshot fails coordinates and cross-table/geometry checks; retained for explicit rejection tests. */
const REJECTED_GTFS_SOURCE_REFS = new Set([
  'https://data.gov.ua/dataset/ea47d118-9085-4695-9202-1839acd7e0c5', // Zhmerinka, rejected 2026-11-13 pending corrected publisher snapshot
  'data.gov.ua:Виконавчий комітет Чорноморської міської ради', // Chornomorsk GTFS snapshot is frozen at 2019-09 and must not be seeded as current service
]);
const CANDIDATE_GTFS_CSV_SOURCE_REFS = new Set([
  'https://data.gov.ua/dataset/ea47d118-9085-4695-9202-1839acd7e0c5',
]);
const CANDIDATE_GTFS_BUNDLE_SOURCE_REFS = new Set([
  'https://data.gov.ua/dataset/3d741a97-1876-4edf-90e2-0a5eff85026e; https://data.gov.ua/dataset/99a26b8f-263f-492f-9302-c41ff9bc950f; https://data.gov.ua/dataset/09ed4f56-a119-43eb-8b98-bad814ade8d4', // Horishni Plavni, three official CC BY component packages
]);
const CANDIDATE_LIVE_JSON_SOURCE_REFS = new Set([
  'https://data.gov.ua/dataset/1d0f5343-2dca-4170-9d70-6e97afbe3852', // Korosten, live positions only; freshness is rechecked at seed time
  'data.gov.ua:Управління транспорту Івано-Франківська', // Dozor positions; opt-in candidate scope is strict and never claims schedule routing
]);

export function selectUkraineSeedEntries(scope: string, catalog: CatalogEntry[]): CatalogEntry[] | null {
  if (scope === 'all') return catalog.filter((entry) => !REJECTED_GTFS_SOURCE_REFS.has(entry.sourceRef));
  if (scope === '--verified-live') {
    return catalog.filter((entry) => entry.sourceType === 'json' && VERIFIED_LIVE_SOURCE_REFS.has(entry.sourceRef));
  }
  if (scope === '--verified-gtfs-rt') {
    return catalog.filter((entry) => entry.sourceType === 'gtfs_rt' && VERIFIED_GTFS_RT_SOURCE_REFS.has(entry.sourceRef));
  }
  if (scope === '--verified-gtfs-schedule') {
    return catalog.filter((entry) => entry.sourceType === 'gtfs' && VERIFIED_GTFS_SCHEDULE_SOURCE_REFS.has(entry.sourceRef));
  }
  if (scope === '--verified-kyiv-gtfs-schedule') {
    return catalog.filter((entry) => entry.sourceType === 'gtfs' && entry.city === 'Київ' && entry.sourceRef === VERIFIED_KYIV_GTFS_SOURCE_REF);
  }
  if (scope === '--verified-lviv-gtfs-schedule') {
    return catalog.filter((entry) => entry.sourceType === 'gtfs' && entry.city === 'Львів' && entry.sourceRef === VERIFIED_LVIV_GTFS_SOURCE_REF);
  }
  if (scope === '--verified-ivano-frankivsk-gtfs-schedule') {
    return catalog.filter((entry) => entry.sourceType === 'gtfs' && entry.city === 'Івано-Франківськ' && entry.sourceRef === VERIFIED_IVANO_FRANKIVSK_GTFS_SOURCE_REF);
  }
  if (scope === '--verified-stryi-uzhhorod-gtfs-schedule') {
    return catalog.filter((entry) => entry.sourceType === 'gtfs' && VERIFIED_STRYI_UZHHOROD_GTFS_SOURCE_REFS.has(entry.sourceRef));
  }
  if (scope === '--candidate-gtfs-csv') {
    return catalog.filter((entry) => entry.sourceType === 'gtfs' && CANDIDATE_GTFS_CSV_SOURCE_REFS.has(entry.sourceRef) && !REJECTED_GTFS_SOURCE_REFS.has(entry.sourceRef));
  }
  if (scope === '--candidate-gtfs-bundle') {
    return catalog.filter((entry) => entry.sourceType === 'gtfs' && CANDIDATE_GTFS_BUNDLE_SOURCE_REFS.has(entry.sourceRef));
  }
  if (scope === '--candidate-live-json') {
    return catalog.filter((entry) => entry.sourceType === 'json' && CANDIDATE_LIVE_JSON_SOURCE_REFS.has(entry.sourceRef));
  }
  if (scope === '--kyiv-metro') {
    return catalog.filter((entry) => entry.city === 'Київ' && entry.name.toLocaleLowerCase('uk-UA').includes('метро'));
  }
  return null;
}

export function enabledStatusForHealth(health: 'healthy' | 'degraded' | 'offline', strict: boolean): 'enabled' | 'disabled' {
  if (health === 'offline' || (strict && health !== 'healthy')) return 'disabled';
  return 'enabled';
}
