export interface GbfsGeofenceRule {
  vehicleTypeIds: string[] | null;
  rideStartAllowed: boolean | null;
  rideEndAllowed: boolean | null;
  rideThroughAllowed: boolean | null;
  maximumSpeedKph: number | null;
  startAt: number | null;
  endAt: number | null;
}
export interface GbfsGeofence {
  id: string;
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
  rules: GbfsGeofenceRule[];
  startAt?: number | null;
  endAt?: number | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const timestamp = (raw: unknown): number | null => typeof raw === 'string' && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : null;

function parseRule(raw: unknown): GbfsGeofenceRule | null {
  if (!isObject(raw)) return null;
  return {
    // In GBFS, an omitted list applies to all vehicle types; an explicit [] matches none.
    vehicleTypeIds: Array.isArray(raw.vehicle_type_ids) ? raw.vehicle_type_ids.filter((value): value is string => typeof value === 'string') : null,
    rideStartAllowed: typeof raw.ride_start_allowed === 'boolean' ? raw.ride_start_allowed : null,
    rideEndAllowed: typeof raw.ride_end_allowed === 'boolean' ? raw.ride_end_allowed : null,
    rideThroughAllowed: typeof raw.ride_through_allowed === 'boolean' ? raw.ride_through_allowed : null,
    maximumSpeedKph: typeof raw.maximum_speed_kph === 'number' && raw.maximum_speed_kph >= 0 ? raw.maximum_speed_kph : null,
    startAt: timestamp(raw.start), endAt: timestamp(raw.end),
  };
}

function validRing(value: unknown): value is Array<[number, number]> {
  if (!Array.isArray(value) || value.length < 4) return false;
  const positions = value.every((position) => Array.isArray(position) && position.length >= 2
    && typeof position[0] === 'number' && Number.isFinite(position[0]) && Math.abs(position[0]) <= 180
    && typeof position[1] === 'number' && Number.isFinite(position[1]) && Math.abs(position[1]) <= 90);
  if (!positions) return false;
  const first = value[0] as number[], last = value[value.length - 1] as number[];
  return first[0] === last[0] && first[1] === last[1];
}

function validPolygon(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(validRing);
}

function validGeometry(type: unknown, coordinates: unknown): type is 'Polygon' | 'MultiPolygon' {
  return type === 'Polygon' ? validPolygon(coordinates)
    : type === 'MultiPolygon' ? Array.isArray(coordinates) && coordinates.length > 0 && coordinates.every(validPolygon)
      : false;
}

export function normalizeGeofencingZones(payload: unknown): { geofences: GbfsGeofence[]; globalRules: GbfsGeofenceRule[]; rejected: number } {
  const data = isObject(payload) && isObject(payload.data) ? payload.data : {};
  const featureCollection = data.geofencing_zones;
  const rawZones = Array.isArray(featureCollection) ? featureCollection
    : isObject(featureCollection) && Array.isArray(featureCollection.features) ? featureCollection.features : [];
  const globalRules = Array.isArray(data.global_rules) ? data.global_rules.map(parseRule).filter((rule): rule is GbfsGeofenceRule => rule !== null) : [];
  const geofences: GbfsGeofence[] = [];
  let rejected = 0;
  for (const [index, raw] of rawZones.entries()) {
    if (!isObject(raw) || !isObject(raw.geometry) || !validGeometry(raw.geometry.type, raw.geometry.coordinates) || !isObject(raw.properties)) { rejected++; continue; }
    const rules = Array.isArray(raw.properties.rules) ? raw.properties.rules.map(parseRule).filter((rule): rule is GbfsGeofenceRule => rule !== null) : [];
    if (!rules.length) { rejected++; continue; }
    geofences.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `zone-${index}`,
      geometry: { type: raw.geometry.type, coordinates: raw.geometry.coordinates }, rules,
      startAt: timestamp(raw.properties.start), endAt: timestamp(raw.properties.end),
    });
  }
  return { geofences, globalRules, rejected };
}

function pointInRing(point: [number, number], ring: unknown): boolean {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (!Array.isArray(a) || !Array.isArray(b) || typeof a[0] !== 'number' || typeof a[1] !== 'number' || typeof b[0] !== 'number' || typeof b[1] !== 'number') continue;
    const intersects = (a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInGeometry(point: [number, number], geometry: Record<string, unknown>): boolean {
  const inPolygon = (polygon: unknown) => {
    if (!Array.isArray(polygon)) return false;
    const [outer, ...holes] = polygon;
    return pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole));
  };
  if (geometry.type === 'Polygon') return inPolygon(geometry.coordinates);
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) return geometry.coordinates.some(inPolygon);
  return false;
}

/** GBFS order is authoritative: first applicable rule, then first applicable polygon; polygons override globals. */
export function geofenceRulesAt(snapshot: { geofences: GbfsGeofence[]; globalRules: GbfsGeofenceRule[] }, point: [number, number], vehicleTypeId: string, at = Date.now()) {
  const activeRule = (rule: GbfsGeofenceRule) => (rule.startAt === null || rule.startAt === undefined || at >= rule.startAt)
    && (rule.endAt === null || rule.endAt === undefined || at <= rule.endAt);
  const forVehicle = (rule: GbfsGeofenceRule) => rule.vehicleTypeIds === null || rule.vehicleTypeIds.includes(vehicleTypeId);
  const firstApplicable = (rules: GbfsGeofenceRule[]) => rules.find((rule) => activeRule(rule) && forVehicle(rule)) ?? null;
  const activeZone = snapshot.geofences.find((zone) => (zone.startAt == null || at >= zone.startAt)
    && (zone.endAt == null || at <= zone.endAt) && pointInGeometry(point, zone.geometry)
    && firstApplicable(zone.rules) !== null);
  const rule = activeZone ? firstApplicable(activeZone.rules) : firstApplicable(snapshot.globalRules);
  return {
    rideStartAllowed: rule?.rideStartAllowed ?? null,
    rideEndAllowed: rule?.rideEndAllowed ?? null,
    rideThroughAllowed: rule?.rideThroughAllowed ?? null,
    maximumSpeedKph: rule?.maximumSpeedKph ?? null,
    matchingRuleCount: rule ? 1 : 0,
  };
}

export function gbfsTimestamp(payload: unknown): number | null {
  if (!isObject(payload)) return null;
  const raw = payload.last_updated;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === 'string' && Number.isFinite(Date.parse(raw))) return Date.parse(raw);
  return null;
}
