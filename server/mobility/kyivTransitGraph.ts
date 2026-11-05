export interface KyivTransitStation {
  id: string;
  name: string;
  nameEng?: string;
  line: string;
  mode: 'METRO' | 'RAIL' | 'FUNICULAR';
  transportType: 'metro' | 'city_train' | 'funicular';
  coordinates: [number, number]; // [lon, lat]
  transferToStationId?: string;
  transferHubName?: string;
}

export interface KyivTransitSegment {
  mode: 'METRO' | 'RAIL' | 'FUNICULAR';
  transportType: 'metro' | 'city_train' | 'funicular';
  providerId: string;
  providerName: string;
  lineName: string;
  originStation: KyivTransitStation;
  destinationStation: KyivTransitStation;
  intermediateStations: KyivTransitStation[];
  durationSeconds: number;
  distanceMeters: number;
  fareMinor: number;
}

export interface KyivTransitJourney {
  id: string;
  segments: KyivTransitSegment[];
  transfers: number;
  transferWalkingMeters: number[];
  transferWalkingSeconds: number[];
  totalDurationSeconds: number;
  totalDistanceMeters: number;
  totalFareMinor: number;
  originStation: KyivTransitStation;
  destinationStation: KyivTransitStation;
  distanceToOriginStationMeters: number;
  distanceFromDestinationStationMeters: number;
}

// Kyiv Metro Stations baseline data with official coordinates from data.kyivcity.gov.ua
export const KYIV_METRO_STATIONS: KyivTransitStation[] = [
  // Red Line: Святошинсько-Броварська (Line 1)
  { id: 'm1_01', name: 'Академмістечко', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.355062, 50.464929] },
  { id: 'm1_02', name: 'Житомирська', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.365444, 50.456258] },
  { id: 'm1_03', name: 'Святошин', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.390653, 50.457766] },
  { id: 'm1_04', name: 'Нивки', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.404558, 50.458902] },
  { id: 'm1_05', name: 'Берестейська', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.418706, 50.459273] },
  { id: 'm1_06', name: 'Шулявська', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.448623, 50.454230] },
  { id: 'm1_07', name: 'Політехнічний інститут', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.466487, 50.450849] },
  { id: 'm1_08', name: 'Вокзальна', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.488426, 50.441857] },
  { id: 'm1_09', name: 'Університет', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.505459, 50.444319] },
  { id: 'm1_10', name: 'Театральна', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.518177, 50.445214], transferToStationId: 'm3_04', transferHubName: 'Театральна ↔ Золоті Ворота' },
  { id: 'm1_11', name: 'Хрещатик', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.525547, 50.447291], transferToStationId: 'm2_08', transferHubName: 'Хрещатик ↔ Майдан Незалежності' },
  { id: 'm1_12', name: 'Арсенальна', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.545199, 50.444288] },
  { id: 'm1_13', name: 'Дніпро', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.559381, 50.441113] },
  { id: 'm1_14', name: 'Гідропарк', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.576856, 50.446152] },
  { id: 'm1_15', name: 'Лівобережна', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.598284, 50.451785] },
  { id: 'm1_16', name: 'Дарниця', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.613388, 50.456012] },
  { id: 'm1_17', name: 'Чернігівська', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.630048, 50.459868] },
  { id: 'm1_18', name: 'Лісова', line: 'Святошинсько-Броварська', mode: 'METRO', transportType: 'metro', coordinates: [30.645731, 50.464686] },

  // Blue Line: Оболонсько-Теремківська (Line 2)
  { id: 'm2_01', name: 'Героїв Дніпра', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.498453, 50.522858] },
  { id: 'm2_02', name: 'Мінська', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.498188, 50.512301] },
  { id: 'm2_03', name: 'Оболонь', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.497956, 50.501569] },
  { id: 'm2_04', name: 'Почайна', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.498124, 50.486241] },
  { id: 'm2_05', name: 'Тараса Шевченка', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.504825, 50.473528] },
  { id: 'm2_06', name: 'Контрактова площа', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.516568, 50.465134] },
  { id: 'm2_07', name: 'Поштова площа', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.525042, 50.459062] },
  { id: 'm2_08', name: 'Майдан Незалежності', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.524458, 50.450125], transferToStationId: 'm1_11', transferHubName: 'Хрещатик ↔ Майдан Незалежності' },
  { id: 'm2_09', name: 'Площа Українських Героїв', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.517351, 50.439485], transferToStationId: 'm3_05', transferHubName: 'Площа Українських Героїв ↔ Палац Спорту' },
  { id: 'm2_10', name: 'Олімпійська', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.516142, 50.432247] },
  { id: 'm2_11', name: 'Палац «Україна»', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.520935, 50.421528] },
  { id: 'm2_12', name: 'Либідська', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.524754, 50.413752] },
  { id: 'm2_13', name: 'Деміївська', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.533215, 50.404781] },
  { id: 'm2_14', name: 'Голосіївська', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.510842, 50.397521] },
  { id: 'm2_15', name: 'Васильківська', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.487824, 50.393284] },
  { id: 'm2_16', name: 'Виставковий центр', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.477432, 50.382625] },
  { id: 'm2_17', name: 'Іподром', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.468752, 50.376541] },
  { id: 'm2_18', name: 'Теремки', line: 'Оболонсько-Теремківська', mode: 'METRO', transportType: 'metro', coordinates: [30.454231, 50.366825] },

  // Green Line: Сирецько-Печерська (Line 3)
  { id: 'm3_01', name: 'Сирець', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.430856, 50.476481] },
  { id: 'm3_02', name: 'Дорогожичі', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.449214, 50.473522] },
  { id: 'm3_03', name: 'Лук’янівська', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.482352, 50.462215] },
  { id: 'm3_04', name: 'Золоті Ворота', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.513284, 50.447025], transferToStationId: 'm1_10', transferHubName: 'Театральна ↔ Золоті Ворота' },
  { id: 'm3_05', name: 'Палац Спорту', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.521852, 50.438012], transferToStationId: 'm2_09', transferHubName: 'Площа Українських Героїв ↔ Палац Спорту' },
  { id: 'm3_06', name: 'Кловська', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.531845, 50.436825] },
  { id: 'm3_07', name: 'Печерська', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.539824, 50.427514] },
  { id: 'm3_08', name: 'Звіринецька', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.545124, 50.419245] },
  { id: 'm3_09', name: 'Видубичі', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.560124, 50.402514] },
  { id: 'm3_10', name: 'Славутич', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.604512, 50.394215] },
  { id: 'm3_11', name: 'Осокорки', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.615824, 50.395612] },
  { id: 'm3_12', name: 'Позняки', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.634125, 50.398014] },
  { id: 'm3_13', name: 'Харківська', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.652841, 50.401254] },
  { id: 'm3_14', name: 'Вирлиця', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.666825, 50.403125] },
  { id: 'm3_15', name: 'Бориспільська', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.682841, 50.403814] },
  { id: 'm3_16', name: 'Червоний хутір', line: 'Сирецько-Печерська', mode: 'METRO', transportType: 'metro', coordinates: [30.697512, 50.408925] },
];

