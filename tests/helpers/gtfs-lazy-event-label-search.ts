import { calculateGtfsItineraryFare } from '../../server/journey/gtfsFares';
import { calculateCityTariffFare } from '../../server/mobility/transportTariffs';
import { scoreJourneys } from '../../server/journey/scoring';
import { createGtfsTransferDecisionContext, eligibleTripInstanceStopEvents, findGtfsItinerariesWithStats,
  rankGtfsItinerariesForCandidateSampling } from '../../server/journey/gtfsTimetable';
import type { GtfsCandidateGraphSnapshot, GtfsDirectJourney, GtfsItinerary, GtfsItinerarySearchInput,
  GtfsItinerarySearchResult, GtfsTimetableFeed } from '../../server/journey/gtfsTimetable';

type EventProjection = NonNullable<ReturnType<typeof eligibleTripInstanceStopEvents>>;
type StopEvent = EventProjection['events'][number];
type BoardingCall = { tripId: string; serviceDate: string; stopIndex: number; departureMs: number; nodeIds: string[] };
type LazyLeg = { journey: GtfsDirectJourney; fromIndex: number; toIndex: number };

function haversineMeters(a: [number, number], b: [number, number]) {
  const rad = (n: number) => n * Math.PI / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Independent test-only event-label search. It materializes downstream legs
 * only for boarding calls reached by a label and validates each edge through
 * the exact production transfer context. It deliberately retains every path
 * label (no fare/time dominance) so fixtures can compare full identities.
 */
export function lazyEventLabelSearch(feed: GtfsTimetableFeed, options: {
  originStopIds: readonly string[];
  destinationStopIds: readonly string[];
  serviceDates: readonly string[];
  earliestDeparture: Date;
  latestDeparture: Date;
  maximumJourneySeconds: number;
  maximumTransfers: number;
  maximumWaitSeconds: number;
  journeyEndAt?: Date;
  transferRadiusMeters: number;
  minimumTransferBufferSeconds: number;
  providerId?: string;
  providerName?: string;
  providerCity?: string;
  maximumExpandedLabels?: number;
}) {
  const journeyEnd = options.journeyEndAt?.getTime()
    ?? (options.latestDeparture.getTime() + options.maximumJourneySeconds * 1000);
  const transferContext = createGtfsTransferDecisionContext({ feed,
    transferRadius: options.transferRadiusMeters,
    minimumTransferBufferSeconds: options.minimumTransferBufferSeconds });
  const projections = new Map<string, EventProjection>();
  const boardingsByStop = new Map<string, BoardingCall[]>();
  const boardingByNode = new Map<string, BoardingCall[]>();
  const transferRulesByFrom = new Map<string, Set<string>>();
  for (const rule of feed.transfers ?? []) {
    const targets = transferRulesByFrom.get(rule.fromStopId) ?? new Set<string>();
    targets.add(rule.toStopId);
    transferRulesByFrom.set(rule.fromStopId, targets);
  }
  const stopCoordinates = new Map<string, [number, number]>();
  const nodeIdsAtStop = (event: StopEvent) => {
    const primary = event.stopTime.sourceStopId ?? event.stopTime.stopId;
    return event.stopTime.sourceParentStationId && event.stopTime.sourceParentStationId !== primary
      ? [primary, event.stopTime.sourceParentStationId] : [primary];
  };
  const calls: BoardingCall[] = [];
  for (const serviceDate of options.serviceDates) for (const [tripId, stopTimes] of feed.stopTimes) {
    const projection = eligibleTripInstanceStopEvents(feed, tripId, serviceDate, stopTimes.map((_, index) => index));
    if (!projection) continue;
    projections.set(`${tripId}\u0000${serviceDate}`, projection);
    for (const event of projection.events) {
      if (!event.canBoard || !event.departureAt || event.departureAt.getTime() > journeyEnd) continue;
      const call: BoardingCall = { tripId, serviceDate, stopIndex: event.stopIndex,
        departureMs: event.departureAt.getTime(), nodeIds: nodeIdsAtStop(event) };
      calls.push(call);
      const byStop = boardingsByStop.get(event.stopTime.stopId) ?? [];
      byStop.push(call); boardingsByStop.set(event.stopTime.stopId, byStop);
      for (const nodeId of call.nodeIds) {
        const byNode = boardingByNode.get(nodeId) ?? [];
        byNode.push(call); boardingByNode.set(nodeId, byNode);
      }
      const stop = feed.stops.get(event.stopTime.stopId);
      const coordinates = event.stopTime.sourceStopCoordinates ?? (stop ? [stop.lon, stop.lat] as [number, number] : undefined);
      if (coordinates) stopCoordinates.set(event.stopTime.stopId, coordinates);
    }
  }
  const eventOrder = (a: BoardingCall, b: BoardingCall) => a.departureMs - b.departureMs
    || a.tripId.localeCompare(b.tripId) || a.serviceDate.localeCompare(b.serviceDate) || a.stopIndex - b.stopIndex;
  for (const values of boardingsByStop.values()) values.sort(eventOrder);
  for (const values of boardingByNode.values()) values.sort(eventOrder);

  // Spatial index is built once per query; exact radius is always checked
  // after cell lookup. Cell width is never smaller than the search radius.
  const cellMeters = Math.max(1, options.transferRadiusMeters);
  const cellKey = (coord: [number, number]) => {
    const latMeters = coord[1] * 111_320;
    const lonMeters = coord[0] * 111_320 * Math.cos(coord[1] * Math.PI / 180);
    return `${Math.floor(lonMeters / cellMeters)}:${Math.floor(latMeters / cellMeters)}`;
  };
  const stopsByCell = new Map<string, Set<string>>();
  for (const [stopId, coordinates] of stopCoordinates) {
    const key = cellKey(coordinates), ids = stopsByCell.get(key) ?? new Set<string>();
    ids.add(stopId); stopsByCell.set(key, ids);
  }
  const pathwayNodes = new Set((feed.pathways ?? []).flatMap((path) => [path.fromStopId, path.toStopId]));
  const successorBoardings = (leg: LazyLeg): BoardingCall[] => {
    const result = new Set<BoardingCall>();
    const priorNodes = leg.journey.destinationTransferNodeIds;
    for (const nodeId of priorNodes) {
      for (const call of boardingByNode.get(nodeId) ?? []) result.add(call);
      for (const targetId of transferRulesByFrom.get(nodeId) ?? []) {
        for (const call of boardingByNode.get(targetId) ?? []) result.add(call);
      }
      if (pathwayNodes.has(nodeId)) {
        for (const nodeId2 of transferContext.reachablePathwayNodes(nodeId)) {
          for (const call of boardingByNode.get(nodeId2) ?? []) result.add(call);
        }
      }
    }
    const center = leg.journey.destinationStop.coordinates;
    const [cx, cy] = cellKey(center).split(':').map(Number);
    const neighborhoodCells = Math.ceil(options.transferRadiusMeters / cellMeters) + 1;
    for (let dx = -neighborhoodCells; dx <= neighborhoodCells; dx++) for (let dy = -neighborhoodCells; dy <= neighborhoodCells; dy++) {
      for (const stopId of stopsByCell.get(`${cx + dx}:${cy + dy}`) ?? []) {
        const coordinates = stopCoordinates.get(stopId);
        if (!coordinates || haversineMeters(center, coordinates) > options.transferRadiusMeters) continue;
        for (const call of boardingsByStop.get(stopId) ?? []) result.add(call);
      }
    }
    return [...result].sort(eventOrder);
  };

  const legCache = new Map<string, LazyLeg[]>();
  const boardingProjection = (call: BoardingCall) => {
    const projection = projections.get(`${call.tripId}\u0000${call.serviceDate}`);
    const trip = feed.trips.get(call.tripId), stopTimes = feed.stopTimes.get(call.tripId);
    const route = trip && feed.routes.get(trip.routeId);
    const event = projection?.events[call.stopIndex];
    if (!projection || !trip || !stopTimes || !route || !event?.canBoard || !event.departureAt) return null;
    const stopTime = event.stopTime, stop = feed.stops.get(stopTime.stopId);
    const coordinates = stopTime.sourceStopCoordinates ?? (stop ? [stop.lon, stop.lat] as [number, number] : undefined);
    if (!stop || !coordinates) return null;
    const provider = feed.providersByRoute?.get(trip.routeId);
    const providerCity = provider?.city ?? options.providerCity;
    return {
      providerId: provider?.id ?? options.providerId ?? 'lazy-event-test',
      tripId: call.tripId,
      routeId: trip.routeId,
      originStop: { id: stopTime.stopId, name: stopTime.sourceStopName ?? stop.name, coordinates },
      originTransferNodeIds: nodeIdsAtStop(event),
      departureAt: event.departureAt,
      transportType: route.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route.transportType,
    };
  };
  const materializeFrom = (call: BoardingCall): LazyLeg[] => {
    const cacheKey = `${call.tripId}\u0000${call.serviceDate}\u0000${call.stopIndex}`;
    const cached = legCache.get(cacheKey);
    if (cached) return cached;
    const projection = projections.get(`${call.tripId}\u0000${call.serviceDate}`);
    const trip = feed.trips.get(call.tripId), stopTimes = feed.stopTimes.get(call.tripId);
    const route = trip && feed.routes.get(trip.routeId);
    if (!projection || !trip || !stopTimes || !route) { legCache.set(cacheKey, []); return []; }
    const from = projection.events[call.stopIndex];
    if (!from?.canBoard || !from.departureAt || !from.scheduledDepartureAt) { legCache.set(cacheKey, []); return []; }
    const legs: LazyLeg[] = [];
    for (let toIndex = call.stopIndex + 1; toIndex < projection.events.length; toIndex++) {
      const to = projection.events[toIndex]!;
      if (!to.canAlight || !to.arrivalAt || !to.scheduledArrivalAt || to.arrivalAt < from.departureAt
        || to.arrivalAt.getTime() > journeyEnd) continue;
      const origin = from.stopTime, destination = to.stopTime;
      const originStop = feed.stops.get(origin.stopId), destinationStop = feed.stops.get(destination.stopId);
      const originCoordinates = origin.sourceStopCoordinates ?? (originStop ? [originStop.lon, originStop.lat] as [number, number] : undefined);
      const destinationCoordinates = destination.sourceStopCoordinates ?? (destinationStop ? [destinationStop.lon, destinationStop.lat] as [number, number] : undefined);
      if (!originStop || !destinationStop || !originCoordinates || !destinationCoordinates) continue;
      const provider = feed.providersByRoute?.get(trip.routeId);
      const providerId = provider?.id ?? options.providerId ?? 'lazy-event-test';
      const providerCity = provider?.city ?? options.providerCity;
      const journey: GtfsDirectJourney = {
        providerId, providerName: provider?.name ?? options.providerName ?? providerId,
        ...(providerCity ? { providerCity } : {}), mode: route.mode,
        routeId: trip.routeId, routeName: route.name, headsign: trip.headsign, tripId: call.tripId,
        originStop: { id: origin.stopId, name: origin.sourceStopName ?? originStop.name, coordinates: originCoordinates },
        destinationStop: { id: destination.stopId, name: destination.sourceStopName ?? destinationStop.name, coordinates: destinationCoordinates },
        originTransferNodeIds: nodeIdsAtStop(from), destinationTransferNodeIds: nodeIdsAtStop(to),
        transportType: route.transportType === 'bus' && providerCity === 'Україна' ? 'intercity_bus' : route.transportType,
        scheduleSemantics: route.scheduleSemantics ?? 'published_departures', serviceDate: call.serviceDate,
        scheduledDepartureAt: from.scheduledDepartureAt, scheduledArrivalAt: to.scheduledArrivalAt,
        departureAt: from.departureAt, arrivalAt: to.arrivalAt, sourceFreshAt: provider?.fetchedAt ?? feed.fetchedAt,
        ...(from.updated || to.updated ? { realtimeUpdatedAt: projection.realtimeUpdate?.updatedAt } : {}),
        distanceToOriginStopMeters: 0, distanceFromDestinationStopMeters: 0,
        ...(origin.sourceZoneId ? { originZoneId: origin.sourceZoneId } : {}),
        ...(destination.sourceZoneId ? { destinationZoneId: destination.sourceZoneId } : {}),
        traveledZoneIds: projection.events.slice(call.stopIndex, toIndex + 1)
          .flatMap((event) => event.stopTime.sourceZoneId ? [event.stopTime.sourceZoneId] : []),
      };
      legs.push({ journey, fromIndex: call.stopIndex, toIndex });
    }
    legCache.set(cacheKey, legs);
    return legs;
  };

  const identities = new Map<string, { identity: string; tripIds: string[]; serviceDates: string[];
    segmentIndexes: Array<[number, number]>; segmentIdentities: string[]; fareMinor: number | null; fareAllocations: unknown;
    path: LazyLeg[] }>();
  const originIds = new Set(options.originStopIds), destinationIds = new Set(options.destinationStopIds);
  const maxLegs = options.maximumTransfers + 1;
  const maxWaitMs = options.maximumWaitSeconds * 1000;
  const maximumExpandedLabels = options.maximumExpandedLabels ?? 100_000;
  let expandedLabels = 0;
  let searchTruncated = false;
  const visit = (path: LazyLeg[]) => {
    if (searchTruncated) return;
    if (expandedLabels >= maximumExpandedLabels) { searchTruncated = true; return; }
    expandedLabels++;
    const last = path.at(-1)!;
    if (destinationIds.has(last.journey.destinationStop.id)) {
      const segments = path.map((leg) => leg.journey);
      const fare = calculateGtfsItineraryFare({ products: feed.fareProducts ?? new Map(),
        rules: feed.fareRules ?? new Map(), faresV2Present: feed.faresV2Present === true },
      segments.map((segment) => ({ providerId: segment.providerId, routeId: segment.routeId,
        ...(feed.routes.get(segment.routeId)?.agencyId ? { agencyId: feed.routes.get(segment.routeId)!.agencyId } : {}),
        departureAt: segment.departureAt, arrivalAt: segment.arrivalAt,
        ...(segment.originZoneId ? { originZoneId: segment.originZoneId } : {}),
        ...(segment.destinationZoneId ? { destinationZoneId: segment.destinationZoneId } : {}),
        traveledZoneIds: segment.traveledZoneIds }))) ?? null;
      const identity = path.map((leg) => `${leg.journey.providerId}:${leg.journey.serviceDate}:${leg.journey.tripId}:${leg.fromIndex}:${leg.toIndex}:${leg.journey.departureAt.getTime()}:${leg.journey.arrivalAt.getTime()}`).join('|');
      identities.set(identity, { identity, tripIds: segments.map((segment) => segment.tripId),
        serviceDates: segments.map((segment) => segment.serviceDate),
        segmentIndexes: path.map((leg) => [leg.fromIndex, leg.toIndex]),
        segmentIdentities: path.map((leg) => `${leg.journey.tripId}:${leg.journey.originStop.id}@${leg.journey.departureAt.getTime()}>${leg.journey.destinationStop.id}@${leg.journey.arrivalAt.getTime()}`),
        fareMinor: fare?.priceMinor ?? null,
        path,
        fareAllocations: fare?.allocations ?? null });
    }
    if (path.length >= maxLegs) return;
    const prior = last.journey;
    const pathTripIds = new Set(path.map((leg) => leg.journey.tripId));
    const visitedStops = new Set(path.flatMap((leg) => [leg.journey.originStop.id, leg.journey.destinationStop.id]));
    const latest = Math.min(prior.arrivalAt.getTime() + maxWaitMs, journeyEnd);
    for (const call of successorBoardings(last)) {
      if (call.departureMs < prior.arrivalAt.getTime() || call.departureMs > latest || pathTripIds.has(call.tripId)) continue;
      const boarding = boardingProjection(call);
      if (!boarding || !transferContext.decideBoarding(prior, boarding).feasible) continue;
      for (const next of materializeFrom(call)) {
        if (visitedStops.has(next.journey.destinationStop.id)) continue;
        if (!transferContext.decide(prior, next.journey).feasible) continue;
        visit([...path, next]);
      }
    }
  };
  for (const call of calls.filter((candidate) => originIds.has(feed.stopTimes.get(candidate.tripId)?.[candidate.stopIndex]?.stopId ?? '')
    && candidate.departureMs >= options.earliestDeparture.getTime() && candidate.departureMs <= options.latestDeparture.getTime()).sort(eventOrder)) {
    for (const first of materializeFrom(call)) visit([first]);
  }
  return { identities, expandedLabels, searchTruncated,
    materializedBoardingExpansions: legCache.size,
    materializedLegs: [...legCache.values()].reduce((sum, legs) => sum + legs.length, 0) };
}

/**
 * Exhaustive graph-relative traversal for the exact request candidate graph.
 * Production owns stop selection, corridor/catchment/interchange policy,
 * segment retention, transfer adjacency and destination reachability; this
 * oracle varies only the path traversal over that captured graph.
 */
function lazySearchCapturedGraph(graph: GtfsCandidateGraphSnapshot, maximumTransfers: number,
  maximumExpandedLabels = 100_000) {
  const byId = new Map(graph.segments.map((entry) => [entry.id, entry.journey] as const));
  const identities = new Map<string, { identity: string; path: Array<{ id: string; journey: GtfsDirectJourney }> }>();
  const maxLegs = maximumTransfers + 1;
  let expandedLabels = 0;
  let searchTruncated = false;
  const visit = (path: Array<{ id: string; journey: GtfsDirectJourney }>) => {
    if (searchTruncated) return;
    if (expandedLabels >= maximumExpandedLabels) { searchTruncated = true; return; }
    expandedLabels++;
    const last = path.at(-1)!.journey;
    if (graph.destinationStopIds.includes(last.destinationStop.id)) {
      const identity = path.map(({ id }) => id).join('|');
      identities.set(identity, { identity, path });
    }
    if (path.length >= maxLegs) return;
    const remainingLegs = maxLegs - path.length;
    const latestDepartureMs = Math.min(last.arrivalAt.getTime() + graph.maximumWaitMs, graph.journeyEndMs);
    const previousIds = new Set(path.map(({ journey }) => journey.tripId));
    const visitedStops = new Set(path.flatMap(({ journey }) => [journey.originStop.id, journey.destinationStop.id]));
    for (const nextId of graph.successors(path.at(-1)!.id, remainingLegs)) {
      const next = byId.get(nextId);
      if (!next || next.departureAt.getTime() < last.arrivalAt.getTime()
        || next.departureAt.getTime() > latestDepartureMs
        || previousIds.has(next.tripId) || visitedStops.has(next.destinationStop.id)
        || !graph.transferDecision(path.at(-1)!.id, nextId).feasible) continue;
      visit([...path, { id: nextId, journey: next as GtfsDirectJourney }]);
      if (searchTruncated) return;
    }
  };
  for (const id of graph.firstLegIds) {
    const journey = byId.get(id);
    if (journey) visit([{ id, journey: journey as GtfsDirectJourney }]);
    if (searchTruncated) break;
  }
  return { identities, expandedLabels, searchTruncated,
    candidateSegmentCount: graph.segments.length,
    firstLegIds: [...graph.firstLegIds],
    originStopIds: [...graph.originStopIds], destinationStopIds: [...graph.destinationStopIds] };
}

/**
 * Test-only adapter that captures the exact production candidate graph and
 * then traverses that graph exhaustively. It intentionally does not reproduce
 * stop selection, corridor/catchment or transfer adjacency.
 */
export function lazyEventLabelSearchForRequest(feed: GtfsTimetableFeed, input: GtfsItinerarySearchInput,
  captured?: { graph: GtfsCandidateGraphSnapshot; production: GtfsItinerarySearchResult }) {
  const maximumTransfers = input.maximumTransfers ?? 4;
  const maximumJourneySeconds = input.maximumJourneySeconds ?? 24 * 60 * 60;
  const limit = input.limit ?? 20;
  let graph: GtfsCandidateGraphSnapshot | undefined = captured?.graph;
  const production = captured?.production ?? findGtfsItinerariesWithStats(feed, input, {}, (snapshot) => { graph = snapshot; });
  if (!graph) throw new Error('production GTFS candidate graph observer did not run');
  const core = lazySearchCapturedGraph(graph, maximumTransfers);
  const transferDecisions = (path: Array<{ id: string; journey: GtfsDirectJourney }>) => path.slice(1)
    .map((entry, index) => graph!.transferDecision(path[index]!.id, entry.id));
  const walkSeconds = (meters: number) => Math.ceil(meters / 1.25);
  const candidates: GtfsItinerary[] = [];
  for (const entry of core.identities.values()) {
    const segments = entry.path.map(({ journey }) => ({ ...journey })) as GtfsDirectJourney[];
    const first = segments[0]!, last = segments.at(-1)!;
    const decisions = transferDecisions(entry.path);
    if (decisions.some((decision) => !decision.feasible)) continue;
    const transferWalkingMeters = decisions.map(({ measure }) => measure.walkingMeters);
    const transferWalkingSeconds = decisions.map(({ measure }) => measure.walkingSeconds);
    const departureAt = new Date(input.earliestDeparture);
    const arrivalAt = new Date(last.arrivalAt.getTime() + walkSeconds(last.distanceFromDestinationStopMeters) * 1000);
    const durationSeconds = Math.ceil((arrivalAt.getTime() - departureAt.getTime()) / 1000);
    if (durationSeconds > maximumJourneySeconds) continue;
    const transferWaitingSeconds = segments.slice(1).reduce((total, segment, index) => total + Math.max(0, Math.ceil((segment.departureAt.getTime()
      - segments[index]!.arrivalAt.getTime() - (transferWalkingSeconds[index] ?? 0) * 1000) / 1000)), 0);
    const initialWaitSeconds = Math.max(0, Math.ceil((first.departureAt.getTime() - departureAt.getTime()
      - walkSeconds(first.distanceToOriginStopMeters) * 1000) / 1000));
    const fare = calculateGtfsItineraryFare({ products: feed.fareProducts ?? new Map(), rules: feed.fareRules ?? new Map(), faresV2Present: feed.faresV2Present === true }, segments.map((segment) => ({
      providerId: segment.providerId, routeId: segment.routeId,
      ...(feed.routes.get(segment.routeId)?.agencyId ? { agencyId: feed.routes.get(segment.routeId)!.agencyId } : {}),
      departureAt: segment.departureAt, arrivalAt: segment.arrivalAt,
      ...(segment.originZoneId ? { originZoneId: segment.originZoneId } : {}),
      ...(segment.destinationZoneId ? { destinationZoneId: segment.destinationZoneId } : {}),
      traveledZoneIds: segment.traveledZoneIds,
    }))) ?? calculateCityTariffFare(segments.map((segment) => ({ providerCity: segment.providerCity, mode: segment.mode,
      transportType: segment.transportType, departureAt: segment.departureAt, arrivalAt: segment.arrivalAt })));
    candidates.push({ id: entry.identity, providerId: first.providerId,
      providerName: [...new Set(segments.map((segment) => segment.providerName))].join(' + '),
      segments, departureAt, arrivalAt, durationSeconds, waitingSeconds: initialWaitSeconds + transferWaitingSeconds,
      transfers: decisions.filter(({ measure }) => !measure.inSeat).length,
      walkingMeters: first.distanceToOriginStopMeters + last.distanceFromDestinationStopMeters
        + transferWalkingMeters.reduce((sum, meters) => sum + meters, 0),
      transferWalkingMeters, transferWalkingSeconds, transferWalkingGeometries: decisions.map(({ measure }) => measure.geometry),
      transferInSeat: decisions.map(({ measure }) => measure.inSeat),
      transferMinimumBufferSeconds: decisions.map(({ minimumBufferSeconds }) => minimumBufferSeconds),
      transferRuleMinimumSeconds: decisions.map(({ ruleMinimumSeconds }) => ruleMinimumSeconds), fare });
  }
  candidates.sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime() || a.transfers - b.transfers || a.id.localeCompare(b.id));
  const byDuration = [...candidates].sort((a, b) => a.durationSeconds - b.durationSeconds || a.transfers - b.transfers || a.id.localeCompare(b.id));
  const byFare = candidates.filter((journey) => journey.fare?.currency === 'UAH')
    .sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor || a.durationSeconds - b.durationSeconds || a.id.localeCompare(b.id));
  const byTransfers = [...candidates].sort((a, b) => a.transfers - b.transfers || a.durationSeconds - b.durationSeconds || a.id.localeCompare(b.id));
  const byWalking = [...candidates].sort((a, b) => a.walkingMeters - b.walkingMeters || a.durationSeconds - b.durationSeconds || a.id.localeCompare(b.id));
  const balanced = rankGtfsItinerariesForCandidateSampling(candidates);
  const selected = new Map<string, GtfsItinerary>();
  const perObjective = Math.max(1, Math.floor(limit / 5));
  for (const ranking of [byDuration, byFare, byTransfers, byWalking, balanced]) {
    for (const itinerary of ranking.slice(0, perObjective)) {
      if (selected.size >= limit) break;
      selected.set(itinerary.id, itinerary);
    }
  }
  for (const itinerary of candidates) {
    if (selected.size >= limit) break;
    selected.set(itinerary.id, itinerary);
  }
  const itineraries = [...selected.values()].sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime()
    || a.transfers - b.transfers || a.id.localeCompare(b.id));
  const scoringOptions = candidates.map((journey) => ({ id: journey.id, durationSeconds: journey.durationSeconds,
    priceMinor: journey.fare?.currency === 'UAH' ? journey.fare.priceMinor : null, transfers: journey.transfers,
    walkingMeters: journey.walkingMeters, reliability: null, transferRisk: journey.transfers > 0 ? 0.3 : 0,
    comfort: null, legs: journey.segments.map((segment) => ({ mode: segment.mode })) }));
  const winners = Object.fromEntries((['FASTEST', 'CHEAPEST', 'BALANCED'] as const).map((strategy) =>
    [strategy, scoreJourneys(scoringOptions, strategy)[0]?.journey.id ?? null]));
  return { ...core, searchTruncated: core.searchTruncated || production.searchTruncated,
    productionSearchTruncated: production.searchTruncated, candidateGraphTruncated: production.candidateGraphTruncated,
    itineraries, winners, selectedOriginStopIds: [...graph.originStopIds],
    selectedDestinationStopIds: [...graph.destinationStopIds] };
}
