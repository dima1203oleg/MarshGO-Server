import { performance } from 'node:perf_hooks';

interface RouteQuery {
  id: string;
  name: string;
  origin: { name: string; coordinates: [number, number] };
  destination: { name: string; coordinates: [number, number] };
  departureAt: string;
  preferences?: Record<string, unknown>;
}

const TEST_CORRIDORS: RouteQuery[] = [
  {
    id: 'lviv-rynok-to-kyiv-maidan',
    name: 'Львів (пл. Ринок) → Київ (Майдан Незалежності)',
    origin: { name: 'Львів, пл. Ринок', coordinates: [24.0323, 49.8450] },
    destination: { name: 'Київ, Майдан', coordinates: [30.5227, 50.4501] },
    departureAt: '2026-11-04T18:00:00Z',
  },
  {
    id: 'lviv-sykhiv-to-kyiv-obolon',
    name: 'Львів (Сихів) → Київ (Оболонь)',
    origin: { name: 'Львів, Сихів (Санта-Барбара)', coordinates: [24.0620, 49.7890] },
    destination: { name: 'Київ, м. Оболонь', coordinates: [30.4981, 50.5015] },
    departureAt: '2026-11-04T18:00:00Z',
  },
  {
    id: 'if-center-to-kyiv-center',
    name: 'Івано-Франківськ (Ратуша) → Київ (Хрещатик)',
    origin: { name: 'Івано-Франківськ, Ратуша', coordinates: [24.7103, 48.9228] },
    destination: { name: 'Київ, Хрещатик', coordinates: [30.5227, 50.4501] },
    departureAt: '2026-11-04T18:00:00Z',
  },
  {
    id: 'ternopil-center-to-kyiv-center',
    name: 'Тернопіль (Центр) → Київ (Хрещатик)',
    origin: { name: 'Тернопіль, Центр', coordinates: [25.5948, 49.5535] },
    destination: { name: 'Київ, Хрещатик', coordinates: [30.5227, 50.4501] },
    departureAt: '2026-11-04T18:00:00Z',
  },
  {
    id: 'poltava-center-to-lviv-center',
    name: 'Полтава (Центр) → Львів (Центр)',
    origin: { name: 'Полтава, Корпусний сад', coordinates: [34.5514, 49.5883] },
    destination: { name: 'Львів, пл. Ринок', coordinates: [24.0323, 49.8450] },
    departureAt: '2026-11-04T18:00:00Z',
  },
  {
    id: 'dnipro-to-kyiv',
    name: 'Дніпро (Центр) → Київ (Центр)',
    origin: { name: 'Дніпро, ЦУМ', coordinates: [35.0440, 48.4647] },
    destination: { name: 'Київ, Майдан', coordinates: [30.5227, 50.4501] },
    departureAt: '2026-11-04T18:00:00Z',
  },
  {
    id: 'stryi-to-uzhhorod',
    name: 'Стрий (Центр) → Ужгород (Центр)',
    origin: { name: 'Стрий, Ринок', coordinates: [23.8510, 49.2590] },
    destination: { name: 'Ужгород, Театральна', coordinates: [22.2985, 48.6210] },
    departureAt: '2026-11-04T18:00:00Z',
  },
  {
    id: 'kyiv-intra-city-transfer',
    name: 'Київ, Троєщина → Теремки (складний міський ланцюг)',
    origin: { name: 'Київ, Троєщина (Маяковського)', coordinates: [30.6015, 50.5180] },
    destination: { name: 'Київ, Теремки (Одеська пл.)', coordinates: [30.4542, 50.3670] },
    departureAt: '2026-11-04T19:00:00Z',
  },
  {
    id: 'lviv-intra-city-transfer',
    name: 'Львів, Рясне-2 → Сихів (складний міський ланцюг)',
    origin: { name: 'Львів, Рясне-2 (Величковського)', coordinates: [23.9312, 49.8785] },
    destination: { name: 'Львів, Сихів (Санта-Барбара)', coordinates: [24.0620, 49.7890] },
    departureAt: '2026-11-04T19:00:00Z',
  },
];

