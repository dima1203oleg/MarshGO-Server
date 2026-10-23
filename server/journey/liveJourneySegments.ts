import { networkRoutesForRoute, type LiveVehicle, type TransportNetwork } from '../mobility/transportLayers';
import { approachingBoardingStop, freshVehiclesForRoute, matchLiveVehicleForJourneyLeg, selectBoardingApproachVehicleIds, unscopeGtfsId } from './liveVehicles';

export interface LiveJourneyTripData {
  trips: Map<string, { routeId: string; directionId?: string }>;
  stopTimes: Map<string, Array<{ stopId: string; sourceStopId?: string; sequence: number }>>;
}

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
  timetable: LiveJourneyTripData | null;
}

export interface LiveJourneySegment {
  legId: string;
  status: 'LIVE' | 'SCHEDULED' | 'UNVERIFIED';
  reason?: 'provider_unavailable' | 'no_fresh_matching_vehicle';
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
  if (!leg.providerId) return { legId: leg.id, status: 'SCHEDULED', lineRoutes: emptyRoutes, vehicles: emptyFleet };
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
    return { legId: leg.id, status: 'UNVERIFIED', reason: 'provider_unavailable', lineRoutes: emptyRoutes, vehicles: emptyFleet };
  }

  const identity = {
    providerId: leg.providerId,
    tripId: typeof leg.metadata.tripId === 'string' ? leg.metadata.tripId : null,
    routeId: typeof leg.metadata.routeId === 'string' ? leg.metadata.routeId : null,
    serviceDate: typeof leg.metadata.serviceDate === 'string' ? leg.metadata.serviceDate : null,
    scheduledDepartureAt: leg.scheduledDepartureAt,
    scheduledArrivalAt: leg.scheduledArrivalAt,
  };
  const selectedVehicle = feed.vehicles ? matchLiveVehicleForJourneyLeg(identity, feed.vehicles, now) : null;
  const rawRouteId = unscopeGtfsId(leg.providerId, identity.routeId);
  const fleet = rawRouteId && feed.vehicles
    ? freshVehiclesForRoute(leg.providerId, rawRouteId, feed.vehicles, now)
    : [];
  const liveNetworkRoutes = feed.network && rawRouteId
    ? networkRoutesForRoute(feed.network, rawRouteId, 'gtfs_shape').map((route) => ({
      id: `${leg.providerId}:${route.id}`,
      providerId: leg.providerId!,
      routeId: rawRouteId,
      name: route.name,
      direction: route.direction,
      directionId: route.directionId ?? null,
      geometrySource: 'gtfs_shape' as const,
      coordinates: route.coordinates,
    }))
    : emptyRoutes;
  const lineRoutes: LiveJourneySegment['lineRoutes'] = liveNetworkRoutes.length > 0 ? liveNetworkRoutes
    : hasTrustedStoredGeometry && routeId && geometrySource ? [{
      id: `${leg.providerId}:${routeId}:scheduled`,
      providerId: leg.providerId,
      routeId,
      name: typeof leg.metadata.routeName === 'string' ? leg.metadata.routeName : routeId,
      direction: typeof leg.metadata.headsign === 'string' && leg.metadata.headsign ? leg.metadata.headsign : 'Напрямок сегмента',
      directionId: null,
      geometrySource: geometrySource as NonNullable<typeof geometrySource>,
      coordinates: storedGeometry,
    }] : emptyRoutes;

  const boardingStopId = typeof leg.metadata.fromStopFeedId === 'string' ? leg.metadata.fromStopFeedId : null;
  const vehicleProgress = fleet.map((item) => {
    const rawTripId = unscopeGtfsId(leg.providerId!, item.tripId);
    const trip = rawTripId ? feed.timetable?.trips.get(rawTripId) : undefined;
    const tripMatchesRoute = Boolean(trip && rawRouteId && trip.routeId === rawRouteId);
    const tripStops = rawTripId ? feed.timetable?.stopTimes.get(rawTripId) ?? [] : [];
    const serviceDateMatches = !item.startDate || !identity.serviceDate || item.startDate === identity.serviceDate;
    const progress = tripMatchesRoute && serviceDateMatches
      ? approachingBoardingStop(leg.providerId!, item, boardingStopId,
        tripStops.map((stop) => ({ stopId: stop.sourceStopId ?? stop.stopId, sequence: stop.sequence })))
      : null;
    return { item, progress, directionId: tripMatchesRoute ? trip?.directionId ?? null : null };
  });
  const emphasizedIds = selectBoardingApproachVehicleIds(vehicleProgress.map(({ item, progress }) => ({
    vehicleId: item.id,
    progress,
  })));
  const vehicles: LiveJourneySegment['vehicles'] = vehicleProgress.flatMap(({ item, progress, directionId }) => {
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
      approachingBoarding: progress?.approaching === true,
      remainingStops: progress?.approaching ? progress.remainingStops : null,
      emphasized: emphasizedIds.has(item.id),
    }];
  });

  if (!selectedVehicle && fleet.length === 0) {
    return {
      legId: leg.id,
      status: lineRoutes.length > 0 ? 'SCHEDULED' : 'UNVERIFIED',
      reason: feed.vehicles ? 'no_fresh_matching_vehicle' : 'provider_unavailable',
      lineRoutes,
      vehicles,
    };
  }
  return {
    legId: leg.id,
    status: 'LIVE',
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
