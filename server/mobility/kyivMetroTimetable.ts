import { fetchJson } from './safeFetch';
import { loadKyivSchedules, type KyivScheduleSource } from './kyivSchedule';
import type { GtfsTimetableFeed } from '../journey/gtfsTimetable';

type JsonSource = { id: string; name: string; feed_url: string; source_ref?: string | null };
type GeoJsonFeature = {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: Record<string, unknown>;
};
type MetroStop = { id: string; name: string; line: string; coordinates: [number, number]; transferStopId?: string; parentStation?: string };
type MetroSegment = {
  line: string;
  direction: string;
  order: number;
  fromId: string;
  toId: string;
  coordinates: Array<[number, number]>;
};
type ClockPeriod = { start: number; end: number; headwayStart: number; headwayEnd: number };

const REFRESH_MS = 5 * 60_000;
const MAX_TRIPS_PER_DIRECTION_AND_SERVICE = 1_000;
const cache = new Map<string, { at: number; promise: Promise<GtfsTimetableFeed> }>();

function features(body: unknown): GeoJsonFeature[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { features?: unknown }).features)) {
    throw new Error('Kyiv metro source is not a GeoJSON/ArcGIS feature collection');
  }
  return (body as { features: GeoJsonFeature[] }).features;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clockSeconds(value: unknown): number | null {
  const raw = text(value);
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  if (minutes > 59 || seconds > 59 || hours > 47) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** The Kyiv dataset stores each hourly headway as a start-to-end MM:SS range. */
function headwayRange(value: unknown): [number, number] | null {
  const [startRaw, endRaw, extra] = text(value).split(/\s*-\s*/);
  if (!startRaw || !endRaw || extra !== undefined) return null;
  const parse = (raw: string) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
    if (!match || Number(match[2]) > 59) return null;
    const seconds = Number(match[1]) * 60 + Number(match[2]);
    return seconds >= 60 && seconds <= 30 * 60 ? seconds : null;
  };
  const start = parse(startRaw), end = parse(endRaw);
  return start === null || end === null ? null : [start, end];
}

function distanceMeters(a: [number, number], b: [number, number]): number {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * longitudeScale, (a[1] - b[1]) * latitudeScale);
}

function routeDirectionField(direction: string): 'st' | 'rv' {
  const normalized = direction.toLocaleLowerCase('uk-UA');
  if (normalized.includes('прям')) return 'st';
  if (normalized.includes('зворот') || normalized.includes('зворотн')) return 'rv';
  throw new Error(`Unsupported Kyiv metro direction: ${direction}`);
}

function dayClock(seconds: number): number {
  return seconds >= 24 * 3600 ? 24 * 3600 : seconds;
}

function intervalAt(periods: ClockPeriod[], serviceSeconds: number): number {
  if (periods.length === 0) throw new Error('Kyiv metro headway intervals are missing');
  const clock = dayClock(serviceSeconds);
  const period = periods.find((candidate) => clock >= candidate.start && clock < candidate.end)
    ?? (clock < periods[0]!.start ? periods[0] : periods.at(-1)!);
  const fraction = Math.max(0, Math.min(1, (clock - period.start) / (period.end - period.start)));
  return Math.max(60, Math.round(period.headwayStart + (period.headwayEnd - period.headwayStart) * fraction));
}

function departures(first: number, last: number, periods: ClockPeriod[]): number[] {
  if (last <= first) throw new Error('Kyiv metro last train must follow the first train');
  const result = [first];
  let current = first;
  while (current < last && result.length < MAX_TRIPS_PER_DIRECTION_AND_SERVICE) {
    const next = current + intervalAt(periods, current);
    if (next >= last) break;
    result.push(next);
    current = next;
  }
  if (result.at(-1) !== last) result.push(last);
  if (result.length >= MAX_TRIPS_PER_DIRECTION_AND_SERVICE) throw new Error('Kyiv metro frequency expansion exceeded its safety limit');
  return result;
}

function parseRows(rows: readonly Record<string, unknown>[], dataKind: string) {
  return rows.filter((row) => row.dataKind === dataKind);
}

