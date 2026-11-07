import type { JourneyOption } from './types';
import type { WalkingRoutePath } from './walkingRoutes';
import { haversineDistanceMeters } from './intercityChain';

export type DirectWalkingCandidate = JourneyOption & {
  kind: 'walking';
  path: WalkingRoutePath;
};

export const MAX_DIRECT_WALK_CANDIDATE_STRAIGHT_LINE_METERS = 5_000;
export const MAX_DIRECT_WALK_ENDPOINT_SNAP_METERS = 15;

export function directWalkingGeometryConnectsEndpoints(input: {
  path: WalkingRoutePath;
  origin: [number, number];
  destination: [number, number];
}): boolean {
  const { path, origin, destination } = input;
  if (path.geometry.length < 2) return false;
  const first = path.geometry[0]!;
  const last = path.geometry.at(-1)!;
  if (haversineDistanceMeters(origin, first) > MAX_DIRECT_WALK_ENDPOINT_SNAP_METERS
    || haversineDistanceMeters(destination, last) > MAX_DIRECT_WALK_ENDPOINT_SNAP_METERS) return false;
  const geometryLengthMeters = path.geometry.slice(1).reduce((total, point, index) =>
    total + haversineDistanceMeters(path.geometry[index]!, point), 0);
  const roundingToleranceMeters = Math.max(2, path.distanceMeters * 0.01);
  return path.distanceMeters + roundingToleranceMeters >= geometryLengthMeters;
}

/** Build a ranking candidate only from a measured pedestrian route. */
export function createDirectWalkingCandidate(input: {
  id: string;
  path: WalkingRoutePath;
  origin: [number, number];
  destination: [number, number];
  maximumWalkingMeters?: number;
  maximumDurationSeconds?: number;
}): DirectWalkingCandidate | null {
  const { path } = input;
  if (!input.id.trim()
    || !Number.isSafeInteger(path.distanceMeters) || path.distanceMeters <= 0
    || !Number.isSafeInteger(path.durationSeconds) || path.durationSeconds <= 0
    || path.geometry.length < 2
    || path.geometry.some(([longitude, latitude]) => !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isFinite(latitude) || latitude < -90 || latitude > 90)) return null;
  if (!directWalkingGeometryConnectsEndpoints(input)) return null;
  if (input.maximumWalkingMeters !== undefined && path.distanceMeters > input.maximumWalkingMeters) return null;
  if (input.maximumDurationSeconds !== undefined && path.durationSeconds > input.maximumDurationSeconds) return null;

  return {
    id: input.id,
    diversityKey: 'walking-only',
    durationSeconds: path.durationSeconds,
    // Walking has no operator fare; zero is a known no-fare amount, not an unknown transit fare.
    priceMinor: 0,
    transfers: 0,
    walkingMeters: path.distanceMeters,
    reliability: null,
    transferRisk: 0,
    comfort: null,
    legs: [{ mode: 'WALK' }],
    kind: 'walking',
    path,
  };
}
