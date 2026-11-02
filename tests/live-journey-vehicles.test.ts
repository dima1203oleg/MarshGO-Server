import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveVehicle } from '../server/mobility/transportLayers';
import { approachingBoardingStop, freshVehiclesForRoute, matchLiveVehicleForJourneyLeg, selectBoardingApproachVehicleIds } from '../server/journey/liveVehicles';

const now = Date.parse('2026-10-12T10:00:00.000Z');
const leg = {
  providerId: 'provider-1', tripId: 'trip-42', routeId: 'route-7', serviceDate: '20261012',
  scheduledDepartureAt: new Date(now - 10 * 60_000), scheduledArrivalAt: new Date(now + 20 * 60_000),
};
function vehicle(overrides: Partial<LiveVehicle> = {}): LiveVehicle {
  return {
    id: 'provider-1:vehicle-1', lon: 24.02, lat: 49.84, type: 'tram', route: 'T9', bearing: 90, speed: 8,
    timestamp: new Date(now - 20_000), providerId: 'provider-1', tripId: 'trip-42', routeId: 'route-7', startDate: '20261012',
    ...overrides,
  };
}

test('live journey leg accepts only fresh GPS tied to its provider, trip, route and service date', () => {
  const match = vehicle();
  assert.equal(matchLiveVehicleForJourneyLeg(leg, [match], now), match);
  assert.equal(matchLiveVehicleForJourneyLeg(leg, [vehicle({ providerId: 'another-provider' })], now), null);
  assert.equal(matchLiveVehicleForJourneyLeg(leg, [vehicle({ tripId: 'another-trip' })], now), null);
  assert.equal(matchLiveVehicleForJourneyLeg(leg, [vehicle({ routeId: 'another-route' })], now), null);
  assert.equal(matchLiveVehicleForJourneyLeg(leg, [vehicle({ startDate: '20261011' })], now), null);
});

test('live journey leg rejects stale GPS and positions outside the scheduled trip window', () => {
  assert.equal(matchLiveVehicleForJourneyLeg(leg, [vehicle({ timestamp: new Date(now - 90_001) })], now), null);
  assert.equal(matchLiveVehicleForJourneyLeg(leg, [vehicle({ timestamp: null })], now), null);
  assert.equal(matchLiveVehicleForJourneyLeg({ ...leg, scheduledDepartureAt: new Date(now + 6 * 60_000) }, [vehicle()], now), null);
  assert.equal(matchLiveVehicleForJourneyLeg({ ...leg, scheduledArrivalAt: new Date(now - 11 * 60_000) }, [vehicle()], now), null);
});

test('a fresh vehicle without an explicit GTFS start date is matched only inside the leg time window', () => {
  const match = vehicle({ startDate: undefined });
  assert.equal(matchLiveVehicleForJourneyLeg(leg, [match], now), match);
  assert.equal(matchLiveVehicleForJourneyLeg({ ...leg, scheduledDepartureAt: new Date(now - 2 * 86_400_000), scheduledArrivalAt: new Date(now - 2 * 86_400_000 + 20 * 60_000) }, [match], now), null);
});

test('merged provider-scoped Journey IDs match raw IDs from the provider GTFS-Realtime feed', () => {
  const scopedLeg = {
    ...leg,
    tripId: 'provider-1:trip-42',
    routeId: 'provider-1:route-7',
  };
  assert.equal(matchLiveVehicleForJourneyLeg(scopedLeg, [vehicle()], now)?.id, 'provider-1:vehicle-1');
  assert.equal(matchLiveVehicleForJourneyLeg({ ...scopedLeg, providerId: 'other-provider' }, [vehicle()], now), null);
});

test('boarding emphasis requires exact GTFS trip progress and only highlights vehicles before the boarding stop', () => {
  const stops = [
    { stopId: 'provider-1:stop-a', sequence: 1 },
    { stopId: 'provider-1:stop-b', sequence: 4 },
    { stopId: 'provider-1:stop-c', sequence: 7 },
  ];
  assert.deepEqual(approachingBoardingStop('provider-1', { currentStopSequence: 1 }, 'provider-1:stop-b', stops), {
    approaching: true, remainingStops: 3,
  });
  assert.deepEqual(approachingBoardingStop('provider-1', { currentStopId: 'stop-b' }, 'provider-1:stop-b', stops), {
    approaching: true, remainingStops: 0,
  });
  assert.deepEqual(approachingBoardingStop('provider-1', { currentStopSequence: 7 }, 'provider-1:stop-b', stops), {
    approaching: false, remainingStops: 0,
  });
  assert.equal(approachingBoardingStop('provider-1', {}, 'provider-1:stop-b', stops), null);
  assert.equal(approachingBoardingStop('provider-1', { currentStopSequence: 1 }, 'other:stop-b', stops), null);
});

test('selected line fleet includes every fresh exact provider and route match, deduplicates vehicles, and excludes stale or unrelated positions', () => {
  const candidates = [
    vehicle({ id: 'vehicle-a' }),
    vehicle({ id: 'vehicle-b', tripId: 'different-trip' }),
    vehicle({ id: 'vehicle-stale', timestamp: new Date(now - 90_001) }),
    vehicle({ id: 'vehicle-other-route', routeId: 'another-route' }),
    vehicle({ id: 'vehicle-other-provider', providerId: 'another-provider' }),
    vehicle({ id: 'vehicle-b', timestamp: new Date(now - 10_000) }),
  ];
  assert.deepEqual(freshVehiclesForRoute('provider-1', 'provider-1:route-7', candidates, now).map((item) => item.id), ['vehicle-a', 'vehicle-b']);
});

test('boarding highlight selects no more than three exact approaches and leaves unknown/opposite-direction vehicles muted', () => {
  const highlighted = selectBoardingApproachVehicleIds([
    { vehicleId: 'farther', approaching: true, evidence: 'OBSERVED_PROGRESS', etaSeconds: 500, remainingStops: 5 },
    { vehicleId: 'near', approaching: true, evidence: 'OBSERVED_PROGRESS', etaSeconds: 100, remainingStops: 1 },
    { vehicleId: 'middle', approaching: true, evidence: 'OBSERVED_PROGRESS', etaSeconds: 250, remainingStops: 3 },
    { vehicleId: 'at-stop', approaching: true, evidence: 'OBSERVED_PROGRESS', etaSeconds: 100, remainingStops: 0 },
    { vehicleId: 'prediction', approaching: true, evidence: 'TRIP_UPDATE_PREDICTION', etaSeconds: 10, remainingStops: null },
    { vehicleId: 'passed-stop', approaching: false, evidence: 'OBSERVED_PROGRESS', etaSeconds: 50, remainingStops: 0 },
    { vehicleId: 'unknown', approaching: true, evidence: null, etaSeconds: null, remainingStops: null },
    { vehicleId: 'expired', approaching: true, evidence: 'TRIP_UPDATE_PREDICTION', etaSeconds: 0, remainingStops: null },
  ]);
  assert.deepEqual([...highlighted], ['at-stop', 'near', 'middle']);
  assert.equal(selectBoardingApproachVehicleIds([
    { vehicleId: 'one', approaching: true, evidence: 'OBSERVED_PROGRESS', etaSeconds: null, remainingStops: 0 },
    { vehicleId: 'two', approaching: true, evidence: 'TRIP_UPDATE_PREDICTION', etaSeconds: 60, remainingStops: null },
  ], 50).size, 2);
});
