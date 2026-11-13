/**
 * MARSHGO Ukraine Multi-Region Transport Catalog
 * Comprehensive coverage across all 24 Oblasts of Ukraine + Kyiv City + AR Crimea
 * across all 12 Canonical Transport Modes.
 */

export const canonicalTransportTypes = [
  'bus',
  'marshrutka',
  'trolleybus',
  'tram',
  'metro',
  'carpool',
  'taxi',
  'train',
  'bike',
  'scooter',
  'carsharing',
  'transfer',
] as const;

export type CanonicalTransportTypeId = (typeof canonicalTransportTypes)[number];

export interface RegionalModeSource {
  name: string;
  type: 'GTFS' | 'GTFS_RT' | 'GBFS' | 'REST_API' | 'OPEN_DATA' | 'INTERNAL';
  url?: string;
  access: 'OPEN' | 'REQUIRES_KEY' | 'CONTRACT_ONLY';
  sourceRef?: string;
}

export interface RegionalModeAvailability {
  available: boolean;
  status: 'AVAILABLE' | 'NOT_AVAILABLE_IN_CITY' | 'REQUIRES_CONTRACT' | 'LIMITED';
  reason?: string | null;
  capabilities: string[];
  sources: RegionalModeSource[];
}

export interface UkraineOblast {
  id: string;
  name: string;
  capital: string;
  majorCities: string[];
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  transportModes: Record<CanonicalTransportTypeId, RegionalModeAvailability>;
}

// -----------------------------------------------------------------------------------------
// Helper source builders for shared nationwide/multiregional services
// -----------------------------------------------------------------------------------------

const carpoolSources: RegionalModeSource[] = [
  {
    name: 'MARSHGO Community Carpool Engine',
    type: 'INTERNAL',
    access: 'OPEN',
    sourceRef: 'marshgo:native-core',
  },
];

const trainSources: RegionalModeSource[] = [
  {
    name: 'Укрзалізниця — розклад поїздів (GTFS/ODbL)',
    type: 'GTFS',
    url: 'https://jbb.ghsq.de/gtfs/ua-ukrzaliznytsya.gtfs.zip',
    access: 'OPEN',
    sourceRef: 'github.com/jqueguiner/gtfs:ua-ukrzaliznytsya',
  },
  {
    name: 'Укрзалізниця — Офіційний розклад та e-квиток',
    type: 'REST_API',
    url: 'https://booking.uz.gov.ua',
    access: 'CONTRACT_ONLY',
    sourceRef: 'uz:official-ticketing',
  },
];

const intercityBusSources: RegionalModeSource[] = [
  {
    name: 'inbus.ua — національний розклад автобусів (GTFS)',
    type: 'GTFS',
    url: 'https://gtfs.fsn1.your-objectstorage.com/feeds/gtfs.zip',
    access: 'OPEN',
    sourceRef: 'mdb:ua-inbusua-gtfs-3044',
  },
  {
    name: 'INFOBUS Partner API',
    type: 'REST_API',
    url: 'https://infobus.eu',
    access: 'CONTRACT_ONLY',
    sourceRef: 'infobus:partner-b2b',
  },
  {
    name: 'VD-Express — міжміські рейси (GTFS)',
    type: 'GTFS',
    url: 'https://vdexpress.net/api/gtfs/feed',
    access: 'OPEN',
    sourceRef: 'mobilitydatabase.org:VD-Express',
  },
];

const taxiSources: RegionalModeSource[] = [
  {
    name: 'Uklon Partner Ride-Hailing API',
    type: 'REST_API',
    url: 'https://uklon.com.ua',
    access: 'CONTRACT_ONLY',
    sourceRef: 'uklon:b2b-api',
  },
  {
    name: 'Bolt Partner API',
    type: 'REST_API',
    url: 'https://bolt.eu',
    access: 'CONTRACT_ONLY',
    sourceRef: 'bolt:partner-b2b',
  },
  {
    name: 'Uber Rides API',
    type: 'REST_API',
    url: 'https://developer.uber.com',
    access: 'REQUIRES_KEY',
    sourceRef: 'uber:developers',
  },
];

const transferSources: RegionalModeSource[] = [
  {
    name: 'MARSHGO Transfer Partner Network',
    type: 'REST_API',
    access: 'CONTRACT_ONLY',
    sourceRef: 'marshgo:transfer-network',
  },
];

const ownBikeSource: RegionalModeSource = {
  name: 'OpenStreetMap Cycleway Routing Profile',
  type: 'OPEN_DATA',
  access: 'OPEN',
  sourceRef: 'osm:ukraine-cycle-network',
};

// -----------------------------------------------------------------------------------------
// Complete Catalog of all 26 Ukrainian Regions (24 Oblasts + Kyiv City + Crimea)
// -----------------------------------------------------------------------------------------

