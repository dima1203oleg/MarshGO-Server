import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RoadRoute } from '../server/routing';
import { MAX_NAVIGATION_STOPS, optimizeStopInsertion, type NavigationStop } from '../server/navigation/stopOptimizer';

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

  it('supports a full 30-stop route while preserving pickup order and segment capacity', async () => {
    const existingStops: NavigationStop[] = [];
    for (let rider = 0; rider < 14; rider += 1) {
      existingStops.push(
        { bookingId: `rider-${rider}`, candidateId: `candidate-${rider}`, kind: 'pickup', placeName: `Pickup ${rider}`, coordinates: [24.01 + rider / 100, 49.01 + rider / 100], seats: 1 },
        { bookingId: `rider-${rider}`, candidateId: `candidate-${rider}`, kind: 'dropoff', placeName: `Dropoff ${rider}`, coordinates: [24.02 + rider / 100, 49.02 + rider / 100], seats: 1 },
      );
    }

    const plan = await optimizeStopInsertion({
      ...base,
      existingStops,
      vehicleCapacity: 3,
      candidate: {
        ...base.candidate,
        pickup: { placeName: 'Final pickup', coordinates: [24.3, 49.3] },
        dropoff: { placeName: 'Final dropoff', coordinates: [24.4, 49.4] },
      },
    }, routeFixture);

    assert.ok(plan);
    assert.equal(plan.stops.length, MAX_NAVIGATION_STOPS);
    const perRider = new Map<string, { pickup: number; dropoff: number }>();
    let occupiedSeats = 0;
    for (const [index, stop] of plan.stops.entries()) {
      const rider = perRider.get(stop.bookingId) ?? { pickup: -1, dropoff: -1 };
      if (stop.kind === 'pickup') {
        rider.pickup = index;
        occupiedSeats += stop.seats;
      } else {
        rider.dropoff = index;
        occupiedSeats -= stop.seats;
      }
      perRider.set(stop.bookingId, rider);
      assert.ok(occupiedSeats >= 0 && occupiedSeats <= 3, 'seat occupancy stays valid after each stop');
    }
    assert.equal(occupiedSeats, 0);
    assert.equal(perRider.size, 15);
    for (const stops of perRider.values()) {
      assert.ok(stops.pickup >= 0 && stops.dropoff > stops.pickup);
    }
  });

  it('rejects routes that would exceed the supported 30-stop plan', async () => {
    const existingStops: NavigationStop[] = Array.from({ length: 29 }, (_, index) => ({
      bookingId: `existing-${index}`,
      candidateId: `candidate-${index}`,
      kind: index % 2 === 0 ? 'pickup' : 'dropoff',
      placeName: `Stop ${index}`,
      coordinates: [24 + index / 1000, 49 + index / 1000],
      seats: 1,
    }));
    await assert.rejects(
      optimizeStopInsertion({ ...base, existingStops }, routeFixture),
      /stop insertion input is invalid/,
    );
  });

  it('refuses to produce ETA from routes without actual per-leg durations', async () => {
    const plan = await optimizeStopInsertion(base, async (points) => ({
      geometry: points, distanceMeters: 1000, durationSeconds: 500,
    }));
    assert.equal(plan, null);
  });
});
