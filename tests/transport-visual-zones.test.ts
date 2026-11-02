// ТЗ-MG-VIZ-4: the universal three-zone split and the five-level vehicle priority
// engine. Fixtures are labelled synthetic — they prove the geometry and ranking
// rules, not any live feed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyVehiclePriority, splitRouteGeometryByStops } from '../server/journey/transportVisualZones';
import { buildLiveJourneySegment } from '../server/journey/liveJourneySegments';
import type { GtfsTimetableFeed } from '../server/journey/gtfsTimetable';
import type { LiveVehicle, TransportNetwork } from '../server/mobility/transportLayers';

const providerId = 'provider-1';
const now = Date.parse('2026-10-18T10:00:00.000Z');
const routeId = 'route-3';
const serviceDate = '20261018';

/** A straight west→east line, six vertices; the reverse direction is the same points flipped. */
const line: Array<[number, number]> = Array.from({ length: 6 }, (_, index) => [24 + index * 0.01, 49.84]);
const stopCoordinates: Record<string, [number, number]> = {
  'stop-1': line[0], 'stop-2': line[1], 'stop-3': line[2], 'stop-4': line[3], 'stop-5': line[5],
};

const basePriority = { fresh: true, sameRoute: true, direction: 'MATCHING' as const, servesBoardingStop: true,
  passedBoardingStop: false, approaching: true, remainingStops: 2 as number | null, etaSeconds: 600 as number | null };

describe('three-zone geometry splitter', () => {
  it('slices the drawn line at the boarding and alighting stops and keeps it continuous', () => {
    const split = splitRouteGeometryByStops(line, stopCoordinates['stop-2'], stopCoordinates['stop-4']);
    assert.ok(split);
    assert.deepEqual(split.beforeBoarding, line.slice(0, 2));
    assert.deepEqual(split.passengerSegment, line.slice(1, 4));
    assert.deepEqual(split.afterAlighting, line.slice(3));
    // Zones A+B+C must re-form the exact line that is drawn, sharing boundary vertices.
    const joined = [...split.beforeBoarding!, ...split.passengerSegment.slice(1), ...split.afterAlighting!.slice(1)];
    assert.deepEqual(joined, line);
  });

  it('has no zone A when boarding is the first vertex and no zone C when alighting is the last', () => {
    const atStart = splitRouteGeometryByStops(line, stopCoordinates['stop-1'], stopCoordinates['stop-4']);
    assert.equal(atStart?.beforeBoarding, null);
    assert.deepEqual(atStart?.passengerSegment, line.slice(0, 4));
    const atEnd = splitRouteGeometryByStops(line, stopCoordinates['stop-2'], stopCoordinates['stop-5']);
    assert.equal(atEnd?.afterAlighting, null);
    assert.deepEqual(atEnd?.passengerSegment, line.slice(1));
  });

  it('extends zone B to the end of the line when the alighting stop is not on this direction', () => {
    const split = splitRouteGeometryByStops(line, stopCoordinates['stop-3'], null);
    assert.deepEqual(split?.passengerSegment, line.slice(2));
    assert.equal(split?.afterAlighting, null);
    assert.equal(split?.alightingShapeIndex, null);
  });

  it('refuses to split when the stops do not project onto this line', () => {
    assert.equal(splitRouteGeometryByStops(line, [24.02, 49.92], stopCoordinates['stop-4']), null);
    assert.equal(splitRouteGeometryByStops(line, null, null), null);
    assert.equal(splitRouteGeometryByStops([[24, 49]] as Array<[number, number]>, [24, 49] as [number, number], null), null);
  });

  it('picks the ordered pair on a line that passes the same place twice', () => {
    // Out and back: index 1 and index 5 are the same stop position.
    const loop: Array<[number, number]> = [[24, 49.84], [24.02, 49.84], [24.04, 49.84], [24.02, 49.840001], [24, 49.840001]];
    const split = splitRouteGeometryByStops(loop, [24, 49.84], [24.04, 49.84]);
    assert.equal(split?.boardingShapeIndex, 0);
    assert.equal(split?.alightingShapeIndex, 2);
  });
});

