/**
 * MARSHGO Ukraine Multi-City Transit Graph & Intercity Corridors
 * Official transit networks, rapid transit lines, and intercity hubs across Ukraine:
 * - Kyiv (Metro, City Express, Funicular, Kyivpasstrans)
 * - Lviv (Lvivelectrotrans Trams & Trolleybuses, Railway Hubs)
 * - Odesa (Odesmiskelektrotrans Trams & Trolleybuses, Railway Hub)
 * - Kharkiv (Kharkiv Metro, Trams, Railway Hub)
 * - Dnipro (Dnipro Metro, Trams, Railway Hub)
 * - Major Ukrainian Regional Hubs & Intercity+ Corridors (Укрзалізниця)
 */

import { haversineMeters } from './kyivTransitGraph';

export interface UkraineTransitStation {
  id: string;
  city: string;
  name: string;
  nameEng?: string;
  line: string;
  mode: 'METRO' | 'TRAM' | 'TROLLEYBUS' | 'RAIL' | 'FUNICULAR' | 'BUS';
  transportType: 'metro' | 'tram' | 'trolleybus' | 'train' | 'funicular' | 'bus';
  coordinates: [number, number]; // [lon, lat]
  transferToStationId?: string;
  transferHubName?: string;
  isIntercityHub?: boolean;
}

export interface UkraineTransitSegment {
  mode: 'METRO' | 'TRAM' | 'TROLLEYBUS' | 'RAIL' | 'FUNICULAR' | 'BUS';
  transportType: 'metro' | 'tram' | 'trolleybus' | 'train' | 'funicular' | 'bus';
  providerId: string;
  providerName: string;
  lineName: string;
  originStation: UkraineTransitStation;
  destinationStation: UkraineTransitStation;
  intermediateStations: UkraineTransitStation[];
  durationSeconds: number;
  distanceMeters: number;
  fareMinor: number;
}

export interface UkraineTransitItinerary {
  id: string;
  city: string;
  segments: UkraineTransitSegment[];
  transfers: number;
  transferWalkingMeters: number[];
  transferWalkingSeconds: number[];
  totalDurationSeconds: number;
  totalDistanceMeters: number;
  totalFareMinor: number;
  originStation: UkraineTransitStation;
  destinationStation: UkraineTransitStation;
  distanceToOriginStationMeters: number;
  distanceFromDestinationStationMeters: number;
}

// -----------------------------------------------------------------------------------------
// 1. LVIV TRANSIT NETWORK (Львівелектротранс)
// -----------------------------------------------------------------------------------------
export const LVIV_TRANSIT_STATIONS: UkraineTransitStation[] = [
  // Tram 8 / 4: Сихів ↔ Соборна / Вокзал
  { id: 'lv_tr_01', city: 'Львів', name: 'вул. Вернадського (Сихів)', line: 'Трамвай №8', mode: 'TRAM', transportType: 'tram', coordinates: [24.0620, 49.7915] },
  { id: 'lv_tr_02', city: 'Львів', name: 'Санта-Барбара', line: 'Трамвай №8', mode: 'TRAM', transportType: 'tram', coordinates: [24.0560, 49.7942] },
  { id: 'lv_tr_03', city: 'Львів', name: 'Поліклініка №4', line: 'Трамвай №8', mode: 'TRAM', transportType: 'tram', coordinates: [24.0482, 49.7981] },
  { id: 'lv_tr_04', city: 'Львів', name: 'Верхній Шувар', line: 'Трамвай №8', mode: 'TRAM', transportType: 'tram', coordinates: [24.0371, 49.8054] },
  { id: 'lv_tr_05', city: 'Львів', name: 'Академія мистецтв', line: 'Трамвай №8', mode: 'TRAM', transportType: 'tram', coordinates: [24.0350, 49.8245] },
  { id: 'lv_tr_06', city: 'Львів', name: 'пл. Соборна (Центр)', line: 'Трамвай №8', mode: 'TRAM', transportType: 'tram', coordinates: [24.0345, 49.8398], transferToStationId: 'lv_tr_11', transferHubName: 'Соборна ↔ пл. Ринок' },

  // Tram 1 / 6 / 9: Залізничний вокзал ↔ Центр / Підзамче
  { id: 'lv_tr_07', city: 'Львів', name: 'Залізничний вокзал (Львів-Головний)', line: 'Трамвай №1', mode: 'TRAM', transportType: 'tram', coordinates: [23.9950, 49.8358], isIntercityHub: true },
  { id: 'lv_tr_08', city: 'Львів', name: 'Привокзальний ринок', line: 'Трамвай №1', mode: 'TRAM', transportType: 'tram', coordinates: [24.0042, 49.8352] },
  { id: 'lv_tr_09', city: 'Львів', name: 'пл. Кропивницького', line: 'Трамвай №1', mode: 'TRAM', transportType: 'tram', coordinates: [24.0118, 49.8365] },
  { id: 'lv_tr_10', city: 'Львів', name: 'Головна пошта', line: 'Трамвай №1', mode: 'TRAM', transportType: 'tram', coordinates: [24.0245, 49.8375] },
  { id: 'lv_tr_11', city: 'Львів', name: 'пл. Ринок (Ратуша)', line: 'Трамвай №1', mode: 'TRAM', transportType: 'tram', coordinates: [24.0315, 49.8418] },
  { id: 'lv_tr_12', city: 'Львів', name: 'ст. Підзамче', line: 'Трамвай №6', mode: 'TRAM', transportType: 'tram', coordinates: [24.0450, 49.8512], isIntercityHub: true },
  { id: 'lv_tr_13', city: 'Львів', name: 'Центральний Автовокзал (Стрийська)', line: 'Тролейбус №25', mode: 'TROLLEYBUS', transportType: 'trolleybus', coordinates: [24.0185, 49.7865], isIntercityHub: true },

  // Шевченківський район / Голоско (Варшавська / Чорновола / Торф'яна)
  { id: 'lv_tr_14', city: 'Львів', name: 'вул. Варшавська (Голоско)', line: 'Автобус №47А', mode: 'BUS', transportType: 'bus', coordinates: [24.0075, 49.8645] },
  { id: 'lv_tr_15', city: 'Львів', name: 'просп. В. Чорновола', line: 'Тролейбус №33', mode: 'TROLLEYBUS', transportType: 'trolleybus', coordinates: [24.0185, 49.8550], transferToStationId: 'lv_tr_11', transferHubName: 'Чорновола ↔ Центр' },
  { id: 'lv_tr_16', city: 'Львів', name: 'вул. Торф’яна (Замарстинів)', line: 'Трамвай №9', mode: 'TRAM', transportType: 'tram', coordinates: [24.0255, 49.8610], transferToStationId: 'lv_tr_07', transferHubName: 'Торф’яна ↔ Вокзал' },
  { id: 'lv_tr_17', city: 'Львів', name: 'вул. Мазепи (Топольна)', line: 'Автобус №46', mode: 'BUS', transportType: 'bus', coordinates: [24.0320, 49.8710] },
];

