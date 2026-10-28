import { retainStrategyCandidatePool, type BoundedJourneyCandidatePool } from './scoring';
import type { GtfsItinerary } from './gtfsTimetable';
import type { JourneyOption, JourneyStrategy } from './types';

/** The exact portion of a scheduled itinerary consumed by the API ranking projection. */
export type ScheduledGtfsProjectionInput = Omit<Pick<GtfsItinerary,
  'id' | 'durationSeconds' | 'fare' | 'transfers' | 'walkingMeters' |
  'transferWalkingMeters' | 'arrivalAt' | 'departureAt'
>, 'id'> & {
  id: string;
  segments: Array<Pick<GtfsItinerary['segments'][number],
    'providerId' | 'routeId' | 'mode' | 'distanceToOriginStopMeters' | 'distanceFromDestinationStopMeters'
  >>;
};

export type ScheduledGtfsCandidate<T extends ScheduledGtfsProjectionInput = ScheduledGtfsProjectionInput> = JourneyOption & {
  arrivalAt: Date;
  departureAt: Date;
  itinerary: T;
};

function transitRouteChainKey(itinerary: ScheduledGtfsProjectionInput): string {
  const routes: string[] = [];
  for (const segment of itinerary.segments) {
    const key = `${segment.providerId}:${segment.routeId}`;
    if (routes.at(-1) !== key) routes.push(key);
  }
  return routes.join('>');
}

/** Apply the production API projection before bounding the merged scheduled-feed pool. */
export function projectScheduledGtfsCandidatePool<T extends ScheduledGtfsProjectionInput>(
  itineraries: readonly T[],
  maximumCandidates: number,
  strategies: readonly JourneyStrategy[],
): BoundedJourneyCandidatePool<ScheduledGtfsCandidate<T>> {
  const projected: ScheduledGtfsCandidate<T>[] = itineraries.map((itinerary) => ({
    id: itinerary.id,
    diversityKey: `transit:${transitRouteChainKey(itinerary)}`,
    durationSeconds: itinerary.durationSeconds,
    priceMinor: itinerary.fare?.currency === 'UAH' ? itinerary.fare.priceMinor : null,
    transfers: itinerary.transfers,
    walkingMeters: itinerary.walkingMeters,
    reliability: null,
    transferRisk: itinerary.transfers ? 0.3 : 0,
    comfort: null,
    legs: [
      ...(itinerary.segments[0].distanceToOriginStopMeters > 0 ? [{ mode: 'WALK' as const }] : []),
      ...itinerary.segments.flatMap((segment, index) => [
        ...(index > 0 && itinerary.transferWalkingMeters[index - 1] > 0 ? [{ mode: 'WALK' as const }] : []),
        { mode: segment.mode, providerId: segment.providerId },
      ]),
      ...(itinerary.segments.at(-1)!.distanceFromDestinationStopMeters > 0 ? [{ mode: 'WALK' as const }] : []),
    ],
    arrivalAt: itinerary.arrivalAt,
    departureAt: itinerary.departureAt,
    itinerary,
  }));

  return retainStrategyCandidatePool(projected, maximumCandidates, strategies);
}