describe('five-level vehicle priority engine', () => {
  it('reserves L4 for a vehicle observed at the boarding stop', () => {
    assert.deepEqual(classifyVehiclePriority({ ...basePriority, remainingStops: 0 }), { level: 'L4', reason: 'at_boarding_stop' });
  });

  it('splits approaching vehicles by a confirmed short ETA', () => {
    assert.equal(classifyVehiclePriority({ ...basePriority, etaSeconds: 120 }).level, 'L3');
    assert.equal(classifyVehiclePriority({ ...basePriority, etaSeconds: 181 }).level, 'L2');
    assert.equal(classifyVehiclePriority({ ...basePriority, etaSeconds: null }).reason, 'approaching_without_eta');
  });

  it('keeps irrelevant vehicles at L1 instead of letting them look like the next arrival', () => {
    assert.deepEqual(classifyVehiclePriority({ ...basePriority, direction: 'OPPOSITE' }), { level: 'L1', reason: 'opposite_direction' });
    assert.deepEqual(classifyVehiclePriority({ ...basePriority, passedBoardingStop: true }), { level: 'L1', reason: 'behind_boarding_stop' });
    assert.deepEqual(classifyVehiclePriority({ ...basePriority, servesBoardingStop: false }), { level: 'L1', reason: 'not_serving_boarding_stop' });
    assert.deepEqual(classifyVehiclePriority({ ...basePriority, direction: 'UNKNOWN' }), { level: 'L1', reason: 'direction_unverified' });
  });

  it('drops stale or other-route vehicles to the background', () => {
    assert.deepEqual(classifyVehiclePriority({ ...basePriority, fresh: false }), { level: 'L0', reason: 'stale_position' });
    assert.deepEqual(classifyVehiclePriority({ ...basePriority, sameRoute: false }), { level: 'L0', reason: 'other_route' });
  });
});

function tripStopIds(tripId: string): string[] {
  return tripId === 'trip-opposite' ? ['stop-5', 'stop-4', 'stop-3', 'stop-2', 'stop-1'] : ['stop-1', 'stop-2', 'stop-3', 'stop-4', 'stop-5'];
}

function timetableFeed(): GtfsTimetableFeed {
  const trips = new Map<string, { routeId: string; serviceId: string; headsign: string; directionId?: string }>();
  const stopTimes = new Map<string, GtfsTimetableFeed['stopTimes'] extends Map<string, infer T> ? T : never>();
  for (const [tripId, directionId] of [['trip-forward', '0'], ['trip-opposite', '1']] as const) {
    trips.set(tripId, { routeId, serviceId: 'service', headsign: directionId === '0' ? 'Схід' : 'Захід', directionId });
    stopTimes.set(tripId, tripStopIds(tripId).map((stopId, index) => ({
      stopId, sequence: index + 1, arrivalSeconds: 13 * 3600 + index * 300, departureSeconds: 13 * 3600 + index * 300,
      pickupType: 0, dropOffType: 0, sourceStopCoordinates: stopCoordinates[stopId],
    })));
  }
  return {
    fetchedAt: new Date(now), timezone: 'Europe/Kyiv', routes: new Map(), stops: new Map(), trips,
    stopTimes: stopTimes as GtfsTimetableFeed['stopTimes'], stopTimesByStop: new Map(),
    calendars: new Map([['service', { start: serviceDate, end: serviceDate, weekdays: [true, true, true, true, true, true, true] }]]),
    exceptions: new Map(),
  };
}

