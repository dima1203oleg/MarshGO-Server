import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveVehicle } from '../server/mobility/transportLayers';
import { matchLiveVehicleForJourneyLeg } from '../server/journey/liveVehicles';

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
