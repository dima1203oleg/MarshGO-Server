import type { OsmBikeRentalFeature, NormalizedOsmBikeRental } from './osmBikeRentals';

export interface OsmBikeAuditFeatureProperties extends Omit<NormalizedOsmBikeRental,'geometry'> {
  cityAssignmentMethod: 'OSM_ADDRESS_TAG' | 'OSM_SETTLEMENT_BOUNDARY' | 'NEAREST_OSM_SETTLEMENT' | 'UNKNOWN';
  cityDistanceMeters: number | null;
  regionAssignmentMethod: 'OSM_ADDRESS_TAG' | 'OSM_ADMIN_LEVEL_4_BOUNDARY' | 'UNKNOWN';
}

export interface OsmBikeAudit {
  generatedAt: string;
  totalRentalLocations: number;
  byProvider: Array<{ providerId: string; count: number; pickupConfirmed: number; dropoffConfirmed: number }>;
  byCity: Array<{ city: string; count: number }>;
  byRegion: Array<{ region: string; count: number }>;
  byCityAssignment: Array<{ method: string; count: number }>;
  byRegionAssignment: Array<{ method: string; count: number }>;
  byRentalModel: Array<{ model: string; count: number }>;
  byRawOperator: Array<{ operator: string; count: number }>;
  byRawNetwork: Array<{ network: string; count: number }>;
  byOperatorNetworkCity: Array<{ providerId: string; operator: string; network: string; city: string; count: number; pickupConfirmed: number; dropoffConfirmed: number }>;
  features: Array<{ type: 'Feature'; id: string; geometry: Record<string, unknown>; properties: OsmBikeAuditFeatureProperties }>;
}

function sortedCounts(values: Iterable<string | null | undefined>, unknownLabel: string) {
  const counts = new Map<string, number>();
  for (const value of values) { const key = value?.trim() || unknownLabel; counts.set(key, (counts.get(key) ?? 0) + 1); }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a,b) => b.count-a.count || a.name.localeCompare(b.name));
}

type Point = [number, number];
type Area = { properties: Record<string, unknown>; geometry: Record<string, unknown> };
type EnrichedOsmBikeRental = NormalizedOsmBikeRental & Pick<OsmBikeAuditFeatureProperties,'cityAssignmentMethod' | 'cityDistanceMeters' | 'regionAssignmentMethod'>;

function named(properties: Record<string, unknown>): string | null {
  for (const key of ['name:uk','name','name:en','name:ru']) if (typeof properties[key] === 'string' && (properties[key] as string).trim()) return (properties[key] as string).trim();
  return null;
}

function pointFromGeometry(geometry: Record<string, unknown>): Point | null {
  const type = geometry.type;
  const coordinates = geometry.coordinates;
  if (type === 'Point' && Array.isArray(coordinates) && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') return [coordinates[0], coordinates[1]];
  const rings = type === 'Polygon' ? [coordinates] : type === 'MultiPolygon' ? coordinates : type === 'LineString' ? [coordinates] : type === 'MultiLineString' ? coordinates : [];
  if (!Array.isArray(rings)) return null;
  const ring = type === 'Polygon' ? rings[0] : type === 'MultiPolygon' ? (Array.isArray(rings[0]) ? rings[0][0] : null) : type === 'LineString' ? rings[0] : Array.isArray(rings[0]) ? rings[0][0] : null;
  if (!Array.isArray(ring)) return null;
  const coords = ring.filter((entry): entry is number[] => Array.isArray(entry) && typeof entry[0] === 'number' && typeof entry[1] === 'number');
  if (!coords.length) return null;
  const openRing = coords.length > 1 && coords[0]?.[0] === coords.at(-1)?.[0] && coords[0]?.[1] === coords.at(-1)?.[1] ? coords.slice(0,-1) : coords;
  return [openRing.reduce((sum, entry) => sum + entry[0]!, 0) / openRing.length, openRing.reduce((sum, entry) => sum + entry[1]!, 0) / openRing.length];
}

function pointInRing(point: Point, ring: unknown): boolean {
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

function pointInPolygon(point: Point, polygon: unknown): boolean {
  if (!Array.isArray(polygon)) return false;
  const [outer, ...holes] = polygon;
  return pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole));
}

