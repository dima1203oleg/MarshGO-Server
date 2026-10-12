import test from 'node:test';
import assert from 'node:assert/strict';
import type { GtfsItinerary } from '../server/journey/gtfsTimetable';
import {
  composeCommunityTransitJourneys,
  type CommunityRideOption,
  type TransitPathSummary,
} from '../server/journey/communityComposition';

const base = Date.parse('2026-10-12T08:00:00Z');
const at = (minutes: number) => new Date(base + minutes * 60_000);

function transitPath(id: string, mode: 'BUS' | 'TRAM', departure: number, arrival: number,
  priceMinor: number | null = 1500): TransitPathSummary {
  return {
    id,
    segments: [{ mode, providerId: `provider-${mode}` } as GtfsItinerary['segments'][number]],
    departureAt: at(departure), arrivalAt: at(arrival),
    durationSeconds: (arrival - departure) * 60,
    waitingSeconds: 180, transfers: 0, walkingMeters: 250,
    fare: priceMinor === null ? null : { currency: 'UAH', priceMinor } as GtfsItinerary['fare'],
  } as TransitPathSummary;
}

function ride(overrides: Partial<CommunityRideOption> = {}): CommunityRideOption {
  return {
    id: 'offer-1', driverId: 'driver-1',
    departureAt: at(40), arrivalAt: at(70),
    origin: { name: 'Pickup', coordinates: [24.0315, 49.8419] },
    destination: { name: 'Dropoff', coordinates: [24.0628, 49.7915] },
    distanceMeters: 12_000, pricePerSeatMinor: 5000, currency: 'UAH', availableSeats: 2,
    routeGeometry: [[24.0315, 49.8419], [24.0628, 49.7915]], snapshotAt: at(0), metadata: {},
    ...overrides,
  };
}

test('composes measured public-transit prefix and suffix around a published private ride', () => {
  const prefix = transitPath('bus-prefix', 'BUS', 0, 30);
  const suffix = transitPath('tram-suffix', 'TRAM', 80, 110, 1200);
  const [result] = composeCommunityTransitJourneys({
    offer: ride(), prefixes: [prefix], suffixes: [suffix], requestedDepartureAt: at(0),
    origin: [24.0315, 49.8419], destination: [24.0628, 49.7915], passengers: 1,
    minimumTransferBufferSeconds: 600, maximumDurationSeconds: 4 * 60 * 60,
  });

  assert.ok(result);
  assert.deepEqual(result.legs.map((leg) => leg.mode), ['BUS', 'COMMUNITY', 'TRAM']);
  assert.equal(result.transfers, 2);
  assert.equal(result.priceMinor, 7700);
  assert.equal(result.durationSeconds, 110 * 60);
  assert.equal(result.walkingMeters, 500);
  assert.equal(result.reliability, null);
});

test('rejects a missed pickup connection and insufficient seat inventory', () => {
  const latePrefix = transitPath('late-bus', 'BUS', 0, 31);
  assert.deepEqual(composeCommunityTransitJourneys({
    offer: ride(), prefixes: [latePrefix], suffixes: [], requestedDepartureAt: at(0),
    origin: [24.0315, 49.8419], destination: [24.0628, 49.7915], passengers: 1,
    minimumTransferBufferSeconds: 600, maximumDurationSeconds: 4 * 60 * 60,
  }), []);

  assert.deepEqual(composeCommunityTransitJourneys({
    offer: ride({ availableSeats: 1 }), prefixes: [transitPath('bus', 'BUS', 0, 20)], suffixes: [],
    requestedDepartureAt: at(0), origin: [24.0315, 49.8419], destination: [24.0628, 49.7915], passengers: 2,
    minimumTransferBufferSeconds: 600, maximumDurationSeconds: 4 * 60 * 60,
  }), []);
});

test('preserves unknown public-transport fares and does not fabricate a zero fare', () => {
  const [result] = composeCommunityTransitJourneys({
    offer: ride(), prefixes: [transitPath('unknown-fare-bus', 'BUS', 0, 20, null)], suffixes: [],
    requestedDepartureAt: at(0), origin: [24.0315, 49.8419], destination: [24.0628, 49.7915], passengers: 1,
    minimumTransferBufferSeconds: 600, maximumDurationSeconds: 4 * 60 * 60,
  });

  assert.ok(result);
  assert.equal(result.priceMinor, null);
  assert.equal(result.currency, null);
});

test('requires actual transit or exact user/offer endpoint coincidence', () => {
  const [result] = composeCommunityTransitJourneys({
    offer: ride(), prefixes: [], suffixes: [transitPath('tram', 'TRAM', 80, 110)],
    requestedDepartureAt: at(0), origin: [24.0315, 49.8419], destination: [24.0628, 49.7915], passengers: 1,
    minimumTransferBufferSeconds: 600, maximumDurationSeconds: 4 * 60 * 60,
  });
  assert.ok(result); // Published pickup matches the requested origin exactly.

  assert.deepEqual(composeCommunityTransitJourneys({
    offer: ride(), prefixes: [], suffixes: [], requestedDepartureAt: at(0),
    origin: [24.05, 49.84], destination: [24.08, 49.78], passengers: 1,
    minimumTransferBufferSeconds: 600, maximumDurationSeconds: 4 * 60 * 60,
  }), []);
});
