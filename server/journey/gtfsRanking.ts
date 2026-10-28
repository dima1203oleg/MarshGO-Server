import type { GtfsItinerary } from './gtfsTimetable';
import type { JourneyOption } from './types';

export type RankedGtfsItinerary = JourneyOption & {
  kind: 'gtfs';
  itinerary: GtfsItinerary;
};

/** Project a GTFS itinerary into the exact scalar/leg features used by search ranking. */
export function toRankedGtfsItinerary(itinerary: GtfsItinerary): RankedGtfsItinerary {
  const routeChain: string[] = [];
  for (const segment of itinerary.segments) {
    const key = `${segment.providerId}:${segment.routeId}`;
    if (routeChain.at(-1) !== key) routeChain.push(key);
  }

  const first = itinerary.segments[0]!;
  const last = itinerary.segments.at(-1)!;
  const legs: JourneyOption['legs'] = [
    ...(first.distanceToOriginStopMeters > 0 ? [{ mode: 'WALK' as const }] : []),
    ...itinerary.segments.flatMap((segment, index) => [
      ...(index > 0 && itinerary.transferWalkingMeters[index - 1]! > 0 ? [{ mode: 'WALK' as const }] : []),
      { mode: segment.mode, providerId: segment.providerId },
    ]),
    ...(last.distanceFromDestinationStopMeters > 0 ? [{ mode: 'WALK' as const }] : []),
  ];

  return {
    id: itinerary.id,
    diversityKey: `transit:${routeChain.join('>')}`,
    durationSeconds: itinerary.durationSeconds,
    priceMinor: itinerary.fare?.currency === 'UAH' ? itinerary.fare.priceMinor : null,
    transfers: itinerary.transfers,
    walkingMeters: itinerary.walkingMeters,
    reliability: null,
    transferRisk: itinerary.transfers ? 0.3 : 0,
    comfort: null,
    legs,
    kind: 'gtfs',
    itinerary,
  };
}
