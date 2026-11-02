import assert from 'node:assert/strict';
import test from 'node:test';
import { buildKyivMetroTimetable } from '../server/mobility/kyivMetroTimetable';
import { findGtfsItinerariesWithStats, mergeGtfsTimetables } from '../server/journey/gtfsTimetable';

const stamp = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
};

function metroFixture() {
  const lines = [
    { id: 'm1', name: 'Святошинсько-Броварська', count: 18, baseLon: 30.1, baseLat: 50.4 },
    { id: 'm2', name: 'Оболонсько-Теремківська', count: 18, baseLon: 30.3, baseLat: 50.4 },
    { id: 'm3', name: 'Сирецько-Печерська', count: 16, baseLon: 30.5, baseLat: 50.4 },
  ];
  const stops = new Map<string, { lineId: string; index: number; name: string; coordinates: [number, number]; transferStopId?: string }>();
  for (const [lineIndex, line] of lines.entries()) {
    for (let index = 0; index < line.count; index++) {
      const id = `${line.id}-${String(index + 1).padStart(2, '0')}`;
      stops.set(id, { lineId: line.id, index, name: `${line.id.toUpperCase()} станція ${index + 1}`,
        coordinates: [line.baseLon + index * 0.001, line.baseLat + lineIndex * 0.001] });
    }
  }
  const pair = (fromLine: string, fromIndex: number, toLine: string, toIndex: number) => {
    const from = stops.get(`${fromLine}-${String(fromIndex + 1).padStart(2, '0')}`)!;
    const to = stops.get(`${toLine}-${String(toIndex + 1).padStart(2, '0')}`)!;
    from.coordinates = [30.4 + fromIndex * 0.001, 50.45];
    to.coordinates = [from.coordinates[0] + 0.0008, 50.45];
    from.transferStopId = `${toLine}-${String(toIndex + 1).padStart(2, '0')}`;
    to.transferStopId = `${fromLine}-${String(fromIndex + 1).padStart(2, '0')}`;
  };
  pair('m1', 6, 'm2', 7);
  pair('m2', 12, 'm3', 8);

  const stationFeatures = [...stops.entries()].map(([code1, stop]) => {
    const line = lines.find((candidate) => candidate.id === stop.lineId)!;
    return { geometry: { type: 'Point', coordinates: stop.coordinates },
      properties: { code1, name: stop.name, line: line.name, ...(stop.transferStopId ? { transf_st: stop.transferStopId } : {}) } };
  });
  const routeFeatures: Array<{ geometry: { type: 'LineString'; coordinates: Array<[number, number]> }; properties: Record<string, unknown> }> = [];
  const scheduleRows: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    scheduleRows.push({ dataKind: 'headways', line: line.name, timeperiod: '00:00-24:00',
      st_weekday: '04:00-04:00', rv_weekday: '04:00-04:00', st_holiday: '04:00-04:00', rv_holiday: '04:00-04:00' });
    for (const direction of ['Прямий', 'Зворотній']) {
      const order = Array.from({ length: line.count }, (_, index) => direction === 'Прямий' ? index : line.count - index - 1);
      const baseFirst = (direction === 'Прямий' ? 5 : 5.1) * 3600;
      const baseLast = 23 * 3600;
      for (const [position, stopIndex] of order.entries()) {
        const stopId = `${line.id}-${String(stopIndex + 1).padStart(2, '0')}`;
        const terminalDestination = position === order.length - 1;
        const first = terminalDestination ? null : stamp(baseFirst + position * 120);
        const last = terminalDestination ? null : stamp(baseLast + position * 120);
        scheduleRows.push({ dataKind: 'stop_times', code1: stopId, line: line.name, napryamok: direction,
          first_trn1: first, first_trn2: first, last_trn1: last, last_trn2: last });
        if (position >= order.length - 1) continue;
        const from = stops.get(stopId)!;
        const toId = `${line.id}-${String(order[position + 1]! + 1).padStart(2, '0')}`;
        const to = stops.get(toId)!;
        const midpoint: [number, number] = [(from.coordinates[0] + to.coordinates[0]) / 2,
          (from.coordinates[1] + to.coordinates[1]) / 2 + 0.00015];
        routeFeatures.push({ geometry: { type: 'LineString', coordinates: [from.coordinates, midpoint, to.coordinates] },
          properties: { num_route: line.name, napryamok: direction, order_: position + 1, from_code1: stopId, to_code1: toId } });
      }
    }
  }
  const timetable = buildKyivMetroTimetable({ stationsGeoJson: { features: stationFeatures }, routesGeoJson: { features: routeFeatures },
    scheduleRows, fetchedAt: new Date('2026-10-13T00:00:00Z') });
  return { timetable, stops };
}

test('builds the three Kyiv metro lines and retains the official transfer links', () => {
  const { timetable } = metroFixture();
  assert.equal(timetable.routes.size, 6);
  assert.equal(new Set([...timetable.routes.values()].map((route) => route.name)).size, 3);
  assert.equal(timetable.stops.size, 52);
  assert.equal(timetable.shapes?.size, 6);
  assert.equal([...timetable.stops.values()].filter((stop) => stop.parentStation).length, 2);
  assert.ok([...timetable.routes.values()].every((route) => route.scheduleSemantics === 'frequency_estimate'));
  assert.ok(timetable.trips.size > 1_000);
});

test('searches and renders an interline metro chain with stop calls and one shape per leg', () => {
  const { timetable, stops } = metroFixture();
  const merged = mergeGtfsTimetables([{ providerId: 'kyiv-metro', providerName: 'Київське метро', providerCity: 'Київ', feed: timetable }]);
  assert.ok(merged);
  const origin = stops.get('m1-03')!;
  const destination = stops.get('m3-15')!;
  const result = findGtfsItinerariesWithStats(merged, {
    providerId: 'kyiv-metro', providerName: 'Київське метро', providerCity: 'Київ',
    origin: origin.coordinates, destination: destination.coordinates,
    earliestDeparture: new Date('2026-10-14T02:00:00Z'), latestDeparture: new Date('2026-10-14T02:20:00Z'),
    now: new Date('2026-10-13T00:00:00Z'), maximumTransfers: 2, maximumJourneySeconds: 2 * 60 * 60,
    maximumWaitSeconds: 2 * 60 * 60, maximumStopDistanceMeters: 500, maximumTransferWalkingMeters: 400, limit: 10,
  });
  const itinerary = result.itineraries.find((candidate) => candidate.segments.length === 3);
  assert.ok(itinerary, 'expected the route to cross both configured transfer links');
  assert.equal(itinerary.transfers, 2);
  assert.deepEqual(itinerary.segments.map((segment) => segment.transportType), ['metro', 'metro', 'metro']);
  for (const segment of itinerary.segments) {
    assert.ok((segment.routeGeometry?.length ?? 0) >= 2);
    assert.ok((segment.stops?.length ?? 0) >= 2);
    assert.equal(segment.scheduleSemantics, 'frequency_estimate');
    assert.ok(segment.stops!.every((stop, index, all) => index === 0
      || Date.parse(stop.arrivalAt) >= Date.parse(all[index - 1]!.departureAt)));
  }
});