export const UKRAINE_REGIONS: UkraineOblast[] = [
  // 1. місто Київ (столиця)
  {
    id: 'kyiv',
    name: 'місто Київ',
    capital: 'Київ',
    majorCities: ['Київ'],
    bbox: [30.23, 50.31, 30.82, 50.59],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS', 'PROVIDER_ATTRIBUTION'],
        sources: [
          {
            name: 'Київпастранс — розклад (GTFS)',
            type: 'GTFS',
            url: 'https://jbb.ghsq.de/gtfs/ua-kyiv.gtfs.zip',
            access: 'OPEN',
            sourceRef: 'data.kyivcity.gov.ua:kpt-gtfs',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS', 'PROVIDER_ATTRIBUTION'],
        sources: [
          {
            name: 'Київ — маршрутки (офіційна геометрія)',
            type: 'OPEN_DATA',
            url: 'https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport/resource/77325f5c-57d0-4f79-844a-cc73675f9743/data/download',
            access: 'OPEN',
            sourceRef: 'data.kyivcity.gov.ua:routeTaxi',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS', 'PROVIDER_ATTRIBUTION'],
        sources: [
          {
            name: 'Київпастранс — тролейбусні лінії (GTFS)',
            type: 'GTFS',
            url: 'https://jbb.ghsq.de/gtfs/ua-kyiv.gtfs.zip',
            access: 'OPEN',
            sourceRef: 'data.kyivcity.gov.ua:trolleybus',
          },
        ],
      },
      tram: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS', 'PROVIDER_ATTRIBUTION'],
        sources: [
          {
            name: 'Київпастранс — трамвайні лінії (GTFS)',
            type: 'GTFS',
            url: 'https://jbb.ghsq.de/gtfs/ua-kyiv.gtfs.zip',
            access: 'OPEN',
            sourceRef: 'data.kyivcity.gov.ua:tram',
          },
        ],
      },
      metro: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS', 'PROVIDER_ATTRIBUTION'],
        sources: [
          {
            name: 'Київ — метро (геометрія ліній)',
            type: 'OPEN_DATA',
            url: 'https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport/resource/5e385793-58e2-49eb-b856-a963dd7486bb/data/download',
            access: 'OPEN',
            sourceRef: 'data.kyivcity.gov.ua:underground',
          },
          {
            name: 'Київ — метро (станції)',
            type: 'OPEN_DATA',
            url: 'https://data.kyivcity.gov.ua/dataset/dani-pro-mistse-rozmishchennia-zupynok-miskoho-elektrychnoho-ta-avtomobilnoho-transpor-dep-transport/resource/93a62dca-e442-43b6-a00e-112c7eb6c13f/data/download',
            access: 'OPEN',
            sourceRef: 'data.kyivcity.gov.ua:stopsUnderground',
          },
        ],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'CANCEL', 'REALTIME_POSITION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'REALTIME_ETA', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING', 'PROVIDER_ATTRIBUTION'],
        sources: [
          ...trainSources,
          {
            name: 'Київська міська електричка (Kyiv City Express)',
            type: 'OPEN_DATA',
            url: 'https://data.kyivcity.gov.ua/dataset/rozklad-rukhu-miskoho-elektrychnoho-ta-avtomobilnoho-transportu-dep-transport/resource/a4fd8556-025a-4e14-bc75-99e4c018d2b9/data/download',
            access: 'OPEN',
            sourceRef: 'data.kyivcity.gov.ua:kyivCityExpress',
          },
        ],
      },
      bike: {
        available: true,
        status: 'LIMITED',
        reason: 'Є статичні точки OSM, але live BikeNow feed, доступність велосипедів і правила повернення не підтверджені.',
        capabilities: ['ASSET_DISCOVERY'],
        sources: [
          ownBikeSource,
        ],
      },
      scooter: {
        available: true,
        status: 'LIMITED',
        reason: 'Zelectra GBFS читається, але містить координати поза Україною; live оренда, правила завершення й booking не підтверджені.',
        capabilities: ['ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Kyiv',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:scooters-kyiv',
          },
          {
            name: 'Uklon Scooters / e-Wings Kyiv',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'uklon:scooters',
          },
          {
            name: '3electra GBFS Hubs',
            type: 'GBFS',
            url: 'https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs',
            access: 'CONTRACT_ONLY',
            sourceRef: 'zelectra:kyiv',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'REQUIRES_CONTRACT',
        reason: 'Getmancar є лише партнерським кандидатом; активний fleet API не налаштований.',
        capabilities: [],
        sources: [
          {
            name: 'Getmancar Kyiv Fleet',
            type: 'REST_API',
            url: 'https://getmancar.com.ua',
            access: 'CONTRACT_ONLY',
            sourceRef: 'getmancar:kyiv-fleet',
          },
        ],
      },
      transfer: {
        available: false,
        status: 'REQUIRES_CONTRACT',
        reason: 'Немає активного quote/booking API; каталогові записи не є пропозицією трансферу.',
        capabilities: [],
        sources: transferSources,
      },
    },
  },

  // 2. Львівська область
  {
    id: 'lviv-oblast',
    name: 'Львівська область',
    capital: 'Львів',
    majorCities: ['Львів', 'Стрий', 'Дрогобич', 'Трускавець', 'Червоноград', 'Самбір', 'Борислав'],
    bbox: [22.7, 48.75, 25.4, 50.6],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION', 'TRANSIT_ROUTES', 'TRANSIT_STOPS', 'PROVIDER_ATTRIBUTION'],
        sources: [
          {
            name: 'Львівавтодор — розклад (GTFS)',
            type: 'GTFS',
            url: 'https://track.ua-gis.com/gtfs/lviv/static.zip',
            access: 'OPEN',
            sourceRef: 'opendata.city-adm.lviv.ua:lvivavtodor-gtfs',
          },
          {
            name: 'Львівавтодор — realtime позиції (GTFS-RT)',
            type: 'GTFS_RT',
            url: 'https://track.ua-gis.com/gtfs/lviv/vehicle_position',
            access: 'OPEN',
            sourceRef: 'opendata.city-adm.lviv.ua:lvivavtodor-gtfs-rt',
          },
          {
            name: 'Стрийська міська рада — розклад (GTFS)',
            type: 'GTFS',
            url: 'https://track.ua-gis.com/gtfs/stryi/static.zip',
            access: 'OPEN',
            sourceRef: 'mdb:ua-stryi-gtfs-2932',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION', 'TRANSIT_ROUTES', 'PROVIDER_ATTRIBUTION'],
        sources: [
          {
            name: 'Червоноград — позиції (EasyWay JSON)',
            type: 'OPEN_DATA',
            url: 'https://public.easyway.info/gps/chervonograd.json',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:chervonograd',
          },
          {
            name: 'Львівські міські та приміські маршрутні таксі (Львівавтодор)',
            type: 'GTFS',
            url: 'https://track.ua-gis.com/gtfs/lviv/static.zip',
            access: 'OPEN',
            sourceRef: 'opendata.city-adm.lviv.ua:minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Львівелектротранс — тролейбуси (GTFS / GTFS-RT)',
            type: 'GTFS_RT',
            url: 'https://track.ua-gis.com/gtfs/lviv/vehicle_position',
            access: 'OPEN',
            sourceRef: 'track.ua-gis.com:trolleybus',
          },
        ],
      },
      tram: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Львівелектротранс — трамваї (GTFS / GTFS-RT)',
            type: 'GTFS_RT',
            url: 'https://track.ua-gis.com/gtfs/lviv/vehicle_position',
            access: 'OPEN',
            sourceRef: 'track.ua-gis.com:tram',
          },
        ],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Львівській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'CANCEL', 'REALTIME_POSITION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'REALTIME_ETA', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'LIMITED',
        reason: 'Є лише статичні точки OSM; живе покриття Nextbike у Львові не підтвердилося перевіркою GBFS.',
        capabilities: ['ASSET_DISCOVERY'],
        sources: [
          ownBikeSource,
        ],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY', 'GEOFENCING'],
        sources: [
          {
            name: 'Bolt Scooters Lviv',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:scooters-lviv',
          },
          {
            name: 'Uklon Scooters / e-Wings Lviv',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'uklon:scooters-lviv',
          },
        ],
      },
      carsharing: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: [
          {
            name: 'Getmancar Lviv Fleet',
            type: 'REST_API',
            url: 'https://getmancar.com.ua',
            access: 'CONTRACT_ONLY',
            sourceRef: 'getmancar:lviv-fleet',
          },
        ],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: [
          ...transferSources,
          {
            name: 'Карпатський та прикордонний трансфер (Шегині, Краківець, Трускавець, Славське)',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:lviv-borders-resorts',
          },
        ],
      },
    },
  },

  // 3. Вінницька область
  {
    id: 'vinnytsia-oblast',
    name: 'Вінницька область',
    capital: 'Вінниця',
    majorCities: ['Вінниця', 'Жмеринка', 'Могилів-Подільський', 'Хмільник', 'Козятин'],
    bbox: [27.4, 48.0, 30.1, 49.8],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Вінницька міська рада — розклад транспорту',
            type: 'OPEN_DATA',
            url: 'https://data.gov.ua/dataset/vinnytsia-transport',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:vinnytsia',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Вінниця — міські маршрутні таксі (EasyWay)',
            type: 'OPEN_DATA',
            url: 'https://public.easyway.info/gps/vinnytsya.json',
            access: 'OPEN',
            sourceRef: 'easyway:vinnytsya',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Вінницька транспортна компанія — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:vinnytsia-trolleybus',
          },
        ],
      },
      tram: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Вінницька транспортна компанія — трамваї (швейцарські вагони)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:vinnytsia-tram',
          },
        ],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Вінницькій області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'LIMITED',
        reason: 'Є лише статичні точки OSM; заявлений Nextbike feed повернув HTTP 404 під час перевірки 2026-10-19.',
        capabilities: ['ASSET_DISCOVERY'],
        sources: [
          ownBikeSource,
        ],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Вінниця',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:vinnytsia',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Вінницькій області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 4. Дніпропетровська область
  {
    id: 'dnipropetrovsk-oblast',
    name: 'Дніпропетровська область',
    capital: 'Дніпро',
    majorCities: ['Дніпро', 'Кривий Ріг', 'Кам’янське', 'Нікополь', 'Павлоград', 'Новомосковськ'],
    bbox: [33.2, 47.4, 37.0, 49.2],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Дніпро — позиції транспорту (iCity JSON)',
            type: 'OPEN_DATA',
            url: 'https://api-t900.icity.com.ua/api/gps_data/',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:dnipro-icity',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Дніпро та Кривий Ріг — маршрутки (iCity / EasyWay)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:dnipro-krivoyrog-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Дніпровський електротранспорт — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:dnipro-trolleybus',
          },
          {
            name: 'Криворізький тролейбус',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kryvyi-rih-trolleybus',
          },
        ],
      },
      tram: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Дніпровський трамвай',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:dnipro-tram',
          },
          {
            name: 'Кам’янський трамвай',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kamianske-tram',
          },
        ],
      },
      metro: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'PROVIDER_ATTRIBUTION'],
        sources: [
          {
            name: 'Дніпровський метрополітен (лінія Покровська — Вокзальна)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:dnipro-metro',
          },
          {
            name: 'Криворізький метротрам (швидкісний трамвай підземного типу)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kryvyi-rih-metrotram',
          },
        ],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'REALTIME_ETA', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: [
          ...trainSources,
          {
            name: 'Dnipro City Express (Укрзалізниця)',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'uz:dnipro-city-express',
          },
        ],
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY', 'EXTERNAL_BOOKING'],
        sources: [
          {
            name: 'Bolt Scooters Dnipro & Kryvyi Rih',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:dnipro-scooters',
          },
        ],
      },
      carsharing: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY', 'EXTERNAL_BOOKING'],
        sources: [
          {
            name: 'Getmancar Dnipro Fleet',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'getmancar:dnipro',
          },
        ],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 5. Харківська область
  {
    id: 'kharkiv-oblast',
    name: 'Харківська область',
    capital: 'Харків',
    majorCities: ['Харків', 'Лозова', 'Ізюм', 'Чугуїв', 'Куп’янськ', 'Люботин'],
    bbox: [35.1, 48.7, 38.0, 50.5],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Харків — муніципальний автобусний транспорт',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kharkiv-bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Харків — приміські та міські маршрутки (EasyWay)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'easyway:kharkiv-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Харківський тролейбус',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kharkiv-trolleybus',
          },
        ],
      },
      tram: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Харківський трамвай',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kharkiv-tram',
          },
        ],
      },
      metro: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'PROVIDER_ATTRIBUTION'],
        sources: [
          {
            name: 'Харківський метрополітен (Холодногірсько-Заводська, Салтівська, Олексіївська лінії)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kharkiv-metro',
          },
        ],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'REALTIME_ETA', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY', 'EXTERNAL_BOOKING'],
        sources: [
          {
            name: 'Bolt Scooters Kharkiv',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:kharkiv-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Харківській області сервіс каршерингу тимчасово призупинено',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 6. Одеська область
  {
    id: 'odesa-oblast',
    name: 'Одеська область',
    capital: 'Одеса',
    majorCities: ['Одеса', 'Чорноморськ', 'Ізмаїл', 'Білгород-Дністровський', 'Подільськ', 'Южне'],
    bbox: [29.2, 45.2, 31.3, 48.2],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Одеса — розклад міського транспорту (GTFS)',
            type: 'GTFS',
            url: 'https://gw.x24.digital/api/od-all/gtfs/v1/download/static',
            access: 'REQUIRES_KEY',
            sourceRef: 'omr.gov.ua:odesa-gtfs',
          },
          {
            name: 'Чорноморськ — розклад (GTFS)',
            type: 'GTFS',
            url: 'https://data.gov.ua/dataset/032c23f0-dbe5-4b63-8c1f-03218758ae60/resource/d997fdbf-7a25-487b-ad47-ee5541d552be/download/chornomorsk-2019-09-05-10-24-50.zip',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:chornomorsk-gtfs',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Одеса — міські та приміські маршрутки (EasyWay)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'easyway:odesa-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Одесміськелектротранс — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'omr.gov.ua:trolleybus',
          },
        ],
      },
      tram: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Одесміськелектротранс — трамваї (включаючи Північ — Південь)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'omr.gov.ua:tram',
          },
        ],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній в Одеській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'REALTIME_ETA', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY', 'EXTERNAL_BOOKING'],
        sources: [
          {
            name: 'Bolt Scooters Odesa',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:odesa-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'В Одеській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: [
          ...transferSources,
          {
            name: 'Трансфери Одеса — Молдова / Румунія (Паланка, Маяки, Рені)',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:odesa-borders',
          },
        ],
      },
    },
  },

  // 7. Івано-Франківська область
  {
    id: 'ivano-frankivsk-oblast',
    name: 'Івано-Франківська область',
    capital: 'Івано-Франківськ',
    majorCities: ['Івано-Франківськ', 'Калуш', 'Коломия', 'Яремче', 'Буковель', 'Надвірна'],
    bbox: [23.8, 47.7, 25.6, 49.3],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Івано-Франківськ — розклад (GTFS, Dozor)',
            type: 'GTFS',
            url: 'https://city.dozor.tech/iv-frankivsk/gtfs/static.zip',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:if-dozor-gtfs',
          },
          {
            name: 'Івано-Франківськ — позиції (GTFS-RT, Dozor)',
            type: 'GTFS_RT',
            url: 'https://city.dozor.tech/iv-frankivsk/gtfs/vehicle_position',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:if-dozor-rt',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Івано-Франківськ — позиції (Dozor JSON)',
            type: 'OPEN_DATA',
            url: 'https://city.dozor.tech/iv-frankivsk/devices.json',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:if-devices',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Електроавтотранс — тролейбуси Івано-Франківська',
            type: 'GTFS_RT',
            url: 'https://city.dozor.tech/iv-frankivsk/gtfs/vehicle_position',
            access: 'OPEN',
            sourceRef: 'eat.if.ua:trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Івано-Франківській області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній в Івано-Франківській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY', 'EXTERNAL_BOOKING'],
        sources: [
          {
            name: 'Bolt Scooters Івано-Франківськ',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:if-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'В Івано-Франківській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: [
          ...transferSources,
          {
            name: 'Гірський трансфер Буковель / Яремче / Ворохта',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:bukovel-transfer',
          },
        ],
      },
    },
  },

  // 8. Рівненська область
  {
    id: 'rivne-oblast',
    name: 'Рівненська область',
    capital: 'Рівне',
    majorCities: ['Рівне', 'Вараш', 'Дубно', 'Костопіль', 'Сарни', 'Острог'],
    bbox: [25.1, 50.0, 27.5, 52.0],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Рівне — розклад (GTFS, Dozor)',
            type: 'GTFS',
            url: 'https://city.dozor.tech/rivne/gtfs/static.zip',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:rivne-dozor-gtfs',
          },
          {
            name: 'Рівне — позиції (GTFS-RT, Dozor)',
            type: 'GTFS_RT',
            url: 'https://city.dozor.tech/rivne/gtfs/vehicle_position',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:rivne-dozor-rt',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Рівне — маршрутні таксі (Dozor City)',
            type: 'OPEN_DATA',
            url: 'https://city.dozor.tech/rivne/devices.json',
            access: 'OPEN',
            sourceRef: 'city.dozor.tech:rivne-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Рівнеелектроавтотранс — тролейбуси',
            type: 'GTFS_RT',
            url: 'https://city.dozor.tech/rivne/gtfs/vehicle_position',
            access: 'OPEN',
            sourceRef: 'city.dozor.tech:rivne-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Рівненській області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Рівненській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Рівне',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:rivne-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Рівненській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 9. Закарпатська область
  {
    id: 'zakarpattia-oblast',
    name: 'Закарпатська область',
    capital: 'Ужгород',
    majorCities: ['Ужгород', 'Мукачево', 'Хуст', 'Берегове', 'Чоп', 'Свалява'],
    bbox: [22.1, 47.9, 24.6, 49.2],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Ужгородська міська рада — розклад (GTFS)',
            type: 'GTFS',
            url: 'https://track.ua-gis.com/gtfs/uzhhorod/static.zip',
            access: 'OPEN',
            sourceRef: 'mdb:ua-uzhhorod-gtfs-2931',
          },
          {
            name: 'Ужгород — позиції (GTFS-RT, Dozor)',
            type: 'GTFS_RT',
            url: 'https://city.dozor.tech/uzhgorod/gtfs/vehicle_position',
            access: 'OPEN',
            sourceRef: 'city.dozor.tech:uzhgorod-rt',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Ужгород — позиції й типи транспорту (Dozor JSON)',
            type: 'OPEN_DATA',
            url: 'https://city.dozor.tech/uzhgorod/devices.json',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:uzhgorod-devices',
          },
        ],
      },
      trolleybus: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Тролейбусна мережа відсутня в Закарпатській області',
        capabilities: [],
        sources: [],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Закарпатській області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Закарпатській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Електросамокати Ужгород / Мукачево',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:scooters-zakarpattia',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Закарпатській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: [
          ...transferSources,
          {
            name: 'Прикордонні трансфери Ужгород / Чоп — Словаччина, Угорщина',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:transcarpathia-borders',
          },
        ],
      },
    },
  },

  // 10. Хмельницька область
  {
    id: 'khmelnytskyi-oblast',
    name: 'Хмельницька область',
    capital: 'Хмельницький',
    majorCities: ['Хмельницький', 'Кам’янець-Подільський', 'Шепетівка', 'Нетішин', 'Славута', 'Старокостянтинів'],
    bbox: [26.1, 48.4, 27.9, 50.6],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Хмельницький — розклад (GTFS, Dozor)',
            type: 'GTFS',
            url: 'https://city.dozor.tech/ua/khmelnyckyi/gtfs/static.zip',
            access: 'OPEN',
            sourceRef: 'dozor:khmelnytskyi-gtfs',
          },
          {
            name: 'Кам’янець-Подільський — розклад (GTFS, Dozor)',
            type: 'GTFS',
            url: 'https://city.dozor.tech/kamyanec/gtfs/static.zip',
            access: 'OPEN',
            sourceRef: 'dozor:kamyanec-gtfs',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Кам’янець-Подільський — позиції (Dozor JSON)',
            type: 'OPEN_DATA',
            url: 'https://city.dozor.tech/kamyanec/devices.json',
            access: 'OPEN',
            sourceRef: 'dozor:kamyanec-devices',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Хмельницьке комунальне підприємство «Електротранс»',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:khmelnytskyi-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Хмельницькій області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Хмельницькій області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Хмельницький',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:khmelnytskyi-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Хмельницькій області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 11. Київська область
  {
    id: 'kyiv-oblast',
    name: 'Київська область',
    capital: 'Київ',
    majorCities: ['Біла Церква', 'Бровари', 'Бориспіль', 'Ірпінь', 'Буча', 'Фастів', 'Васильків'],
    bbox: [29.2, 49.1, 32.2, 51.5],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Біла Церква — розклад (GTFS, Dozor)',
            type: 'GTFS',
            url: 'https://city.dozor.tech/bila-cerkva/gtfs/static.zip',
            access: 'OPEN',
            sourceRef: 'dozor:bila-cerkva-gtfs',
          },
          {
            name: 'КП «Бучатранссервіс» — розклад (GTFS)',
            type: 'GTFS',
            url: 'https://gw.x24.digital/api/bu/gtfs/v1/download/static',
            access: 'REQUIRES_KEY',
            sourceRef: 'mdb:ua-bucha-gtfs-2945',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Біла Церква — позиції (Dozor JSON)',
            type: 'OPEN_DATA',
            url: 'https://city.dozor.tech/bila-cerkva/devices.json',
            access: 'OPEN',
            sourceRef: 'dozor:bila-cerkva-devices',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Тролейбусне управління Білої Церкви',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:bila-cerkva-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в містах Київської області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен розташований у межах міста Києва',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Біла Церква / Ірпінь / Буча',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:kyiv-oblast-scooters',
          },
        ],
      },
      carsharing: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY', 'EXTERNAL_BOOKING'],
        sources: [
          {
            name: 'Getmancar Київська агломерація (Бориспіль, Ірпінь, Буча)',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'getmancar:kyiv-suburbs',
          },
        ],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: [
          ...transferSources,
          {
            name: 'Аеропортові та заміські трансфери Київщини (Бориспіль, Жуляни)',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:kyiv-airports',
          },
        ],
      },
    },
  },

  // 12. Полтавська область
  {
    id: 'poltava-oblast',
    name: 'Полтавська область',
    capital: 'Полтава',
    majorCities: ['Полтава', 'Кременчук', 'Горішні Плавні', 'Лубни', 'Миргород'],
    bbox: [32.0, 48.7, 35.5, 50.6],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Полтава — позиції транспорту (EasyWay JSON)',
            type: 'OPEN_DATA',
            url: 'https://public.easyway.info/gps/poltava.json',
            access: 'OPEN',
            sourceRef: 'easyway:poltava-gps',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Полтава та Кременчук — маршрутки (EasyWay)',
            type: 'OPEN_DATA',
            url: 'https://public.easyway.info/gps/poltava.json',
            access: 'OPEN',
            sourceRef: 'easyway:poltava-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Полтаваелектроавтотранс — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:poltava-trolleybus',
          },
          {
            name: 'Кременчуцьке тролейбусне управління',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kremenchuk-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Полтавській області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Полтавській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Полтава & Кременчук',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:poltava-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Полтавській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 13. Сумська область
  {
    id: 'sumy-oblast',
    name: 'Сумська область',
    capital: 'Суми',
    majorCities: ['Суми', 'Конотоп', 'Шостка', 'Охтирка', 'Ромни', 'Глухів'],
    bbox: [33.1, 50.0, 35.7, 52.4],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Конотоп — позиції транспорту (EasyWay JSON)',
            type: 'OPEN_DATA',
            url: 'https://public.easyway.info/gps/konotop.json',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:konotop-gps',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Конотоп та Суми — маршрутки (EasyWay)',
            type: 'OPEN_DATA',
            url: 'https://public.easyway.info/gps/konotop.json',
            access: 'OPEN',
            sourceRef: 'easyway:sumy-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Електроавтотранс м. Суми — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:sumy-trolleybus',
          },
        ],
      },
      tram: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Конотопський трамвай (КП «Конотопське трамвайне управління»)',
            type: 'OPEN_DATA',
            url: 'https://public.easyway.info/gps/konotop.json',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:konotop-tram',
          },
        ],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Сумській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Електросамокати Суми',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:sumy-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Сумській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 14. Кіровоградська область
  {
    id: 'kirovohrad-oblast',
    name: 'Кіровоградська область',
    capital: 'Кропивницький',
    majorCities: ['Кропивницький', 'Олександрія', 'Знам’янка', 'Світловодськ'],
    bbox: [29.8, 47.7, 33.7, 49.3],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Олександрія — розклад (GTFS, Dozor)',
            type: 'GTFS',
            url: 'https://city.dozor.tech/oleksandriya/gtfs/static.zip',
            access: 'OPEN',
            sourceRef: 'dozor:oleksandriya-gtfs',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Олександрія — позиції (Dozor JSON)',
            type: 'OPEN_DATA',
            url: 'https://city.dozor.tech/oleksandriya/devices.json',
            access: 'OPEN',
            sourceRef: 'dozor:oleksandriya-devices',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Електротранс Кропивницький — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kropyvnytskyi-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Кіровоградській області (історичний трамвай закритий)',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Кіровоградській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Електросамокати Кропивницький',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:kropyvnytskyi-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Кіровоградській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 15. Запорізька область
  {
    id: 'zaporizhzhia-oblast',
    name: 'Запорізька область',
    capital: 'Запоріжжя',
    majorCities: ['Запоріжжя', 'Мелітополь', 'Бердянськ', 'Енергодар'],
    bbox: [34.3, 46.5, 37.3, 48.2],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Запоріжжя — муніципальні автобуси (Запоріжелектротранс)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:zaporizhzhia-bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Запоріжжя — маршрутні таксі (Dozor / EasyWay)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'dozor:zaporizhzhia-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Запоріжелектротранс — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:zaporizhzhia-trolleybus',
          },
        ],
      },
      tram: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Запоріжелектротранс — трамваї',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:zaporizhzhia-tram',
          },
        ],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Запорізькій області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Запоріжжя',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:zaporizhzhia-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Запорізькій області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 16. Волинська область
  {
    id: 'volyn-oblast',
    name: 'Волинська область',
    capital: 'Луцьк',
    majorCities: ['Луцьк', 'Ковель', 'Нововолинськ', 'Володимир'],
    bbox: [23.6, 50.4, 26.2, 52.0],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Луцька міська рада — розклад руху автобусів',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:lutsk-bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Луцьк — маршрутні таксі (CityBus / Dozor)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'lutsk:minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Луцьке підприємство електротранспорту — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:lutsk-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня у Волинській області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Волинській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Луцьк',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:lutsk-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Волинській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: [
          ...transferSources,
          {
            name: 'Прикордонні трансфери Ягодин / Устилуг (Польща)',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:volyn-borders',
          },
        ],
      },
    },
  },

  // 17. Житомирська область
  {
    id: 'zhytomyr-oblast',
    name: 'Житомирська область',
    capital: 'Житомир',
    majorCities: ['Житомир', 'Бердичів', 'Коростень', 'Новоград-Волинський / Звягель', 'Малин'],
    bbox: [27.2, 49.6, 29.8, 51.7],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Житомир — міські автобуси (Dozor City)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'dozor:zhytomyr-bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Житомир — маршрутні таксі (Dozor City)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'dozor:zhytomyr-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Житомирське трамвайно-тролейбусне управління — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:zhytomyr-trolleybus',
          },
        ],
      },
      tram: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Житомирський трамвай (історична лінія на вузькій колії)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:zhytomyr-tram',
          },
        ],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Житомирській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Житомир',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:zhytomyr-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Житомирській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 18. Тернопільська область
  {
    id: 'ternopil-oblast',
    name: 'Тернопільська область',
    capital: 'Тернопіль',
    majorCities: ['Тернопіль', 'Чортків', 'Кременець', 'Бережани', 'Збараж'],
    bbox: [24.7, 48.5, 26.5, 50.3],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Тернопіль — міські автобуси (Департамент транспорту)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:ternopil-bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Тернопіль — маршрутні таксі (EasyWay)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'easyway:ternopil-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'КП «Тернопільелектротранс» — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:ternopil-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Тернопільській області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Тернопільській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Тернопіль',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:ternopil-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Тернопільській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 19. Чернігівська область
  {
    id: 'chernihiv-oblast',
    name: 'Чернігівська область',
    capital: 'Чернігів',
    majorCities: ['Чернігів', 'Ніжин', 'Прилуки', 'Бахмач', 'Новгород-Сіверський'],
    bbox: [30.5, 50.3, 33.5, 52.4],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Чернігів — автобуси (Dozor City)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'dozor:chernihiv-bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Чернігів — маршрутні таксі (Dozor City)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'dozor:chernihiv-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Чернігівське тролейбусне управління',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:chernihiv-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Чернігівській області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Чернігівській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Чернігів',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:chernihiv-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Чернігівській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 20. Черкаська область
  {
    id: 'cherkasy-oblast',
    name: 'Черкаська область',
    capital: 'Черкаси',
    majorCities: ['Черкаси', 'Умань', 'Сміла', 'Золотоноша', 'Канів'],
    bbox: [30.9, 48.5, 33.0, 50.2],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Черкаси — автобуси (Dozor City)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'dozor:cherkasy-bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Черкаси та Умань — маршрутки (Dozor / EasyWay)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'dozor:cherkasy-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Черкасиелектротранс — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:cherkasy-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Черкаській області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Черкаській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Черкаси & Умань',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:cherkasy-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Черкаській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: [
          ...transferSources,
          {
            name: 'Трансфери в Умань (Хасидське паломництво / Софіївка)',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:uman-transfers',
          },
        ],
      },
    },
  },

  // 21. Чернівецька область
  {
    id: 'chernivtsi-oblast',
    name: 'Чернівецька область',
    capital: 'Чернівці',
    majorCities: ['Чернівці', 'Сторожинець', 'Новодністровськ', 'Хотин'],
    bbox: [24.9, 47.7, 27.5, 48.7],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Чернівецьке тролейбусне управління — автобуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:chernivtsi-bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Чернівці — маршрутні таксі (EasyWay)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'easyway:chernivtsi-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Чернівецьке тролейбусне управління (ЧТУ)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:chernivtsi-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Чернівецькій області (історичний трамвай закритий 1967 р.)',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Чернівецькій області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Bolt Scooters Чернівці',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'bolt:chernivtsi-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Чернівецькій області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: [
          ...transferSources,
          {
            name: 'Прикордонний трансфер Порубне (Румунія / Сучава)',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:chernivtsi-porubne',
          },
        ],
      },
    },
  },

  // 22. Миколаївська область
  {
    id: 'mykolaiv-oblast',
    name: 'Миколаївська область',
    capital: 'Миколаїв',
    majorCities: ['Миколаїв', 'Первомайськ', 'Вознесенськ', 'Южноукраїнськ', 'Очаків'],
    bbox: [30.8, 46.5, 33.2, 48.2],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES', 'TRANSIT_STOPS'],
        sources: [
          {
            name: 'Миколаївпастранс — автобуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:mykolaiv-bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'REALTIME_POSITION'],
        sources: [
          {
            name: 'Миколаїв — маршрутні таксі (EasyWay)',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'easyway:mykolaiv-minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'КП «Миколаївелектротранс» — тролейбуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:mykolaiv-trolleybus',
          },
        ],
      },
      tram: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'КП «Миколаївелектротранс» — трамваї',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:mykolaiv-tram',
          },
        ],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Миколаївській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [
          {
            name: 'Електросамокати Миколаїв',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:mykolaiv-scooters',
          },
        ],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Миколаївській області ще немає підключеного каршеринг-партнера',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 23. Херсонська область
  {
    id: 'kherson-oblast',
    name: 'Херсонська область',
    capital: 'Херсон',
    majorCities: ['Херсон', 'Нова Каховка', 'Каховка', 'Олешки', 'Генічеськ', 'Скадовськ'],
    bbox: [31.5, 45.7, 35.0, 47.3],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Херсонський комунальний транспорт',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kherson-bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE'],
        sources: [
          {
            name: 'Херсонські приміські та міські перевізники',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'kherson:minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'МКП «Херсонелектротранс»',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:kherson-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа відсутня в Херсонській області',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Херсонській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Прокат електросамокатів у Херсонській області тимчасово обмежено з міркувань безпеки',
        capabilities: [],
        sources: [],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'У Херсонській області сервіс каршерингу не підключено',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 24. Донецька область
  {
    id: 'donetsk-oblast',
    name: 'Донецька область',
    capital: 'Краматорськ',
    majorCities: ['Краматорськ', 'Слов’янськ', 'Покровськ', 'Костянтинівка', 'Бахмут', 'Маріуполь'],
    bbox: [36.5, 46.8, 39.2, 49.3],
    transportModes: {
      bus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Краматорське трамвайно-тролейбусне управління — автобуси',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'kramatorsk:bus',
          },
          ...intercityBusSources,
        ],
      },
      marshrutka: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE'],
        sources: [
          {
            name: 'Маршрутні перевізники Донеччини',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'donetsk:minibus',
          },
        ],
      },
      trolleybus: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_ROUTES'],
        sources: [
          {
            name: 'Краматорський та Слов’янський тролейбус',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'data.gov.ua:donbass-trolleybus',
          },
        ],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайний рух у підконтрольних містах області тимчасово призупинено',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Донецькій області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'EXTERNAL_BOOKING'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'EXTERNAL_BOOKING'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Шеринг електросамокатів у зоні підвищеної небезпеки не діє',
        capabilities: [],
        sources: [],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Каршеринг у Донецькій області не функціонує',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: [
          ...transferSources,
          {
            name: 'Евакуаційні та міжміські трансфери Донеччини',
            type: 'REST_API',
            access: 'CONTRACT_ONLY',
            sourceRef: 'marshgo:donetsk-transfers',
          },
        ],
      },
    },
  },

  // 25. Луганська область
  {
    id: 'luhansk-oblast',
    name: 'Луганська область',
    capital: 'Сєвєродонецьк',
    majorCities: ['Сєвєродонецьк', 'Лисичанськ', 'Рубіжне', 'Старобільськ', 'Луганськ'],
    bbox: [37.8, 47.8, 40.3, 50.1],
    transportModes: {
      bus: {
        available: true,
        status: 'LIMITED',
        capabilities: ['SEARCH', 'SCHEDULE'],
        sources: intercityBusSources,
      },
      marshrutka: {
        available: true,
        status: 'LIMITED',
        capabilities: ['SEARCH'],
        sources: [
          {
            name: 'Міжміські перевізники Луганщини',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'luhansk:minibus',
          },
        ],
      },
      trolleybus: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Тролейбусна інфраструктура зазнала критичних пошкоджень під час бойових дій',
        capabilities: [],
        sources: [],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа Луганщини не функціонує',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній у Луганській області',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: true,
        status: 'LIMITED',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE'],
        sources: taxiSources,
      },
      train: {
        available: true,
        status: 'LIMITED',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'ASSET_DISCOVERY'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Шеринг електросамокатів у Луганській області не діє',
        capabilities: [],
        sources: [],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Каршеринг у Луганській області не функціонує',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },

  // 26. Автономна Республіка Крим та місто Севастополь
  {
    id: 'crimea',
    name: 'Автономна Республіка Крим',
    capital: 'Сімферополь',
    majorCities: ['Сімферополь', 'Севастополь', 'Ялта', 'Керч', 'Євпаторія', 'Феодосія'],
    bbox: [32.4, 44.3, 36.7, 46.2],
    transportModes: {
      bus: {
        available: true,
        status: 'LIMITED',
        capabilities: ['SEARCH'],
        sources: intercityBusSources,
      },
      marshrutka: {
        available: true,
        status: 'LIMITED',
        capabilities: ['SEARCH'],
        sources: [
          {
            name: 'Прикордонні та міжобласні автобусні сполучення Криму',
            type: 'OPEN_DATA',
            access: 'OPEN',
            sourceRef: 'crimea:bus',
          },
        ],
      },
      trolleybus: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Тролейбусна мережа Криму (вкл. Кримський тролейбус) тимчасово недоступна для онлайн-інтеграції через окупацію',
        capabilities: [],
        sources: [],
      },
      tram: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Трамвайна мережа тимчасово недоступна для онлайн-інтеграції через окупацію',
        capabilities: [],
        sources: [],
      },
      metro: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Метрополітен відсутній в АР Крим',
        capabilities: [],
        sources: [],
      },
      carpool: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'BOOK_IN_APP', 'RESERVATION', 'PRICE_LOCK'],
        sources: carpoolSources,
      },
      taxi: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Офіційні українські ride-hailing провайдери не оперують на тимчасово окупованій території',
        capabilities: [],
        sources: [],
      },
      train: {
        available: true,
        status: 'LIMITED',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS'],
        sources: trainSources,
      },
      bike: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH'],
        sources: [ownBikeSource],
      },
      scooter: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Прокатні сервіси самокатів не підключено',
        capabilities: [],
        sources: [],
      },
      carsharing: {
        available: false,
        status: 'NOT_AVAILABLE_IN_CITY',
        reason: 'Каршеринг в АР Крим не підключено',
        capabilities: [],
        sources: [],
      },
      transfer: {
        available: true,
        status: 'AVAILABLE',
        capabilities: ['SEARCH', 'PRICE_ESTIMATE', 'RESERVATION'],
        sources: transferSources,
      },
    },
  },
];

