import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RoadRoute } from '../server/routing';
import { optimizeStopInsertion, type NavigationStop } from '../server/navigation/stopOptimizer';

const routeFixture = async (points: [number, number][]): Promise<RoadRoute> => {
  const durationSeconds = points.length * 60;
  return {
    geometry: points,
    distanceMeters: points.length * 1000,
    durationSeconds,
    legs: points.slice(1).map(() => ({ distanceMeters: 1000, durationSeconds: 60 })),
  };
};
const base = {
  currentLocation: [24, 49] as [number, number],
  destination: [25, 50] as [number, number],
  existingStops: [] as NavigationStop[],
  onboardSeats: 0,
  onboardBookingIds: [] as string[],
  vehicleCapacity: 3,
  now: new Date('2026-10-01T07:00:00Z'),
  maxDetourMeters: 100_000,
  maxDetourSeconds: 10_000,
  candidate: {
    bookingId: 'new-booking', candidateId: 'new-candidate', seats: 1,
    pickup: { placeName: 'Pickup B', coordinates: [24.2, 49.2] as [number, number] },
    dropoff: { placeName: 'Dropoff B', coordinates: [24.6, 49.6] as [number, number] },
    earliestPickupAt: new Date('2026-10-01T06:59:00Z'),
    latestPickupAt: new Date('2026-10-01T08:00:00Z'),
  },
};

describe('multi-passenger navigation stop insertion', () => {
  it('keeps each rider pickup before dropoff and returns the feasible lowest-detour insertion', async () => {
    const existingStops: NavigationStop[] = [
      { bookingId: 'rider-a', candidateId: 'candidate-a', kind: 'pickup', placeName: 'Pickup A', coordinates: [24.1, 49.1], seats: 1 },
      { bookingId: 'rider-a', candidateId: 'candidate-a', kind: 'dropoff', placeName: 'Dropoff A', coordinates: [24.8, 49.8], seats: 1 },
    ];
    const plan = await optimizeStopInsertion({ ...base, existingStops }, routeFixture);
    assert.ok(plan);
    assert.ok(plan.pickupOrdinal < plan.dropoffOrdinal);
    assert.equal(plan.stops.filter((stop) => stop.bookingId === 'rider-a').map((stop) => stop.kind).join(','), 'pickup,dropoff');
    assert.equal(plan.stops.filter((stop) => stop.bookingId === 'new-booking').map((stop) => stop.kind).join(','), 'pickup,dropoff');
    assert.ok(plan.pickupEta >= base.candidate.earliestPickupAt && plan.pickupEta <= base.candidate.latestPickupAt);
  });

  it('permits a second rider only when every scheduled segment stays within capacity', async () => {
    const existingStops: NavigationStop[] = [
      { bookingId: 'rider-a', candidateId: 'candidate-a', kind: 'pickup', placeName: 'Pickup A', coordinates: [24.1, 49.1], seats: 2 },
      { bookingId: 'rider-a', candidateId: 'candidate-a', kind: 'dropoff', placeName: 'Dropoff A', coordinates: [24.8, 49.8], seats: 2 },
    ];
    const plan = await optimizeStopInsertion({ ...base, vehicleCapacity: 2, existingStops }, routeFixture);
    assert.ok(plan);
    const events = plan.stops.map((stop) => `${stop.bookingId}:${stop.kind}`);
    assert.ok(events.indexOf('new-booking:dropoff') < events.indexOf('rider-a:pickup')
      || events.indexOf('rider-a:dropoff') < events.indexOf('new-booking:pickup'));
    const full = await optimizeStopInsertion({ ...base, vehicleCapacity: 2, onboardSeats: 2, existingStops: [] }, routeFixture);
    assert.equal(full, null);
  });

  it('refuses to produce ETA from routes without actual per-leg durations', async () => {
    const plan = await optimizeStopInsertion(base, async (points) => ({
      geometry: points, distanceMeters: 1000, durationSeconds: 500,
    }));
    assert.equal(plan, null);
  });
});
