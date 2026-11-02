/**
 * Universal transport visualisation primitives (ТЗ-MG-VIZ-4).
 *
 * Both helpers are category-agnostic: they operate on a drawn polyline plus two
 * stop positions, or on an already-verified vehicle approach record. Nothing here
 * knows about trams specifically, so every line type that publishes a real route
 * shape gets the same treatment.
 */

export type ZonePoint = [number, number];

export interface RouteZoneSplit {
  boardingShapeIndex: number;
  alightingShapeIndex: number | null;
  /** Null when the boarding stop is the first vertex: nothing runs before it. */
  beforeBoarding: ZonePoint[] | null;
  passengerSegment: ZonePoint[];
  /** Null when the alighting stop is the last vertex or the trip end is unknown. */
  afterAlighting: ZonePoint[] | null;
  /** Snap distance actually used, so the client can state how certain the split is. */
  snapMeters: number;
}

const EARTH_RADIUS_M = 6_371_000;
/** Matches the projection tolerance already used when slicing trip shapes. */
export const ZONE_SNAP_LIMIT_METERS = 600;
const CANDIDATES_PER_STOP = 8;

function distanceMeters(a: ZonePoint, b: ZonePoint): number {
  const radians = (value: number) => (value * Math.PI) / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function nearestIndexes(coordinates: readonly ZonePoint[], point: ZonePoint): Array<{ index: number; distance: number }> {
  return coordinates
    .map((coordinate, index) => ({ index, distance: distanceMeters(coordinate, point) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, CANDIDATES_PER_STOP);
}

/**
 * Slice a drawn route line into the three zones at the passenger's boarding and
 * alighting stops. Returns null when the stops cannot be projected onto this
 * exact line, because a guessed split would draw a route the vehicle does not
 * run. When `alighting` is null only the boarding half of the split is produced
 * and zone B extends to the end of the line.
 */
export function splitRouteGeometryByStops(
  coordinates: readonly ZonePoint[],
  boarding: ZonePoint | null,
  alighting: ZonePoint | null,
  snapLimitMeters = ZONE_SNAP_LIMIT_METERS,
): RouteZoneSplit | null {
  if (coordinates.length < 2 || !boarding) return null;
  const starts = nearestIndexes(coordinates, boarding);

  if (alighting) {
    const ends = nearestIndexes(coordinates, alighting);
    let best: { start: number; end: number; distance: number } | undefined;
    for (const start of starts) for (const end of ends) {
      if (start.index >= end.index) continue;
      const distance = start.distance + end.distance;
      if (!best || distance < best.distance) best = { start: start.index, end: end.index, distance };
    }
    if (!best || best.distance > snapLimitMeters) return null;
    return {
      boardingShapeIndex: best.start,
      alightingShapeIndex: best.end,
      beforeBoarding: best.start > 0 ? coordinates.slice(0, best.start + 1) : null,
      passengerSegment: coordinates.slice(best.start, best.end + 1),
      afterAlighting: best.end < coordinates.length - 1 ? coordinates.slice(best.end) : null,
      snapMeters: Math.round(best.distance),
    };
  }

  const start = starts[0];
  if (!start || start.distance > snapLimitMeters) return null;
  return {
    boardingShapeIndex: start.index,
    alightingShapeIndex: null,
    beforeBoarding: start.index > 0 ? coordinates.slice(0, start.index + 1) : null,
    passengerSegment: coordinates.slice(start.index),
    afterAlighting: null,
    snapMeters: Math.round(start.distance),
  };
}

export type VehiclePriorityLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export type VehiclePriorityReason =
  | 'at_boarding_stop'
  | 'eta_under_3_minutes'
  | 'approaching_boarding_stop'
  | 'approaching_without_eta'
  | 'behind_boarding_stop'
  | 'opposite_direction'
  | 'direction_unverified'
  | 'not_serving_boarding_stop'
  | 'other_route'
  | 'stale_position';

/** L3 needs a confirmed short ETA; longer than this and the vehicle only counts as approaching. */
export const ARRIVING_SOON_MAX_ETA_SECONDS = 180;

export interface VehiclePriorityInput {
  fresh: boolean;
  sameRoute: boolean;
  /**
   * `MATCHING` means stop-sequence progress or an equal directionId places the
   * vehicle ahead of our boarding stop on the same run. `UNKNOWN` is never
   * promoted above L1, because an unverified direction is how oncoming vehicles
   * end up looking like the one about to arrive.
   */
  direction: 'MATCHING' | 'OPPOSITE' | 'UNKNOWN';
  /** The vehicle's trip does not call at the boarding stop at all. */
  servesBoardingStop: boolean;
  /** Stop-sequence progress says the vehicle already passed the boarding stop. */
  passedBoardingStop: boolean;
  /** Verified approach evidence: observed stop progress or a fresh dated prediction. */
  approaching: boolean;
  remainingStops: number | null;
  etaSeconds: number | null;
}

export interface VehiclePriority {
  level: VehiclePriorityLevel;
  reason: VehiclePriorityReason;
}

/**
 * Rank one vehicle of the selected line against the passenger's boarding stop.
 * Only verified facts raise a level: route identity, direction, stop sequence,
 * ETA evidence and GPS freshness. Everything unverifiable stays at L0/L1 so the
 * map never presents an irrelevant vehicle as the one that will arrive.
 */
export function classifyVehiclePriority(input: VehiclePriorityInput): VehiclePriority {
  if (!input.fresh) return { level: 'L0', reason: 'stale_position' };
  if (!input.sameRoute) return { level: 'L0', reason: 'other_route' };
  if (!input.servesBoardingStop) return { level: 'L1', reason: 'not_serving_boarding_stop' };
  if (input.direction === 'OPPOSITE') return { level: 'L1', reason: 'opposite_direction' };
  if (input.passedBoardingStop) return { level: 'L1', reason: 'behind_boarding_stop' };
  if (input.direction === 'UNKNOWN') return { level: 'L1', reason: 'direction_unverified' };
  if (!input.approaching) return { level: 'L1', reason: 'direction_unverified' };
  if (input.remainingStops === 0) return { level: 'L4', reason: 'at_boarding_stop' };
  if (input.etaSeconds !== null && input.etaSeconds <= ARRIVING_SOON_MAX_ETA_SECONDS) {
    return { level: 'L3', reason: 'eta_under_3_minutes' };
  }
  return input.etaSeconds === null
    ? { level: 'L2', reason: 'approaching_without_eta' }
    : { level: 'L2', reason: 'approaching_boarding_stop' };
}
