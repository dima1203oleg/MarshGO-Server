import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GtfsTimetableFeed } from '../server/journey/gtfsTimetable';
import { buildLiveJourneySegment } from '../server/journey/liveJourneySegments';
import { networkSchema, type LiveVehicle, type TransportNetwork } from '../server/mobility/transportLayers';

const providerId = 'provider-1';
const now = Date.parse('2026-10-18T10:00:00.000Z');
const routeId = 'route-55';
const serviceDate = '20261018';

function vehicle(id: string, tripId: string, currentStopSequence: number, overrides: Partial<LiveVehicle> = {}): LiveVehicle {
  return {
    id: `${providerId}:${id}`, lon: 24.02, lat: 49.84, type: 'marshrutka', route: '55', bearing: 90, speed: 8,
    timestamp: new Date(now - 20_000), providerId, tripId, routeId, startDate: serviceDate, currentStopSequence,
    ...overrides,
  };
}

function feed(): GtfsTimetableFeed {
  const stopTimes = new Map<string, Array<{ stopId: string; sequence: number; arrivalSeconds: number; departureSeconds: number; pickupType: number; dropOffType: number }>>();
  const trips = new Map<string, { routeId: string; serviceId: string; headsign: string; directionId?: string }>();
  for (const [tripId, directionId] of [['trip-selected', '0'], ['trip-near', '0'], ['trip-middle', '0'], ['trip-far', '0'], ['trip-opposite', '1']] as const) {
    trips.set(tripId, { routeId, serviceId: 'service', headsign: directionId === '0' ? 'to boarding' : 'away from boarding', directionId });
    const stopIds = tripId === 'trip-opposite'
      ? ['stop-4', 'stop-5', 'stop-6', 'stop-7', 'stop-8']
      : ['stop-1', 'stop-2', 'stop-3', 'stop-4', 'stop-5'];
    stopTimes.set(tripId, stopIds.map((stopId, index) => ({
      stopId, sequence: index + 1, arrivalSeconds: index * 300, departureSeconds: index * 300,
      pickupType: 0, dropOffType: 0,
    })));
  }
  return {
    fetchedAt: new Date(now), timezone: 'Europe/Kyiv', routes: new Map(), stops: new Map(), trips,
    stopTimes, stopTimesByStop: new Map(), calendars: new Map(), exceptions: new Map(),
  };
}

function network(): TransportNetwork {
  const coordinates: Array<[number, number]> = [[24, 49], [24.01, 49.01]];
  return {
    stops: [], bbox: [24, 49, 24.01, 49.01],
    routes: [
      { id: `${routeId}|0`, name: '55', type: 'marshrutka', direction: 'A → B', directionId: '0', geometrySource: 'gtfs_shape', stopCount: 5, coordinates },
      { id: `${routeId}|1`, name: '55', type: 'marshrutka', direction: 'B → A', directionId: '1', geometrySource: 'gtfs_shape', stopCount: 5, coordinates: [...coordinates].reverse() },
      { id: `${routeId}|2`, name: '55', type: 'marshrutka', direction: 'estimated', directionId: '2', geometrySource: 'stop_sequence', stopCount: 2, coordinates },
      { id: 'route-550|0', name: '550', type: 'marshrutka', direction: 'other route', directionId: '0', geometrySource: 'gtfs_shape', stopCount: 2, coordinates },
    ],
  };
}

