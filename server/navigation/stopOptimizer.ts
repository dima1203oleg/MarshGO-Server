import type { RoadRoute } from '../routing';

export type StopKind = 'pickup' | 'dropoff';
export interface NavigationStop {
  bookingId: string;
  candidateId: string;
  kind: StopKind;
  placeName: string;
  coordinates: [number, number];
  seats: number;
}
export interface StopInsertionRequest {
  currentLocation: [number, number];
  destination: [number, number];
  existingStops: NavigationStop[];
  onboardSeats: number;
  onboardBookingIds: string[];
  vehicleCapacity: number;
  candidate: {
    bookingId: string;
    candidateId: string;
    seats: number;
    pickup: { placeName: string; coordinates: [number, number] };
    dropoff: { placeName: string; coordinates: [number, number] };
    earliestPickupAt: Date;
    latestPickupAt: Date;
  };
  now: Date;
  maxDetourMeters: number;
  maxDetourSeconds: number;
}
export interface StopInsertionPlan {
  stops: NavigationStop[];
  route: RoadRoute;
  pickupEta: Date;
  detourDistanceM: number;
  detourDurationS: number;
  pickupOrdinal: number;
  dropoffOrdinal: number;
}

function validCoordinates(point: [number, number]) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
}

function capacityAllows(stops: readonly NavigationStop[], onboardSeats: number, onboardBookingIds: readonly string[], capacity: number) {
  let occupied = onboardSeats;
  if (occupied < 0 || occupied > capacity) return false;
  const activeByBooking = new Map<string, { pickup: number; dropoff: number; seats: number }>();
  for (const stop of stops) {
    const booking = activeByBooking.get(stop.bookingId) ?? { pickup: 0, dropoff: 0, seats: stop.seats };
    if (booking.seats !== stop.seats) return false;
    if (stop.kind === 'pickup') booking.pickup += 1;
    else booking.dropoff += 1;
    if (booking.pickup > 1 || booking.dropoff > 1) return false;
    activeByBooking.set(stop.bookingId, booking);
  }
  for (const [bookingId, booking] of activeByBooking) {
    if (booking.pickup === 1 && booking.dropoff === 1) continue;
    if (booking.pickup === 0 && booking.dropoff === 1 && onboardBookingIds.includes(bookingId)) continue;
    return false;
  }

  for (const stop of stops) {
    occupied += stop.kind === 'pickup' ? stop.seats : -stop.seats;
    if (occupied < 0 || occupied > capacity) return false;
  }
  return occupied === 0;
}

function routeHasLegs(route: RoadRoute, pointCount: number): boolean {
  return route.legs?.length === pointCount - 1
    && route.legs.every((leg) => Number.isFinite(leg.durationSeconds) && leg.durationSeconds > 0
      && Number.isFinite(leg.distanceMeters) && leg.distanceMeters > 0);
}