// Kyiv City Express (Urban Electric Train) 20 ring stations
export const KYIV_CITY_EXPRESS_STATIONS: KyivTransitStation[] = [
  { id: 'ce_01', name: 'Святошин', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.388990, 50.456843] },
  { id: 'ce_02', name: 'Берестейська', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.417344, 50.462406] },
  { id: 'ce_03', name: 'Сирець', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.431245, 50.476214] },
  { id: 'ce_04', name: 'Вишгородська', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.459812, 50.497514] },
  { id: 'ce_05', name: 'Зеніт', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.485124, 50.489124] },
  { id: 'ce_06', name: 'Почайна', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.499824, 50.486814] },
  { id: 'ce_07', name: 'Троєщина', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.548124, 50.491214] },
  { id: 'ce_08', name: 'Троєщина-2', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.561245, 50.484512] },
  { id: 'ce_09', name: 'Київ-Дніпровський', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.589124, 50.465124] },
  { id: 'ce_10', name: 'Лівобережна', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.601245, 50.452814] },
  { id: 'ce_11', name: 'Русанівка', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.612145, 50.441245] },
  { id: 'ce_12', name: 'Дарниця', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.638124, 50.435814] },
  { id: 'ce_13', name: 'Лівий Берег', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.598124, 50.412814] },
  { id: 'ce_14', name: 'Видубичі', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.561824, 50.402124] },
  { id: 'ce_15', name: 'Київ-Деміївський', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.531245, 50.406814] },
  { id: 'ce_16', name: 'Протасів Яр', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.501245, 50.422514] },
  { id: 'ce_17', name: 'Вокзальна (Північна)', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.488124, 50.440814] },
  { id: 'ce_18', name: 'Караваєві Дачі', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.449812, 50.438914] },
  { id: 'ce_19', name: 'Київ-Волинський', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.421245, 50.428514] },
  { id: 'ce_20', name: 'Борщагівка', line: 'Кільцева електричка (E1/E2)', mode: 'RAIL', transportType: 'city_train', coordinates: [30.395124, 50.441814] },
];

