export type RouteCoordinate = [number, number];

/** Accept only finite WGS84 route positions from an explicit provider/feed shape. */
export function sourceRouteGeometry(value: unknown): RouteCoordinate[] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const valid = value.every((point) => Array.isArray(point)
    && point.length === 2
    && Number.isFinite(point[0])
    && Number.isFinite(point[1])
    && point[0] >= -180 && point[0] <= 180
    && point[1] >= -90 && point[1] <= 90);
  return valid ? value as RouteCoordinate[] : undefined;
}