function straightLineMeters(a: [number, number], b: [number, number]): number {
  const radians = (value: number) => value * Math.PI / 180;
  const lat1 = radians(a[1]); const lat2 = radians(b[1]);
  const dLat = lat2 - lat1; const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export async function optimizeStopInsertion(
  input: StopInsertionRequest,
  route: (points: [number, number][]) => Promise<RoadRoute>,
): Promise<StopInsertionPlan | null> {
  const { candidate } = input;
  const datesValid = Number.isFinite(input.now.getTime()) && Number.isFinite(candidate.earliestPickupAt.getTime())
    && Number.isFinite(candidate.latestPickupAt.getTime()) && candidate.earliestPickupAt <= candidate.latestPickupAt;
  if (!validCoordinates(input.currentLocation) || !validCoordinates(input.destination)
    || !validCoordinates(candidate.pickup.coordinates) || !validCoordinates(candidate.dropoff.coordinates)
    || !datesValid || !Number.isInteger(candidate.seats) || candidate.seats < 1
    || !Number.isInteger(input.vehicleCapacity) || input.vehicleCapacity < 1
    || !Number.isInteger(input.onboardSeats) || input.onboardSeats < 0
    || !Array.isArray(input.onboardBookingIds) || new Set(input.onboardBookingIds).size !== input.onboardBookingIds.length
    || !Number.isFinite(input.maxDetourMeters) || input.maxDetourMeters < 0
    || !Number.isFinite(input.maxDetourSeconds) || input.maxDetourSeconds < 0
    || input.existingStops.length > 26) {
    throw new TypeError('stop insertion input is invalid');
  }
  if (candidate.seats > input.vehicleCapacity) return null;
  if (input.existingStops.some((stop) => !validCoordinates(stop.coordinates) || !Number.isInteger(stop.seats) || stop.seats < 1)) {
    throw new TypeError('existing navigation stop is invalid');
  }
  const baselinePoints = [input.currentLocation, ...input.existingStops.map((stop) => stop.coordinates), input.destination];
  const baseline = await route(baselinePoints);
  if (!routeHasLegs(baseline, baselinePoints.length)) return null;

  const candidatePlans: Array<{ stops: NavigationStop[]; points: [number, number][]; approximateDistanceM: number }> = [];
  const n = input.existingStops.length;
  for (let pickupIndex = 0; pickupIndex <= n; pickupIndex += 1) {
    for (let dropoffIndex = pickupIndex + 1; dropoffIndex <= n + 1; dropoffIndex += 1) {
      const stops = [...input.existingStops];
      const pickup: NavigationStop = { bookingId: candidate.bookingId, candidateId: candidate.candidateId, kind: 'pickup', ...candidate.pickup, seats: candidate.seats };
      const dropoff: NavigationStop = { bookingId: candidate.bookingId, candidateId: candidate.candidateId, kind: 'dropoff', ...candidate.dropoff, seats: candidate.seats };
      stops.splice(pickupIndex, 0, pickup);
      stops.splice(dropoffIndex, 0, dropoff);
      if (!capacityAllows(stops, input.onboardSeats, input.onboardBookingIds, input.vehicleCapacity)) continue;

      const points = [input.currentLocation, ...stops.map((stop) => stop.coordinates), input.destination];
      const approximateDistanceM = points.slice(1).reduce((sum, point, index) => sum + straightLineMeters(points[index], point), 0);
      candidatePlans.push({ stops, points, approximateDistanceM });
    }
  }
  // Stage B calls the real road router only for the best geometric insertions.
  const shortlist = candidatePlans.sort((a, b) => a.approximateDistanceM - b.approximateDistanceM).slice(0, 8);
  const evaluated = await Promise.all(shortlist.map(async ({ stops, points }) => {
      let proposed: RoadRoute;
      try { proposed = await route(points); }
      catch { return null; }
      if (!routeHasLegs(proposed, points.length)) return null;
      const pickupOrdinal = stops.findIndex((stop) => stop.bookingId === candidate.bookingId && stop.kind === 'pickup') + 1;
      const dropoffOrdinal = stops.findIndex((stop) => stop.bookingId === candidate.bookingId && stop.kind === 'dropoff') + 1;
      const pickupDuration = proposed.legs!.slice(0, pickupOrdinal).reduce((sum, leg) => sum + leg.durationSeconds, 0);
      const pickupEta = new Date(input.now.getTime() + pickupDuration * 1000);
      if (pickupEta < candidate.earliestPickupAt || pickupEta > candidate.latestPickupAt) return null;
      const detourDistanceM = Math.max(0, Math.round(proposed.distanceMeters - baseline.distanceMeters));
      const detourDurationS = Math.max(0, Math.round(proposed.durationSeconds - baseline.durationSeconds));
      if (detourDistanceM > input.maxDetourMeters || detourDurationS > input.maxDetourSeconds) return null;
      const plan = { stops, route: proposed, pickupEta, detourDistanceM, detourDurationS, pickupOrdinal, dropoffOrdinal };
      return plan;
  }));
  return evaluated.filter((plan): plan is StopInsertionPlan => Boolean(plan)).sort((a, b) =>
    a.detourDurationS - b.detourDurationS || a.detourDistanceM - b.detourDistanceM || a.pickupOrdinal - b.pickupOrdinal,
  )[0] ?? null;
}
