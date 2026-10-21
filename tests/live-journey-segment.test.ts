import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GtfsTimetableFeed } from '../server/journey/gtfsTimetable';
import { buildLiveJourneySegment } from '../server/journey/liveJourneySegments';
import { gtfsRealtimeTripUpdateKey, type GtfsRealtimeTripUpdate } from '../server/journey/gtfsRealtime';
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
      stopId, sequence: index + 1, arrivalSeconds: 13 * 3600 + index * 300, departureSeconds: 13 * 3600 + index * 300,
      pickupType: 0, dropOffType: 0,
    })));
  }
  const timetable: GtfsTimetableFeed = {
    fetchedAt: new Date(now), timezone: 'Europe/Kyiv', routes: new Map(), stops: new Map(), trips,
    stopTimes, stopTimesByStop: new Map(), calendars: new Map([['service', {
      start: serviceDate, end: serviceDate, weekdays: [true, true, true, true, true, true, true],
    }]]), exceptions: new Map(),
  };
  timetable.realtimeTripUpdates = new Map([...trips].map(([tripId]) => {
    const opposite = tripId === 'trip-opposite';
    return [gtfsRealtimeTripUpdateKey(tripId, serviceDate), tripUpdate({
      tripId,
      stops: [{ stopSequence: opposite ? 1 : 4, stopId: 'stop-4', arrival: { delaySeconds: 300 }, relationship: 'SCHEDULED' }],
    })] as const;
  }));
  return timetable;
}

