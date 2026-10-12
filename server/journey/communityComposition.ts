import type { GtfsItinerary } from './gtfsTimetable';
import type { JourneyLegMode, JourneyOption } from './types';

export type TransitPathSummary = Pick<GtfsItinerary,
  'id' | 'segments' | 'departureAt' | 'arrivalAt' | 'durationSeconds' | 'waitingSeconds' | 'transfers' | 'walkingMeters' | 'fare'>;

export interface CommunityRideOption {
  id: string;
  driverId: string;
  departureAt: Date;
  arrivalAt: Date;
  origin: { name: string; coordinates: [number, number] };
  destination: { name: string; coordinates: [number, number] };
  distanceMeters: number;
  pricePerSeatMinor: number;
  currency: string;
  availableSeats: number;
  routeGeometry: Array<[number, number]> | null;
  snapshotAt: Date;
  metadata: Record<string, unknown>;
}

export interface CommunityTransitJourney extends JourneyOption {
  kind: 'community-transit';
  offer: CommunityRideOption;
  prefix: TransitPathSummary | null;
  suffix: TransitPathSummary | null;
  departureAt: Date;
  arrivalAt: Date;
  waitingSeconds: number;
  currency: 'UAH' | null;
}

export interface ComposeCommunityTransitInput {
  offer: CommunityRideOption;
  prefixes: readonly TransitPathSummary[];
  suffixes: readonly TransitPathSummary[];
  requestedDepartureAt: Date;
  origin: [number, number];
  destination: [number, number];
  passengers: number;
  minimumTransferBufferSeconds: number;
  maximumDurationSeconds: number;
  maximumWalkingMeters?: number;
  exactEndpointToleranceMeters?: number;
  maximumResults?: number;
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(b[1] - a[1]), dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

function validTransitPath(path: TransitPathSummary): boolean {
  return path.segments.length > 0
    && Number.isFinite(path.departureAt.getTime())
    && Number.isFinite(path.arrivalAt.getTime())
    && path.arrivalAt >= path.departureAt
    && Number.isInteger(path.waitingSeconds) && path.waitingSeconds >= 0
    && Number.isInteger(path.walkingMeters) && path.walkingMeters >= 0
    && Number.isInteger(path.transfers) && path.transfers >= 0;
}

function fareInUah(path: TransitPathSummary | null): number | null {
  if (!path) return 0;
  if (!path.fare || path.fare.currency !== 'UAH' || !Number.isSafeInteger(path.fare.priceMinor)
    || path.fare.priceMinor < 0) return null;
  return path.fare.priceMinor;
}

/**
 * Join only a published ride between its agreed pickup and drop-off points.
 * Transit paths must already contain verified walks to/from those exact
 * points; this function never invents an intermediate stop or connection.
 */
export function composeCommunityTransitJourneys(input: ComposeCommunityTransitInput): CommunityTransitJourney[] {
  const {
    offer, prefixes, suffixes, requestedDepartureAt, origin, destination,
    passengers, minimumTransferBufferSeconds, maximumDurationSeconds,
    maximumWalkingMeters, maximumResults = 12,
  } = input;
  const tolerance = input.exactEndpointToleranceMeters ?? 5;
  const settings = [requestedDepartureAt.getTime(), offer.departureAt.getTime(), offer.arrivalAt.getTime()];
  if (settings.some((value) => !Number.isFinite(value)) || offer.arrivalAt <= offer.departureAt
    || !Number.isSafeInteger(offer.pricePerSeatMinor) || offer.pricePerSeatMinor < 0
    || !Number.isInteger(offer.availableSeats) || offer.availableSeats < passengers
    || !Number.isInteger(passengers) || passengers < 1
    || !Number.isInteger(minimumTransferBufferSeconds) || minimumTransferBufferSeconds < 0
    || !Number.isInteger(maximumDurationSeconds) || maximumDurationSeconds < 1
    || (maximumWalkingMeters !== undefined && (!Number.isInteger(maximumWalkingMeters) || maximumWalkingMeters < 0))
    || !Number.isFinite(tolerance) || tolerance < 0
    || !Number.isInteger(maximumResults) || maximumResults < 1 || maximumResults > 100) return [];

  const exactOrigin = haversineMeters(origin, offer.origin.coordinates) <= tolerance;
  const exactDestination = haversineMeters(destination, offer.destination.coordinates) <= tolerance;
  const prefixChoices: Array<TransitPathSummary | null> = prefixes.length ? [...prefixes] : [null];
  const suffixChoices: Array<TransitPathSummary | null> = suffixes.length ? [...suffixes] : [null];
  const results: CommunityTransitJourney[] = [];

  for (const prefix of prefixChoices) {
    if (prefix && !validTransitPath(prefix)) continue;
    if (!prefix && !exactOrigin) continue;
    const pickupReadyAt = prefix?.arrivalAt ?? requestedDepartureAt;
    if (offer.departureAt.getTime() - pickupReadyAt.getTime() < minimumTransferBufferSeconds * 1000) continue;

    for (const suffix of suffixChoices) {
      if (suffix && !validTransitPath(suffix)) continue;
      if (!suffix && !exactDestination) continue;
      const suffixStart = suffix?.departureAt ?? offer.arrivalAt;
      if (suffix && suffixStart.getTime() < offer.arrivalAt.getTime() + minimumTransferBufferSeconds * 1000) continue;
      if (!prefix && !suffix) continue; // A direct ride is ranked by the existing direct-offer path.

      const arrivalAt = suffix?.arrivalAt ?? offer.arrivalAt;
      const durationSeconds = Math.ceil((arrivalAt.getTime() - requestedDepartureAt.getTime()) / 1000);
      if (durationSeconds <= 0 || durationSeconds > maximumDurationSeconds) continue;
      const walkingMeters = (prefix?.walkingMeters ?? 0) + (suffix?.walkingMeters ?? 0);
      if (maximumWalkingMeters !== undefined && walkingMeters > maximumWalkingMeters) continue;

      const prefixFare = fareInUah(prefix);
      const suffixFare = fareInUah(suffix);
      const rideFare = offer.currency === 'UAH' ? offer.pricePerSeatMinor * passengers : null;
      const allFaresKnown = prefixFare !== null && suffixFare !== null && rideFare !== null
        && Number.isSafeInteger(rideFare);
      const priceMinor = allFaresKnown ? prefixFare + rideFare + suffixFare : null;
      if (priceMinor !== null && !Number.isSafeInteger(priceMinor)) continue;

      const transitLegs = [
        ...(prefix?.segments.map((segment) => ({ mode: segment.mode as JourneyLegMode, providerId: segment.providerId })) ?? []),
        { mode: 'COMMUNITY' as const, providerId: 'marshgo-community' },
        ...(suffix?.segments.map((segment) => ({ mode: segment.mode as JourneyLegMode, providerId: segment.providerId })) ?? []),
      ];
      const waitingBeforeRide = Math.max(0, Math.floor((offer.departureAt.getTime() - pickupReadyAt.getTime()) / 1000));
      const waitingAfterRide = suffix
        ? Math.max(0, Math.floor((suffixStart.getTime() - offer.arrivalAt.getTime()) / 1000)) + suffix.waitingSeconds
        : 0;
      const id = `community-transit:${offer.id}:${prefix?.id ?? 'origin'}:${suffix?.id ?? 'destination'}`;
      results.push({
        id,
        kind: 'community-transit',
        offer,
        prefix,
        suffix,
        departureAt: requestedDepartureAt,
        arrivalAt,
        waitingSeconds: (prefix?.waitingSeconds ?? 0) + waitingBeforeRide + waitingAfterRide,
        durationSeconds,
        priceMinor,
        currency: priceMinor === null ? null : 'UAH',
        transfers: Math.max(0, transitLegs.length - 1),
        walkingMeters,
        reliability: null,
        // A transfer through an unscored private ride remains conservatively
        // penalized; it is not exposed as a measured reliability percentage.
        transferRisk: transitLegs.length > 1 ? 0.5 : 0,
        comfort: null,
        diversityKey: `community>${[...(prefix?.segments ?? []).map((segment) => segment.mode), ...(suffix?.segments ?? []).map((segment) => segment.mode)].join('>')}`,
        legs: transitLegs,
      });
    }
  }

  return results.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime()
    || (a.priceMinor ?? Number.MAX_SAFE_INTEGER) - (b.priceMinor ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id)).slice(0, maximumResults);
}