// -----------------------------------------------------------------------------------------
// Fast Lookups and Canonical Catalog Engine API
// -----------------------------------------------------------------------------------------

export function getAllRegions(): UkraineOblast[] {
  return UKRAINE_REGIONS;
}

export function findRegion(query: string): UkraineOblast | undefined {
  const q = query.trim().toLowerCase();
  return UKRAINE_REGIONS.find((reg) => {
    if (reg.id.toLowerCase() === q) return true;
    if (reg.name.toLowerCase().includes(q)) return true;
    if (reg.capital.toLowerCase() === q) return true;
    return reg.majorCities.some((c) => c.toLowerCase() === q);
  });
}

export function findRegionByCoordinates(lon: number, lat: number): UkraineOblast | undefined {
  return UKRAINE_REGIONS.find((reg) => {
    const [minLon, minLat, maxLon, maxLat] = reg.bbox;
    return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
  });
}

export interface CatalogTransportTypeDto {
  id: CanonicalTransportTypeId;
  label: string;
  enabled: boolean;
  availability: 'AVAILABLE' | 'NOT_AVAILABLE_IN_CITY' | 'REQUIRES_CONTRACT' | 'LIMITED';
  capabilities: string[];
  reason: string | null;
}

const CANONICAL_LABELS: Record<CanonicalTransportTypeId, string> = {
  bus: 'Автобуси',
  marshrutka: 'Маршрутки',
  trolleybus: 'Тролейбуси',
  tram: 'Трамваї',
  metro: 'Метро',
  carpool: 'Попутки',
  taxi: 'Таксі',
  train: 'Поїзди',
  bike: 'Велосипеди',
  scooter: 'Самокати',
  carsharing: 'Каршеринг',
  transfer: 'Трансфери',
};