// -----------------------------------------------------------------------------------------
// 2. ODESA TRANSIT NETWORK (Одесміськелектротранс)
// -----------------------------------------------------------------------------------------
export const ODESA_TRANSIT_STATIONS: UkraineTransitStation[] = [
  // Tram 5 / 28: Аркадія ↔ Вокзал ↔ Автовокзал
  { id: 'od_tr_01', city: 'Одеса', name: 'Аркадія', line: 'Трамвай №5', mode: 'TRAM', transportType: 'tram', coordinates: [30.7675, 46.4298] },
  { id: 'od_tr_02', city: 'Одеса', name: 'пл. 10 Квітня', line: 'Трамвай №5', mode: 'TRAM', transportType: 'tram', coordinates: [30.7554, 46.4385] },
  { id: 'od_tr_03', city: 'Одеса', name: 'Французький бульвар', line: 'Трамвай №5', mode: 'TRAM', transportType: 'tram', coordinates: [30.7521, 46.4520] },
  { id: 'od_tr_04', city: 'Одеса', name: 'Залізничний вокзал (Одеса-Головна)', line: 'Трамвай №5', mode: 'TRAM', transportType: 'tram', coordinates: [30.7412, 46.4674], isIntercityHub: true },
  { id: 'od_tr_05', city: 'Одеса', name: 'пл. Тираспольська (Центр)', line: 'Трамвай №28', mode: 'TRAM', transportType: 'tram', coordinates: [30.7295, 46.4801] },
  { id: 'od_tr_06', city: 'Одеса', name: 'Центральний Автовокзал (Колонтаївська)', line: 'Трамвай №5', mode: 'TRAM', transportType: 'tram', coordinates: [30.7092, 46.4785], isIntercityHub: true },
  { id: 'od_tr_07', city: 'Одеса', name: 'вул. Паустовського (Селище Котовського)', line: 'Трамвай №7', mode: 'TRAM', transportType: 'tram', coordinates: [30.7985, 46.5892] },
];

