import { isFreshVehicleTimestamp, type LiveVehicle } from '../mobility/transportLayers';

export interface ScheduledJourneyLegIdentity {
  providerId: string | null;
  tripId: string | null;
  routeId: string | null;
  serviceDate: string | null;
  scheduledDepartureAt: Date | null;
  scheduledArrivalAt: Date | null;
}

/** Journey IDs are provider-scoped in the merged timetable; feed IDs are raw. */
export function unscopeGtfsId(providerId: string, id: string | null | undefined): string | null {
  if (!id) return null;
  const prefix = `${encodeURIComponent(providerId)}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
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
  const tripId = unscopeGtfsId(leg.providerId ?? '', leg.tripId);
  const routeId = unscopeGtfsId(leg.providerId ?? '', leg.routeId);
  if (!leg.providerId || !tripId || !routeId || !leg.serviceDate
    || !isJourneyLegGpsWindowOpen(leg.scheduledDepartureAt, leg.scheduledArrivalAt, now)) return null;

  const candidates = vehicles.filter((vehicle) => vehicle.providerId === leg.providerId
    && vehicle.tripId === tripId
    && vehicle.routeId === routeId
    && (!vehicle.startDate || vehicle.startDate === leg.serviceDate)
    && isFreshVehicleTimestamp(vehicle.timestamp, now));
  if (candidates.length === 0) return null;

  return candidates.reduce((newest, candidate) => (candidate.timestamp!.getTime() > newest.timestamp!.getTime() ? candidate : newest));
}

/** All fresh, provider-scoped GTFS positions on one exact published route. */
export function freshVehiclesForRoute(
  providerId: string,
  routeId: string,
  vehicles: readonly LiveVehicle[],
  now = Date.now(),
): LiveVehicle[] {
  const rawRouteId = unscopeGtfsId(providerId, routeId);
  if (!rawRouteId) return [];
  const byVehicle = new Map<string, LiveVehicle>();
  for (const vehicle of vehicles) {
    if (vehicle.providerId !== providerId || vehicle.routeId !== rawRouteId || !isFreshVehicleTimestamp(vehicle.timestamp, now)) continue;
    const previous = byVehicle.get(vehicle.id);
    if (!previous || vehicle.timestamp!.getTime() > previous.timestamp!.getTime()) byVehicle.set(vehicle.id, vehicle);
  }
  return [...byVehicle.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface GtfsStopSequence { stopId: string; sequence: number }

/** Only returns an approaching status when the live feed identifies where the vehicle is in this exact trip. */
export function approachingBoardingStop(
  providerId: string,
  vehicle: Pick<LiveVehicle, 'currentStopSequence' | 'currentStopId'>,
  boardingStopId: string | null,
  tripStops: readonly GtfsStopSequence[],
): { approaching: boolean; remainingStops: number } | null {
  const targetStopId = unscopeGtfsId(providerId, boardingStopId);
  if (!targetStopId || tripStops.length === 0) return null;
  const target = tripStops.find((stop) => unscopeGtfsId(providerId, stop.stopId) === targetStopId);
  if (!target) return null;

  let currentSequence = vehicle.currentStopSequence;
  if (vehicle.currentStopId) {
    const current = tripStops.find((stop) => unscopeGtfsId(providerId, stop.stopId) === unscopeGtfsId(providerId, vehicle.currentStopId));
    if (current) currentSequence = current.sequence;
  }
  if (!Number.isInteger(currentSequence) || currentSequence! < 0) return null;
  const remainingStops = target.sequence - currentSequence!;
  return { approaching: remainingStops >= 0, remainingStops: Math.max(0, remainingStops) };
}

/** Choose at most three vehicles with exact live trip progress toward the selected boarding stop. */
export function selectBoardingApproachVehicleIds(
  candidates: ReadonlyArray<{ vehicleId: string; progress: { approaching: boolean; remainingStops: number } | null }>,
  limit = 3,
): Set<string> {
  const safeLimit = Number.isInteger(limit) ? Math.max(0, Math.min(3, limit)) : 3;
  return new Set(candidates.filter((candidate) => candidate.progress?.approaching)
    .sort((a, b) => a.progress!.remainingStops - b.progress!.remainingStops || a.vehicleId.localeCompare(b.vehicleId))
    .slice(0, safeLimit).map((candidate) => candidate.vehicleId));
}
