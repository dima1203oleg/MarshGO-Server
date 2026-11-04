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

test('composes multimodal cross-provider transit chain connecting tram to metro via walking transfer', () => {
  const { timetable: metroTimetable, stops: metroStops } = metroFixture();
  const metroStart = metroStops.get('m1-02')!;

  // Create a synthetic surface transit feed (tram connecting to m1-02 via ~100m walk)
  const tramStopCoords: [number, number] = [metroStart.coordinates[0] + 0.001, metroStart.coordinates[1]];
  const tramFeed: Parameters<typeof mergeGtfsTimetables>[0][number]['feed'] = {
    fetchedAt: new Date('2026-10-13T00:00:00Z'),
    timezone: 'Europe/Kyiv',
    routes: new Map([
      ['tram-3', { name: 'Трамвай 3', mode: 'TRAM', transportType: 'tram' }]
    ]),
    stops: new Map([
      ['tram-origin', { id: 'tram-origin', name: 'Початкова зупинка', lon: 30.070, lat: 50.40 }],
      ['tram-transfer', { id: 'tram-transfer', name: 'Пересадочна зупинка', lon: tramStopCoords[0], lat: tramStopCoords[1] }]
    ]),
    trips: new Map([
      ['tram-trip-1', { routeId: 'tram-3', serviceId: 'tram-cal', directionId: 0, headsign: 'Центр' }]
    ]),
    stopTimes: new Map([
      ['tram-trip-1', [
        { stopId: 'tram-origin', sequence: 1, departureSeconds: 18300, arrivalSeconds: 18300, pickupType: 0, dropOffType: 0 },
        { stopId: 'tram-transfer', sequence: 2, departureSeconds: 18600, arrivalSeconds: 18600, pickupType: 0, dropOffType: 0 }
      ]]
    ]),
    stopTimesByStop: new Map([
      ['tram-origin', [{
        tripId: 'tram-trip-1', stopId: 'tram-origin', stopSequence: 1,
        departureTime: '05:05:00', arrivalTime: '05:05:00', pickupType: 0, dropOffType: 0
      }]],
      ['tram-transfer', [{
        tripId: 'tram-trip-1', stopId: 'tram-transfer', stopSequence: 2,
        departureTime: '05:10:00', arrivalTime: '05:10:00', pickupType: 0, dropOffType: 0
      }]]
    ]),
    calendars: new Map([
      ['tram-cal', { start: '20260101', end: '20261231', weekdays: [true, true, true, true, true, true, true] }]
    ]),
    exceptions: new Map(),
  };

  const merged = mergeGtfsTimetables([
    { providerId: 'kyiv-tram', providerName: 'Київпастранс', providerCity: 'Київ', feed: tramFeed },
    { providerId: 'kyiv-metro', providerName: 'Київське метро', providerCity: 'Київ', feed: metroTimetable },
  ]);
  assert.ok(merged);

  const destinationStation = metroStops.get('m1-05')!;
  const result = findGtfsItinerariesWithStats(merged, {
    origin: [30.070, 50.40],
    destination: destinationStation.coordinates,
    earliestDeparture: new Date('2026-10-14T02:00:00Z'),
    latestDeparture: new Date('2026-10-14T02:15:00Z'),
    now: new Date('2026-10-13T00:00:00Z'),
    maximumTransfers: 2,
    maximumJourneySeconds: 7200,
    maximumWaitSeconds: 3600,
    maximumAccessWalkingMeters: 1200,
    maximumEgressWalkingMeters: 1200,
    maximumTransferWalkingMeters: 800,
    limit: 10,
  });

  const intermodal = result.itineraries.find((it) => it.segments.some((s) => s.transportType === 'tram')
    && it.segments.some((s) => s.transportType === 'metro'));
  assert.ok(intermodal, 'expected a combined tram + metro multimodal itinerary');
  assert.equal(intermodal.segments[0].transportType, 'tram');
  assert.equal(intermodal.segments[1].transportType, 'metro');
});
