/**
 * Open transport sources for Ukraine found by auditing the MobilityData Mobility Database catalog
 * (github.com/MobilityData/mobility-database-catalogs) and the GBFS systems list (github.com/MobilityData/gbfs),
 * then probing every URL (October 2026). Nothing here is invented: each entry has a catalogue reference.
 * `access` records what the audit found; sources that are not open are registered but never enabled.
 */
export interface CatalogEntry {
  name: string; city: string; providerType: 'public_transit' | 'scooter'; sourceType: 'gtfs' | 'gtfs_rt' | 'gbfs';
  feedUrl: string; access: 'open' | 'requires_credentials' | 'insecure_endpoint'; license?: string; updateFrequency?: string; coverage: string; sourceRef: string; priority?: number;
}

const lvivLicense = 'Open data portal of Lviv city (opendata.city-adm.lviv.ua)';
export const ukraineCatalog: CatalogEntry[] = [
  { name: 'Львівавтодор — розклад (GTFS)', city: 'Львів', providerType: 'public_transit', sourceType: 'gtfs', feedUrl: 'https://track.ua-gis.com/gtfs/lviv/static.zip', access: 'open', license: lvivLicense, updateFrequency: 'періодично (статичний розклад)', coverage: 'Громадський транспорт Львова: автобуси, трамваї', sourceRef: 'mdb:ua-lviv-lvivavtodor-gtfs-2374', priority: 10 },
  { name: 'Львівавтодор — realtime позиції (GTFS-RT)', city: 'Львів', providerType: 'public_transit', sourceType: 'gtfs_rt', feedUrl: 'https://track.ua-gis.com/gtfs/lviv/vehicle_position', access: 'open', license: lvivLicense, updateFrequency: 'реальний час (секунди)', coverage: 'Позиції транспорту Львова', sourceRef: 'mdb:ua-lviv-lvivavtodor-gtfs-rt-vp-2376', priority: 10 },
  { name: 'Львівавтодор — затримки (GTFS-RT)', city: 'Львів', providerType: 'public_transit', sourceType: 'gtfs_rt', feedUrl: 'https://track.ua-gis.com/gtfs/lviv/trip_updates', access: 'open', license: lvivLicense, updateFrequency: 'реальний час', coverage: 'Оновлення рейсів і затримки Львова', sourceRef: 'mdb:ua-lviv-lvivavtodor-gtfs-rt-tu-2375', priority: 20 },
  { name: 'Стрийська міська рада — розклад (GTFS)', city: 'Стрий', providerType: 'public_transit', sourceType: 'gtfs', feedUrl: 'https://track.ua-gis.com/gtfs/stryi/static.zip', access: 'open', updateFrequency: 'періодично', coverage: 'Міський транспорт Стрия', sourceRef: 'mdb:ua-stryi-gtfs-2932', priority: 10 },
  { name: 'Ужгородська міська рада — розклад (GTFS)', city: 'Ужгород', providerType: 'public_transit', sourceType: 'gtfs', feedUrl: 'https://track.ua-gis.com/gtfs/uzhhorod/static.zip', access: 'open', updateFrequency: 'періодично', coverage: 'Міський транспорт Ужгорода', sourceRef: 'mdb:ua-uzhhorod-gtfs-2931', priority: 10 },
  { name: 'inbus.ua — розклад (GTFS)', city: 'Україна', providerType: 'public_transit', sourceType: 'gtfs', feedUrl: 'https://gtfs.fsn1.your-objectstorage.com/feeds/gtfs.zip', access: 'open', updateFrequency: 'періодично', coverage: 'Міжміські автобуси (inbus.ua), фід невеликий — потребує перевірки покриття', sourceRef: 'mdb:ua-inbusua-gtfs-3044', priority: 50 },
  { name: '3electra — е-самокати (GBFS 3.0)', city: 'Київ', providerType: 'scooter', sourceType: 'gbfs', feedUrl: 'https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs', access: 'open', license: 'GBFS публічний фід оператора (умови уточнити у 3electra)', updateFrequency: 'майже реальний час', coverage: 'Е-самокати Києва, free-floating', sourceRef: 'gbfs-systems.csv:UA/3electra', priority: 10 },
  { name: 'Київ — розклад (GTFS)', city: 'Київ', providerType: 'public_transit', sourceType: 'gtfs', feedUrl: 'http://193.23.225.211:8002/export-gtfs-static', access: 'insecure_endpoint', license: 'CC BY 4.0', updateFrequency: 'періодично', coverage: 'Громадський транспорт Києва. Джерело доступне лише по http на IP-адресі, тому не підключається', sourceRef: 'mdb:ua-kyiv-gtfs-3230', priority: 10 },
  { name: 'Київ — realtime (GTFS-RT)', city: 'Київ', providerType: 'public_transit', sourceType: 'gtfs_rt', feedUrl: 'http://193.23.225.214:732/api/realtime', access: 'insecure_endpoint', license: 'CC BY 4.0', updateFrequency: 'реальний час', coverage: 'Realtime Києва. Лише http на IP-адресі, не підключається', sourceRef: 'mdb:ua-kiev-gtfs-rt-3231', priority: 10 },
  { name: 'Одеса — розклад (GTFS)', city: 'Одеса', providerType: 'public_transit', sourceType: 'gtfs', feedUrl: 'https://gw.x24.digital/api/od-all/gtfs/v1/download/static', access: 'requires_credentials', license: 'https://omr.gov.ua/ua/city/departments/dtks/open-data/', updateFrequency: 'періодично', coverage: 'Громадський транспорт Одеси. Потрібен ключ API (отримано HTTP 401)', sourceRef: 'mdb:ua-odesa-gtfs-2946', priority: 10 },
  { name: 'КП «Бучатранссервіс» — розклад (GTFS)', city: 'Буча', providerType: 'public_transit', sourceType: 'gtfs', feedUrl: 'https://gw.x24.digital/api/bu/gtfs/v1/download/static', access: 'requires_credentials', updateFrequency: 'періодично', coverage: 'Транспорт Бучі. Потрібен ключ API (отримано HTTP 401)', sourceRef: 'mdb:ua-bucha-gtfs-2945', priority: 10 },
];