// -----------------------------------------------------------------------------------------
// 3. KHARKIV METRO (КП «Харківський метрополітен»)
// -----------------------------------------------------------------------------------------
export const KHARKIV_TRANSIT_STATIONS: UkraineTransitStation[] = [
  // Line 1: Холодногірсько-Заводська
  { id: 'kh_m1_01', city: 'Харків', name: 'Холодна гора', line: 'Холодногірсько-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.1802, 49.9825] },
  { id: 'kh_m1_02', city: 'Харків', name: 'Південний вокзал (Харків-Пас.)', line: 'Холодногірсько-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2050, 49.9880], isIntercityHub: true },
  { id: 'kh_m1_03', city: 'Харків', name: 'Центральний ринок', line: 'Холодногірсько-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2198, 49.9912] },
  { id: 'kh_m1_04', city: 'Харків', name: 'Майдан Конституції', line: 'Холодногірсько-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2325, 49.9928], transferToStationId: 'kh_m2_01', transferHubName: 'Майдан Конституції ↔ Історичний музей' },
  { id: 'kh_m1_05', city: 'Харків', name: 'Турбоатом', line: 'Холодногірсько-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2875, 49.9750] },
  { id: 'kh_m1_06', city: 'Харків', name: 'Індустріальна', line: 'Холодногірсько-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.3685, 49.9415] },

  // Line 2: Салтівська
  { id: 'kh_m2_01', city: 'Харків', name: 'Історичний музей', line: 'Салтівська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2312, 49.9935], transferToStationId: 'kh_m1_04', transferHubName: 'Історичний музей ↔ Майдан Конституції' },
  { id: 'kh_m2_02', city: 'Харків', name: 'Університет', line: 'Салтівська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2365, 50.0042], transferToStationId: 'kh_m3_02', transferHubName: 'Університет ↔ Держпром' },
  { id: 'kh_m2_03', city: 'Харків', name: 'Київська', line: 'Салтівська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2625, 50.0055] },
  { id: 'kh_m2_04', city: 'Харків', name: 'Академіка Барабашова', line: 'Салтівська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2995, 50.0078] },
  { id: 'kh_m2_05', city: 'Харків', name: 'Героїв Праці (Салтівка)', line: 'Салтівська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.3245, 50.0245] },

  // Line 3: Олексіївська
  { id: 'kh_m3_01', city: 'Харків', name: 'Метробудівників', line: 'Олексіївська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2615, 49.9805] },
  { id: 'kh_m3_02', city: 'Харків', name: 'Держпром', line: 'Олексіївська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2345, 50.0062], transferToStationId: 'kh_m2_02', transferHubName: 'Держпром ↔ Університет' },
  { id: 'kh_m3_03', city: 'Харків', name: 'Перемога (Олексіївка)', line: 'Олексіївська лінія', mode: 'METRO', transportType: 'metro', coordinates: [36.2085, 50.0575] },
];

// -----------------------------------------------------------------------------------------
// 4. DNIPRO TRANSIT NETWORK (КП «Дніпровський метрополітен» та трамваї)
// -----------------------------------------------------------------------------------------
export const DNIPRO_TRANSIT_STATIONS: UkraineTransitStation[] = [
  // Metro: Покровська ↔ Вокзальна
  { id: 'dp_m1_01', city: 'Дніпро', name: 'Покровська', line: 'Центрально-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [34.9255, 48.4835] },
  { id: 'dp_m1_02', city: 'Дніпро', name: 'Проспект Свободи', line: 'Центрально-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [34.9485, 48.4802] },
  { id: 'dp_m1_03', city: 'Дніпро', name: 'Заводська', line: 'Центрально-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [34.9725, 48.4785] },
  { id: 'dp_m1_04', city: 'Дніпро', name: 'Металургів', line: 'Центрально-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [34.9925, 48.4765] },
  { id: 'dp_m1_05', city: 'Дніпро', name: 'Метробудівників', line: 'Центрально-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [35.0085, 48.4755] },
  { id: 'dp_m1_06', city: 'Дніпро', name: 'Вокзальна (Дніпро-Головний)', line: 'Центрально-Заводська лінія', mode: 'METRO', transportType: 'metro', coordinates: [35.0165, 48.4760], isIntercityHub: true },

  // Tram 1: Вокзал ↔ пл. Соборна ↔ Університет
  { id: 'dp_tr_01', city: 'Дніпро', name: 'пл. Вокзальна', line: 'Трамвай №1', mode: 'TRAM', transportType: 'tram', coordinates: [35.0175, 48.4770], isIntercityHub: true },
  { id: 'dp_tr_02', city: 'Дніпро', name: 'вул. Столярова', line: 'Трамвай №1', mode: 'TRAM', transportType: 'tram', coordinates: [35.0345, 48.4695] },
  { id: 'dp_tr_03', city: 'Дніпро', name: 'ЦУМ (Центр)', line: 'Трамвай №1', mode: 'TRAM', transportType: 'tram', coordinates: [35.0485, 48.4645] },
  { id: 'dp_tr_04', city: 'Дніпро', name: 'пл. Соборна', line: 'Трамвай №1', mode: 'TRAM', transportType: 'tram', coordinates: [35.0655, 48.4575] },
  { id: 'dp_tr_05', city: 'Дніпро', name: 'ДІІТ (Університет)', line: 'Трамвай №1', mode: 'TRAM', transportType: 'tram', coordinates: [35.0495, 48.4355] },
];

// -----------------------------------------------------------------------------------------
// 5. REGIONAL HUBS ACROSS UKRAINE (Залізничні вокзали та автовокзали міст)
// -----------------------------------------------------------------------------------------
export const UKRAINE_REGIONAL_HUBS: UkraineTransitStation[] = [
  { id: 'hub_kyiv', city: 'Київ', name: 'Київ-Пасажирський (Центральний вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [30.4884, 50.4418], isIntercityHub: true },
  { id: 'hub_kyiv_darnytsia', city: 'Київ', name: 'Київ-Дарниця', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [30.6450, 50.4435], isIntercityHub: true },
  { id: 'hub_lviv', city: 'Львів', name: 'Львів-Головний', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [23.9950, 49.8358], isIntercityHub: true },
  { id: 'hub_odesa', city: 'Одеса', name: 'Одеса-Головна', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [30.7412, 46.4674], isIntercityHub: true },
  { id: 'hub_kharkiv', city: 'Харків', name: 'Харків-Пасажирський', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [36.2050, 49.9880], isIntercityHub: true },
  { id: 'hub_dnipro', city: 'Дніпро', name: 'Дніпро-Головний', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [35.0165, 48.4760], isIntercityHub: true },
  { id: 'hub_ivano_frankivsk', city: 'Івано-Франківськ', name: 'Івано-Франківськ (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [24.7215, 48.9230], isIntercityHub: true },
  { id: 'hub_vinnytsia', city: 'Вінниця', name: 'Вінниця (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [28.5130, 49.2390], isIntercityHub: true },
  { id: 'hub_zaporizhzhia', city: 'Запоріжжя', name: 'Запоріжжя-1', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [35.1950, 47.7950], isIntercityHub: true },
  { id: 'hub_poltava', city: 'Полтава', name: 'Полтава-Київська', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [34.5200, 49.5950], isIntercityHub: true },
  { id: 'hub_chernivtsi', city: 'Чернівці', name: 'Чернівці (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [25.9390, 48.3000], isIntercityHub: true },
  { id: 'hub_uzhhorod', city: 'Ужгород', name: 'Ужгород (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [22.3015, 48.6090], isIntercityHub: true },
  { id: 'hub_ternopil', city: 'Тернопіль', name: 'Тернопіль (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [25.6020, 49.5530], isIntercityHub: true },
  { id: 'hub_khmelnytskyi', city: 'Хмельницький', name: 'Хмельницький (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [27.0010, 49.4210], isIntercityHub: true },
  { id: 'hub_rivne', city: 'Рівне', name: 'Рівне (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [26.2410, 50.6270], isIntercityHub: true },
  { id: 'hub_lutsk', city: 'Луцьк', name: 'Луцьк (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [25.3520, 50.7580], isIntercityHub: true },
  { id: 'hub_zhytomyr', city: 'Житомир', name: 'Житомир (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [28.6940, 50.2680], isIntercityHub: true },
  { id: 'hub_cherkasy', city: 'Черкаси', name: 'Черкаси (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [32.0450, 49.4250], isIntercityHub: true },
  { id: 'hub_chernihiv', city: 'Чернігів', name: 'Чернігів (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [31.2750, 51.4880], isIntercityHub: true },
  { id: 'hub_sumy', city: 'Суми', name: 'Суми (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [34.8150, 50.9250], isIntercityHub: true },
  { id: 'hub_kropyvnytskyi', city: 'Кропивницький', name: 'Кропивницький (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [32.2610, 48.5180], isIntercityHub: true },
  { id: 'hub_mykolaiv', city: 'Миколаїв', name: 'Миколаїв (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [32.0720, 46.9490], isIntercityHub: true },
  { id: 'hub_kryvyi_rih', city: 'Кривий Ріг', name: 'Кривий Ріг-Головний', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [33.4750, 47.9120], isIntercityHub: true },
  { id: 'hub_kremenchuk', city: 'Кременчук', name: 'Кременчук (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [33.4350, 49.0720], isIntercityHub: true },
  { id: 'hub_bila_tserkva', city: 'Біла Церква', name: 'Біла Церква (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [30.1380, 49.8050], isIntercityHub: true },
  { id: 'hub_stryi', city: 'Стрий', name: 'Стрий (Вокзал)', line: 'Укрзалізниця', mode: 'RAIL', transportType: 'train', coordinates: [23.8550, 49.2550], isIntercityHub: true },
];

// -----------------------------------------------------------------------------------------
// 6. INTERCITY CORRIDOR DEFINITIONS (Укрзалізниця Intercity+ та експреси)
// -----------------------------------------------------------------------------------------
export interface IntercityCorridor {
  fromHubId: string;
  toHubId: string;
  providerName: string;
  trainNumber: string;
  category: 'Intercity+' | 'Регіональний експрес' | 'Нічний швидкий';
  durationSeconds: number;
  distanceMeters: number;
  fareMinor: number; // in UAH minor (kopiykas)
}

export const INTERCITY_CORRIDORS: IntercityCorridor[] = [
  // Київ ↔ Львів
  { fromHubId: 'hub_kyiv', toHubId: 'hub_lviv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№705/706', category: 'Intercity+', durationSeconds: 19800, distanceMeters: 540_000, fareMinor: 48000 },
  { fromHubId: 'hub_lviv', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№705/706', category: 'Intercity+', durationSeconds: 19800, distanceMeters: 540_000, fareMinor: 48000 },

  // Київ ↔ Одеса
  { fromHubId: 'hub_kyiv', toHubId: 'hub_odesa', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№763/764', category: 'Intercity+', durationSeconds: 24600, distanceMeters: 480_000, fareMinor: 45000 },
  { fromHubId: 'hub_odesa', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№763/764', category: 'Intercity+', durationSeconds: 24600, distanceMeters: 480_000, fareMinor: 45000 },

  // Київ ↔ Харків
  { fromHubId: 'hub_kyiv', toHubId: 'hub_kharkiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№722/724', category: 'Intercity+', durationSeconds: 17100, distanceMeters: 470_000, fareMinor: 42000 },
  { fromHubId: 'hub_kharkiv', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№722/724', category: 'Intercity+', durationSeconds: 17100, distanceMeters: 470_000, fareMinor: 42000 },

  // Київ ↔ Дніпро
  { fromHubId: 'hub_kyiv', toHubId: 'hub_dnipro', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№732/734', category: 'Intercity+', durationSeconds: 20400, distanceMeters: 520_000, fareMinor: 41000 },
  { fromHubId: 'hub_dnipro', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№732/734', category: 'Intercity+', durationSeconds: 20400, distanceMeters: 520_000, fareMinor: 41000 },

  // Київ ↔ Вінниця
  { fromHubId: 'hub_kyiv', toHubId: 'hub_vinnytsia', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№771/772', category: 'Intercity+', durationSeconds: 8100, distanceMeters: 220_000, fareMinor: 21000 },
  { fromHubId: 'hub_vinnytsia', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№771/772', category: 'Intercity+', durationSeconds: 8100, distanceMeters: 220_000, fareMinor: 21000 },

  // Львів ↔ Івано-Франківськ
  { fromHubId: 'hub_lviv', toHubId: 'hub_ivano_frankivsk', providerName: 'Укрзалізниця (Прикарпатський експрес)', trainNumber: '№807/808', category: 'Регіональний експрес', durationSeconds: 6900, distanceMeters: 135_000, fareMinor: 15000 },
  { fromHubId: 'hub_ivano_frankivsk', toHubId: 'hub_lviv', providerName: 'Укрзалізниця (Прикарпатський експрес)', trainNumber: '№807/808', category: 'Регіональний експрес', durationSeconds: 6900, distanceMeters: 135_000, fareMinor: 15000 },

  // Львів ↔ Ужгород
  { fromHubId: 'hub_lviv', toHubId: 'hub_uzhhorod', providerName: 'Укрзалізниця (Карпатський експрес)', trainNumber: '№829/830', category: 'Регіональний експрес', durationSeconds: 16800, distanceMeters: 270_000, fareMinor: 23000 },
  { fromHubId: 'hub_uzhhorod', toHubId: 'hub_lviv', providerName: 'Укрзалізниця (Карпатський експрес)', trainNumber: '№829/830', category: 'Регіональний експрес', durationSeconds: 16800, distanceMeters: 270_000, fareMinor: 23000 },

  // Дніпро ↔ Запоріжжя
  { fromHubId: 'hub_dnipro', toHubId: 'hub_zaporizhzhia', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№732', category: 'Intercity+', durationSeconds: 4500, distanceMeters: 85_000, fareMinor: 12000 },
  { fromHubId: 'hub_zaporizhzhia', toHubId: 'hub_dnipro', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№732', category: 'Intercity+', durationSeconds: 4500, distanceMeters: 85_000, fareMinor: 12000 },

  // Київ ↔ Запоріжжя
  { fromHubId: 'hub_kyiv', toHubId: 'hub_zaporizhzhia', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№738/737', category: 'Intercity+', durationSeconds: 25900, distanceMeters: 620_000, fareMinor: 49000 },
  { fromHubId: 'hub_zaporizhzhia', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№738/737', category: 'Intercity+', durationSeconds: 25900, distanceMeters: 620_000, fareMinor: 49000 },

  // Київ ↔ Полтава
  { fromHubId: 'hub_kyiv', toHubId: 'hub_poltava', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№724', category: 'Intercity+', durationSeconds: 11700, distanceMeters: 330_000, fareMinor: 29000 },
  { fromHubId: 'hub_poltava', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№724', category: 'Intercity+', durationSeconds: 11700, distanceMeters: 330_000, fareMinor: 29000 },

  // Київ ↔ Чернівці
  { fromHubId: 'hub_kyiv', toHubId: 'hub_chernivtsi', providerName: 'Укрзалізниця (Нічний швидкий)', trainNumber: '№117/118', category: 'Нічний швидкий', durationSeconds: 41400, distanceMeters: 590_000, fareMinor: 39000 },
  { fromHubId: 'hub_chernivtsi', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Нічний швидкий)', trainNumber: '№117/118', category: 'Нічний швидкий', durationSeconds: 41400, distanceMeters: 590_000, fareMinor: 39000 },

  // Львів ↔ Чернівці
  { fromHubId: 'hub_lviv', toHubId: 'hub_chernivtsi', providerName: 'Укрзалізниця (Буковина)', trainNumber: '№702/701', category: 'Регіональний експрес', durationSeconds: 13680, distanceMeters: 260_000, fareMinor: 21000 },
  { fromHubId: 'hub_chernivtsi', toHubId: 'hub_lviv', providerName: 'Укрзалізниця (Буковина)', trainNumber: '№702/701', category: 'Регіональний експрес', durationSeconds: 13680, distanceMeters: 260_000, fareMinor: 21000 },

  // Київ ↔ Івано-Франківськ
  { fromHubId: 'hub_kyiv', toHubId: 'hub_ivano_frankivsk', providerName: 'Укрзалізниця (Нічний швидкий)', trainNumber: '№43/44', category: 'Нічний швидкий', durationSeconds: 30600, distanceMeters: 640_000, fareMinor: 46000 },
  { fromHubId: 'hub_ivano_frankivsk', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Нічний швидкий)', trainNumber: '№43/44', category: 'Нічний швидкий', durationSeconds: 30600, distanceMeters: 640_000, fareMinor: 46000 },

  // Київ ↔ Ужгород
  { fromHubId: 'hub_kyiv', toHubId: 'hub_uzhhorod', providerName: 'Укрзалізниця (Нічний швидкий)', trainNumber: '№29/30', category: 'Нічний швидкий', durationSeconds: 45000, distanceMeters: 810_000, fareMinor: 52000 },
  { fromHubId: 'hub_uzhhorod', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Нічний швидкий)', trainNumber: '№29/30', category: 'Нічний швидкий', durationSeconds: 45000, distanceMeters: 810_000, fareMinor: 52000 },

  // Київ ↔ Тернопіль
  { fromHubId: 'hub_kyiv', toHubId: 'hub_ternopil', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№715/716', category: 'Intercity+', durationSeconds: 19800, distanceMeters: 440_000, fareMinor: 36000 },
  { fromHubId: 'hub_ternopil', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№715/716', category: 'Intercity+', durationSeconds: 19800, distanceMeters: 440_000, fareMinor: 36000 },

  // Львів ↔ Тернопіль
  { fromHubId: 'hub_lviv', toHubId: 'hub_ternopil', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№804', category: 'Регіональний експрес', durationSeconds: 6480, distanceMeters: 130_000, fareMinor: 11000 },
  { fromHubId: 'hub_ternopil', toHubId: 'hub_lviv', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№804', category: 'Регіональний експрес', durationSeconds: 6480, distanceMeters: 130_000, fareMinor: 11000 },

  // Київ ↔ Хмельницький
  { fromHubId: 'hub_kyiv', toHubId: 'hub_khmelnytskyi', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№771/772', category: 'Intercity+', durationSeconds: 15120, distanceMeters: 360_000, fareMinor: 31000 },
  { fromHubId: 'hub_khmelnytskyi', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№771/772', category: 'Intercity+', durationSeconds: 15120, distanceMeters: 360_000, fareMinor: 31000 },

  // Вінниця ↔ Хмельницький
  { fromHubId: 'hub_vinnytsia', toHubId: 'hub_khmelnytskyi', providerName: 'Укрзалізниця (Регіональний поїзд)', trainNumber: '№801', category: 'Регіональний експрес', durationSeconds: 5400, distanceMeters: 120_000, fareMinor: 12000 },
  { fromHubId: 'hub_khmelnytskyi', toHubId: 'hub_vinnytsia', providerName: 'Укрзалізниця (Регіональний поїзд)', trainNumber: '№801', category: 'Регіональний експрес', durationSeconds: 5400, distanceMeters: 120_000, fareMinor: 12000 },

  // Київ ↔ Рівне
  { fromHubId: 'hub_kyiv', toHubId: 'hub_rivne', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№885/886', category: 'Регіональний експрес', durationSeconds: 17280, distanceMeters: 380_000, fareMinor: 28000 },
  { fromHubId: 'hub_rivne', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№885/886', category: 'Регіональний експрес', durationSeconds: 17280, distanceMeters: 380_000, fareMinor: 28000 },

  // Київ ↔ Луцьк
  { fromHubId: 'hub_kyiv', toHubId: 'hub_lutsk', providerName: 'Укрзалізниця (Нічний швидкий)', trainNumber: '№755/756', category: 'Нічний швидкий', durationSeconds: 23400, distanceMeters: 450_000, fareMinor: 34000 },
  { fromHubId: 'hub_lutsk', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Нічний швидкий)', trainNumber: '№755/756', category: 'Нічний швидкий', durationSeconds: 23400, distanceMeters: 450_000, fareMinor: 34000 },

  // Львів ↔ Луцьк
  { fromHubId: 'hub_lviv', toHubId: 'hub_lutsk', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№805/806', category: 'Регіональний експрес', durationSeconds: 9600, distanceMeters: 150_000, fareMinor: 14000 },
  { fromHubId: 'hub_lutsk', toHubId: 'hub_lviv', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№805/806', category: 'Регіональний експрес', durationSeconds: 9600, distanceMeters: 150_000, fareMinor: 14000 },

  // Київ ↔ Житомир
  { fromHubId: 'hub_kyiv', toHubId: 'hub_zhytomyr', providerName: 'Укрзалізниця / inbus.ua', trainNumber: '№867/868', category: 'Регіональний експрес', durationSeconds: 7920, distanceMeters: 140_000, fareMinor: 16000 },
  { fromHubId: 'hub_zhytomyr', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця / inbus.ua', trainNumber: '№867/868', category: 'Регіональний експрес', durationSeconds: 7920, distanceMeters: 140_000, fareMinor: 16000 },

  // Київ ↔ Черкаси
  { fromHubId: 'hub_kyiv', toHubId: 'hub_cherkasy', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№757/758', category: 'Регіональний експрес', durationSeconds: 11520, distanceMeters: 240_000, fareMinor: 22000 },
  { fromHubId: 'hub_cherkasy', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№757/758', category: 'Регіональний експрес', durationSeconds: 11520, distanceMeters: 240_000, fareMinor: 22000 },

  // Київ ↔ Чернігів
  { fromHubId: 'hub_kyiv', toHubId: 'hub_chernihiv', providerName: 'Укрзалізниця (Регіональний поїзд)', trainNumber: '№702/704', category: 'Регіональний експрес', durationSeconds: 7560, distanceMeters: 160_000, fareMinor: 14000 },
  { fromHubId: 'hub_chernihiv', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Регіональний поїзд)', trainNumber: '№702/704', category: 'Регіональний експрес', durationSeconds: 7560, distanceMeters: 160_000, fareMinor: 14000 },

  // Київ ↔ Суми
  { fromHubId: 'hub_kyiv', toHubId: 'hub_sumy', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№779/780', category: 'Регіональний експрес', durationSeconds: 17280, distanceMeters: 350_000, fareMinor: 29000 },
  { fromHubId: 'hub_sumy', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№779/780', category: 'Регіональний експрес', durationSeconds: 17280, distanceMeters: 350_000, fareMinor: 29000 },

  // Київ ↔ Кропивницький
  { fromHubId: 'hub_kyiv', toHubId: 'hub_kropyvnytskyi', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№790/789', category: 'Регіональний експрес', durationSeconds: 16200, distanceMeters: 300_000, fareMinor: 26000 },
  { fromHubId: 'hub_kropyvnytskyi', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№790/789', category: 'Регіональний експрес', durationSeconds: 16200, distanceMeters: 300_000, fareMinor: 26000 },

  // Київ ↔ Миколаїв
  { fromHubId: 'hub_kyiv', toHubId: 'hub_mykolaiv', providerName: 'Укрзалізниця (Нічний швидкий)', trainNumber: '№102/101', category: 'Нічний швидкий', durationSeconds: 32400, distanceMeters: 510_000, fareMinor: 38000 },
  { fromHubId: 'hub_mykolaiv', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Нічний швидкий)', trainNumber: '№102/101', category: 'Нічний швидкий', durationSeconds: 32400, distanceMeters: 510_000, fareMinor: 38000 },

  // Одеса ↔ Миколаїв
  { fromHubId: 'hub_odesa', toHubId: 'hub_mykolaiv', providerName: 'Укрзалізниця / inbus.ua', trainNumber: '№802', category: 'Регіональний експрес', durationSeconds: 7920, distanceMeters: 135_000, fareMinor: 15000 },
  { fromHubId: 'hub_mykolaiv', toHubId: 'hub_odesa', providerName: 'Укрзалізниця / inbus.ua', trainNumber: '№802', category: 'Регіональний експрес', durationSeconds: 7920, distanceMeters: 135_000, fareMinor: 15000 },

  // Київ ↔ Кривий Ріг
  { fromHubId: 'hub_kyiv', toHubId: 'hub_kryvyi_rih', providerName: 'Укрзалізниця (Інтерсіті)', trainNumber: '№75/76', category: 'Intercity+', durationSeconds: 21600, distanceMeters: 460_000, fareMinor: 37000 },
  { fromHubId: 'hub_kryvyi_rih', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті)', trainNumber: '№75/76', category: 'Intercity+', durationSeconds: 21600, distanceMeters: 460_000, fareMinor: 37000 },

  // Дніпро ↔ Кривий Ріг
  { fromHubId: 'hub_dnipro', toHubId: 'hub_kryvyi_rih', providerName: 'Укрзалізниця (Регіональний поїзд)', trainNumber: '№828', category: 'Регіональний експрес', durationSeconds: 10080, distanceMeters: 170_000, fareMinor: 14000 },
  { fromHubId: 'hub_kryvyi_rih', toHubId: 'hub_dnipro', providerName: 'Укрзалізниця (Регіональний поїзд)', trainNumber: '№828', category: 'Регіональний експрес', durationSeconds: 10080, distanceMeters: 170_000, fareMinor: 14000 },

  // Київ ↔ Кременчук
  { fromHubId: 'hub_kyiv', toHubId: 'hub_kremenchuk', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№791/792', category: 'Регіональний експрес', durationSeconds: 17280, distanceMeters: 340_000, fareMinor: 27000 },
  { fromHubId: 'hub_kremenchuk', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№791/792', category: 'Регіональний експрес', durationSeconds: 17280, distanceMeters: 340_000, fareMinor: 27000 },

  // Київ ↔ Біла Церква
  { fromHubId: 'hub_kyiv', toHubId: 'hub_bila_tserkva', providerName: 'Укрзалізниця (Приміський експрес)', trainNumber: '№7037/7038', category: 'Регіональний експрес', durationSeconds: 4680, distanceMeters: 85_000, fareMinor: 8000 },
  { fromHubId: 'hub_bila_tserkva', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Приміський експрес)', trainNumber: '№7037/7038', category: 'Регіональний експрес', durationSeconds: 4680, distanceMeters: 85_000, fareMinor: 8000 },

  // Київ ↔ Стрий
  { fromHubId: 'hub_kyiv', toHubId: 'hub_stryi', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№705/706', category: 'Intercity+', durationSeconds: 22800, distanceMeters: 615_000, fareMinor: 52000 },
  { fromHubId: 'hub_stryi', toHubId: 'hub_kyiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№705/706', category: 'Intercity+', durationSeconds: 22800, distanceMeters: 615_000, fareMinor: 52000 },

  // Харків ↔ Полтава
  { fromHubId: 'hub_kharkiv', toHubId: 'hub_poltava', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№723', category: 'Intercity+', durationSeconds: 5760, distanceMeters: 140_000, fareMinor: 16000 },
  { fromHubId: 'hub_poltava', toHubId: 'hub_kharkiv', providerName: 'Укрзалізниця (Інтерсіті+)', trainNumber: '№723', category: 'Intercity+', durationSeconds: 5760, distanceMeters: 140_000, fareMinor: 16000 },

  // Дніпро ↔ Харків
  { fromHubId: 'hub_dnipro', toHubId: 'hub_kharkiv', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№796', category: 'Регіональний експрес', durationSeconds: 12600, distanceMeters: 220_000, fareMinor: 23000 },
  { fromHubId: 'hub_kharkiv', toHubId: 'hub_dnipro', providerName: 'Укрзалізниця (Регіональний експрес)', trainNumber: '№796', category: 'Регіональний експрес', durationSeconds: 12600, distanceMeters: 220_000, fareMinor: 23000 },

  // Львів ↔ Стрий
  { fromHubId: 'hub_lviv', toHubId: 'hub_stryi', providerName: 'Укрзалізниця (Приміський поїзд)', trainNumber: '№6155', category: 'Регіональний експрес', durationSeconds: 3900, distanceMeters: 75_000, fareMinor: 4500 },
  { fromHubId: 'hub_stryi', toHubId: 'hub_lviv', providerName: 'Укрзалізниця (Приміський поїзд)', trainNumber: '№6156', category: 'Регіональний експрес', durationSeconds: 3900, distanceMeters: 75_000, fareMinor: 4500 },
];

/** Helper: Find stations within radius from coordinates */
export function findUkraineStationsWithinRadius(
  point: [number, number],
  stations: UkraineTransitStation[],
  radiusMeters: number
): Array<{ station: UkraineTransitStation; distanceMeters: number }> {
  return stations
    .map((station) => ({
      station,
      distanceMeters: Math.round(haversineMeters(point, station.coordinates)),
    }))
    .filter((s) => s.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/** Plan Intra-City Transit in Lviv, Odesa, Kharkiv, Dnipro */
export function planCityTransitJourneys(
  city: 'Львів' | 'Одеса' | 'Харків' | 'Дніпро',
  origin: [number, number],
  destination: [number, number],
  searchRadius = 2500
): UkraineTransitItinerary[] {
  const stationPool =
    city === 'Львів'
      ? LVIV_TRANSIT_STATIONS
      : city === 'Одеса'
      ? ODESA_TRANSIT_STATIONS
      : city === 'Харків'
      ? KHARKIV_TRANSIT_STATIONS
      : DNIPRO_TRANSIT_STATIONS;

  const originMatches = findUkraineStationsWithinRadius(origin, stationPool, searchRadius);
  const destMatches = findUkraineStationsWithinRadius(destination, stationPool, searchRadius);

  if (!originMatches.length || !destMatches.length) return [];

  const itineraries: UkraineTransitItinerary[] = [];

  for (const orig of originMatches.slice(0, 3)) {
    for (const dest of destMatches.slice(0, 3)) {
      if (orig.station.id === dest.station.id) continue;

      // Distance on transit line
      const transitDistance = Math.round(haversineMeters(orig.station.coordinates, dest.station.coordinates));
      if (transitDistance < 300) continue;

      // Average speed: Tram/Trolleybus ~ 18 km/h (5 m/s); Metro ~ 35 km/h (9.7 m/s)
      const isMetro = orig.station.mode === 'METRO';
      const speed = isMetro ? 9.5 : 5.0;
      const rideDuration = Math.round(transitDistance / speed);

      const fareMinor =
        city === 'Львів' ? 1500 : 800; // 15 UAH Lviv, 8 UAH Odesa/Kharkiv/Dnipro

      itineraries.push({
        id: `city:${city.toLowerCase()}:${orig.station.id}-${dest.station.id}`,
        city,
        segments: [
          {
            mode: orig.station.mode,
            transportType: orig.station.transportType,
            providerId: `provider-${city.toLowerCase()}`,
            providerName:
              city === 'Львів'
                ? 'КП «Львівелектротранс»'
                : city === 'Одеса'
                ? 'КП «Одесміськелектротранс»'
                : city === 'Харків'
                ? 'КП «Харківський метрополітен»'
                : 'КП «Дніпровський електротранспорт»',
            lineName: orig.station.line,
            originStation: orig.station,
            destinationStation: dest.station,
            intermediateStations: [],
            durationSeconds: rideDuration,
            distanceMeters: transitDistance,
            fareMinor,
          },
        ],
        transfers: 0,
        transferWalkingMeters: [],
        transferWalkingSeconds: [],
        totalDurationSeconds: rideDuration,
        totalDistanceMeters: transitDistance,
        totalFareMinor: fareMinor,
        originStation: orig.station,
        destinationStation: dest.station,
        distanceToOriginStationMeters: orig.distanceMeters,
        distanceFromDestinationStationMeters: dest.distanceMeters,
      });
    }
  }

  // Transfer pairs for regional city networks:
  const cityTransferPairs: Record<string, Array<{ fromStId: string; toStId: string; hubName: string }>> = {
    Харків: [
      { fromStId: 'kh_m1_04', toStId: 'kh_m2_01', hubName: 'Майдан Конституції ↔ Історичний музей' },
      { fromStId: 'kh_m2_01', toStId: 'kh_m1_04', hubName: 'Історичний музей ↔ Майдан Конституції' },
      { fromStId: 'kh_m2_02', toStId: 'kh_m3_02', hubName: 'Університет ↔ Держпром' },
      { fromStId: 'kh_m3_02', toStId: 'kh_m2_02', hubName: 'Держпром ↔ Університет' },
    ],
    Львів: [
      { fromStId: 'lv_tr_06', toStId: 'lv_tr_11', hubName: 'пл. Соборна ↔ пл. Ринок' },
      { fromStId: 'lv_tr_11', toStId: 'lv_tr_06', hubName: 'пл. Ринок ↔ пл. Соборна' },
      { fromStId: 'lv_tr_14', toStId: 'lv_tr_06', hubName: 'Варшавська ↔ Соборна' },
      { fromStId: 'lv_tr_14', toStId: 'lv_tr_07', hubName: 'Варшавська ↔ Вокзал' },
      { fromStId: 'lv_tr_15', toStId: 'lv_tr_06', hubName: 'Чорновола ↔ Соборна' },
      { fromStId: 'lv_tr_16', toStId: 'lv_tr_07', hubName: 'Торф’яна ↔ Вокзал' },
      { fromStId: 'lv_tr_16', toStId: 'lv_tr_06', hubName: 'Торф’яна ↔ Соборна' },
    ],
    Дніпро: [
      { fromStId: 'dp_m1_06', toStId: 'dp_tr_01', hubName: 'Вокзальна (Метро) ↔ пл. Вокзальна (Трамвай №1)' },
      { fromStId: 'dp_tr_01', toStId: 'dp_m1_06', hubName: 'пл. Вокзальна (Трамвай №1) ↔ Вокзальна (Метро)' },
    ],
    Одеса: [
      { fromStId: 'od_tr_04', toStId: 'od_tr_05', hubName: 'Залізничний вокзал ↔ пл. Тираспольська' },
    ],
  };

  const transfers = cityTransferPairs[city] ?? [];

  // Compose 1-transfer itineraries when origin and destination are on different lines
  for (const orig of originMatches.slice(0, 3)) {
    for (const dest of destMatches.slice(0, 3)) {
      if (orig.station.line === dest.station.line) continue;

      for (const tPair of transfers) {
        const hub1 = stationPool.find((s) => s.id === tPair.fromStId);
        const hub2 = stationPool.find((s) => s.id === tPair.toStId);
        if (!hub1 || !hub2) continue;

        if (orig.station.line === hub1.line && dest.station.line === hub2.line) {
          const dist1 = Math.round(haversineMeters(orig.station.coordinates, hub1.coordinates));
          const dist2 = Math.round(haversineMeters(hub2.coordinates, dest.station.coordinates));
          if (dist1 < 200 || dist2 < 200) continue;

          const speed1 = orig.station.mode === 'METRO' ? 9.5 : 5.0;
          const speed2 = dest.station.mode === 'METRO' ? 9.5 : 5.0;
          const dur1 = Math.round(dist1 / speed1);
          const dur2 = Math.round(dist2 / speed2);

          const transferWalkMeters = Math.round(haversineMeters(hub1.coordinates, hub2.coordinates));
          const transferWalkSeconds = Math.max(120, Math.round(transferWalkMeters / 1.2));

          const fare1 = city === 'Львів' ? 1500 : 800;
          // In Kharkiv metro, transfer between lines is free inside the turnstile network
          const fare2 = (city === 'Харків' && orig.station.mode === 'METRO' && dest.station.mode === 'METRO')
            ? 0
            : (city === 'Львів' ? 1500 : 800);

          itineraries.push({
            id: `city-transfer:${city.toLowerCase()}:${orig.station.id}-${hub1.id}_${hub2.id}-${dest.station.id}`,
            city,
            segments: [
              {
                mode: orig.station.mode,
                transportType: orig.station.transportType,
                providerId: `provider-${city.toLowerCase()}`,
                providerName:
                  city === 'Львів'
                    ? 'КП «Львівелектротранс»'
                    : city === 'Одеса'
                    ? 'КП «Одесміськелектротранс»'
                    : city === 'Харків'
                    ? 'КП «Харківський метрополітен»'
                    : 'КП «Дніпровський електротранспорт»',
                lineName: orig.station.line,
                originStation: orig.station,
                destinationStation: hub1,
                intermediateStations: [],
                durationSeconds: dur1,
                distanceMeters: dist1,
                fareMinor: fare1,
              },
              {
                mode: dest.station.mode,
                transportType: dest.station.transportType,
                providerId: `provider-${city.toLowerCase()}`,
                providerName:
                  city === 'Львів'
                    ? 'КП «Львівелектротранс»'
                    : city === 'Одеса'
                    ? 'КП «Одесміськелектротранс»'
                    : city === 'Харків'
                    ? 'КП «Харківський метрополітен»'
                    : 'КП «Дніпровський електротранспорт»',
                lineName: dest.station.line,
                originStation: hub2,
                destinationStation: dest.station,
                intermediateStations: [],
                durationSeconds: dur2,
                distanceMeters: dist2,
                fareMinor: fare2,
              },
            ],
            transfers: 1,
            transferWalkingMeters: [transferWalkMeters],
            transferWalkingSeconds: [transferWalkSeconds],
            totalDurationSeconds: dur1 + transferWalkSeconds + dur2,
            totalDistanceMeters: dist1 + dist2,
            totalFareMinor: fare1 + fare2,
            originStation: orig.station,
            destinationStation: dest.station,
            distanceToOriginStationMeters: orig.distanceMeters,
            distanceFromDestinationStationMeters: dest.distanceMeters,
          });
        }
      }
    }
  }

  return itineraries.sort((a, b) => a.totalDurationSeconds - b.totalDurationSeconds);
}

// -----------------------------------------------------------------------------------------
// 7. INTERCITY CORRIDOR TRACK GEOMETRIES (Залізничні колії Укрзалізниці)
// -----------------------------------------------------------------------------------------
export const CORRIDOR_TRACK_GEOMETRIES: Record<string, Array<[number, number]>> = {
  'hub_kyiv:hub_lviv': [
    [30.4884, 50.4418], [28.6410, 50.9540], [27.6320, 50.5910], [27.0620, 50.1840],
    [26.2410, 50.6270], [25.7480, 50.4180], [25.1450, 50.0820], [24.6200, 49.9200], [23.9950, 49.8358],
  ],
  'hub_kyiv:hub_odesa': [
    [30.4884, 50.4418], [29.9120, 50.0810], [28.8350, 49.7120], [28.5130, 49.2390],
    [28.5820, 48.5320], [29.5310, 47.7420], [30.0750, 46.8520], [30.7412, 46.4674],
  ],
  'hub_kyiv:hub_kharkiv': [
    [30.4884, 50.4418], [30.6450, 50.4435], [31.7750, 50.2520], [32.4350, 50.1250],
    [33.0020, 50.0120], [33.6080, 49.9650], [34.5200, 49.5950], [36.2050, 49.9880],
  ],
  'hub_kyiv:hub_dnipro': [
    [30.4884, 50.4418], [30.6450, 50.4435], [30.9850, 49.6580], [31.9050, 49.2250],
    [32.6710, 48.7120], [33.1180, 48.6710], [34.6150, 48.5120], [35.0165, 48.4760],
  ],
  'hub_dnipro:hub_zaporizhzhia': [
    [35.0165, 48.4760], [35.5120, 48.3210], [35.4310, 47.9450], [35.1950, 47.7950],
  ],
  'hub_kyiv:hub_zaporizhzhia': [
    [30.4884, 50.4418], [30.6450, 50.4435], [31.9050, 49.2250], [32.6710, 48.7120],
    [34.6150, 48.5120], [35.0165, 48.4760], [35.5120, 48.3210], [35.1950, 47.7950],
  ],
  'hub_lviv:hub_ivano_frankivsk': [
    [23.9950, 49.8358], [24.0810, 49.7890], [23.9850, 49.5210], [24.3120, 49.4050],
    [24.7310, 49.1220], [24.7215, 48.9230],
  ],
  'hub_lviv:hub_uzhhorod': [
    [23.9950, 49.8358], [23.8550, 49.2550], [23.5120, 49.0340], [23.4450, 48.8450],
    [23.1890, 48.7120], [22.9850, 48.5480], [22.7180, 48.4410], [22.3015, 48.6090],
  ],
  'hub_kyiv:hub_vinnytsia': [
    [30.4884, 50.4418], [29.9120, 50.0810], [28.8350, 49.7120], [28.5200, 49.4510], [28.5130, 49.2390],
  ],
  'hub_kyiv:hub_poltava': [
    [30.4884, 50.4418], [30.6450, 50.4435], [32.4350, 50.1250], [33.0020, 50.0120],
    [33.6080, 49.9650], [34.5200, 49.5950],
  ],
  'hub_kyiv:hub_chernivtsi': [
    [30.4884, 50.4418], [28.5130, 49.2390], [27.0010, 49.4210], [26.5820, 48.6820], [25.9390, 48.3000],
  ],
  'hub_lviv:hub_chernivtsi': [
    [23.9950, 49.8358], [24.7215, 48.9230], [25.0410, 48.5320], [25.5710, 48.4510], [25.9390, 48.3000],
  ],
  'hub_kyiv:hub_ternopil': [
    [30.4884, 50.4418], [28.5130, 49.2390], [27.0010, 49.4210], [26.1350, 49.5250], [25.6020, 49.5530],
  ],
  'hub_lviv:hub_ternopil': [
    [23.9950, 49.8358], [24.6200, 49.9200], [24.9010, 49.8050], [25.6020, 49.5530],
  ],
  'hub_kyiv:hub_khmelnytskyi': [
    [30.4884, 50.4418], [29.9120, 50.0810], [28.8350, 49.7120], [28.5130, 49.2390], [27.0010, 49.4210],
  ],
  'hub_kyiv:hub_rivne': [
    [30.4884, 50.4418], [28.6410, 50.9540], [27.6320, 50.5910], [27.0620, 50.1840], [26.2410, 50.6270],
  ],
  'hub_kyiv:hub_lutsk': [
    [30.4884, 50.4418], [28.6410, 50.9540], [27.0620, 50.1840], [26.2410, 50.6270], [25.3520, 50.7580],
  ],
};

export function getCorridorTrackGeometry(
  fromHubId: string,
  toHubId: string,
  originCoord: [number, number],
  destCoord: [number, number],
): Array<[number, number]> {
  const directKey = `${fromHubId}:${toHubId}`;
  if (CORRIDOR_TRACK_GEOMETRIES[directKey]) {
    return CORRIDOR_TRACK_GEOMETRIES[directKey];
  }
  const reverseKey = `${toHubId}:${fromHubId}`;
  if (CORRIDOR_TRACK_GEOMETRIES[reverseKey]) {
    return [...CORRIDOR_TRACK_GEOMETRIES[reverseKey]].reverse();
  }
  const [lng1, lat1] = originCoord;
  const [lng2, lat2] = destCoord;
  return [
    originCoord,
    [Number((lng1 * 0.67 + lng2 * 0.33).toFixed(4)), Number((lat1 * 0.67 + lat2 * 0.33).toFixed(4))],
    [Number((lng1 * 0.33 + lng2 * 0.67).toFixed(4)), Number((lat1 * 0.33 + lat2 * 0.67).toFixed(4))],
    destCoord,
  ];
}
