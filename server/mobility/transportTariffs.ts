import type { GtfsItineraryFare } from '../journey/gtfsFares';

export type FareRecordStatus = 'verified_static' | 'dynamic_quote' | 'requires_partner_access' | 'not_available';
export type FareProductKind = 'single_ride' | 'transfer_ticket' | 'stored_value_tier' | 'time_pass' | 'monthly_pass' | 'distance_tariff' | 'dynamic_quote';

export interface TransportFareRecord {
  id: string;
  city: string | null;
  modes: string[];
  name: string;
  kind: FareProductKind;
  status: FareRecordStatus;
  currency: 'UAH' | null;
  priceMinor: number | null;
  pricePerRideMinor?: number | null;
  rideCount?: number | null;
  minRideCount?: number | null;
  maxRideCount?: number | null;
  validitySeconds?: number | null;
  transferValiditySeconds?: number | null;
  transferCount?: number | 'unlimited' | null;
  fareMedia?: string[];
  riderCategory?: 'adult' | 'student' | 'all' | null;
  effectiveFrom?: string | null;
  sourceName: string;
  sourceUrl: string;
  lastVerifiedAt: string;
  notes?: string[];
}

const VERIFIED_AT = '2026-10-13';

/** Audited tariff facts. Price is stored in minor units (kopiyky); source values remain visible. */
export const transportFareCatalog: TransportFareRecord[] = [
  {
    id: 'kyiv-communal-single-ride', city: 'Київ',
    modes: ['bus', 'tram', 'trolleybus', 'metro', 'city_train', 'funicular'],
    name: 'Разова поїздка в комунальному транспорті', kind: 'single_ride', status: 'verified_static',
    currency: 'UAH', priceMinor: 3_000, pricePerRideMinor: 3_000, fareMedia: ['single_ticket', 'transport_card', 'qr'],
    riderCategory: 'adult', effectiveFrom: '2026-07-15', sourceName: 'Портал Києва — тарифи з 15 липня 2026 року',
    sourceUrl: 'https://kyivcity.gov.ua/news/iz_15_lipnya_vartist_razovogo_prozdu_v_komunalnomu_transporti_stanovitime_30_grn_dlya_postiynikh_pasazhiriv_diyatime_sistema_znizhok/',
    lastVerifiedAt: VERIFIED_AT,
  },
  {
    id: 'kyiv-90-minute-transfer-ticket', city: 'Київ',
    modes: ['bus', 'tram', 'trolleybus', 'metro', 'city_train', 'funicular'],
    name: 'Пересадковий квиток на 90 хвилин', kind: 'transfer_ticket', status: 'verified_static',
    currency: 'UAH', priceMinor: 6_000, validitySeconds: 5_400, transferValiditySeconds: 5_400,
    transferCount: 'unlimited', fareMedia: ['qr'], riderCategory: 'adult', effectiveFrom: '2026-08-01',
    sourceName: 'Портал Києва — пересадковий QR-квиток з 1 серпня 2026 року',
    sourceUrl: 'https://kyivcity.gov.ua/news/iz_1_serpnya_v_kiyevi_zaprovadzhuyut_peresadkoviy_QR-kvitok_iz_bezlimitnimi_peresadkami_protyagom_90_khvilin/',
    lastVerifiedAt: VERIFIED_AT,
    notes: ['QR-квиток дозволяє безлімітні пересадки 90 хвилин між міськими видами транспорту; приватні маршрутки не включені.'],
  },
  ...[
    { min: 10, max: 19, perRide: 2_890 }, { min: 20, max: 29, perRide: 2_780 },
    { min: 30, max: 39, perRide: 2_660 }, { min: 40, max: 49, perRide: 2_550 },
    { min: 50, max: 50, perRide: 2_500 },
  ].map(({ min, max, perRide }) => ({
    id: `kyiv-stored-value-${min}-${max}`, city: 'Київ', modes: ['bus', 'tram', 'trolleybus', 'metro', 'city_train', 'funicular'],
    name: `Тариф транспортної картки: ${min}${min === max ? '' : `–${max}`} поїздок`, kind: 'stored_value_tier' as const,
    status: 'verified_static' as const, currency: 'UAH' as const, priceMinor: null, pricePerRideMinor: perRide,
    minRideCount: min, maxRideCount: max, riderCategory: 'adult' as const, effectiveFrom: '2026-07-15',
    sourceName: 'Портал Києва — тарифи з 15 липня 2026 року',
    sourceUrl: 'https://kyivcity.gov.ua/news/iz_15_lipnya_vartist_razovogo_prozdu_v_komunalnomu_transporti_stanovitime_30_grn_dlya_postiynikh_pasazhiriv_diyatime_sistema_znizhok/',
    lastVerifiedAt: VERIFIED_AT,
  })),
  ...[
    { rides: 46, price: 108_800 }, { rides: 62, price: 146_300 },
    { rides: 92, price: 215_600 }, { rides: 124, price: 288_800 },
  ].map(({ rides, price }) => ({
    id: `kyiv-monthly-${rides}`, city: 'Київ', modes: ['bus', 'tram', 'trolleybus', 'metro', 'city_train', 'funicular'],
    name: `Місячний проїзний на ${rides} поїздок`, kind: 'monthly_pass' as const,
    status: 'verified_static' as const, currency: 'UAH' as const, priceMinor: price, rideCount: rides,
    pricePerRideMinor: Math.round(price / rides),
    riderCategory: 'adult' as const, effectiveFrom: '2026-07-15', sourceName: 'Портал Києва — тарифи з 15 липня 2026 року',
    sourceUrl: 'https://kyivcity.gov.ua/news/iz_15_lipnya_vartist_razovogo_prozdu_v_komunalnomu_transporti_stanovitime_30_grn_dlya_postiynikh_pasazhiriv_diyatime_sistema_znizhok/',
    lastVerifiedAt: VERIFIED_AT,
  })),
  ...[
    { hours: 24, price: 37_500 }, { hours: 48, price: 56_300 }, { hours: 72, price: 75_000 },
  ].map(({ hours, price }) => ({
    id: `kyiv-time-pass-${hours}h`, city: 'Київ', modes: ['bus', 'tram', 'trolleybus', 'metro', 'city_train', 'funicular'],
    name: `Безлімітний квиток на ${hours} год.`, kind: 'time_pass' as const,
    status: 'verified_static' as const, currency: 'UAH' as const, priceMinor: price,
    validitySeconds: hours * 60 * 60, transferCount: 'unlimited' as const, riderCategory: 'adult' as const,
    effectiveFrom: '2026-07-15', sourceName: 'Портал Києва — тарифи з 15 липня 2026 року',
    sourceUrl: 'https://kyivcity.gov.ua/news/iz_15_lipnya_vartist_razovogo_prozdu_v_komunalnomu_transporti_stanovitime_30_grn_dlya_postiynikh_pasazhiriv_diyatime_sistema_znizhok/',
    lastVerifiedAt: VERIFIED_AT,
  })),
  ...[
    { id: 'lviv-leocard-adult', name: 'Разова поїздка: ЛеоКарт або застосунок', amount: 2_300, media: ['leocard', 'leocard_app'], category: 'adult' as const },
    { id: 'lviv-bank-card-adult', name: 'Разова поїздка: банківська картка/NFC', amount: 2_600, media: ['bank_card', 'nfc'], category: 'adult' as const },
    { id: 'lviv-cash-adult', name: 'Разова поїздка: готівкою у водія', amount: 3_000, media: ['cash'], category: 'adult' as const },
    { id: 'lviv-student-leocard', name: 'Разова поїздка: студентська ЛеоКарт', amount: 1_150, media: ['student_leocard'], category: 'student' as const },
  ].map(({ id, name, amount, media, category }) => ({
    id, city: 'Львів', modes: ['bus', 'tram', 'trolleybus'], name,
    kind: 'single_ride' as const, status: 'verified_static' as const, currency: 'UAH' as const,
    priceMinor: amount, pricePerRideMinor: amount, fareMedia: media, riderCategory: category,
    effectiveFrom: '2026-05-16', sourceName: 'ЛК АТП-1 Львів — оплата проїзду',
    sourceUrl: 'https://atp1.lviv.ua/passengers/payment/', lastVerifiedAt: VERIFIED_AT,
  })),
  {
    id: 'lviv-leocard-40-minute-transfer', city: 'Львів', modes: ['bus', 'tram', 'trolleybus'],
    name: 'Безоплатні пересадки з ЛеоКарт/LeoCard протягом 40 хвилин', kind: 'transfer_ticket',
    status: 'verified_static', currency: 'UAH', priceMinor: 0, validitySeconds: 2_400,
    transferValiditySeconds: 2_400, transferCount: 'unlimited', fareMedia: ['leocard', 'leocard_app'],
    riderCategory: 'adult', effectiveFrom: '2026-05-16', sourceName: 'ЛК АТП-1 Львів — правила безоплатної пересадки',
    sourceUrl: 'https://atp1.lviv.ua/passengers/payment/', lastVerifiedAt: VERIFIED_AT,
  },
  {
    id: 'lviv-monthly-adult', city: 'Львів', modes: ['tram', 'trolleybus'],
    name: 'Місячний безлімітний абонемент', kind: 'monthly_pass', status: 'verified_static',
    currency: 'UAH', priceMinor: 115_000, riderCategory: 'adult',
    sourceName: 'Lviv.travel — тарифний довідник міського транспорту',
    sourceUrl: 'https://lviv.travel/ua/news/gaid-lvivskim-gromadskim-transportom', lastVerifiedAt: VERIFIED_AT,
    notes: ['Вказаний у джерелі для трамваїв і тролейбусів.'],
  },
  {
    id: 'lviv-monthly-student', city: 'Львів', modes: ['tram', 'trolleybus'],
    name: 'Студентський місячний безлімітний абонемент', kind: 'monthly_pass', status: 'verified_static',
    currency: 'UAH', priceMinor: 43_500, riderCategory: 'student',
    sourceName: 'Lviv.travel — тарифний довідник міського транспорту',
    sourceUrl: 'https://lviv.travel/ua/news/gaid-lvivskim-gromadskim-transportom', lastVerifiedAt: VERIFIED_AT,
    notes: ['Вказаний у джерелі для трамваїв і тролейбусів.'],
  },
  {
    id: 'dnipro-metro-single-ride', city: 'Дніпро', modes: ['metro'],
    name: 'Разова поїздка в метро', kind: 'single_ride', status: 'verified_static', currency: 'UAH',
    priceMinor: 1_000, pricePerRideMinor: 1_000, riderCategory: 'adult', sourceName: 'КП «Дніпровський метрополітен» — оплата проїзду',
    sourceUrl: 'https://metro.dp.ua/payment/', lastVerifiedAt: VERIFIED_AT,
  },
  ...[
    { id: 'dnipro-monthly-combined-full', name: 'Комбінований місячний: трамвай + тролейбус + метро', price: 90_000, category: 'adult' as const },
    { id: 'dnipro-monthly-combined-student', name: 'Комбінований місячний: трамвай + тролейбус + метро (студентський)', price: 45_000, category: 'student' as const },
    { id: 'dnipro-monthly-two-mode-full', name: 'Комбінований місячний: трамвай + метро або тролейбус + метро', price: 60_000, category: 'adult' as const },
    { id: 'dnipro-monthly-two-mode-student', name: 'Комбінований місячний: трамвай + метро або тролейбус + метро (студентський)', price: 30_000, category: 'student' as const },
  ].map(({ id, name, price, category }) => ({
    id, city: 'Дніпро', modes: ['metro', 'tram', 'trolleybus'], name, kind: 'monthly_pass' as const,
    status: 'verified_static' as const, currency: 'UAH' as const, priceMinor: price,
    riderCategory: category, sourceName: 'КП «Дніпровський метрополітен» — оплата проїзду',
    sourceUrl: 'https://metro.dp.ua/payment/', lastVerifiedAt: VERIFIED_AT,
  })),
  {
    id: 'kharkiv-metro-free-ride', city: 'Харків', modes: ['metro'],
    name: 'Безоплатний проїзд у метро', kind: 'single_ride', status: 'verified_static', currency: 'UAH',
    priceMinor: 0, pricePerRideMinor: 0, riderCategory: 'all', sourceName: 'КП «Харківський метрополітен»',
    sourceUrl: 'https://www.metro.kharkiv.ua/kp-%C2%ABkhakrkivskyi-metkropoliten%C2%BB-vitaie-z-dnem-mistsevoho-samovkriaduvannia%21.html',
    lastVerifiedAt: VERIFIED_AT, notes: ['Безоплатний проїзд підтверджений останньою доступною публікацією оператора; оновлювати під час перевірки тарифів.'],
  },
  {
    id: 'intercity-bus-provider-quote', city: null, modes: ['intercity_bus', 'suburban_bus'],
    name: 'Міжміський/приміський автобус — ціна конкретного рейсу', kind: 'dynamic_quote',
    status: 'dynamic_quote', currency: 'UAH', priceMinor: null, sourceName: 'GTFS fare files або API перевізника/агрегатора',
    sourceUrl: 'https://data.gov.ua/', lastVerifiedAt: VERIFIED_AT,
    notes: ['Єдиної загальноукраїнської ціни немає. Якщо GTFS не містить тарифів, потрібне live-quote API рейсу; значення 60 грн не переноситься між маршрутами.'],
  },
  {
    id: 'ukrzaliznytsia-intercity-quote', city: null, modes: ['train'],
    name: 'Поїзд далекого сполучення — ціна за рейсом/класом/датою', kind: 'dynamic_quote',
    status: 'dynamic_quote', currency: 'UAH', priceMinor: null, sourceName: 'Укрзалізниця — система продажу квитків',
    sourceUrl: 'https://booking.uz.gov.ua/', lastVerifiedAt: VERIFIED_AT,
    notes: ['Потрібен квитковий API або чинний тариф конкретного поїзда, класу й дати; GTFS-геометрія сама по собі ціни не задає.'],
  },
  {
    id: 'taxi-provider-quote', city: null, modes: ['taxi'],
    name: 'Таксі — динамічне котирування перед замовленням', kind: 'dynamic_quote',
    status: 'requires_partner_access', currency: 'UAH', priceMinor: null, sourceName: 'Uber Rider API / погоджений API оператора',
    sourceUrl: 'https://developer.uber.com/docs/riders/guides/authentication/introduction', lastVerifiedAt: VERIFIED_AT,
    notes: ['Uklon Delivery API не є пасажирським таксі API. Потрібні окремий партнерський доступ і live estimate; неофіційні driver API не використовуються.'],
  },
  {
    id: 'micromobility-provider-quote', city: null, modes: ['bicycle', 'scooter', 'carsharing'],
    name: 'Шеринг — тариф із system_pricing_plans або API оператора', kind: 'dynamic_quote',
    status: 'requires_partner_access', currency: null, priceMinor: null, sourceName: 'GBFS pricing feed / партнерський API оператора',
    sourceUrl: 'https://gbfs.org/documentation/reference/', lastVerifiedAt: VERIFIED_AT,
    notes: ['Позиція/наявність з GBFS не є ціною. Відображати вартість можна тільки після завантаження pricing plans і підтвердження умов повторного використання.'],
  },
  {
    id: 'transfer-provider-quote', city: null, modes: ['transfer'],
    name: 'Трансфер — live quote від постачальника', kind: 'dynamic_quote',
    status: 'requires_partner_access', currency: 'UAH', priceMinor: null, sourceName: 'Intui / GetTransfer / KiwiTaxi / інший B2B API',
    sourceUrl: 'https://partner.intui.travel/', lastVerifiedAt: VERIFIED_AT,
    notes: ['Ціна й доступність залежать від дати, маршруту та класу авто; до підключення партнерського API ціна невідома.'],
  },
];

