import { performance } from 'node:perf_hooks';

interface ODTestCase {
  id: number;
  name: string;
  expected: string;
  origin: { name: string; coordinates: [number, number] };
  destination: { name: string; coordinates: [number, number] };
  preferences?: Record<string, unknown>;
}

export const OD_CASES: ODTestCase[] = [
  {
    id: 1,
    name: 'Львів, пл. Ринок → зал. вокзал',
    expected: 'міський пошук: вулична геометрія (Львів bbox), трансфер ≤ 4',
    origin: { name: 'Львів, пл. Ринок', coordinates: [24.0323, 49.8450] },
    destination: { name: 'Львів, зал. вокзал', coordinates: [24.0205, 49.8302] },
    preferences: {},
  },
  {
    id: 2,
    name: 'Львів → аеропорт Львів',
    expected: 'поза bbox: піше плече оцінка прямої, не вулиця',
    origin: { name: 'Львів, пл. Ринок', coordinates: [24.0323, 49.8450] },
    destination: { name: 'Аеропорт Львів', coordinates: [23.9555, 49.8130] },
    preferences: {},
  },
  {
    id: 3,
    name: 'Київ, Майдан → аеропорт Жуляни (50.2338)',
    expected: 'широта 50.2338 нижче bbox 50.25 → відкат на оцінку прямої',
    origin: { name: 'Київ, Майдан', coordinates: [30.5227, 50.4501] },
    destination: { name: 'Аеропорт Жуляни', coordinates: [30.3511, 50.2338] },
    preferences: {},
  },
  {
    id: 4,
    name: 'Київ, Лівобережні → Правобережні (метро)',
    expected: 'метро: немає джерела → категорія вимкнена з поясненням',
    origin: { name: 'Київ, Лівобережна', coordinates: [30.5986, 50.4517] },
    destination: { name: 'Київ, Хрещатик', coordinates: [30.5227, 50.4501] },
    preferences: { allowedTransportTypes: ['metro'] },
  },
  {
    id: 5,
    name: 'Львів → Київ (міжмісто)',
    expected: 'статичний УЗ: ланцюг пішки → поїзд → пішки, ціна null',
    origin: { name: 'Львів, зал. вокзал', coordinates: [23.9950, 49.8357] },
    destination: { name: 'Київ, Пасажирський', coordinates: [30.4883, 50.4417] },
    preferences: {},
  },
  {
    id: 6,
    name: 'Івано-Франківськ → Львів',
    expected: 'GTFS в обох; міжміський сегмент УЗ або чесна порожнеча',
    origin: { name: 'Івано-Франківськ, Вокзал', coordinates: [24.7264, 48.9236] },
    destination: { name: 'Львів, зал. вокзал', coordinates: [23.9950, 49.8357] },
    preferences: {},
  },
  {
    id: 7,
    name: 'Стрий → Ужгород',
    expected: 'по 2 рядки реєстру; міжмісто УЗ без пішого роутера',
    origin: { name: 'Стрий, Вокзал', coordinates: [23.8566, 49.2558] },
    destination: { name: 'Ужгород, Вокзал', coordinates: [22.2985, 48.6083] },
    preferences: {},
  },
  {
    id: 8,
    name: 'Тернопіль → Львів',
    expected: 'Тернопіль відсутній у муніципальних; УЗ поїзд або пояснення',
    origin: { name: 'Тернопіль, Центр', coordinates: [25.5948, 49.5535] },
    destination: { name: 'Львів, пл. Ринок', coordinates: [24.0323, 49.8450] },
    preferences: {},
  },
  {
    id: 9,
    name: 'Чернівці → Київ',
    expected: 'Чернівці відсутні в реєстрі → чесна порожнеча з причиною',
    origin: { name: 'Чернівці, Центр', coordinates: [25.9358, 48.2917] },
    destination: { name: 'Київ, Майдан', coordinates: [30.5227, 50.4501] },
    preferences: {},
  },
  {
    id: 10,
    name: 'Полтава → Київ',
    expected: 'у Полтаві лише EasyWay JSON позицій без розкладу',
    origin: { name: 'Полтава, Центр', coordinates: [34.5514, 49.5883] },
    destination: { name: 'Київ, Майдан', coordinates: [30.5227, 50.4501] },
    preferences: {},
  },
  {
    id: 11,
    name: 'Одеса → Миколаїв',
    expected: 'Одеса 1 рядок, Миколаїв 0 → чесна порожнеча з причиною',
    origin: { name: 'Одеса, Центр', coordinates: [30.7233, 46.4825] },
    destination: { name: 'Миколаїв, Центр', coordinates: [31.9946, 46.9750] },
    preferences: {},
  },
  {
    id: 12,
    name: 'Вінниця → Київ',
    expected: 'Вінниці немає в муніципальному реєстрі; УЗ поїзд або пусто',
    origin: { name: 'Вінниця, Центр', coordinates: [28.4682, 49.2331] },
    destination: { name: 'Київ, Майдан', coordinates: [30.5227, 50.4501] },
    preferences: {},
  },
  {
    id: 13,
    name: 'Дніпро внутрішній пошук',
    expected: 'у Дніпрі лише позиції iCity без розкладу → немає розкладу',
    origin: { name: 'Дніпро, пр. Яворницького', coordinates: [35.0440, 48.4647] },
    destination: { name: 'Дніпро, Вокзал', coordinates: [35.0163, 48.4759] },
    preferences: {},
  },
  {
    id: 14,
    name: 'Київ, метро Вокзальна → зупинка',
    expected: 'міжвидовий перехід + буфер; наземний стик',
    origin: { name: 'Київ, метро Вокзальна', coordinates: [30.4883, 50.4417] },
    destination: { name: 'Київ, пл. Вокзальна', coordinates: [30.4895, 50.4428] },
    preferences: {},
  },
];