describe('live journey segment assembly', () => {
  const leg = {
    id: 'leg-1', providerId,
    metadata: { tripId: `${providerId}:trip-selected`, routeId: `${providerId}:${routeId}`, serviceDate, fromStopFeedId: `${providerId}:stop-4`, routeName: '55' },
    scheduledDepartureAt: new Date(now - 60_000), scheduledArrivalAt: new Date(now + 20 * 60_000),
  };

  it('draws both exact GTFS directions, shows every fresh route vehicle, and emphasizes only the three proven approaches', () => {
    const vehicles = [
      vehicle('selected', 'trip-selected', 1),
      vehicle('near', 'trip-near', 3),
      vehicle('middle', 'trip-middle', 2),
      vehicle('far', 'trip-far', 0),
      vehicle('opposite', 'trip-opposite', 5),
      vehicle('unknown-trip', 'not-in-static-feed', 1),
      vehicle('stale', 'trip-near', 1, { timestamp: new Date(now - 90_001) }),
      vehicle('other-route', 'trip-near', 1, { routeId: 'route-550' }),
      vehicle('other-provider', 'trip-near', 1, { providerId: 'provider-2' }),
    ];
    const result = buildLiveJourneySegment(leg, { vehicles, network: network(), timetable: feed() }, now);

    assert.equal(result.status, 'LIVE');
    assert.deepEqual(result.lineRoutes.map(({ directionId }) => directionId), ['0', '1']);
    assert.ok(result.lineRoutes.every(({ geometrySource }) => geometrySource === 'gtfs_shape'));
    assert.deepEqual(result.vehicles.map(({ id }) => id), [
      `${providerId}:far`, `${providerId}:middle`, `${providerId}:near`, `${providerId}:opposite`,
      `${providerId}:selected`, `${providerId}:unknown-trip`,
    ]);
    assert.deepEqual(result.vehicles.filter(({ emphasized }) => emphasized).map(({ id }) => id), [
      `${providerId}:middle`, `${providerId}:near`, `${providerId}:selected`,
    ]);
    assert.equal(result.vehicles.find(({ id }) => id.endsWith(':opposite'))?.approachingBoarding, false);
    assert.equal(result.vehicles.find(({ id }) => id.endsWith(':unknown-trip'))?.approachingBoarding, false);
    assert.equal(result.vehicles.find(({ id }) => id.endsWith(':far'))?.approachingBoarding, true);
    assert.equal(result.vehicle?.coordinates[0], 24.02);
  });

  it('preserves GTFS direction and geometry provenance across the cached network schema', () => {
    const cachedNetwork = networkSchema.parse(network());
    const result = buildLiveJourneySegment(leg, { vehicles: [], network: cachedNetwork, timetable: feed() }, now);

    assert.deepEqual(cachedNetwork.routes.slice(0, 2).map(({ directionId, geometrySource }) => ({ directionId, geometrySource })), [
      { directionId: '0', geometrySource: 'gtfs_shape' },
      { directionId: '1', geometrySource: 'gtfs_shape' },
    ]);
    assert.deepEqual(result.lineRoutes.map(({ directionId }) => directionId), ['0', '1']);
  });

  it('keeps a verified scheduled line when live positions are absent and refuses stop-sequence estimates as full line geometry', () => {
    const result = buildLiveJourneySegment(leg, { vehicles: null, network: network(), timetable: feed() }, now);
    assert.equal(result.status, 'SCHEDULED');
    assert.deepEqual(result.lineRoutes.map(({ directionId }) => directionId), ['0', '1']);
    assert.deepEqual(result.vehicles, []);
  });

  it('uses provenance-marked official route geometry as scheduled context without inventing live vehicles', () => {
    const coordinates: Array<[number, number]> = [[30.598, 50.452], [30.57, 50.455], [30.526, 50.459]];
    const result = buildLiveJourneySegment({
      ...leg,
      metadata: { routeId: 'kyiv-metro:red:0', routeName: 'M1', headsign: 'Поштова площа', routeGeometrySource: 'official_geojson', routeGeometry: coordinates },
    }, { vehicles: null, network: null, timetable: null }, now);

    assert.equal(result.status, 'SCHEDULED');
    assert.equal(result.lineRoutes.length, 1);
    assert.equal(result.lineRoutes[0]?.geometrySource, 'official_geojson');
    assert.deepEqual(result.lineRoutes[0]?.coordinates, coordinates);
    assert.deepEqual(result.vehicles, []);
  });

  it('does not use stored route geometry without an explicit trusted source marker', () => {
    const result = buildLiveJourneySegment({
      ...leg,
      metadata: { routeId: 'route-55', routeGeometry: [[24, 49], [24.01, 49.01]] },
    }, { vehicles: null, network: null, timetable: null }, now);

    assert.equal(result.status, 'UNVERIFIED');
    assert.equal(result.reason, 'provider_unavailable');
    assert.deepEqual(result.lineRoutes, []);
    assert.deepEqual(result.vehicles, []);
  });

  it('does not claim live coverage when neither a vehicle feed nor a network is available', () => {
    const result = buildLiveJourneySegment(leg, { vehicles: null, network: null, timetable: null }, now);
    assert.equal(result.status, 'UNVERIFIED');
    assert.equal(result.reason, 'provider_unavailable');
    assert.deepEqual(result.lineRoutes, []);
    assert.deepEqual(result.vehicles, []);
  });

  it('returns a scheduled empty segment when the leg has no provider identity', () => {
    const result = buildLiveJourneySegment({ ...leg, providerId: null }, { vehicles: [], network: network(), timetable: feed() }, now);
    assert.equal(result.status, 'SCHEDULED');
    assert.deepEqual(result.lineRoutes, []);
    assert.deepEqual(result.vehicles, []);
  });
});