// Kyiv Funicular
export const KYIV_FUNICULAR_STATIONS: KyivTransitStation[] = [
  { id: 'fun_01', name: 'Фунікулер. Нижня станція', line: 'Київський фунікулер', mode: 'FUNICULAR', transportType: 'funicular', coordinates: [30.523588, 50.458925] },
  { id: 'fun_02', name: 'Фунікулер. Верхня станція', line: 'Київський фунікулер', mode: 'FUNICULAR', transportType: 'funicular', coordinates: [30.521873, 50.457223] },
];

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const radians = (deg: number) => (deg * Math.PI) / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function findNearestStation(
  point: [number, number],
  stations: KyivTransitStation[],
  maxDistanceMeters = 3000,
): { station: KyivTransitStation; distanceMeters: number } | null {
  let nearest: { station: KyivTransitStation; distanceMeters: number } | null = null;
  for (const station of stations) {
    const dist = haversineMeters(point, station.coordinates);
    if (dist <= maxDistanceMeters && (!nearest || dist < nearest.distanceMeters)) {
      nearest = { station, distanceMeters: Math.round(dist) };
    }
  }
  return nearest;
}

export function findStationsWithinRadius(
  point: [number, number],
  stations: KyivTransitStation[],
  radiusMeters = 2500,
): Array<{ station: KyivTransitStation; distanceMeters: number }> {
  return stations
    .map((station) => ({ station, distanceMeters: Math.round(haversineMeters(point, station.coordinates)) }))
    .filter((item) => item.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/**
 * Plans rapid transit routes inside Kyiv network (Metro, City Express, Funicular)
 * including transfers between lines.
 */
export function planKyivRapidTransitJourneys(
  origin: [number, number],
  destination: [number, number],
  maxWalkToStation = 2500,
): KyivTransitJourney[] {
  const originStations = findStationsWithinRadius(origin, KYIV_METRO_STATIONS, maxWalkToStation);
  const destinationStations = findStationsWithinRadius(destination, KYIV_METRO_STATIONS, maxWalkToStation);

  const journeys: KyivTransitJourney[] = [];

  // Helper map for station index in line
  const metroByLine = new Map<string, KyivTransitStation[]>();
  for (const st of KYIV_METRO_STATIONS) {
    const list = metroByLine.get(st.line) ?? [];
    list.push(st);
    metroByLine.set(st.line, list);
  }

  // 1. Direct Metro on same line
  for (const { station: origSt, distanceMeters: distToOrig } of originStations.slice(0, 4)) {
    for (const { station: destSt, distanceMeters: distFromDest } of destinationStations.slice(0, 4)) {
      if (origSt.id === destSt.id) continue;

      if (origSt.line === destSt.line) {
        const lineStations = metroByLine.get(origSt.line)!;
        const i1 = lineStations.findIndex((s) => s.id === origSt.id);
        const i2 = lineStations.findIndex((s) => s.id === destSt.id);
        if (i1 === -1 || i2 === -1) continue;

        const stopCount = Math.abs(i2 - i1);
        const intermediate = i1 < i2
          ? lineStations.slice(i1 + 1, i2)
          : lineStations.slice(i2 + 1, i1).reverse();

        // 120 seconds per stop average runtime
        const durationSeconds = stopCount * 120;
        const distanceMeters = Math.round(haversineMeters(origSt.coordinates, destSt.coordinates) * 1.25);

        journeys.push({
          id: `metro-direct:${origSt.id}-${destSt.id}`,
          segments: [{
            mode: 'METRO',
            transportType: 'metro',
            providerId: 'kyiv-metro',
            providerName: 'Київський метрополітен',
            lineName: origSt.line,
            originStation: origSt,
            destinationStation: destSt,
            intermediateStations: intermediate,
            durationSeconds,
            distanceMeters,
            fareMinor: 800, // 8.00 UAH
          }],
          transfers: 0,
          transferWalkingMeters: [],
          transferWalkingSeconds: [],
          totalDurationSeconds: durationSeconds,
          totalDistanceMeters: distanceMeters,
          totalFareMinor: 800,
          originStation: origSt,
          destinationStation: destSt,
          distanceToOriginStationMeters: distToOrig,
          distanceFromDestinationStationMeters: distFromDest,
        });
      }
    }
  }

  // 2. Metro with 1 Transfer between lines
  // Transfer hubs:
  // Red (m1_10 Театральна) ↔ Green (m3_04 Золоті Ворота)
  // Red (m1_11 Хрещатик) ↔ Blue (m2_08 Майдан Незалежності)
  // Blue (m2_09 Площа Українських Героїв) ↔ Green (m3_05 Палац Спорту)
  const transferPairs = [
    { fromStId: 'm1_10', toStId: 'm3_04', name: 'Театральна ↔ Золоті Ворота' },
    { fromStId: 'm3_04', toStId: 'm1_10', name: 'Золоті Ворота ↔ Театральна' },
    { fromStId: 'm1_11', toStId: 'm2_08', name: 'Хрещатик ↔ Майдан Незалежності' },
    { fromStId: 'm2_08', toStId: 'm1_11', name: 'Майдан Незалежності ↔ Хрещатик' },
    { fromStId: 'm2_09', toStId: 'm3_05', name: 'Площа Українських Героїв ↔ Палац Спорту' },
    { fromStId: 'm3_05', toStId: 'm2_09', name: 'Палац Спорту ↔ Площа Українських Героїв' },
  ];

  for (const { station: origSt, distanceMeters: distToOrig } of originStations.slice(0, 3)) {
    for (const { station: destSt, distanceMeters: distFromDest } of destinationStations.slice(0, 3)) {
      if (origSt.line === destSt.line) continue; // direct already handled

      for (const pair of transferPairs) {
        const hub1 = KYIV_METRO_STATIONS.find((s) => s.id === pair.fromStId);
        const hub2 = KYIV_METRO_STATIONS.find((s) => s.id === pair.toStId);
        if (!hub1 || !hub2) continue;

        if (origSt.line === hub1.line && destSt.line === hub2.line) {
          const line1Stations = metroByLine.get(origSt.line)!;
          const line2Stations = metroByLine.get(destSt.line)!;

          const idxOrig = line1Stations.findIndex((s) => s.id === origSt.id);
          const idxHub1 = line1Stations.findIndex((s) => s.id === hub1.id);
          const idxHub2 = line2Stations.findIndex((s) => s.id === hub2.id);
          const idxDest = line2Stations.findIndex((s) => s.id === destSt.id);

          if (idxOrig === -1 || idxHub1 === -1 || idxHub2 === -1 || idxDest === -1) continue;

          const stops1 = Math.abs(idxHub1 - idxOrig);
          const stops2 = Math.abs(idxDest - idxHub2);
          const dur1 = stops1 * 120;
          const dur2 = stops2 * 120;
          const transferWalkSeconds = 180; // 3 min walk in transfer tunnel
          const transferWalkMeters = 150;

          const dist1 = Math.round(haversineMeters(origSt.coordinates, hub1.coordinates) * 1.25);
          const dist2 = Math.round(haversineMeters(hub2.coordinates, destSt.coordinates) * 1.25);

          journeys.push({
            id: `metro-transfer:${origSt.id}-${hub1.id}_${hub2.id}-${destSt.id}`,
            segments: [
              {
                mode: 'METRO',
                transportType: 'metro',
                providerId: 'kyiv-metro',
                providerName: 'Київський метрополітен',
                lineName: origSt.line,
                originStation: origSt,
                destinationStation: hub1,
                intermediateStations: [],
                durationSeconds: dur1,
                distanceMeters: dist1,
                fareMinor: 800, // 8.00 UAH (includes free transfer within metro)
              },
              {
                mode: 'METRO',
                transportType: 'metro',
                providerId: 'kyiv-metro',
                providerName: 'Київський метрополітен',
                lineName: destSt.line,
                originStation: hub2,
                destinationStation: destSt,
                intermediateStations: [],
                durationSeconds: dur2,
                distanceMeters: dist2,
                fareMinor: 0, // Transfer within Kyiv Metro is free
              },
            ],
            transfers: 1,
            transferWalkingMeters: [transferWalkMeters],
            transferWalkingSeconds: [transferWalkSeconds],
            totalDurationSeconds: dur1 + transferWalkSeconds + dur2,
            totalDistanceMeters: dist1 + dist2,
            totalFareMinor: 800, // 8.00 UAH single entrance token/card
            originStation: origSt,
            destinationStation: destSt,
            distanceToOriginStationMeters: distToOrig,
            distanceFromDestinationStationMeters: distFromDest,
          });
        }
      }
    }
  }

  // 3. Kyiv City Express (Urban Electric Train) journeys
  const expressOriginStations = findStationsWithinRadius(origin, KYIV_CITY_EXPRESS_STATIONS, maxWalkToStation);
  const expressDestStations = findStationsWithinRadius(destination, KYIV_CITY_EXPRESS_STATIONS, maxWalkToStation);

  for (const { station: origExp, distanceMeters: distOrigExp } of expressOriginStations.slice(0, 2)) {
    for (const { station: destExp, distanceMeters: distDestExp } of expressDestStations.slice(0, 2)) {
      if (origExp.id === destExp.id) continue;

      const i1 = KYIV_CITY_EXPRESS_STATIONS.findIndex((s) => s.id === origExp.id);
      const i2 = KYIV_CITY_EXPRESS_STATIONS.findIndex((s) => s.id === destExp.id);
      if (i1 === -1 || i2 === -1) continue;

      const n = KYIV_CITY_EXPRESS_STATIONS.length;
      const forwardStops = (i2 - i1 + n) % n;
      const backwardStops = (i1 - i2 + n) % n;
      const shortestStops = Math.min(forwardStops, backwardStops);

      const durationSeconds = shortestStops * 210; // 3.5 min between stops
      const distanceMeters = Math.round(haversineMeters(origExp.coordinates, destExp.coordinates) * 1.35);

      journeys.push({
        id: `city-express:${origExp.id}-${destExp.id}`,
        segments: [{
          mode: 'RAIL',
          transportType: 'city_train',
          providerId: 'kyiv-city-express',
          providerName: 'Kyiv City Express (Укрзалізниця)',
          lineName: forwardStops <= backwardStops ? 'E1 (За годинниковою стрілкою)' : 'E2 (Проти годинникової стрілки)',
          originStation: origExp,
          destinationStation: destExp,
          intermediateStations: [],
          durationSeconds,
          distanceMeters,
          fareMinor: 1500, // 15.00 UAH
        }],
        transfers: 0,
        transferWalkingMeters: [],
        transferWalkingSeconds: [],
        totalDurationSeconds: durationSeconds,
        totalDistanceMeters: distanceMeters,
        totalFareMinor: 1500,
        originStation: origExp,
        destinationStation: destExp,
        distanceToOriginStationMeters: distOrigExp,
        distanceFromDestinationStationMeters: distDestExp,
      });
    }
  }

  // 4. Kyiv Funicular (if origin/dest are near Poshtova/Mykhailivska)
  const funOrigin = findStationsWithinRadius(origin, KYIV_FUNICULAR_STATIONS, 1200);
  const funDest = findStationsWithinRadius(destination, KYIV_FUNICULAR_STATIONS, 1200);
  if (funOrigin.length > 0 && funDest.length > 0 && funOrigin[0].station.id !== funDest[0].station.id) {
    const origFun = funOrigin[0].station;
    const destFun = funDest[0].station;
    journeys.push({
      id: `funicular:${origFun.id}-${destFun.id}`,
      segments: [{
        mode: 'FUNICULAR',
        transportType: 'funicular',
        providerId: 'kyiv-funicular',
        providerName: 'Київський фунікулер (КП «Київпастранс»)',
        lineName: 'Фунікулер',
        originStation: origFun,
        destinationStation: destFun,
        intermediateStations: [],
        durationSeconds: 180, // 3 min ride
        distanceMeters: 222,
        fareMinor: 800, // 8.00 UAH
      }],
      transfers: 0,
      transferWalkingMeters: [],
      transferWalkingSeconds: [],
      totalDurationSeconds: 180,
      totalDistanceMeters: 222,
      totalFareMinor: 800,
      originStation: origFun,
      destinationStation: destFun,
      distanceToOriginStationMeters: funOrigin[0].distanceMeters,
      distanceFromDestinationStationMeters: funDest[0].distanceMeters,
    });
  }

  // Sort journeys by duration
  return journeys.sort((a, b) => a.totalDurationSeconds - b.totalDurationSeconds);
}
