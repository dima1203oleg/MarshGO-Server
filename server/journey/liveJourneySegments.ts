import { networkRoutesForRoute, type LiveVehicle, type TransportNetwork } from '../mobility/transportLayers';
import { getGtfsTripStopArrival, type GtfsTimetableFeed } from './gtfsTimetable';
import { approachingBoardingStop, freshVehiclesForRoute, isJourneyLegGpsWindowOpen, matchLiveVehicleForJourneyLeg, selectBoardingApproachVehicleIds, unscopeGtfsId } from './liveVehicles';
import { classifyVehiclePriority, splitRouteGeometryByStops, type RouteZoneSplit, type VehiclePriority } from './transportVisualZones';

export interface LiveJourneyLegInput {
  id: string;
  providerId: string | null;
  metadata: Record<string, unknown>;
  scheduledDepartureAt: Date | null;
  scheduledArrivalAt: Date | null;
}

export interface LiveJourneyProviderData {
  vehicles: LiveVehicle[] | null;
  network: TransportNetwork | null;
  timetable: GtfsTimetableFeed | null;
}

export interface LiveJourneySegment {
  legId: string;
  status: 'LIVE' | 'SCHEDULED' | 'UNVERIFIED';
  reason?: 'provider_unavailable' | 'no_fresh_matching_vehicle';
  /** GPS is an observation; a TripUpdate ETA is a separate prediction. */
  vehiclePositionStatus: 'OBSERVED' | 'UNAVAILABLE';
  boardingStopArrival: {
    status: 'PREDICTED' | 'SCHEDULED' | 'UNAVAILABLE';
    scheduledAt?: string;
    predictedAt?: string;
    realtimeUpdatedAt?: string;
  };
  vehicle?: {
    coordinates: [number, number];
    bearing: number | null;
    speed: number | null;
    route: string;
    updatedAt: string;
  };
  lineRoutes: Array<{
    id: string;
    providerId: string;
    routeId: string;
    name: string;
    direction: string;
    directionId: string | null;
    geometrySource: 'gtfs_shape' | 'official_geojson';
    /**
     * `full_route` is the whole published line, so zones A and C can exist.
     * `leg_only` is only the boarding-to-alighting slice, so the client must not
     * imply that nothing runs before or after it.
     */
    geometryScope: 'full_route' | 'leg_only';
    /** Null when this direction cannot be projected onto the passenger's stops. */
    zones: (RouteZoneSplit & { boardingStopId: string | null; alightingStopId: string | null }) | null;
    coordinates: Array<[number, number]>;
  }>;
  vehicles: Array<{
    id: string;
    providerId: string;
    coordinates: [number, number];
    bearing: number | null;
    speed: number | null;
    updatedAt: string;
    tripId: string | null;
    routeId: string | null;
    directionId: string | null;
    approachingBoarding: boolean;
    remainingStops: number | null;
    emphasized: boolean;
    /** Five-level visual priority, derived only from verified route/stop/GPS facts. */
    priority: VehiclePriority;
    etaConfidence: 'OBSERVED' | 'PREDICTED' | 'NONE';
    approachEvidence: null | {
      source: 'OBSERVED_PROGRESS' | 'TRIP_UPDATE_PREDICTION';
      predictedArrivalAt?: string;
      realtimeUpdatedAt?: string;
      remainingStops?: number;
      currentStopSequence?: number;
      currentStopId?: string;
    };
    etaSeconds: number | null;
  }>;
}