/**
 * Returns exactly the 12 canonical transport categories in their strict canonical order,
 * with city/region-specific capability and availability flags.
 */
export function getTransportCatalogForCity(cityNameOrRegionId?: string): CatalogTransportTypeDto[] {
  const region = cityNameOrRegionId ? findRegion(cityNameOrRegionId) : undefined;

  return canonicalTransportTypes.map((typeId) => {
    const label = CANONICAL_LABELS[typeId];
    if (!region) {
      // A national feed catalog does not prove that a particular route is covered.
      const defaultAvailable = typeId === 'carpool';
      return {
        id: typeId,
        label,
        enabled: defaultAvailable,
        availability: defaultAvailable ? 'AVAILABLE' : ['taxi', 'carsharing', 'transfer'].includes(typeId) ? 'REQUIRES_CONTRACT' : 'LIMITED',
        capabilities: defaultAvailable
          ? ['SEARCH']
          : [],
        reason: defaultAvailable
          ? 'Пошук використовує лише опубліковані пропозиції MARSHGO; ціна й місця залежать від конкретної пропозиції.'
          : ['taxi', 'carsharing', 'transfer'].includes(typeId)
            ? 'Потрібен підтверджений партнерський API та договір.'
            : 'Оберіть конкретне місто: національний каталог фідів не доводить покриття цього маршруту.',
      };
    }

    const mode = region.transportModes[typeId];
    const sources = mode?.sources ?? [];
    const hasOpenGtfs = sources.some((source) => source.access === 'OPEN' && source.type === 'GTFS' && Boolean(source.url));
    const openGeoSources = sources.filter((source) => source.access === 'OPEN' && source.type === 'OPEN_DATA' && Boolean(source.url));

    if (typeId === 'carpool' && sources.some((source) => source.type === 'INTERNAL' && source.access === 'OPEN')) {
      return {
        id: typeId,
        label,
        enabled: true,
        availability: 'AVAILABLE',
        capabilities: ['SEARCH', 'RESERVATION', 'IN_APP_BOOKING', 'LIVE_NAVIGATION'],
        reason: 'Пошук працює за опублікованими пропозиціями MARSHGO; конкретна наявність визначається під час пошуку.',
      };
    }

    if (typeId === 'taxi' || typeId === 'carsharing' || typeId === 'transfer') {
      return {
        id: typeId,
        label,
        enabled: false,
        availability: 'REQUIRES_CONTRACT',
        capabilities: [],
        reason: 'Партнерський кандидат у каталозі не означає активного API, підтвердженої ціни, наявності чи бронювання.',
      };
    }

    if (typeId === 'bike') {
      const staticAssets = sources.some((source) => source.type === 'OPEN_DATA' && source.access === 'OPEN');
      return {
        id: typeId,
        label,
        enabled: false,
        availability: staticAssets ? 'LIMITED' : 'NOT_AVAILABLE_IN_CITY',
        capabilities: staticAssets ? ['ASSET_DISCOVERY'] : [],
        reason: staticAssets ? `${mode?.reason ?? 'Є лише статичні точки.'} Актуальні велосипеди, правила повернення й початок оренди не підтверджені.` : 'Підтверджене джерело велосипедів не знайдено.',
      };
    }

    if (typeId === 'scooter') {
      const verifiedOpenGbfs = sources.some((source) => source.type === 'GBFS' && source.access === 'OPEN' && Boolean(source.url));
      return {
        id: typeId,
        label,
        enabled: false,
        availability: verifiedOpenGbfs ? 'LIMITED' : sources.length ? 'REQUIRES_CONTRACT' : 'NOT_AVAILABLE_IN_CITY',
        capabilities: verifiedOpenGbfs ? ['ASSET_DISCOVERY'] : [],
        reason: verifiedOpenGbfs ? 'Фід може показувати об’єкти; це не підтверджує дозвіл на оренду, тариф або зону завершення.' : 'Немає підтвердженого дозволеного GBFS чи партнерського API для цього міста.',
      };
    }

    if (typeId === 'marshrutka' && !hasOpenGtfs) {
      const hasGeometry = openGeoSources.length > 0;
      return {
        id: typeId,
        label,
        enabled: false,
        availability: hasGeometry ? 'LIMITED' : 'NOT_AVAILABLE_IN_CITY',
        capabilities: hasGeometry ? ['TRANSIT_ROUTES', 'TRANSIT_GEOMETRY'] : [],
        reason: hasGeometry ? 'Є геометрія маршруту без підтвердженого розкладу й послідовності зупинок; у пошук рейсу її не включаємо.' : 'Підтверджене джерело маршруток із розкладом не знайдено.',
      };
    }

    if (typeId === 'metro' && openGeoSources.length > 0) {
      return {
        id: typeId,
        label,
        enabled: false,
        availability: 'LIMITED',
        capabilities: ['TRANSIT_STOPS', 'TRANSIT_GEOMETRY'],
        reason: 'Карта має статичні станції й геометрію, але активного розкладу метро в маршрутному рушії немає; поїздки метро не плануються.',
      };
    }

    const routeableTransit = ['bus', 'marshrutka', 'trolleybus', 'tram', 'train'].includes(typeId);
    if (routeableTransit && hasOpenGtfs) {
      return {
        id: typeId,
        label,
        enabled: true,
        availability: 'LIMITED',
        capabilities: ['SEARCH', 'SCHEDULE', 'TRANSIT_STOPS', 'TRANSIT_ROUTES'],
        reason: 'Планування можливе лише для рейсів із активного GTFS-фіда; live, ціна й продаж квитка можуть бути відсутні.',
      };
    }

    if (openGeoSources.length > 0) {
      return {
        id: typeId,
        label,
        enabled: false,
        availability: 'LIMITED',
        capabilities: ['TRANSIT_ROUTES', 'TRANSIT_GEOMETRY'],
        reason: 'Джерело містить геометрію, але не підтверджує розклад або доступність рейсу.',
      };
    }

    return {
      id: typeId,
      label,
      enabled: false,
      availability: mode?.sources.some((source) => source.access === 'CONTRACT_ONLY') ? 'REQUIRES_CONTRACT' : 'NOT_AVAILABLE_IN_CITY',
      capabilities: [],
      reason: 'Немає активного джерела для пошуку цього режиму в обраному місті.',
    };
  });
}
