export type GeographicBbox = readonly [west: number, south: number, east: number, north: number];

function segmentIntersectsRectangle(
  start: readonly [number, number],
  end: readonly [number, number],
  rectangle: readonly [minX: number, minY: number, maxX: number, maxY: number],
): boolean {
  const [minX, minY, maxX, maxY] = rectangle;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  let enter = 0;
  let leave = 1;

  for (const [p, q] of [
    [-dx, start[0] - minX],
    [dx, maxX - start[0]],
    [-dy, start[1] - minY],
    [dy, maxY - start[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const intersection = q / p;
    if (p < 0) enter = Math.max(enter, intersection);
    else leave = Math.min(leave, intersection);
    if (enter > leave) return false;
  }
  return true;
}

/**
 * Tests a provider coverage box against a buffered straight search corridor.
 * The projection is locally equirectangular, which is accurate enough for
 * Ukraine-sized journey corridors and avoids loading every feed in a large
 * axis-aligned rectangle between distant cities.
 */
export function bboxIntersectsRouteCorridor(
  box: GeographicBbox,
  origin: readonly [longitude: number, latitude: number],
  destination: readonly [longitude: number, latitude: number],
  corridorWidthMeters: number,
): boolean {
  const [west, south, east, north] = box;
  const coordinates = [...box, ...origin, ...destination, corridorWidthMeters];
  if (!coordinates.every(Number.isFinite)
    || west < -180 || east > 180 || south < -90 || north > 90
    || west > east || south > north || corridorWidthMeters < 0 || corridorWidthMeters > 100_000
    || origin[0] < -180 || origin[0] > 180 || destination[0] < -180 || destination[0] > 180
    || origin[1] < -90 || origin[1] > 90 || destination[1] < -90 || destination[1] > 90) {
    return false;
  }

  const referenceLatitude = (origin[1] + destination[1]) / 2;
  const metersPerLongitude = 111_320 * Math.max(0.2, Math.cos(referenceLatitude * Math.PI / 180));
  const metersPerLatitude = 110_574;
  const rectangle = [
    (west - origin[0]) * metersPerLongitude - corridorWidthMeters,
    (south - origin[1]) * metersPerLatitude - corridorWidthMeters,
    (east - origin[0]) * metersPerLongitude + corridorWidthMeters,
    (north - origin[1]) * metersPerLatitude + corridorWidthMeters,
  ] as const;
  const routeEnd = [
    (destination[0] - origin[0]) * metersPerLongitude,
    (destination[1] - origin[1]) * metersPerLatitude,
  ] as const;
  return segmentIntersectsRectangle([0, 0], routeEnd, rectangle);
}