function pointInGeometry(point: Point, geometry: Record<string, unknown>): boolean {
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));
  return false;
}

function ringArea(ring: unknown): number {
  if (!Array.isArray(ring) || ring.length < 4) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    if (Array.isArray(a) && Array.isArray(b) && typeof a[0] === 'number' && typeof a[1] === 'number' && typeof b[0] === 'number' && typeof b[1] === 'number') sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum / 2);
}

function geometryArea(geometry: Record<string, unknown>): number {
  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) return ringArea(geometry.coordinates[0]);
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) return Math.min(...geometry.coordinates.map((polygon) => Array.isArray(polygon) ? ringArea(polygon[0]) : Number.POSITIVE_INFINITY));
  return Number.POSITIVE_INFINITY;
}

function distanceMeters(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const lat1 = a[1] * rad, lat2 = b[1] * rad;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat/2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

function isPolygon(geometry: Record<string, unknown>): boolean { return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon'; }

function assignGeography(records: NormalizedOsmBikeRental[], administrativeFeatures: OsmBikeRentalFeature[]): EnrichedOsmBikeRental[] {
  const areas: Area[] = administrativeFeatures.flatMap((feature) => {
    const properties = feature.properties;
    const geometry = feature.geometry;
    return properties && geometry && isPolygon(geometry as Record<string,unknown>) ? [{ properties, geometry: geometry as Record<string,unknown> }] : [];
  });
  const regionAreas = areas.filter((area) => area.properties.boundary === 'administrative' && String(area.properties.admin_level) === '4' && named(area.properties));
  const settlementAreas = areas.filter((area) => ['city','town'].includes(String(area.properties.place)) && named(area.properties));
  const settlementPoints = administrativeFeatures.flatMap((feature) => {
    const properties = feature.properties;
    const geometry = feature.geometry as Record<string,unknown> | null | undefined;
    const name = properties ? named(properties) : null;
    const point = geometry ? pointFromGeometry(geometry) : null;
    return properties && name && ['city','town'].includes(String(properties.place)) && geometry?.type === 'Point' && point ? [{name, point}] : [];
  });

  return records.map((row) => {
    const point = pointFromGeometry(row.geometry);
    let city = row.city;
    let cityAssignmentMethod: OsmBikeAuditFeatureProperties['cityAssignmentMethod'] = city ? 'OSM_ADDRESS_TAG' : 'UNKNOWN';
    let cityDistanceMeters: number | null = null;
    if (!city && point) {
      const containing = settlementAreas.filter((area) => pointInGeometry(point, area.geometry)).sort((a,b) => geometryArea(a.geometry) - geometryArea(b.geometry));
      const areaName = containing[0] ? named(containing[0].properties) : null;
      if (areaName) { city = areaName; cityAssignmentMethod = 'OSM_SETTLEMENT_BOUNDARY'; }
      else {
        const nearest = settlementPoints.map((settlement) => ({ ...settlement, distance: distanceMeters(point, settlement.point) })).sort((a,b) => a.distance - b.distance)[0];
        if (nearest && nearest.distance <= 5_000) { city = nearest.name; cityDistanceMeters = Math.round(nearest.distance); cityAssignmentMethod = 'NEAREST_OSM_SETTLEMENT'; }
      }
    }
    let region = row.region;
    let regionAssignmentMethod: OsmBikeAuditFeatureProperties['regionAssignmentMethod'] = region ? 'OSM_ADDRESS_TAG' : 'UNKNOWN';
    if (!region && point) {
      const containing = regionAreas.filter((area) => pointInGeometry(point, area.geometry)).sort((a,b) => geometryArea(a.geometry) - geometryArea(b.geometry));
      const areaName = containing[0] ? named(containing[0].properties) : null;
      if (areaName) { region = areaName; regionAssignmentMethod = 'OSM_ADMIN_LEVEL_4_BOUNDARY'; }
    }
    return { ...row, city, region, cityAssignmentMethod, cityDistanceMeters, regionAssignmentMethod };
  });
}

export function buildOsmBikeAudit(records: NormalizedOsmBikeRental[], generatedAt = new Date(), administrativeFeatures: OsmBikeRentalFeature[] = []): OsmBikeAudit {
  const enriched = assignGeography(records, administrativeFeatures);
  const providerCounts = new Map<string, { count: number; pickupConfirmed: number; dropoffConfirmed: number }>();
  for (const row of enriched) {
    const count = providerCounts.get(row.providerId) ?? { count: 0, pickupConfirmed: 0, dropoffConfirmed: 0 };
    count.count++;
    if (row.pickupAllowed === true) count.pickupConfirmed++;
    if (row.dropoffAllowed === true) count.dropoffConfirmed++;
    providerCounts.set(row.providerId, count);
  }
  const cities = sortedCounts(enriched.map((row) => row.city), 'Місто не встановлене');
  const regions = sortedCounts(enriched.map((row) => row.region), 'Область не встановлена');
  const cityMethods = sortedCounts(enriched.map((row) => row.cityAssignmentMethod), 'UNKNOWN');
  const regionMethods = sortedCounts(enriched.map((row) => row.regionAssignmentMethod), 'UNKNOWN');
  const rentalModels = sortedCounts(enriched.map((row) => row.rentalModel), 'Модель не встановлена');
  const operators = sortedCounts(enriched.map((row) => row.operator), 'operator відсутній');
  const networks = sortedCounts(enriched.map((row) => row.network), 'network відсутній');
  const locationGroups = new Map<string, OsmBikeAudit['byOperatorNetworkCity'][number]>();
  for (const row of enriched) {
    const operator = row.operator ?? row.brand ?? 'оператор не вказаний';
    const network = row.network ?? 'мережа не вказана';
    const city = row.city ?? 'місто не встановлене';
    const key = JSON.stringify([row.providerId, operator, network, city]);
    const group = locationGroups.get(key) ?? { providerId: row.providerId, operator, network, city, count: 0, pickupConfirmed: 0, dropoffConfirmed: 0 };
    group.count++;
    if (row.pickupAllowed === true) group.pickupConfirmed++;
    if (row.dropoffAllowed === true) group.dropoffConfirmed++;
    locationGroups.set(key, group);
  }
  return {
    generatedAt: generatedAt.toISOString(), totalRentalLocations: enriched.length,
    byProvider: [...providerCounts].map(([providerId, counts]) => ({ providerId, ...counts })).sort((a,b) => b.count-a.count || a.providerId.localeCompare(b.providerId)),
    byCity: cities.map(({name: city,count}) => ({ city,count })),
    byRegion: regions.map(({name: region,count}) => ({ region,count })),
    byCityAssignment: cityMethods.map(({name: method,count}) => ({ method,count })),
    byRegionAssignment: regionMethods.map(({name: method,count}) => ({ method,count })),
    byRentalModel: rentalModels.map(({name: model,count}) => ({ model,count })),
    byRawOperator: operators.map(({name: operator,count}) => ({ operator,count })),
    byRawNetwork: networks.map(({name: network,count}) => ({ network,count })),
    byOperatorNetworkCity: [...locationGroups.values()].sort((a,b) => b.count-a.count || a.operator.localeCompare(b.operator) || a.city.localeCompare(b.city)),
    features: enriched.map(({ geometry, ...properties }) => ({ type: 'Feature', id: properties.externalId, geometry, properties })),
  };
}

export function renderOsmBikeAuditMarkdown(audit: OsmBikeAudit, sourceName: string): string {
  const rows = audit.byOperatorNetworkCity.map((row) => `| ${row.operator.replaceAll('|','\\|')} (${row.providerId}) | ${row.network.replaceAll('|','\\|')} | ${row.city.replaceAll('|','\\|')} | ${row.count} | 0 | ${row.pickupConfirmed} | ${row.dropoffConfirmed} | OSM / ${sourceName} | ${audit.generatedAt} |`).join('\n');
  const cityRows = audit.byCity.map((row) => `| ${row.city} | ${row.count} |`).join('\n');
  const regionRows = audit.byRegion.map((row) => `| ${row.region} | ${row.count} |`).join('\n');
  const cityMethodRows = audit.byCityAssignment.map((row) => `| ${row.method} | ${row.count} |`).join('\n');
  const regionMethodRows = audit.byRegionAssignment.map((row) => `| ${row.method} | ${row.count} |`).join('\n');
  const operatorRows = audit.byRawOperator.map((row) => `| ${row.operator.replaceAll('|','\\|')} | ${row.count} |`).join('\n');
  const networkRows = audit.byRawNetwork.map((row) => `| ${row.network.replaceAll('|','\\|')} | ${row.count} |`).join('\n');
  return `# BIKE_RENTAL_UKRAINE_AUDIT\n\n`+
    `Generated: ${audit.generatedAt}\n\nSource: ${sourceName} (full Geofabrik Ukraine OSM PBF). `+
    `Rows include only positive bicycle-rental service tags; ordinary bicycle parking is excluded.\n\n`+
    `## Summary\n\n- Rental objects found: **${audit.totalRentalLocations}**\n- Live inventory records: **0** (OSM is static)\n- Pickup rights confirmed: **${audit.byProvider.reduce((total,row)=>total+row.pickupConfirmed,0)}**\n- Drop-off rights confirmed: **${audit.byProvider.reduce((total,row)=>total+row.dropoffConfirmed,0)}**\n- OSM import does not establish one-way return rights, current stock, or shared networks.\n\n`+
    `## Provider audit\n\n| operator | network | city | total_locations | live_locations | pickup_confirmed | dropoff_confirmed | source | last_updated |\n|---|---|---|---:|---:|---:|---:|---|---|\n${rows}\n\n`+
    `## Counts by settlement\n\n| Settlement | Count |\n|---|---:|\n${cityRows}\n\n`+
    `## Counts by oblast or region\n\n| Region | Count |\n|---|---:|\n${regionRows}\n\n`+
    `## Geography assignment method\n\n| Method | Count |\n|---|---:|\n${cityMethodRows}\n\n`+
    `| Region method | Count |\n|---|---:|\n${regionMethodRows}\n\n`+
    `## Raw OSM operator names\n\n| OSM operator | Count |\n|---|---:|\n${operatorRows}\n\n`+
    `## Raw OSM network names\n\n| OSM network | Count |\n|---|---:|\n${networkRows}\n\n`+
    `## Source limitations\n\nProvider names stay unknown unless verified by an operator, network, brand, or official domain tag. `+
    `City fallback uses a containing OSM city/town boundary, then a nearest city/town point within 5 km; assignment methods and distances are included in the export. `+
    `No cross-provider return compatibility is inferred. Attribution: © OpenStreetMap contributors, ODbL 1.0.\n`;
}

export function renderOsmBikeAuditCsv(audit: OsmBikeAudit): string {
  const columns = ['external_id','object_type','provider_id','operator','network','brand','name','city','city_assignment_method','city_distance_meters','region','region_assignment_method','latitude','longitude','postcode','address','ref','ref:gbfs','rental_model','rental_type','capacity','opening_hours','access','website','phone','pickup_allowed','dropoff_allowed','availability','source','attribution','raw_tags'];
  const escape = (raw: unknown) => `"${String(raw ?? '').replaceAll('"','""')}"`;
  return [columns.join(','), ...audit.features.map(({geometry,properties}) => columns.map((column) => {
    const key = ({ external_id:'externalId', object_type:'objectType', provider_id:'providerId', city_assignment_method:'cityAssignmentMethod', city_distance_meters:'cityDistanceMeters', region_assignment_method:'regionAssignmentMethod', rental_model:'rentalModel', rental_type:'rentalType', opening_hours:'openingHours', pickup_allowed:'pickupAllowed', dropoff_allowed:'dropoffAllowed', 'ref:gbfs':'refGbfs', raw_tags:'rawTags' } as Record<string,string>)[column];
    const coordinates = pointFromGeometry(geometry);
    const value = column === 'source' ? 'OpenStreetMap' : column === 'attribution' ? '© OpenStreetMap contributors, ODbL 1.0'
      : column === 'longitude' ? coordinates?.[0] : column === 'latitude' ? coordinates?.[1]
        : (properties as unknown as Record<string,unknown>)[key ?? column];
    return escape(value && typeof value === 'object' ? JSON.stringify(value) : value);
  }).join(','))].join('\n') + '\n';
}