/** Build a truthful map overlay for one selected scheduled transit leg. */
export function buildLiveJourneySegment(
  leg: LiveJourneyLegInput,
  feed: LiveJourneyProviderData,
  now = Date.now(),
): LiveJourneySegment {
  const emptyFleet: LiveJourneySegment['vehicles'] = [];
  const emptyRoutes: LiveJourneySegment['lineRoutes'] = [];
  const unavailableArrival: LiveJourneySegment['boardingStopArrival'] = { status: 'UNAVAILABLE' };
  if (!leg.providerId) return { legId: leg.id, status: 'SCHEDULED', vehiclePositionStatus: 'UNAVAILABLE',
    boardingStopArrival: unavailableArrival, lineRoutes: emptyRoutes, vehicles: emptyFleet };
  const routeId = typeof leg.metadata.routeId === 'string' ? leg.metadata.routeId : null;
  const geometrySource = leg.metadata.routeGeometrySource === 'official_geojson' || leg.metadata.routeGeometrySource === 'gtfs_shape'
    ? leg.metadata.routeGeometrySource : null;
  const storedGeometry = Array.isArray(leg.metadata.routeGeometry) ? leg.metadata.routeGeometry.flatMap((point): Array<[number, number]> => {
    if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number'
      || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return [];
    return [[point[0], point[1]]];
  }) : [];
  const hasTrustedStoredGeometry = Boolean(routeId && geometrySource && storedGeometry.length >= 2);
  if (!feed.vehicles && !feed.network && !hasTrustedStoredGeometry) {
    return { legId: leg.id, status: 'UNVERIFIED', reason: 'provider_unavailable', vehiclePositionStatus: 'UNAVAILABLE',
      boardingStopArrival: unavailableArrival, lineRoutes: emptyRoutes, vehicles: emptyFleet };
  }

  const identity = {
    providerId: leg.providerId,
    tripId: typeof leg.metadata.tripId === 'string' ? leg.metadata.tripId : null,
    routeId: typeof leg.metadata.routeId === 'string' ? leg.metadata.routeId : null,
    serviceDate: typeof leg.metadata.serviceDate === 'string' ? leg.metadata.serviceDate : null,
    scheduledDepartureAt: leg.scheduledDepartureAt,
    scheduledArrivalAt: leg.scheduledArrivalAt,
  };
  const rawRouteId = unscopeGtfsId(leg.providerId, identity.routeId);
  const rawTripId = unscopeGtfsId(leg.providerId, identity.tripId);
  const rawServiceDate = identity.serviceDate?.replaceAll('-', '') ?? null;
  const rawBoardingStopId = unscopeGtfsId(leg.providerId, typeof leg.metadata.fromStopFeedId === 'string'
    ? leg.metadata.fromStopFeedId : null);
  let boardingStopArrival: LiveJourneySegment['boardingStopArrival'] = unavailableArrival;
  let tripStopArrival: ReturnType<typeof getGtfsTripStopArrival> | null = null;
  if (feed.timetable && rawTripId && rawServiceDate && rawBoardingStopId) {
    tripStopArrival = getGtfsTripStopArrival(feed.timetable, rawTripId, rawRouteId ?? '', rawServiceDate, rawBoardingStopId, new Date(now));
    if (tripStopArrival.status === 'SCHEDULED' || tripStopArrival.status === 'PREDICTED') {
      boardingStopArrival = { status: 'SCHEDULED', ...(tripStopArrival.scheduledArrivalAt ? { scheduledAt: tripStopArrival.scheduledArrivalAt.toISOString() } : {}) };
    }
  }
  const exactSelectedVehicle = feed.vehicles ? matchLiveVehicleForJourneyLeg(identity, feed.vehicles, now) : null;
  const hasFreshDatedStopPrediction = tripStopArrival?.status === 'PREDICTED'
    && Boolean(tripStopArrival.predictedArrivalAt && tripStopArrival.predictedArrivalAt.getTime() > now
      && tripStopArrival.realtimeUpdatedAt);
  // A VehiclePosition without start_date can inherit the selected service date
  // only when a fresh TripUpdate independently confirms this trip's boarding stop.
  const selectedVehicle = exactSelectedVehicle ?? (hasFreshDatedStopPrediction && feed.vehicles
    ? matchLiveVehicleForJourneyLeg(identity, feed.vehicles, now, { allowMissingServiceDate: true }) : null);
  if (tripStopArrival?.status === 'PREDICTED' && hasFreshDatedStopPrediction
    && tripStopArrival.scheduledArrivalAt && tripStopArrival.predictedArrivalAt
    && selectedVehicle?.tripId === rawTripId
    && selectedVehicle.routeId === rawRouteId
    && (!selectedVehicle.startDate || selectedVehicle.startDate === rawServiceDate)) {
    boardingStopArrival = { status: 'PREDICTED', scheduledAt: tripStopArrival.scheduledArrivalAt.toISOString(),
      predictedAt: tripStopArrival.predictedArrivalAt.toISOString(),
      ...(tripStopArrival.realtimeUpdatedAt ? { realtimeUpdatedAt: tripStopArrival.realtimeUpdatedAt.toISOString() } : {}) };
  }
  const fleet = rawRouteId && feed.vehicles
    ? freshVehiclesForRoute(leg.providerId, rawRouteId, feed.vehicles, now)
    : [];
  const boardingStopId = typeof leg.metadata.fromStopFeedId === 'string' ? leg.metadata.fromStopFeedId : null;
  const rawAlightingStopId = unscopeGtfsId(leg.providerId, typeof leg.metadata.toStopFeedId === 'string'
    ? leg.metadata.toStopFeedId : null);
  const legTripStops = rawTripId ? feed.timetable?.stopTimes.get(rawTripId) ?? [] : [];
  // Stop coordinates come from the selected trip's own call list first, because a merged
  // timetable canonicalises stop ids across feeds; the raw network stop table is the fallback.
  const stopPoint = (rawStopId: string | null): [number, number] | null => {
    if (!rawStopId) return null;
    const onTrip = legTripStops.find((stop) => unscopeGtfsId(leg.providerId!, stop.stopId) === rawStopId)?.sourceStopCoordinates;
    if (onTrip) return onTrip;
    const networkStop = feed.network?.stops.find((stop) => stop.id === rawStopId);
    return networkStop ? [networkStop.lon, networkStop.lat] : null;
  };
  const boardingPoint = stopPoint(unscopeGtfsId(leg.providerId, boardingStopId));
  const alightingPoint = stopPoint(rawAlightingStopId);
  const rawBoardingStopForZones = unscopeGtfsId(leg.providerId, boardingStopId);
  const legTripDirection = rawTripId ? feed.timetable?.trips.get(rawTripId)?.directionId ?? null : null;
  const zonesFor = (route: LiveJourneySegment['lineRoutes'][number]) => {
    if (route.geometryScope === 'leg_only') {
      return {
        boardingShapeIndex: 0,
        alightingShapeIndex: route.coordinates.length - 1,
        beforeBoarding: null,
        passengerSegment: route.coordinates,
        afterAlighting: null,
        snapMeters: 0,
        boardingStopId: rawBoardingStopForZones,
        alightingStopId: rawAlightingStopId,
      };
    }
    // A slice of the opposite direction would be a different line, so refuse to guess it.
    if (legTripDirection && route.directionId && legTripDirection !== route.directionId) return null;
    const split = splitRouteGeometryByStops(route.coordinates, boardingPoint, alightingPoint);
    return split ? { ...split, boardingStopId: rawBoardingStopForZones, alightingStopId: rawAlightingStopId } : null;
  };
  const liveNetworkRoutes: LiveJourneySegment['lineRoutes'] = feed.network && rawRouteId
    ? networkRoutesForRoute(feed.network, rawRouteId, 'gtfs_shape').map((route) => ({
      id: `${leg.providerId}:${route.id}`,
      providerId: leg.providerId!,
      routeId: rawRouteId,
      name: route.name,
      direction: route.direction,
      directionId: route.directionId ?? null,
      geometrySource: 'gtfs_shape' as const,
      geometryScope: 'full_route' as const,
      zones: null,
      coordinates: route.coordinates,
    }))
    : emptyRoutes;
  const scheduledRoute: LiveJourneySegment['lineRoutes'][number] | null = hasTrustedStoredGeometry && routeId && geometrySource ? {
    id: `${leg.providerId}:${routeId}:scheduled`,
    providerId: leg.providerId,
    routeId,
    name: typeof leg.metadata.routeName === 'string' ? leg.metadata.routeName : routeId,
    direction: typeof leg.metadata.headsign === 'string' && leg.metadata.headsign ? leg.metadata.headsign : 'Напрямок сегмента',
    directionId: null,
    geometrySource: geometrySource as NonNullable<typeof geometrySource>,
    geometryScope: 'leg_only',
    zones: null,
    coordinates: storedGeometry,
  } : null;
  const lineRoutes = (liveNetworkRoutes.length > 0 ? liveNetworkRoutes : scheduledRoute ? [scheduledRoute] : emptyRoutes)
    .map((route) => ({ ...route, zones: zonesFor(route) }));
  const vehicleProgress = fleet.map((item) => {
    const rawTripId = unscopeGtfsId(leg.providerId!, item.tripId);
    const rawVehicleRouteId = unscopeGtfsId(leg.providerId!, item.routeId);
    const rawVehicleServiceDate = item.startDate?.replaceAll('-', '') ?? null;
    const trip = rawTripId ? feed.timetable?.trips.get(rawTripId) : undefined;
    const tripMatchesRouteAndSelectedInstance = Boolean(item.tripId && item.routeId
      && rawTripId && rawRouteId && rawVehicleRouteId === rawRouteId && trip && trip.routeId === rawRouteId
      && (!rawVehicleServiceDate || rawVehicleServiceDate === rawServiceDate));
    const tripStops = rawTripId ? feed.timetable?.stopTimes.get(rawTripId) ?? [] : [];
    const stopArrival = tripMatchesRouteAndSelectedInstance && feed.timetable && rawTripId && rawRouteId && rawServiceDate && rawBoardingStopId
      ? getGtfsTripStopArrival(feed.timetable, rawTripId, rawRouteId, rawServiceDate, rawBoardingStopId, new Date(now))
      : { status: 'UNAVAILABLE' as const };
    const positionIsInSelectedTripWindow = isJourneyLegGpsWindowOpen(
      leg.scheduledDepartureAt, leg.scheduledArrivalAt, item.timestamp?.getTime() ?? Number.NaN,
    );
    const tripMatchesRoute = Boolean(tripMatchesRouteAndSelectedInstance
      && (rawVehicleServiceDate === rawServiceDate
        || (!rawVehicleServiceDate && positionIsInSelectedTripWindow && stopArrival.status === 'PREDICTED')));
    const progress = tripMatchesRoute
      ? approachingBoardingStop(leg.providerId!, item, boardingStopId,
        tripStops.map((stop) => ({ stopId: stop.sourceStopId ?? stop.stopId, sequence: stop.sequence })))
      : null;
    const etaSeconds = stopArrival.status === 'PREDICTED' && stopArrival.predictedArrivalAt
      && stopArrival.predictedArrivalAt.getTime() > now
      ? Math.ceil((stopArrival.predictedArrivalAt.getTime() - now) / 1000) : null;
    // Exact fresh stop progress is sufficient observed evidence. A prediction
    // without observed progress needs a fresh exact dated future stop update.
    const progressApproaches = progress?.approaching === true;
    const predictedApproach = tripMatchesRoute && etaSeconds !== null && progress?.approaching !== false
      && stopArrival.status === 'PREDICTED';
    const approachEvidence: LiveJourneySegment['vehicles'][number]['approachEvidence'] = progressApproaches && progress
      && !stopArrival.approachBlocked
      ? {
        source: 'OBSERVED_PROGRESS',
        ...(stopArrival.predictedArrivalAt && etaSeconds !== null ? { predictedArrivalAt: stopArrival.predictedArrivalAt.toISOString() } : {}),
        ...(stopArrival.realtimeUpdatedAt ? { realtimeUpdatedAt: stopArrival.realtimeUpdatedAt.toISOString() } : {}),
        remainingStops: progress.remainingStops,
        ...(Number.isInteger(item.currentStopSequence) ? { currentStopSequence: item.currentStopSequence } : {}),
        ...(item.currentStopId ? { currentStopId: item.currentStopId } : {}),
      }
      : predictedApproach && stopArrival.predictedArrivalAt && stopArrival.realtimeUpdatedAt
        ? {
          source: 'TRIP_UPDATE_PREDICTION',
          predictedArrivalAt: stopArrival.predictedArrivalAt.toISOString(),
          realtimeUpdatedAt: stopArrival.realtimeUpdatedAt.toISOString(),
        }
        : null;
    const approaching = Boolean(approachEvidence);
    // An explicit directionId comparison is authoritative: a vehicle on the reverse trip can
    // show stop-sequence progress toward the same physical stop and still be going away.
    // Stop-sequence progress only proves the direction when the feed omits direction ids.
    const vehicleDirectionId = trip?.directionId ?? null;
    const direction: 'MATCHING' | 'OPPOSITE' | 'UNKNOWN' = legTripDirection && vehicleDirectionId
      ? (legTripDirection === vehicleDirectionId ? 'MATCHING' : 'OPPOSITE')
      : progress ? 'MATCHING' : 'UNKNOWN';
    const servesBoardingStop = tripMatchesRoute && rawBoardingStopId
      ? tripStops.some((stop) => unscopeGtfsId(leg.providerId!, stop.stopId) === rawBoardingStopId)
      : false;
    const priority = classifyVehiclePriority({
      fresh: true,
      sameRoute: true,
      direction,
      servesBoardingStop,
      passedBoardingStop: progress?.approaching === false,
      approaching,
      remainingStops: approaching && progress?.approaching ? progress.remainingStops : null,
      etaSeconds: approachEvidence ? etaSeconds : null,
    });
    return { item, progress, approaching, approachEvidence,
      etaSeconds: approachEvidence ? etaSeconds : null,
      directionId: tripMatchesRoute ? trip?.directionId ?? null : null,
      priority,
      etaConfidence: approachEvidence?.source === 'OBSERVED_PROGRESS' ? 'OBSERVED' as const
        : approachEvidence?.source === 'TRIP_UPDATE_PREDICTION' ? 'PREDICTED' as const : 'NONE' as const };
  });
  const emphasizedIds = selectBoardingApproachVehicleIds(vehicleProgress.map(({ item, progress, approaching, approachEvidence, etaSeconds }) => ({
    vehicleId: item.id,
    approaching,
    evidence: approachEvidence?.source ?? null,
    etaSeconds,
    remainingStops: progress?.approaching ? progress.remainingStops : null,
  })));
  const vehicles: LiveJourneySegment['vehicles'] = vehicleProgress.flatMap(({ item, progress, directionId,
    approaching, approachEvidence, etaSeconds, priority, etaConfidence }) => {
    if (!item.timestamp) return [];
    return [{
      id: item.id,
      providerId: leg.providerId!,
      coordinates: [item.lon, item.lat] as [number, number],
      bearing: item.bearing,
      speed: item.speed,
      updatedAt: item.timestamp.toISOString(),
      tripId: item.tripId ?? null,
      routeId: item.routeId ?? null,
      directionId,
      approachingBoarding: approaching,
      remainingStops: approaching && progress?.approaching ? progress.remainingStops : null,
      emphasized: emphasizedIds.has(item.id),
      priority,
      etaConfidence,
      approachEvidence,
      etaSeconds,
    }];
  });

  // A fresh vehicle on the same route is not proof that this selected trip is
  // live. A different trip instance or direction must not promote a scheduled
  // itinerary when no vehicle matches its exact identity.
  if (!selectedVehicle) {
    return {
      legId: leg.id,
      status: lineRoutes.length > 0 ? 'SCHEDULED' : 'UNVERIFIED',
      vehiclePositionStatus: 'UNAVAILABLE',
      boardingStopArrival,
      ...(feed.vehicles
        ? { reason: 'no_fresh_matching_vehicle' as const }
        : lineRoutes.length === 0 ? { reason: 'provider_unavailable' as const } : {}),
      lineRoutes,
      vehicles,
    };
  }
  return {
    legId: leg.id,
    status: 'LIVE',
    vehiclePositionStatus: selectedVehicle?.timestamp ? 'OBSERVED' : 'UNAVAILABLE',
    boardingStopArrival,
    ...(selectedVehicle?.timestamp ? { vehicle: {
      coordinates: [selectedVehicle.lon, selectedVehicle.lat],
      bearing: selectedVehicle.bearing,
      speed: selectedVehicle.speed,
      route: typeof leg.metadata.routeName === 'string' ? leg.metadata.routeName : selectedVehicle.route,
      updatedAt: selectedVehicle.timestamp.toISOString(),
    } } : {}),
    lineRoutes,
    vehicles,
  };
}
