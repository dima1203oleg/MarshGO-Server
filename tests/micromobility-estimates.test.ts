import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBicycleRouteEstimates,
  buildScooterRouteEstimates,
  completeMicromobilityFareMinor,
  type GeofenceSnapshotForRouting,
  type RentalRouteNetwork,
  type RentalRoutePoint,
} from '../server/journey/micromobilityEstimates';

test('micromobility journey fare stays unknown unless the complete rental fare is known', () => {
  assert.equal(completeMicromobilityFareMinor(null), null, 'a rental-only estimate has no confirmed rental fare');
  assert.equal(completeMicromobilityFareMinor(null, 2_300), null, 'a known transit subtotal cannot price a journey with an unknown rental');
  assert.equal(completeMicromobilityFareMinor(1_200, null), null, 'an unknown transit fare keeps a composed journey total unknown');
  assert.equal(completeMicromobilityFareMinor(1_200, 2_300), 3_500, 'complete known rental and transit fares are combined');
  assert.equal(completeMicromobilityFareMinor(Number.MAX_SAFE_INTEGER, 1), null, 'overflow cannot become a comparable fare');
});

const departureAt = new Date('2026-10-16T08:00:00+03:00');
const bicycleNetwork: RentalRouteNetwork = {
  networkId: 'nextbike-ua', providerIds: ['nextbike_ua'], compatibilityStatus: 'CONFIRMED',
  returnRule: 'ANY_NETWORK_LOCATION', returnRuleSource: 'OWNER_ATTESTED',
};
const points: RentalRoutePoint[] = [
  { id: 'a', providerId: 'nextbike_ua', providerName: 'Nextbike', networkId: 'nextbike-ua', name: 'start rack', coordinates: [30.50, 50.45], mode: 'BICYCLE', pickupAllowed: null, dropoffAllowed: null, availability: 'UNKNOWN', source: 'OSM' },
  { id: 'b', providerId: 'nextbike_ua', providerName: 'Nextbike', networkId: 'nextbike-ua', name: 'end rack', coordinates: [30.52, 50.45], mode: 'BICYCLE', pickupAllowed: null, dropoffAllowed: null, availability: 'UNKNOWN', source: 'OSM' },
  { id: 'c', providerId: 'bikenow', providerName: 'BikeNow', networkId: 'bikenow-ua', name: 'other provider', coordinates: [30.52, 50.45], mode: 'BICYCLE', pickupAllowed: null, dropoffAllowed: null, availability: 'UNKNOWN', source: 'OSM' },
];

test('bike estimates only use one owner-confirmed provider network and keep inventory unknown', () => {
  const estimates = buildBicycleRouteEstimates({
    origin: { name: 'A', coordinates: [30.50, 50.45] },
    destination: { name: 'B', coordinates: [30.52, 50.45] },
    points,
    networks: new Map([['nextbike-ua', bicycleNetwork]]),
    options: { departureAt, maxWalkToRentalMeters: 500, maxCandidates: 6 },
  });

  assert.equal(estimates.length, 1);
  assert.equal(estimates[0]?.providerId, 'nextbike_ua');
  assert.equal(estimates[0]?.availabilityStatus, 'UNKNOWN');
  assert.equal(estimates[0]?.priceMinor, null);
  assert.equal(estimates[0]?.legs.find((leg) => leg.mode === 'BICYCLE')?.metadata.bookingAvailable, false);
  assert.deepEqual(estimates[0]?.legs.find((leg) => leg.mode === 'BICYCLE')?.routeGeometry, [[30.5, 50.45], [30.52, 50.45]]);
});

const allowedZone = (rideThroughAllowed: boolean | null = null): GeofenceSnapshotForRouting => ({
  geofences: [{
    id: 'allowed-area', geometry: { type: 'Polygon', coordinates: [[
      [30.49, 50.44], [30.53, 50.44], [30.53, 50.46], [30.49, 50.46], [30.49, 50.44],
    ]] },
    rules: [{ vehicleTypeIds: ['scooter'], rideStartAllowed: true, rideEndAllowed: true, rideThroughAllowed, maximumSpeedKph: null, startAt: null, endAt: null }],
  }],
  globalRules: [], lastUpdated: Date.parse('2026-10-16T04:59:00Z'), staleAfterSeconds: 300,
});

test('scooter estimates require fresh same-provider start and end zones', () => {
  const options = { departureAt, maxWalkToRentalMeters: 300, maxCandidates: 6 };
  const estimates = buildScooterRouteEstimates({
    origin: { name: 'A', coordinates: [30.50, 50.45] as [number, number] }, destination: { name: 'B', coordinates: [30.52, 50.45] as [number, number] },
    providers: [{ providerId: 'zelectra', providerName: 'Zelectra', networkId: 'zelectra-66', snapshot: allowedZone() }],
    options, now: Date.parse('2026-10-16T05:00:00Z'),
  });

  assert.equal(estimates.length, 1);
  assert.equal(estimates[0]?.mode, 'SCOOTER');
  assert.equal(estimates[0]?.availabilityStatus, 'UNKNOWN');
  assert.equal(estimates[0]?.legs.find((leg) => leg.mode === 'SCOOTER')?.metadata.bookingAvailable, false);
  assert.equal(estimates[0]?.legs.find((leg) => leg.mode === 'SCOOTER')?.metadata.returnRuleSource, 'PROVIDER_GBFS_GEOFENCE');
});

test('scooter estimates reject stale geofences and routes crossing explicitly forbidden zones', () => {
  const request = {
    origin: { name: 'A', coordinates: [30.50, 50.45] as [number, number] }, destination: { name: 'B', coordinates: [30.52, 50.45] as [number, number] },
    providers: [{ providerId: 'zelectra', providerName: 'Zelectra', networkId: 'zelectra-66', snapshot: allowedZone(false) }],
    options: { departureAt, maxWalkToRentalMeters: 300, maxCandidates: 6 },
  };
  assert.deepEqual(buildScooterRouteEstimates({ ...request, now: Date.parse('2026-10-16T05:00:00Z') }), []);
  assert.deepEqual(buildScooterRouteEstimates({
    ...request, providers: [{ ...request.providers[0]!, snapshot: { ...allowedZone(), lastUpdated: Date.parse('2026-10-16T04:00:00Z') } }],
    now: Date.parse('2026-10-16T05:00:00Z'),
  }), []);
});
