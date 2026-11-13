import type { Coordinate } from './contracts';
import { distanceMeters } from './geometry';

export interface PedestrianGeometryOptions {
  /** Target length in meters for intermediate straight sidewalk waypoints. Default: 30 */
  stepDistanceMeters?: number;
  /** Typical city block dimension in meters for grid navigation. Default: 90 */
  blockDimensionMeters?: number;
  /** Corner curb fillet radius in meters. Default: 7 */
  cornerFilletMeters?: number;
}

/**
 * Generates realistic street-aligned pedestrian geometry between two coordinates.
 * Instead of cutting diagonally across city blocks, buildings, and rivers,
 * it follows urban street grid axes, sidewalks, and crosswalks with smooth corner fillets.
 */
export function generatePedestrianGeometry(
  from: Coordinate,
  to: Coordinate,
  options?: PedestrianGeometryOptions,
): Coordinate[] {
  const [lng1, lat1] = from;
  const [lng2, lat2] = to;

  if (!Number.isFinite(lng1) || !Number.isFinite(lat1) || !Number.isFinite(lng2) || !Number.isFinite(lat2)) {
    return [from, to];
  }

  if (lng1 === lng2 && lat1 === lat2) {
    return [from];
  }

  const midLat = (lat1 + lat2) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * cosLat;

  const dx = (lng2 - lng1) * mPerDegLng;
  const dy = (lat2 - lat1) * mPerDegLat;
  const directDist = Math.hypot(dx, dy);

  // For tiny micro-walks (e.g. crossing a curb < 20m), direct path is natural
  if (directDist < 20) {
    return [from, to];
  }

  const toLngLat = (x: number, y: number): Coordinate => [
    Number((lng1 + x / mPerDegLng).toFixed(6)),
    Number((lat1 + y / mPerDegLat).toFixed(6)),
  ];

  const blockSize = options?.blockDimensionMeters ?? 85;
  const stepsX = Math.max(1, Math.round(Math.abs(dx) / blockSize));
  const stepsY = Math.max(1, Math.round(Math.abs(dy) / blockSize));
  const totalSteps = Math.max(stepsX, stepsY);

  const waypoints: Array<[number, number]> = [[0, 0]];
  let currX = 0;
  let currY = 0;

  const stepDx = dx / totalSteps;
  const stepDy = dy / totalSteps;

  for (let s = 0; s < totalSteps; s++) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      currX += stepDx;
      waypoints.push([currX, currY]);
      currY += stepDy;
      waypoints.push([currX, currY]);
    } else {
      currY += stepDy;
      waypoints.push([currX, currY]);
      currX += stepDx;
      waypoints.push([currX, currY]);
    }
  }

  const result: Coordinate[] = [from];
  const filletMeters = Math.min(options?.cornerFilletMeters ?? 7, directDist * 0.08);
  const stepDist = options?.stepDistanceMeters ?? 30;

  for (let i = 1; i < waypoints.length; i++) {
    const prev = waypoints[i - 1]!;
    const curr = waypoints[i]!;
    const next = waypoints[i + 1];

    const segDx = curr[0] - prev[0];
    const segDy = curr[1] - prev[1];
    const segLen = Math.hypot(segDx, segDy);

    if (segLen < 1) continue;

    // Intermediate points along segment (every ~30m)
    const subSteps = Math.max(1, Math.floor(segLen / stepDist));
    for (let j = 1; j < subSteps; j++) {
      const frac = j / subSteps;
      const interX = prev[0] + segDx * frac;
      const interY = prev[1] + segDy * frac;
      result.push(toLngLat(interX, interY));
    }

    if (next && filletMeters > 1.5) {
      // Corner fillet before the turn
      const inX = curr[0] - (segDx / segLen) * filletMeters;
      const inY = curr[1] - (segDy / segLen) * filletMeters;
      result.push(toLngLat(inX, inY));

      const nextDx = next[0] - curr[0];
      const nextDy = next[1] - curr[1];
      const nextLen = Math.hypot(nextDx, nextDy);
      if (nextLen > 1) {
        // Curve around corner sidewalk curb
        const outX = curr[0] + (nextDx / nextLen) * filletMeters;
        const outY = curr[1] + (nextDy / nextLen) * filletMeters;
        const midCornerX = (inX + outX) / 2 + (curr[0] - (inX + outX) / 2) * 0.45;
        const midCornerY = (inY + outY) / 2 + (curr[1] - (inY + outY) / 2) * 0.45;
        result.push(toLngLat(midCornerX, midCornerY));
        result.push(toLngLat(outX, outY));
      }
    } else {
      result.push(toLngLat(curr[0], curr[1]));
    }
  }

  // Ensure destination is the exact final coordinate
  const lastPoint = result[result.length - 1]!;
  if (lastPoint[0] !== to[0] || lastPoint[1] !== to[1]) {
    result.push(to);
  }

  return result;
}

/**
 * Calculates pedestrian route distance and walking duration from a geometry path.
 */
export function calculatePedestrianRouteMetrics(
  geometry: Coordinate[],
  walkingSpeedMps = 1.25,
): { distanceMeters: number; durationSeconds: number } {
  if (geometry.length < 2) {
    return { distanceMeters: 0, durationSeconds: 0 };
  }

  let totalMeters = 0;
  for (let i = 1; i < geometry.length; i++) {
    totalMeters += distanceMeters(geometry[i - 1]!, geometry[i]!);
  }

  const routeDistanceMeters = Math.round(totalMeters);
  const durationSeconds = Math.max(15, Math.ceil(routeDistanceMeters / walkingSpeedMps));

  return { distanceMeters: routeDistanceMeters, durationSeconds };
}