async function run() {
  const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:3018';
  const token = process.env.AUTH_TOKEN ?? '8L2ADRORat0Ms5eIdAosqjhMN8jPY4EnKFIphKdVZpo';
  const departureAt = process.env.DEPARTURE_AT ?? '2026-11-04T18:00:00Z';

  console.log(`# MARSHGO — ХАРНЕС ОД-МАТРИЦІ (14 ПАР)`);
  console.log(`Дата виміру: ${new Date().toISOString()}`);
  console.log(`API endpoint: ${apiUrl}`);
  console.log();
  console.log(`| # | Пара | Очікування | Фактично | Ланки | Геометрія | Ціна | Partial reasons | Wall ms |`);
  console.log(`|---|---|---|---|---|---|---|---|:---:|`);

  for (const testCase of OD_CASES) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${apiUrl}/api/v1/journeys/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          origin: testCase.origin,
          destination: testCase.destination,
          departureAt,
          passengers: 1,
          strategy: 'FASTEST',
          preferences: testCase.preferences ?? {},
        }),
      });

      const wallMs = Math.round(performance.now() - t0);
      const json = await res.json() as {
        data?: {
          journeys?: Array<{
            id: string;
            totalPriceMinor: number | null;
            legs: Array<{
              mode: string;
              source?: string;
              routeGeometry?: unknown;
            }>;
          }>;
          partialReasons?: string[];
          providerErrors?: string[];
        };
      };

      const journeys = json.data?.journeys ?? [];
      const partialReasons = json.data?.partialReasons ?? [];

      let factStatus = 'PASS (порожньо з причиною)';
      let legSummary = '0';
      let geomSummary = '—';
      let priceSummary = '—';

      if (journeys.length > 0) {
        factStatus = `Знайдено ${journeys.length}`;
        const firstJourney = journeys[0]!;
        legSummary = `${firstJourney.legs.length} (${firstJourney.legs.map((l) => l.mode).join('→')})`;
        const geomSources = firstJourney.legs.map((l) => l.source ?? (l.routeGeometry ? 'shape' : 'estimate'));
        geomSummary = geomSources.join(', ');
        priceSummary = firstJourney.totalPriceMinor !== null ? `${firstJourney.totalPriceMinor / 100} грн` : '— (null)';
      }

      const partialStr = partialReasons.length > 0 ? partialReasons.join(', ') : 'none';

      console.log(`| ${testCase.id} | ${testCase.name} | ${testCase.expected} | ${factStatus} | ${legSummary} | ${geomSummary} | ${priceSummary} | ${partialStr} | ${wallMs} |`);
    } catch (err) {
      const wallMs = Math.round(performance.now() - t0);
      console.log(`| ${testCase.id} | ${testCase.name} | ${testCase.expected} | ERROR: ${err instanceof Error ? err.message : String(err)} | — | — | — | — | ${wallMs} |`);
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