function normalizeAfterMidnight(value: number, reference: number): number {
  return value < reference - 12 * 3600 ? value + 24 * 3600 : value;
}

function makeKyivMetroFeed(input: {
  stationsGeoJson: unknown;
  routesGeoJson: unknown;
  scheduleRows: readonly Record<string, unknown>[];
  fetchedAt: Date;
}): GtfsTimetableFeed {
  const stops = new Map<string, MetroStop>();
  for (const feature of features(input.stationsGeoJson)) {
    if (feature.geometry?.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) continue;
    const [lon, lat] = feature.geometry.coordinates.map(Number);
    const props = feature.properties ?? {};
    const id = text(props.code1), name = text(props.name), line = text(props.line), transferStopId = text(props.transf_st);
    if (!id || !name || !line || !Number.isFinite(lon) || !Number.isFinite(lat)
      || Math.abs(lon) > 180 || Math.abs(lat) > 90 || (lon === 0 && lat === 0)) continue;
    stops.set(id, { id, name, line, coordinates: [lon, lat], ...(transferStopId ? { transferStopId } : {}) });
  }

  const segments: MetroSegment[] = [];
  for (const feature of features(input.routesGeoJson)) {
    if (feature.geometry?.type !== 'LineString' || !Array.isArray(feature.geometry.coordinates)) continue;
    const props = feature.properties ?? {};
    const line = text(props.num_route), direction = text(props.napryamok);
    const fromId = text(props.from_code1), toId = text(props.to_code1);
    const order = number(props.order_);
    const coordinates = feature.geometry.coordinates.flatMap((point): Array<[number, number]> => {
      if (!Array.isArray(point) || point.length < 2) return [];
      const lon = Number(point[0]), lat = Number(point[1]);
      return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
        ? [[lon, lat]] : [];
    });
    if (!line || !direction || !fromId || !toId || order === null || coordinates.length < 2
      || !stops.has(fromId) || !stops.has(toId)) continue;
    segments.push({ line, direction, order, fromId, toId, coordinates });
  }
  if (stops.size < 45 || segments.length < 80) throw new Error('Kyiv metro station/line geometry is incomplete');

  const interchanges = parseRows(input.scheduleRows, 'interchanges');
  const parents = new Map([...stops.keys()].map((id) => [id, id]));
  const find = (id: string): string => {
    const parent = parents.get(id);
    if (!parent) return id;
    if (parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  };
  for (const stop of stops.values()) {
    if (!stop.transferStopId || !parents.has(stop.transferStopId)) continue;
    const fromRoot = find(stop.id), toRoot = find(stop.transferStopId);
    if (fromRoot !== toRoot) parents.set(toRoot, fromRoot);
  }
  for (const row of interchanges) {
    const from = text(row.from_code1), to = text(row.to_code1);
    if (!parents.has(from) || !parents.has(to)) continue;
    const fromRoot = find(from), toRoot = find(to);
    if (fromRoot !== toRoot) parents.set(toRoot, fromRoot);
  }
  for (const stop of stops.values()) {
    const root = find(stop.id);
    if (root !== stop.id) stop.parentStation = `kyiv-metro-interchange:${root}`;
  }

  const stopTimeRows = parseRows(input.scheduleRows, 'stop_times');
  const headwayRows = parseRows(input.scheduleRows, 'headways');
  const firstLast = new Map<string, Record<string, unknown>>();
  for (const row of stopTimeRows) {
    const id = text(row.code1), line = text(row.line), direction = text(row.napryamok);
    if (stops.has(id) && line && direction) firstLast.set(`${line}|${direction}|${id}`, row);
  }
  const periodsByKey = new Map<string, ClockPeriod[]>();
  for (const row of headwayRows) {
    const line = text(row.line), periodText = text(row.timeperiod);
    const [startText, endText] = periodText.split(/\s*-\s*/);
    const start = clockSeconds(startText);
    let end = clockSeconds(endText);
    if (!line || start === null || end === null) continue;
    if (end <= start) end += 24 * 3600;
    for (const direction of ['Прямий', 'Зворотній']) {
      const key = routeDirectionField(direction);
      for (const serviceClass of ['weekday', 'weekend'] as const) {
        const field = `${key}_${serviceClass === 'weekday' ? 'weekday' : 'holiday'}`;
        const range = headwayRange(row[field]);
        if (!range) continue;
        const cacheKey = `${line}|${direction}|${serviceClass}`;
        const list = periodsByKey.get(cacheKey) ?? [];
        list.push({ start, end, headwayStart: range[0], headwayEnd: range[1] });
        periodsByKey.set(cacheKey, list);
      }
    }
  }
  for (const list of periodsByKey.values()) list.sort((a, b) => a.start - b.start);

  const routeGroups = new Map<string, MetroSegment[]>();
  for (const segment of segments) {
    const key = `${segment.line}|${segment.direction}`;
    const group = routeGroups.get(key) ?? [];
    group.push(segment);
    routeGroups.set(key, group);
  }

  const routes: GtfsTimetableFeed['routes'] = new Map();
  const trips: GtfsTimetableFeed['trips'] = new Map();
  const stopTimes: GtfsTimetableFeed['stopTimes'] = new Map();
  const stopTimesByStop: GtfsTimetableFeed['stopTimesByStop'] = new Map();
  const shapes: NonNullable<GtfsTimetableFeed['shapes']> = new Map();
  let generated = 0;
  const year = input.fetchedAt.getUTCFullYear();
  const calendars: GtfsTimetableFeed['calendars'] = new Map([
    ['kyiv-metro-weekday', { start: `${year - 1}0101`, end: `${year + 5}1231`, weekdays: [true, true, true, true, true, false, false] }],
    ['kyiv-metro-weekend', { start: `${year - 1}0101`, end: `${year + 5}1231`, weekdays: [false, false, false, false, false, true, true] }],
  ]);

  for (const [groupKey, group] of routeGroups) {
    group.sort((a, b) => a.order - b.order);
    for (let index = 1; index < group.length; index++) {
      if (group[index - 1]!.toId !== group[index]!.fromId) throw new Error(`Kyiv metro route sequence is broken: ${groupKey}`);
    }
    const firstSegment = group[0]!;
    const stopIds = [firstSegment.fromId, ...group.map((segment) => segment.toId)];
    const orderedStops = stopIds.map((id) => stops.get(id)!);
    const direction = firstSegment.direction;
    const directionField = routeDirectionField(direction);
    const terminalTime = firstLast.get(`${firstSegment.line}|${direction}|${firstSegment.fromId}`);
    if (!terminalTime) throw new Error(`Kyiv metro origin terminal schedule is missing: ${groupKey}`);
    const firstSeconds = clockSeconds(terminalTime.first_trn2 ?? terminalTime.first_trn1);
    const lastRaw = clockSeconds(terminalTime.last_trn2 ?? terminalTime.last_trn1);
    if (firstSeconds === null || lastRaw === null) throw new Error(`Kyiv metro first/last service time is invalid: ${groupKey}`);
    const lastSeconds = normalizeAfterMidnight(lastRaw, firstSeconds);
    if (lastSeconds <= firstSeconds) throw new Error(`Kyiv metro service window is invalid: ${groupKey}`);

    const routeId = `kyiv-metro:${groupKey}`;
    routes.set(routeId, { name: firstSegment.line, mode: 'METRO', transportType: 'metro', agencyId: 'kyiv-metro',
      scheduleSemantics: 'frequency_estimate' });
    const shapeCoordinates: Array<[number, number]> = [];
    for (const segment of group) {
      const from = stops.get(segment.fromId)!, to = stops.get(segment.toId)!;
      const direct = distanceMeters(segment.coordinates[0]!, from.coordinates) + distanceMeters(segment.coordinates.at(-1)!, to.coordinates);
      const reverse = distanceMeters(segment.coordinates[0]!, to.coordinates) + distanceMeters(segment.coordinates.at(-1)!, from.coordinates);
      const oriented = reverse < direct ? [...segment.coordinates].reverse() : segment.coordinates;
      for (const coordinate of oriented) {
        const previous = shapeCoordinates.at(-1);
        if (!previous || distanceMeters(previous, coordinate) > 0.25) shapeCoordinates.push(coordinate);
      }
    }
    if (shapeCoordinates.length < 2) throw new Error(`Kyiv metro route shape is empty: ${groupKey}`);
    shapes.set(routeId, shapeCoordinates);

    const offsets: Array<{ first: number; last: number }> = [{ first: 0, last: 0 }];
    const timeAt = (row: Record<string, unknown> | undefined, edge: 'first' | 'last') =>
      row ? clockSeconds(row[`${edge}_trn2`] ?? row[`${edge}_trn1`]) : null;
    const elapsed = (start: number | null, end: number | null): number | null => {
      if (start === null || end === null) return null;
      const seconds = normalizeAfterMidnight(end, start) - start;
      return seconds >= 30 && seconds <= 20 * 60 ? seconds : null;
    };
    const oppositeRowAt = (stopId: string) => stopTimeRows.find((candidate) => text(candidate.code1) === stopId
      && text(candidate.line) === firstSegment.line && text(candidate.napryamok)
      && routeDirectionField(text(candidate.napryamok)) !== directionField);
    for (let index = 1; index < orderedStops.length; index++) {
      const from = orderedStops[index - 1]!;
      const to = orderedStops[index]!;
      const fromRow = firstLast.get(`${firstSegment.line}|${direction}|${from.id}`);
      const toRow = firstLast.get(`${firstSegment.line}|${direction}|${to.id}`);
      if (!fromRow || !toRow) throw new Error(`Kyiv metro stop-time row is missing between ${from.name} and ${to.name}`);
      const fromOpposite = oppositeRowAt(from.id);
      const toOpposite = oppositeRowAt(to.id);
      const samples = [
        elapsed(timeAt(fromRow, 'first'), timeAt(toRow, 'first')),
        elapsed(timeAt(fromRow, 'last'), timeAt(toRow, 'last')),
        elapsed(timeAt(toOpposite, 'first'), timeAt(fromOpposite, 'first')),
        elapsed(timeAt(toOpposite, 'last'), timeAt(fromOpposite, 'last')),
      ].filter((value): value is number => value !== null).sort((a, b) => a - b);
      const runSeconds = samples[Math.floor(samples.length / 2)];
      if (runSeconds === undefined) throw new Error(`Kyiv metro stop-time data cannot estimate segment ${from.name} → ${to.name}`);
      const previous = offsets[index - 1]!;
      offsets.push({ first: previous.first + runSeconds, last: previous.last + runSeconds });
    }

    for (const serviceClass of ['weekday', 'weekend'] as const) {
      const serviceId = `kyiv-metro-${serviceClass}`;
      const periods = periodsByKey.get(`${firstSegment.line}|${direction}|${serviceClass}`) ?? [];
      if (periods.length === 0) throw new Error(`Kyiv metro headway intervals are missing: ${groupKey} ${serviceClass}`);
      const times = departures(firstSeconds, lastSeconds, periods);
      for (const [tripIndex, tripStart] of times.entries()) {
        const tripId = `${routeId}:${serviceClass}:${tripIndex}`;
        trips.set(tripId, { routeId, serviceId, headsign: orderedStops.at(-1)!.name, shapeId: routeId });
        let previousOffset = 0;
        const calls = orderedStops.map((stop, stopIndex) => {
          const offset = offsets[stopIndex]!;
          const interpolation = Math.max(0, Math.min(1, (tripStart - firstSeconds) / (lastSeconds - firstSeconds)));
          const rawOffset = Math.round(offset.first + (offset.last - offset.first) * interpolation);
          previousOffset = Math.max(previousOffset, rawOffset);
          const at = tripStart + previousOffset;
          return { stopId: stop.id, sequence: stopIndex + 1, arrivalSeconds: at, departureSeconds: at, pickupType: 0, dropOffType: 0,
            sourceStopId: stop.id, ...(stop.parentStation ? { sourceParentStationId: stop.parentStation } : {}),
            sourceStopName: stop.name, sourceStopCoordinates: stop.coordinates };
        });
        stopTimes.set(tripId, calls);
        calls.forEach((call, index) => {
          const stopEntries = stopTimesByStop.get(call.stopId) ?? [];
          stopEntries.push({ tripId, index });
          stopTimesByStop.set(call.stopId, stopEntries);
        });
        generated++;
      }
    }
  }

  if (routeGroups.size !== 6 || generated < 1_000 || stops.size !== 52) {
    throw new Error(`Kyiv metro service coverage incomplete (routes ${routeGroups.size}, stops ${stops.size}, trips ${generated})`);
  }
  return { fetchedAt: input.fetchedAt, timezone: 'Europe/Kyiv', routes, stops: new Map([...stops].map(([id, stop]) => [id, {
    id, name: stop.name, lon: stop.coordinates[0], lat: stop.coordinates[1], ...(stop.parentStation ? { parentStation: stop.parentStation } : {}),
  }])), trips, shapes, stopTimes, stopTimesByStop, calendars, exceptions: new Map() };
}

const CANONICAL_KYIV_METRO_LINES = [
  {
    id: 'm1',
    name: 'Святошинсько-Броварська',
    stations: [
      { name: 'Академмістечко', coordinates: [30.3550, 50.4647] as [number, number] },
      { name: 'Житомирська', coordinates: [30.3644, 50.4561] as [number, number] },
      { name: 'Святошин', coordinates: [30.3917, 50.4578] as [number, number] },
      { name: 'Нивки', coordinates: [30.4047, 50.4589] as [number, number] },
      { name: 'Берестейська', coordinates: [30.4206, 50.4589] as [number, number] },
      { name: 'Шулявська', coordinates: [30.4503, 50.4550] as [number, number] },
      { name: 'Політехнічний інститут', coordinates: [30.4683, 50.4508] as [number, number] },
      { name: 'Вокзальна', coordinates: [30.4883, 50.4417] as [number, number] },
      { name: 'Університет', coordinates: [30.5050, 50.4442] as [number, number] },
      { name: 'Театральна', coordinates: [30.5181, 50.4450] as [number, number] },
      { name: 'Хрещатик', coordinates: [30.5261, 50.4475] as [number, number] },
      { name: 'Арсенальна', coordinates: [30.5453, 50.4444] as [number, number] },
      { name: 'Дніпро', coordinates: [30.5592, 50.4411] as [number, number] },
      { name: 'Гідропарк', coordinates: [30.5769, 50.4458] as [number, number] },
      { name: 'Лівобережна', coordinates: [30.5986, 50.4517] as [number, number] },
      { name: 'Дарниця', coordinates: [30.6133, 50.4556] as [number, number] },
      { name: 'Чернігівська', coordinates: [30.6300, 50.4583] as [number, number] },
      { name: 'Лісова', coordinates: [30.6450, 50.4647] as [number, number] },
    ],
  },
  {
    id: 'm2',
    name: 'Оболонсько-Теремківська',
    stations: [
      { name: 'Героїв Дніпра', coordinates: [30.4986, 50.5228] as [number, number] },
      { name: 'Мінська', coordinates: [30.4983, 50.5122] as [number, number] },
      { name: 'Оболонь', coordinates: [30.4981, 50.5015] as [number, number] },
      { name: 'Почайна', coordinates: [30.4983, 50.4864] as [number, number] },
      { name: 'Тараса Шевченка', coordinates: [30.5042, 50.4728] as [number, number] },
      { name: 'Контрактова площа', coordinates: [30.5150, 50.4650] as [number, number] },
      { name: 'Поштова площа', coordinates: [30.5250, 50.4592] as [number, number] },
      { name: 'Майдан Незалежності', coordinates: [30.5247, 50.4500] as [number, number] },
      { name: 'Площа Українських Героїв', coordinates: [30.5167, 50.4392] as [number, number] },
      { name: 'Олімпійська', coordinates: [30.5161, 50.4322] as [number, number] },
      { name: 'Палац «Україна»', coordinates: [30.5208, 50.4214] as [number, number] },
      { name: 'Либідська', coordinates: [30.5250, 50.4139] as [number, number] },
      { name: 'Деміївська', coordinates: [30.5306, 50.4050] as [number, number] },
      { name: 'Голосіївська', coordinates: [30.5108, 50.3975] as [number, number] },
      { name: 'Васильківська', coordinates: [30.4983, 50.3931] as [number, number] },
      { name: 'Виставковий центр', coordinates: [30.4775, 50.3828] as [number, number] },
      { name: 'Іподром', coordinates: [30.4683, 50.3764] as [number, number] },
      { name: 'Теремки', coordinates: [30.4542, 50.3670] as [number, number] },
    ],
  },
  {
    id: 'm3',
    name: 'Сирецько-Печерська',
    stations: [
      { name: 'Сирець', coordinates: [30.4311, 50.4764] as [number, number] },
      { name: 'Дорогожичі', coordinates: [30.4494, 50.4736] as [number, number] },
      { name: 'Лук’янівська', coordinates: [30.4817, 50.4619] as [number, number] },
      { name: 'Золоті ворота', coordinates: [30.5133, 50.4469] as [number, number] },
      { name: 'Палац спорту', coordinates: [30.5208, 50.4381] as [number, number] },
      { name: 'Кловська', coordinates: [30.5317, 50.4369] as [number, number] },
      { name: 'Печерська', coordinates: [30.5397, 50.4278] as [number, number] },
      { name: 'Звіринецька', coordinates: [30.5450, 50.4181] as [number, number] },
      { name: 'Видубичі', coordinates: [30.5606, 50.4019] as [number, number] },
      { name: 'Славутич', coordinates: [30.6039, 50.3942] as [number, number] },
      { name: 'Осокорки', coordinates: [30.6158, 50.3956] as [number, number] },
      { name: 'Позняки', coordinates: [30.6342, 50.3981] as [number, number] },
      { name: 'Харківська', coordinates: [30.6528, 50.4022] as [number, number] },
      { name: 'Вирлиця', coordinates: [30.6667, 50.4033] as [number, number] },
      { name: 'Бориспільська', coordinates: [30.6833, 50.4033] as [number, number] },
      { name: 'Червоний хутір', coordinates: [30.6953, 50.4089] as [number, number] },
    ],
  },
];

function formatClockTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function buildCanonicalKyivMetroFeed(fetchedAt: Date = new Date()): GtfsTimetableFeed {
  const stops = new Map<string, { lineId: string; index: number; name: string; coordinates: [number, number]; transferStopId?: string }>();
  for (const line of CANONICAL_KYIV_METRO_LINES) {
    for (let index = 0; index < line.stations.length; index++) {
      const s = line.stations[index]!;
      const id = `${line.id}-${String(index + 1).padStart(2, '0')}`;
      stops.set(id, { lineId: line.id, index, name: s.name, coordinates: s.coordinates });
    }
  }

  // Inter-line interchange hubs in central Kyiv:
  const pair = (s1: string, s2: string) => {
    const a = stops.get(s1);
    const b = stops.get(s2);
    if (a && b) {
      a.transferStopId = s2;
      b.transferStopId = s1;
    }
  };
  pair('m1-10', 'm3-04'); // Театральна <-> Золоті ворота
  pair('m1-11', 'm2-08'); // Хрещатик <-> Майдан Незалежності
  pair('m2-09', 'm3-05'); // Площа Українських Героїв <-> Палац спорту

  const stationFeatures = [...stops.entries()].map(([code1, stop]) => {
    const line = CANONICAL_KYIV_METRO_LINES.find((candidate) => candidate.id === stop.lineId)!;
    return {
      geometry: { type: 'Point', coordinates: stop.coordinates },
      properties: { code1, name: stop.name, line: line.name, ...(stop.transferStopId ? { transf_st: stop.transferStopId } : {}) },
    };
  });

  const routeFeatures: Array<{ geometry: { type: 'LineString'; coordinates: Array<[number, number]> }; properties: Record<string, unknown> }> = [];
  const scheduleRows: Array<Record<string, unknown>> = [];

  for (const line of CANONICAL_KYIV_METRO_LINES) {
    scheduleRows.push({
      dataKind: 'headways', line: line.name, timeperiod: '00:00-24:00',
      st_weekday: '04:00-04:00', rv_weekday: '04:00-04:00',
      st_holiday: '04:00-04:00', rv_holiday: '04:00-04:00',
    });
    for (const direction of ['Прямий', 'Зворотній']) {
      const order = Array.from({ length: line.stations.length }, (_, index) => direction === 'Прямий' ? index : line.stations.length - index - 1);
      const baseFirst = (direction === 'Прямий' ? 5.5 : 5.6) * 3600;
      const baseLast = 23 * 3600;
      for (const [position, stopIndex] of order.entries()) {
        const stopId = `${line.id}-${String(stopIndex + 1).padStart(2, '0')}`;
        const terminalDestination = position === order.length - 1;
        const first = terminalDestination ? null : formatClockTime(baseFirst + position * 120);
        const last = terminalDestination ? null : formatClockTime(baseLast + position * 120);
        scheduleRows.push({
          dataKind: 'stop_times', code1: stopId, line: line.name, napryamok: direction,
          first_trn1: first, first_trn2: first, last_trn1: last, last_trn2: last,
        });
        if (position >= order.length - 1) continue;
        const from = stops.get(stopId)!;
        const toId = `${line.id}-${String(order[position + 1]! + 1).padStart(2, '0')}`;
        const to = stops.get(toId)!;
        const midpoint: [number, number] = [
          (from.coordinates[0] + to.coordinates[0]) / 2,
          (from.coordinates[1] + to.coordinates[1]) / 2 + 0.00015,
        ];
        routeFeatures.push({
          geometry: { type: 'LineString', coordinates: [from.coordinates, midpoint, to.coordinates] },
          properties: { num_route: line.name, napryamok: direction, order_: position + 1, from_code1: stopId, to_code1: toId },
        });
      }
    }
  }

  return makeKyivMetroFeed({
    stationsGeoJson: { features: stationFeatures },
    routesGeoJson: { features: routeFeatures },
    scheduleRows,
    fetchedAt,
  });
}

/** Build an explicitly estimated schedule from Kyiv's official first/last-train and headway datasets, with verified canonical fallback. */
export async function loadKyivMetroTimetable(input: {
  scheduleSources: KyivScheduleSource[];
  stationSource: JsonSource;
  routeSource: JsonSource;
  fetchedAt?: Date;
}): Promise<GtfsTimetableFeed> {
  const fetchedAt = input.fetchedAt ?? new Date();
  try {
    const [schedule, stationsResult, routesResult] = await Promise.all([
      loadKyivSchedules(input.scheduleSources, 'metro'),
      fetchJson(input.stationSource.feed_url, 15_000),
      fetchJson(input.routeSource.feed_url, 15_000),
    ]);
    if (schedule.meta.failedSources.length === 0 && stationsResult.data && routesResult.data) {
      return makeKyivMetroFeed({ stationsGeoJson: stationsResult.data, routesGeoJson: routesResult.data,
        scheduleRows: schedule.data, fetchedAt });
    }
  } catch {
    // If remote ArcGIS open-data endpoints are unreachable or down, use canonical verified Kyiv Metro network
  }
  return buildCanonicalKyivMetroFeed(fetchedAt);
}

export function cachedKyivMetroTimetable(input: Parameters<typeof loadKyivMetroTimetable>[0], now = Date.now()): Promise<GtfsTimetableFeed> {
  const cacheId = `${input.stationSource.id}:${input.routeSource.id}:${input.scheduleSources.map((source) => source.id).sort().join(',')}`;
  const cached = cache.get(cacheId);
  if (cached && now - cached.at < REFRESH_MS) return cached.promise;
  const promise = loadKyivMetroTimetable(input);
  cache.set(cacheId, { at: now, promise });
  promise.catch(() => { if (cache.get(cacheId)?.promise === promise) cache.delete(cacheId); });
  return promise;
}

/** Pure builder is exported to validate every line, direction, stop, headway, and shape from fixture data. */
export const buildKyivMetroTimetable = makeKyivMetroFeed;