function networkFeed(): TransportNetwork {
  return {
    bbox: [24, 49.8, 24.06, 49.9],
    stops: Object.entries(stopCoordinates).map(([id, [lon, lat]]) => ({ id, name: id, lon, lat, types: ['tram'], routes: [routeId] })),
    routes: [
      { id: `${routeId}|0`, name: '3', type: 'tram', direction: 'Захід → Схід', directionId: '0', geometrySource: 'gtfs_shape', stopCount: 5, coordinates: line },
      { id: `${routeId}|1`, name: '3', type: 'tram', direction: 'Схід → Захід', directionId: '1', geometrySource: 'gtfs_shape', stopCount: 5, coordinates: [...line].reverse() },
    ],
  };
}

function liveVehicle(id: string, tripId: string, currentStopSequence: number): LiveVehicle {
  return { id: `${providerId}:${id}`, lon: 24.01, lat: 49.84, type: 'tram', route: '3', bearing: 90, speed: 6,
    timestamp: new Date(now - 20_000), providerId, tripId, routeId, startDate: serviceDate, currentStopSequence };
}

describe('live segment carries the zones and priorities the map draws', () => {
  const leg = {
    id: 'leg-1', providerId,
    metadata: {
      tripId: `${providerId}:trip-forward`, routeId: `${providerId}:${routeId}`, serviceDate,
      fromStopFeedId: `${providerId}:stop-2`, toStopFeedId: `${providerId}:stop-4`, routeName: '3',
    },
    scheduledDepartureAt: new Date(now - 60_000), scheduledArrivalAt: new Date(now + 20 * 60_000),
  };

  it('slices only the direction the passenger rides and leaves the reverse direction unsliced', () => {
    const result = buildLiveJourneySegment(leg, { vehicles: [liveVehicle('a', 'trip-forward', 1), liveVehicle('b', 'trip-opposite', 1)],
      network: networkFeed(), timetable: timetableFeed() }, now);
    const forward = result.lineRoutes.find(({ directionId }) => directionId === '0');
    const reverse = result.lineRoutes.find(({ directionId }) => directionId === '1');
    assert.equal(forward?.geometryScope, 'full_route');
    assert.deepEqual(forward?.zones?.beforeBoarding, line.slice(0, 2));
    assert.deepEqual(forward?.zones?.passengerSegment, line.slice(1, 4));
    assert.deepEqual(forward?.zones?.afterAlighting, line.slice(3));
    assert.equal(reverse?.zones, null, 'the opposite direction is a different line, not a zone of ours');
  });

  it('labels a leg-only scheduled fallback as the passenger segment instead of a full line', () => {
    const withGeometry = buildLiveJourneySegment({
      ...leg,
      metadata: { routeId, routeGeometrySource: 'gtfs_shape', routeGeometry: line.slice(1, 4), fromStopFeedId: 'stop-2', toStopFeedId: 'stop-4' },
    }, { vehicles: null, network: null, timetable: null }, now);
    assert.equal(withGeometry.lineRoutes.length, 1);
    assert.equal(withGeometry.lineRoutes[0]?.geometryScope, 'leg_only');
    assert.deepEqual(withGeometry.lineRoutes[0]?.zones?.passengerSegment, line.slice(1, 4));
    assert.equal(withGeometry.lineRoutes[0]?.zones?.beforeBoarding, null);
    assert.equal(withGeometry.lineRoutes[0]?.zones?.afterAlighting, null);
  });

  it('ranks an oncoming vehicle of the same line below the one approaching our stop', () => {
    const result = buildLiveJourneySegment(leg, { vehicles: [liveVehicle('a', 'trip-forward', 1), liveVehicle('b', 'trip-opposite', 1)],
      network: networkFeed(), timetable: timetableFeed() }, now);
    const forward = result.vehicles.find(({ id }) => id.endsWith(':a'));
    const reverse = result.vehicles.find(({ id }) => id.endsWith(':b'));
    assert.equal(forward?.priority.level, 'L2');
    assert.equal(forward?.etaConfidence, 'OBSERVED');
    assert.equal(reverse?.priority.level, 'L1');
    assert.equal(reverse?.priority.reason, 'opposite_direction');
  });
});
