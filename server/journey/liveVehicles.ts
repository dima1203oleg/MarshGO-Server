import { isFreshVehicleTimestamp, type LiveVehicle } from '../mobility/transportLayers';

export interface ScheduledJourneyLegIdentity {
  providerId: string | null;
  tripId: string | null;
  routeId: string | null;
  serviceDate: string | null;
  scheduledDepartureAt: Date | null;
  scheduledArrivalAt: Date | null;
}

const BEFORE_DEPARTURE_WINDOW_MS = 5 * 60_000;
const AFTER_ARRIVAL_WINDOW_MS = 10 * 60_000;

export function isJourneyLegGpsWindowOpen(departure: Date | null, arrival: Date | null, now = Date.now()): boolean {
  return Boolean(departure && arrival && Number.isFinite(departure.getTime()) && Number.isFinite(arrival.getTime())
    && arrival >= departure
    && now >= departure.getTime() - BEFORE_DEPARTURE_WINDOW_MS
    && now <= arrival.getTime() + AFTER_ARRIVAL_WINDOW_MS);
}

/** Match only a current, fresh GPS position for this exact provider-scoped scheduled trip. */
export function matchLiveVehicleForJourneyLeg(
  leg: ScheduledJourneyLegIdentity,
  vehicles: readonly LiveVehicle[],
  now = Date.now(),
): LiveVehicle | null {
  if (!leg.providerId || !leg.tripId || !leg.routeId || !leg.serviceDate
    || !isJourneyLegGpsWindowOpen(leg.scheduledDepartureAt, leg.scheduledArrivalAt, now)) return null;

  const candidates = vehicles.filter((vehicle) => vehicle.providerId === leg.providerId
    && vehicle.tripId === leg.tripId
    && vehicle.routeId === leg.routeId
    && (!vehicle.startDate || vehicle.startDate === leg.serviceDate)
    && isFreshVehicleTimestamp(vehicle.timestamp, now));
  if (candidates.length === 0) return null;

  return candidates.reduce((newest, candidate) => (candidate.timestamp!.getTime() > newest.timestamp!.getTime() ? candidate : newest));
}