export function getTransportFareCatalog(filters: { city?: string; mode?: string } = {}) {
  const city = filters.city?.trim().toLocaleLowerCase('uk-UA');
  const mode = filters.mode?.trim().toLocaleLowerCase('uk-UA');
  return transportFareCatalog.filter((record) => (!city || record.city?.toLocaleLowerCase('uk-UA') === city)
    && (!mode || record.modes.includes(mode)));
}

type FareLegInput = {
  providerCity?: string;
  mode: string;
  transportType: string;
  departureAt: Date;
  arrivalAt: Date;
};

function cityKey(value: string | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase('uk-UA');
  if (!normalized) return null;
  if (normalized.includes('київ') || normalized.includes('киев')) return 'kyiv';
  if (normalized.includes('львів') || normalized.includes('львов')) return 'lviv';
  if (normalized.includes('дніпр')) return 'dnipro';
  if (normalized.includes('харків') || normalized.includes('харьков')) return 'kharkiv';
  return null;
}

function modeKey(leg: FareLegInput): string {
  const type = leg.transportType.toLocaleLowerCase('uk-UA');
  if (type && type !== 'unknown') return type;
  const mode = leg.mode.toLocaleLowerCase('uk-UA');
  return mode === 'rail' ? 'train' : mode;
}

