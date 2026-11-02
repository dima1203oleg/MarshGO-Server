import { createGtfsTransferDecisionContext, eligibleTripInstanceStopEvents } from '../../server/journey/gtfsTimetable';
import type { GtfsDirectJourney, GtfsTimetableFeed } from '../../server/journey/gtfsTimetable';

type IndexedPrototypeLeg = {
  tripId: string;
  serviceDate: string;
  routeId: string;
  fromStopId: string;
  toStopId: string;
  fromIndex: number;
  toIndex: number;
  departureAt: number;
  arrivalAt: number;
};

/**
 * Test-only query-directed event index prototype. It indexes boarding events
 * by stop, then creates stop-pair legs only when search asks for a boarding
 * stop. It deliberately over-selects transfer candidates (radius, pathways,
 * station parent, and explicit transfer targets); the production search remains
 * the final transferDecision authority in the test below.
 */
export function queryDirectedEventIndexPrototype(feed: GtfsTimetableFeed, options: {
  originStopId?: string; destinationStopId?: string; originStopIds?: readonly string[]; destinationStopIds?: readonly string[];
  earliestDeparture: Date; latestDeparture: Date;
  maximumTransferWalkingMeters: number; maximumTransfers: number;
  serviceDates?: readonly string[];
  maximumCandidateLegVisits?: number;
}) {
  const serviceDates = options.serviceDates ?? ['20261012'];
  const originStopIds = options.originStopIds ?? (options.originStopId ? [options.originStopId] : []);
  const destinationStopIds = new Set(options.destinationStopIds ?? (options.destinationStopId ? [options.destinationStopId] : []));
  const journeyEnd = options.latestDeparture.getTime() + 6 * 60 * 60_000;
  const eventsByTrip = new Map<string, ReturnType<typeof eligibleTripInstanceStopEvents>>();
  const departuresByStop = new Map<string, Array<{ tripId: string; serviceDate: string; stopIndex: number; departureAt: number }>>();
  let indexedBoardingEvents = 0;
  for (const serviceDate of serviceDates) for (const [tripId] of feed.trips) {
    const stopTimes = feed.stopTimes.get(tripId);
    if (!stopTimes) continue;
    const events = eligibleTripInstanceStopEvents(feed, tripId, serviceDate, stopTimes.map((_, index) => index));
    const tripInstanceKey = `${tripId}\u0000${serviceDate}`;
    eventsByTrip.set(tripInstanceKey, events);
    if (!events) continue;
    for (const event of events.events) {
      if (!event.canBoard || !event.departureAt || event.departureAt.getTime() > journeyEnd) continue;
      const choices = departuresByStop.get(event.stopTime.stopId) ?? [];
      choices.push({ tripId, serviceDate, stopIndex: event.stopIndex, departureAt: event.departureAt.getTime() });
      departuresByStop.set(event.stopTime.stopId, choices);
      indexedBoardingEvents++;
    }
  }
  for (const choices of departuresByStop.values()) choices.sort((a, b) => a.departureAt - b.departureAt
    || a.tripId.localeCompare(b.tripId) || a.serviceDate.localeCompare(b.serviceDate) || a.stopIndex - b.stopIndex);

  const distanceMeters = (a: [number, number], b: [number, number]) => {
    const rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad;
    const dLon = (b[0] - a[0]) * rad;
    const lat1 = a[1] * rad, lat2 = b[1] * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  const stopCoordinates = (stopId: string): [number, number] | undefined => {
    const stop = feed.stops.get(stopId);
    return stop ? [stop.lon, stop.lat] : undefined;
  };
  let materializedLegs = 0;
  const legsByOrigin = new Map<string, IndexedPrototypeLeg[]>();
  const legsFrom = (stopId: string): IndexedPrototypeLeg[] => {
    const cached = legsByOrigin.get(stopId);
    if (cached) return cached;
    const legs: IndexedPrototypeLeg[] = [];
    for (const boarding of departuresByStop.get(stopId) ?? []) {
      const instance = eventsByTrip.get(`${boarding.tripId}\u0000${boarding.serviceDate}`);
      const trip = feed.trips.get(boarding.tripId);
      if (!instance || !trip) continue;
      const fromEvent = instance.events[boarding.stopIndex];
      if (!fromEvent?.canBoard || !fromEvent.departureAt) continue;
      for (const toEvent of instance.events) {
        if (toEvent.stopIndex <= boarding.stopIndex || !toEvent.canAlight || !toEvent.arrivalAt) continue;
        const departureAt = fromEvent.departureAt.getTime();
        const arrivalAt = toEvent.arrivalAt.getTime();
        if (arrivalAt < departureAt || arrivalAt > journeyEnd) continue;
        legs.push({ tripId: boarding.tripId, serviceDate: boarding.serviceDate, routeId: trip.routeId,
          fromStopId: stopId, toStopId: toEvent.stopTime.stopId,
          fromIndex: boarding.stopIndex, toIndex: toEvent.stopIndex,
          departureAt, arrivalAt });
        materializedLegs++;
      }
    }
    legs.sort((a, b) => a.departureAt - b.departureAt || a.arrivalAt - b.arrivalAt
      || a.tripId.localeCompare(b.tripId) || a.toIndex - b.toIndex);
    legsByOrigin.set(stopId, legs);
    return legs;
  };

  const pathwayAdjacency = new Map<string, string[]>();
  for (const pathway of feed.pathways ?? []) {
    pathwayAdjacency.set(pathway.fromStopId, [...(pathwayAdjacency.get(pathway.fromStopId) ?? []), pathway.toStopId]);
    if (pathway.bidirectional) pathwayAdjacency.set(pathway.toStopId,
      [...(pathwayAdjacency.get(pathway.toStopId) ?? []), pathway.fromStopId]);
  }
  const canonicalNodes = (tripId: string, stopId: string) => {
    const stopTime = feed.stopTimes.get(tripId)?.find((entry) => entry.stopId === stopId);
    return new Set([stopId, stopTime?.sourceStopId, stopTime?.sourceParentStationId,
      feed.stops.get(stopId)?.parentStation].filter((value): value is string => Boolean(value)));
  };
  const successorStopIds = (leg: IndexedPrototypeLeg) => {
    const sourceNodes = canonicalNodes(leg.tripId, leg.toStopId);
    const pathwayReachable = new Set(sourceNodes);
    const queue = [...sourceNodes];
    for (let cursor = 0; cursor < queue.length; cursor++) for (const next of pathwayAdjacency.get(queue[cursor]!) ?? []) {
      if (pathwayReachable.has(next)) continue;
      pathwayReachable.add(next);
      queue.push(next);
    }
    const center = stopCoordinates(leg.toStopId);
    const transferTargets = new Set((feed.transfers ?? [])
      .filter((rule) => sourceNodes.has(rule.fromStopId)
        && (!rule.fromTripId || rule.fromTripId === leg.tripId))
      .map((rule) => rule.toStopId));
    return [...feed.stops.keys()].filter((stopId) => {
      const targetNodes = canonicalNodes('', stopId);
      if ([...targetNodes].some((id) => pathwayReachable.has(id) || transferTargets.has(id))) return true;
      if ([...sourceNodes].some((id) => targetNodes.has(id))) return true;
      const target = stopCoordinates(stopId);
      return Boolean(center && target && distanceMeters(center, target) <= options.maximumTransferWalkingMeters);
    });
  };

  const candidatePaths = new Set<string>();
  const candidateTripIds = new Set<string>();
  let candidateLegVisits = 0;
  let truncated = false;
  const maximumCandidateLegVisits = options.maximumCandidateLegVisits ?? 100_000;
  const signature = (leg: IndexedPrototypeLeg) =>
    `${leg.tripId}:${leg.fromStopId}@${leg.departureAt}>${leg.toStopId}@${leg.arrivalAt}`;
  const visit = (path: IndexedPrototypeLeg[], visitedStops: Set<string>, seenTrips: Set<string>) => {
    if (truncated) return;
    const last = path.at(-1)!;
    if (destinationStopIds.has(last.toStopId)) {
      candidatePaths.add(path.map(signature).join('|'));
      path.forEach((leg) => candidateTripIds.add(leg.tripId));
      return;
    }
    if (path.length > options.maximumTransfers) return;
    for (const nextStopId of successorStopIds(last)) for (const next of legsFrom(nextStopId)) {
      if (candidateLegVisits >= maximumCandidateLegVisits) { truncated = true; return; }
      candidateLegVisits++;
      if (next.departureAt > journeyEnd || seenTrips.has(next.tripId) || visitedStops.has(next.toStopId)) continue;
      visit([...path, next], new Set([...visitedStops, next.toStopId]), new Set([...seenTrips, next.tripId]));
      if (truncated) return;
    }
  };
  for (const originStopId of originStopIds) for (const first of legsFrom(originStopId)) {
    if (truncated) break;
    if (first.departureAt < options.earliestDeparture.getTime() || first.departureAt > options.latestDeparture.getTime()) continue;
    visit([first], new Set([first.fromStopId, first.toStopId]), new Set([first.tripId]));
  }
  return { candidatePaths, candidateTripIds, indexedBoardingEvents, materializedLegs, candidateLegVisits, truncated };
}

/**
 * Test-only v2 feasibility gate. It deliberately leaves v1 candidate
 * generation untouched, then validates every adjacent leg with the exact
 * transfer authority used by production. This is a proof adapter, not a
 * replacement search: candidate completeness still depends on v1 and its
 * truncation counter remains visible to callers.
 */
export function validateEventIndexCandidatesWithProductionTransfers(feed: GtfsTimetableFeed, options: {
  candidatePaths: ReadonlySet<string>;
  transferRadius: number;
  minimumTransferBufferSeconds: number;
  serviceDates?: readonly string[];
  providerCity?: string;
}) {
  const transferContext = createGtfsTransferDecisionContext({ feed,
    transferRadius: options.transferRadius,
    minimumTransferBufferSeconds: options.minimumTransferBufferSeconds });
  const instanceEvents = new Map<string, ReturnType<typeof eligibleTripInstanceStopEvents>>();
  const journeyCache = new Map<string, GtfsDirectJourney | null>();
  const asJourney = (signature: string): GtfsDirectJourney | null => {
    const cached = journeyCache.get(signature);
    if (cached !== undefined) return cached;
    const separator = signature.lastIndexOf(':');
    const tripId = signature.slice(0, separator);
    const rest = signature.slice(separator + 1);
    const match = /^(.*)@(\d+)>(.*)@(\d+)$/.exec(rest);
    if (!match) { journeyCache.set(signature, null); return null; }
    const [, fromStopId, departureMsText, toStopId, arrivalMsText] = match;
    const departureMs = Number(departureMsText), arrivalMs = Number(arrivalMsText);
    const trip = feed.trips.get(tripId), stopTimes = feed.stopTimes.get(tripId), route = trip && feed.routes.get(trip.routeId);
    if (!trip || !stopTimes || !route) { journeyCache.set(signature, null); return null; }
    // v1 signatures omit serviceDate because its tiny fixtures use one date.
    // Resolve all active service dates and require a unique effective call
    // pair; ambiguity is rejected instead of silently choosing a different
    // transfer-node or realtime interpretation.
    const matching: GtfsDirectJourney[] = [];
    for (const serviceDate of options.serviceDates ?? ['20261012']) {
      const key = `${tripId}\u0000${serviceDate}`;
      let projection = instanceEvents.get(key);
      if (projection === undefined) {
        projection = eligibleTripInstanceStopEvents(feed, tripId, serviceDate,
          stopTimes.map((_, index) => index));
        instanceEvents.set(key, projection);
      }
      if (!projection) continue;
      for (const from of projection.events) {
        if (!from.canBoard || from.departureAt?.getTime() !== departureMs || from.stopTime.stopId !== fromStopId) continue;
        for (const to of projection.events) {
          if (to.stopIndex <= from.stopIndex || !to.canAlight || to.arrivalAt?.getTime() !== arrivalMs || to.stopTime.stopId !== toStopId) continue;
          const provider = feed.providersByRoute?.get(trip.routeId);
          const makeStop = (stopId: string, stopTime: typeof from.stopTime) => {
            const stop = feed.stops.get(stopId);
            const coordinates = stopTime.sourceStopCoordinates ?? (stop ? [stop.lon, stop.lat] as [number, number] : null);
            return stop && coordinates ? { id: stopId, name: stopTime.sourceStopName ?? stop.name, coordinates } : null;
          };
          const originStop = makeStop(from.stopTime.stopId, from.stopTime);
          const destinationStop = makeStop(to.stopTime.stopId, to.stopTime);
          if (!originStop || !destinationStop || !from.scheduledDepartureAt || !to.scheduledArrivalAt
            || !from.departureAt || !to.arrivalAt) continue;
          const journey: GtfsDirectJourney = {
            providerId: provider?.id ?? 'event-index-prototype', providerName: provider?.name ?? 'Prototype',
            ...(provider?.city ? { providerCity: provider.city } : options.providerCity ? { providerCity: options.providerCity } : {}),
            mode: route.mode, routeId: trip.routeId, routeName: route.name, headsign: trip.headsign, tripId,
            originStop, destinationStop,
            originTransferNodeIds: [from.stopTime.sourceStopId ?? from.stopTime.stopId,
              ...(from.stopTime.sourceParentStationId ? [from.stopTime.sourceParentStationId] : [])],
            destinationTransferNodeIds: [to.stopTime.sourceStopId ?? to.stopTime.stopId,
              ...(to.stopTime.sourceParentStationId ? [to.stopTime.sourceParentStationId] : [])],
            transportType: route.transportType === 'bus' && (provider?.city ?? options.providerCity) === 'Україна'
              ? 'intercity_bus' : route.transportType,
            scheduleSemantics: route.scheduleSemantics ?? 'published_departures', serviceDate,
            scheduledDepartureAt: from.scheduledDepartureAt, scheduledArrivalAt: to.scheduledArrivalAt,
            departureAt: from.departureAt, arrivalAt: to.arrivalAt,
            sourceFreshAt: provider?.fetchedAt ?? feed.fetchedAt, distanceToOriginStopMeters: 0,
            distanceFromDestinationStopMeters: 0,
            ...(from.stopTime.sourceZoneId ? { originZoneId: from.stopTime.sourceZoneId } : {}),
            ...(to.stopTime.sourceZoneId ? { destinationZoneId: to.stopTime.sourceZoneId } : {}),
            traveledZoneIds: projection.events.slice(from.stopIndex, to.stopIndex + 1)
              .flatMap((event) => event.stopTime.sourceZoneId ? [event.stopTime.sourceZoneId] : []),
          };
          matching.push(journey);
        }
      }
    }
    const result = matching.length === 1 ? matching[0]! : null;
    journeyCache.set(signature, result);
    return result;
  };

  const feasiblePaths = new Set<string>();
  const rejectedPaths = new Set<string>();
  for (const path of options.candidatePaths) {
    const legs = path.split('|').map(asJourney);
    if (legs.some((leg) => !leg)) { rejectedPaths.add(path); continue; }
    let feasible = true;
    for (let index = 1; index < legs.length; index++) {
      if (!transferContext.decide(legs[index - 1]!, legs[index]!).feasible) { feasible = false; break; }
    }
    (feasible ? feasiblePaths : rejectedPaths).add(path);
  }
  return { feasiblePaths, rejectedPaths };
}