function tripUpdate(overrides: Partial<GtfsRealtimeTripUpdate> = {}): GtfsRealtimeTripUpdate {
  return {
    tripId: 'trip-selected', routeId, startDate: serviceDate, relationship: 'SCHEDULED',
    stops: [{ stopSequence: 4, stopId: 'stop-4', arrival: { delaySeconds: 300 }, relationship: 'SCHEDULED' }],
    updatedAt: new Date(now - 10_000), feedTimestamp: new Date(now - 10_000), ...overrides,
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
    assert.equal(result.vehicles.find(({ id }) => id.endsWith(':selected'))?.approachEvidence?.source, 'OBSERVED_PROGRESS');
    assert.equal(result.vehicles.find(({ id }) => id.endsWith(':selected'))?.etaSeconds, 1_200);
    assert.equal(result.vehicle?.coordinates[0], 24.02);
    assert.equal(result.vehiclePositionStatus, 'OBSERVED');
    assert.equal(result.boardingStopArrival.status, 'PREDICTED');
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

  it('keeps a schedule-only line when a fresh realtime snapshot is valid but empty', () => {
    const timetable = feed();
    timetable.realtimeTripUpdates = new Map();
    const result = buildLiveJourneySegment(leg, { vehicles: [], network: network(), timetable }, now);

    assert.equal(result.status, 'SCHEDULED');
    assert.equal(result.vehiclePositionStatus, 'UNAVAILABLE');
    assert.equal(result.boardingStopArrival.status, 'SCHEDULED');
    assert.equal(result.boardingStopArrival.predictedAt, undefined);
    assert.deepEqual(result.lineRoutes.map(({ directionId }) => directionId), ['0', '1']);
    assert.deepEqual(result.vehicles, [], 'an empty snapshot must not create live vehicle markers');
  });

  it('links a fresh exact vehicle trip instance to its boarding-stop TripUpdate as a prediction, not an observation', () => {
    const timetable = feed();
    timetable.realtimeTripUpdates = new Map([[gtfsRealtimeTripUpdateKey('trip-selected', serviceDate), tripUpdate()]]);
    const result = buildLiveJourneySegment(leg, { vehicles: [vehicle('selected', 'trip-selected', 1)], network: network(), timetable }, now);

    assert.equal(result.vehiclePositionStatus, 'OBSERVED');
    assert.equal(result.boardingStopArrival.status, 'PREDICTED');
    assert.equal(Date.parse(result.boardingStopArrival.predictedAt!) - Date.parse(result.boardingStopArrival.scheduledAt!), 300_000);
    assert.equal(result.boardingStopArrival.realtimeUpdatedAt, new Date(now - 10_000).toISOString());
  });

  it('does not link a TripUpdate to a vehicle when the vehicle service date is absent or mismatched', () => {
    const timetable = feed();
    timetable.realtimeTripUpdates = new Map([[gtfsRealtimeTripUpdateKey('trip-selected', serviceDate), tripUpdate()]]);
    const withoutDate = buildLiveJourneySegment(leg, {
      vehicles: [vehicle('selected', 'trip-selected', 1, { startDate: undefined })], network: network(), timetable,
    }, now);
    const wrongDate = buildLiveJourneySegment(leg, {
      vehicles: [vehicle('selected', 'trip-selected', 1, { startDate: '20261017' })], network: network(), timetable,
    }, now);

    assert.equal(withoutDate.boardingStopArrival.status, 'SCHEDULED');
    assert.equal(wrongDate.boardingStopArrival.status, 'SCHEDULED');
    assert.equal(withoutDate.vehiclePositionStatus, 'OBSERVED');
    assert.equal(wrongDate.vehiclePositionStatus, 'UNAVAILABLE');
    assert.equal(withoutDate.vehicles[0]?.approachingBoarding, false);
    assert.equal(withoutDate.vehicles[0]?.emphasized, false);
    assert.equal(withoutDate.vehicles[0]?.approachEvidence, null);
    assert.equal(wrongDate.vehicles[0]?.approachingBoarding, false);
    assert.equal(wrongDate.vehicles[0]?.emphasized, false);
  });

  it('does not apply a TripUpdate with a mismatched route or boarding stop identity', () => {
    const wrongRouteFeed = feed();
    wrongRouteFeed.realtimeTripUpdates = new Map([[gtfsRealtimeTripUpdateKey('trip-selected', serviceDate), tripUpdate({ routeId: 'other-route' })]]);
    const wrongStopFeed = feed();
    wrongStopFeed.realtimeTripUpdates = new Map([[gtfsRealtimeTripUpdateKey('trip-selected', serviceDate), tripUpdate({
      stops: [{ stopSequence: 4, stopId: 'different-stop', arrival: { delaySeconds: 300 }, relationship: 'SCHEDULED' }],
    })]]);

    const wrongRoute = buildLiveJourneySegment(leg, { vehicles: [vehicle('selected', 'trip-selected', 1)], network: network(), timetable: wrongRouteFeed }, now);
    const wrongStop = buildLiveJourneySegment(leg, { vehicles: [vehicle('selected', 'trip-selected', 1)], network: network(), timetable: wrongStopFeed }, now);
    assert.equal(wrongRoute.boardingStopArrival.status, 'SCHEDULED');
    assert.equal(wrongStop.boardingStopArrival.status, 'SCHEDULED');
  });

  it('does not label non-scheduled TripUpdate relationships as predictions', () => {
    const timetable = feed();
    timetable.realtimeTripUpdates = new Map([[gtfsRealtimeTripUpdateKey('trip-selected', serviceDate), tripUpdate({
      relationship: 'OTHER',
    })]]);
    const result = buildLiveJourneySegment(leg, { vehicles: [vehicle('selected', 'trip-selected', 1)], network: network(), timetable }, now);
    assert.equal(result.boardingStopArrival.status, 'SCHEDULED');
  });

  it('does not infer a boarding-stop arrival time from a departure-only update', () => {
    const timetable = feed();
    timetable.realtimeTripUpdates = new Map([[gtfsRealtimeTripUpdateKey('trip-selected', serviceDate), tripUpdate({
      stops: [{ stopSequence: 4, stopId: 'stop-4', departure: { delaySeconds: 300 }, relationship: 'SCHEDULED' }],
    })]]);
    const result = buildLiveJourneySegment(leg, { vehicles: [vehicle('selected', 'trip-selected', 1)], network: network(), timetable }, now);
    assert.equal(result.boardingStopArrival.status, 'SCHEDULED');
    assert.equal(result.boardingStopArrival.predictedAt, undefined);
    assert.equal(result.vehicles[0]?.approachEvidence?.source, 'OBSERVED_PROGRESS');
    assert.equal(result.vehicles[0]?.etaSeconds, null);
  });

  it('emphasizes prediction-only vehicles only for an exact fresh future dated stop update', () => {
    const makeResult = (update: GtfsRealtimeTripUpdate) => {
      const timetable = feed();
      timetable.realtimeTripUpdates = new Map([[gtfsRealtimeTripUpdateKey('trip-selected', serviceDate), update]]);
      return buildLiveJourneySegment(leg, {
        vehicles: [vehicle('prediction-only', 'trip-selected', 1, { currentStopSequence: undefined, currentStopId: undefined })],
        network: network(), timetable,
      }, now).vehicles[0];
    };
    const valid = makeResult(tripUpdate());
    assert.equal(valid?.approachingBoarding, true);
    assert.equal(valid?.emphasized, true);
    assert.equal(valid?.approachEvidence?.source, 'TRIP_UPDATE_PREDICTION');
    assert.equal(valid?.etaSeconds, 1_200);

    const mutedUpdates = [
      tripUpdate({ updatedAt: new Date(now - 90_001), feedTimestamp: new Date(now - 90_001) }),
      tripUpdate({ relationship: 'CANCELED' }),
      tripUpdate({ relationship: 'DELETED' }),
      tripUpdate({ tripId: 'another-trip' }),
      tripUpdate({ startDate: '20261017' }),
      tripUpdate({ routeId: 'other-route' }),
      tripUpdate({ stops: [{ stopSequence: 4, stopId: 'wrong-stop', arrival: { delaySeconds: 300 }, relationship: 'SCHEDULED' }] }),
      tripUpdate({ stops: [{ stopSequence: 4, stopId: 'stop-4', arrival: { delaySeconds: 300 }, relationship: 'SKIPPED' }] }),
      tripUpdate({ stops: [{ stopSequence: 4, stopId: 'stop-4', arrival: { delaySeconds: 300 }, relationship: 'NO_DATA' }] }),
      tripUpdate({ stops: [{ stopSequence: 4, stopId: 'stop-4', arrival: { delaySeconds: 300 }, relationship: 'UNSCHEDULED' }] }),
      tripUpdate({ stops: [{ stopSequence: 3, stopId: 'stop-4', arrival: { delaySeconds: 300 }, relationship: 'SCHEDULED' }] }),
      tripUpdate({ stops: [{ stopSequence: 4, stopId: 'stop-4', arrival: { time: new Date(now - 1_000) }, relationship: 'SCHEDULED' }] }),
    ];
    for (const update of mutedUpdates) {
      const result = makeResult(update);
      assert.equal(result?.approachingBoarding, false, JSON.stringify(update));
      assert.equal(result?.emphasized, false, JSON.stringify(update));
      assert.equal(result?.approachEvidence, null, JSON.stringify(update));
      assert.equal(result?.etaSeconds, null, JSON.stringify(update));
    }
  });

  it('keeps observed progress evidence usable without a TripUpdate ETA', () => {
    const timetable = feed();
    timetable.realtimeTripUpdates = new Map();
    const result = buildLiveJourneySegment(leg, {
      vehicles: [vehicle('observed-only', 'trip-selected', 1)], network: network(), timetable,
    }, now);
    const item = result.vehicles[0];
    assert.equal(item?.approachingBoarding, true);
    assert.equal(item?.emphasized, true);
    assert.equal(item?.approachEvidence?.source, 'OBSERVED_PROGRESS');
    assert.equal(item?.etaSeconds, null);
    assert.equal(item?.approachEvidence?.remainingStops, 3);
  });

  it('does not let stale realtime override fresh observed progress, but explicit cancellation or skipped stops suppress it', () => {
    const makeResult = (update?: GtfsRealtimeTripUpdate) => {
      const timetable = feed();
      timetable.realtimeTripUpdates = update
        ? new Map([[gtfsRealtimeTripUpdateKey('trip-selected', serviceDate), update]])
        : new Map();
      return buildLiveJourneySegment(leg, {
        vehicles: [vehicle('observed', 'trip-selected', 1)], network: network(), timetable,
      }, now).vehicles[0];
    };
    const stale = makeResult(tripUpdate({ updatedAt: new Date(now - 90_001), feedTimestamp: new Date(now - 90_001) }));
    assert.equal(stale?.approachEvidence?.source, 'OBSERVED_PROGRESS');
    assert.equal(stale?.emphasized, true);

    for (const update of [
      tripUpdate({ relationship: 'CANCELED' }),
      tripUpdate({ relationship: 'DELETED' }),
      ...(['SKIPPED', 'NO_DATA', 'UNSCHEDULED'] as const).map((relationship) => tripUpdate({
        stops: [{ stopSequence: 4, stopId: 'stop-4', arrival: { delaySeconds: 300 }, relationship }],
      })),
    ]) {
      const item = makeResult(update);
      assert.equal(item?.approachingBoarding, false, JSON.stringify(update));
      assert.equal(item?.emphasized, false, JSON.stringify(update));
      assert.equal(item?.approachEvidence, null, JSON.stringify(update));
    }
  });

  it('does not expose an already-past TripUpdate as a future boarding prediction', () => {
    const timetable = feed();
    timetable.realtimeTripUpdates = new Map([[gtfsRealtimeTripUpdateKey('trip-selected', serviceDate), tripUpdate({
      stops: [{ stopSequence: 4, stopId: 'stop-4', arrival: { time: new Date(now - 1_000) }, relationship: 'SCHEDULED' }],
    })]]);
    const result = buildLiveJourneySegment(leg, {
      vehicles: [vehicle('selected', 'trip-selected', 1)], network: network(), timetable,
    }, now);
    assert.equal(result.boardingStopArrival.status, 'SCHEDULED');
    assert.equal(result.boardingStopArrival.predictedAt, undefined);
  });

  it('returns a scheduled empty segment when the leg has no provider identity', () => {
    const result = buildLiveJourneySegment({ ...leg, providerId: null }, { vehicles: [], network: network(), timetable: feed() }, now);
    assert.equal(result.status, 'SCHEDULED');
    assert.deepEqual(result.lineRoutes, []);
    assert.deepEqual(result.vehicles, []);
  });
});