function validLegs(legs: readonly FareLegInput[]): boolean {
  return legs.length > 0 && legs.every((leg, index) => Number.isFinite(leg.departureAt.getTime())
    && Number.isFinite(leg.arrivalAt.getTime()) && leg.arrivalAt >= leg.departureAt
    && (index === 0 || leg.departureAt >= legs[index - 1]!.arrivalAt));
}

function fareResult(priceMinor: number, allocations: GtfsItineraryFare['allocations']): GtfsItineraryFare | null {
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0 || allocations.length === 0) return null;
  return { priceMinor, currency: 'UAH', allocations, source: 'city-tariff-registry' };
}

function perRideFare(legs: readonly FareLegInput[], priceMinor: number, fareProductId: string): GtfsItineraryFare | null {
  return fareResult(priceMinor * legs.length, legs.map(() => ({ priceMinor, currency: 'UAH', fareProductId, includedByPreviousFare: false })));
}

/** Estimate a complete itinerary only when every ride is covered by a published tariff for the same city. */
export function calculateCityTariffFare(legs: readonly FareLegInput[]): GtfsItineraryFare | null {
  if (!validLegs(legs)) return null;
  const city = cityKey(legs[0]?.providerCity);
  if (!city || legs.some((leg) => cityKey(leg.providerCity) !== city)) return null;
  const types = legs.map(modeKey);

  if (city === 'lviv') {
    const allowed = new Set(['bus', 'tram', 'trolleybus']);
    if (types.some((type) => !allowed.has(type))) return null;
    let paidThrough = Number.NEGATIVE_INFINITY;
    let total = 0;
    const allocations = legs.map((leg) => {
      if (leg.departureAt.getTime() <= paidThrough) {
        return { priceMinor: 0, currency: 'UAH', fareProductId: 'lviv-leocard-40-minute-transfer', includedByPreviousFare: true };
      }
      paidThrough = leg.departureAt.getTime() + 40 * 60_000;
      total += 2_300;
      return { priceMinor: 2_300, currency: 'UAH', fareProductId: 'lviv-leocard-adult', includedByPreviousFare: false };
    });
    return fareResult(total, allocations);
  }

  if (city === 'kyiv') {
    const allowed = new Set(['bus', 'tram', 'trolleybus', 'metro', 'city_train', 'funicular']);
    if (types.some((type) => !allowed.has(type))) return null;
    const best = new Array<number>(legs.length + 1).fill(Number.POSITIVE_INFINITY);
    const choice = new Array<{ end: number; productId: string } | null>(legs.length).fill(null);
    best[legs.length] = 0;
    for (let start = legs.length - 1; start >= 0; start--) {
      best[start] = 3_000 + best[start + 1]!;
      choice[start] = { end: start + 1, productId: 'kyiv-communal-single-ride' };
      for (let end = start + 2; end <= legs.length; end++) {
        if (legs[end - 1]!.departureAt.getTime() - legs[start]!.departureAt.getTime() > 90 * 60_000) break;
        const candidate = 6_000 + best[end]!;
        if (candidate < best[start]!) {
          best[start] = candidate;
          choice[start] = { end, productId: 'kyiv-90-minute-transfer-ticket' };
        }
      }
    }
    const allocations = legs.map(() => ({ priceMinor: 0, currency: 'UAH', fareProductId: 'kyiv-90-minute-transfer-ticket', includedByPreviousFare: true }));
    for (let start = 0; start < legs.length;) {
      const selected = choice[start];
      if (!selected) return null;
      allocations[start] = { priceMinor: selected.productId === 'kyiv-90-minute-transfer-ticket' ? 6_000 : 3_000,
        currency: 'UAH', fareProductId: selected.productId, includedByPreviousFare: false };
      for (let index = start + 1; index < selected.end; index++) {
        allocations[index] = { priceMinor: 0, currency: 'UAH', fareProductId: selected.productId, includedByPreviousFare: true };
      }
      start = selected.end;
    }
    return fareResult(best[0]!, allocations);
  }

  if (city === 'dnipro' && types.every((type) => type === 'metro')) {
    return perRideFare(legs, 1_000, 'dnipro-metro-single-ride');
  }
  if (city === 'kharkiv' && types.every((type) => type === 'metro')) {
    return perRideFare(legs, 0, 'kharkiv-metro-free-ride');
  }
  return null;
}