async function main() {
  const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:3018';
  const token = process.env.AUTH_TOKEN ?? '8L2ADRORat0Ms5eIdAosqjhMN8jPY4EnKFIphKdVZpo';

  console.log('================================================================');
  console.log('   MARSHGO — КОМПЛЕКСНЕ ТЕСТУВАННЯ МУЛЬТИМОДАЛЬНИХ ЛАНЦЮГІВ   ');
  console.log('================================================================');
  console.log(`Endpoint: ${apiUrl}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log();

  for (const query of TEST_CORRIDORS) {
    console.log(`\n----------------------------------------------------------------`);
    console.log(`ТЕСТ: [${query.id}] ${query.name}`);
    console.log(`Від: ${query.origin.name} (${query.origin.coordinates.join(', ')})`);
    console.log(`До:  ${query.destination.name} (${query.destination.coordinates.join(', ')})`);
    console.log(`Час відправлення: ${query.departureAt}`);

    const t0 = performance.now();
    try {
      const response = await fetch(`${apiUrl}/api/v1/journeys/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          origin: query.origin,
          destination: query.destination,
          departureAt: query.departureAt,
          passengers: 1,
          strategy: 'FASTEST',
          preferences: query.preferences ?? {},
        }),
      });

      const wallMs = Math.round(performance.now() - t0);
      const data = await response.json() as any;

      if (!response.ok) {
        console.log(`[HTTP ${response.status}] Помилка:`, data.errors ?? data.message ?? data);
        continue;
      }

      const journeys = data.data?.journeys ?? [];
      const providerErrors = data.data?.providerErrors ?? [];
      const partialReasons = data.data?.partialReasons ?? [];

      console.log(`[HTTP 200] Знайдено маршрутів: ${journeys.length} (запит тривав ${wallMs} ms)`);
      if (providerErrors.length > 0) {
        console.log(`Повідомлення провайдерів (${providerErrors.length}):`, providerErrors.join('; '));
      }
      if (partialReasons.length > 0) {
        console.log(`Причини неповноти (${partialReasons.length}):`, partialReasons.join('; '));
      }

      if (journeys.length === 0) {
        console.log(`-> Маршрутів не знайдено (чесна поведінка за відсутності покриття/стикувань)`);
        continue;
      }

      journeys.slice(0, 3).forEach((j: any, idx: number) => {
        const durMin = Math.round((j.durationSeconds ?? 0) / 60);
        const priceStr = j.priceMinor !== null && j.priceMinor !== undefined
          ? `${(j.priceMinor / 100).toFixed(2)} ${j.currency ?? 'UAH'}`
          : 'null (чесна невизначеність вартості)';
        
        console.log(`\n  * ВАРІАНТ #${idx + 1}:`);
        console.log(`    Тривалість: ${durMin} хв | Пересадок: ${j.transfers} | Вартість: ${priceStr}`);
        console.log(`    Пішки: ${j.walkingMeters ?? 0} м | Очікування: ${Math.round((j.waitingSeconds ?? 0) / 60)} хв`);
        
        const chainSummary = (j.legs ?? []).map((l: any) => `${l.mode}${l.routeName ? '(' + l.routeName + ')' : ''}`).join(' ➔ ');
        console.log(`    Ланцюг режимів: ${chainSummary}`);

        (j.legs ?? []).forEach((l: any, legIdx: number) => {
          const legDurMin = Math.round((l.durationSeconds ?? 0) / 60);
          const geom = l.geometrySource ?? (l.mode === 'WALK' ? 'walk-geo' : 'transit-shape');
          console.log(`      [${legIdx + 1}] ${l.mode.padEnd(5)} | ${l.origin?.name} ➔ ${l.destination?.name} | ${legDurMin} хв | ${l.distanceMeters ?? '?'} м | провайдер: ${l.providerName ?? '—'} | геометрія: ${geom}`);
        });
      });
    } catch (err: any) {
      console.log(`Помилка запиту:`, err.message);
    }
  }
}

main().catch(console.error);
