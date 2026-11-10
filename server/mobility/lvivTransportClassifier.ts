/** Evidence-backed distinction between a bus service and a marshrutka. */
export type LvivClassifiedBusType = 'bus' | 'marshrutka' | 'bus_unspecified';
export type LvivClassificationEvidenceLevel = 'GTFS_TYPE' | 'NAME_MARKER' | 'UNRESOLVED';
export type LvivClassificationReviewStatus = 'AUTO' | 'REVIEW_REQUIRED';

export interface LvivTransportClassification {
  classifiedType: LvivClassifiedBusType;
  serviceClass: 'BUS' | 'MARSHRUTKA' | 'UNRESOLVED';
  vehicleClass: null;
  evidenceLevel: LvivClassificationEvidenceLevel;
  evidenceSource: string;
  confidence: number;
  reviewStatus: LvivClassificationReviewStatus;
}

const MARSHRUTKA_NAME = /(?:^|[^а-яіїєґa-z0-9])(?:маршрутка|маршрутне\s+таксі|marshrutka|minibus)(?:$|[^а-яіїєґa-z0-9])/u;
const BUS_NAME = /(?:^|[^а-яіїєґa-z0-9])(?:автобус|bus)(?:$|[^а-яіїєґa-z0-9])/u;
const TROLLEYBUS_NAME = /тролейбус|trolleybus|(?:^|\s)тр\.?\s*\d/u;

/**
 * Classify only the bus/minibus family. Generic GTFS route_type=3 is not a
 * bus-vs-marshrutka decision; exact labels may resolve it but remain reviewable.
 * GTFS extended type 1501 is communal taxi service; the GTFS extension lists
 * marshrutka as an example. It is used here only when the route is actually
 * present in the schedule feed. Vehicle size is deliberately never inferred.
 */
export function classifyLvivTransport(input: { routeType: number; routeName?: string }): LvivTransportClassification | null {
  const name = (input.routeName ?? '').normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
  if (TROLLEYBUS_NAME.test(name)) return null;

  if (input.routeType === 1501) return {
    classifiedType: 'marshrutka', serviceClass: 'MARSHRUTKA', vehicleClass: null,
    evidenceLevel: 'GTFS_TYPE', evidenceSource: 'GTFS route_type=1501 (extended communal taxi class)',
    confidence: 0.95, reviewStatus: 'REVIEW_REQUIRED',
  };

  if (input.routeType >= 700 && input.routeType < 800) return {
    classifiedType: 'bus', serviceClass: 'BUS', vehicleClass: null,
    evidenceLevel: 'GTFS_TYPE', evidenceSource: `GTFS route_type=${input.routeType} (extended bus class)`,
    confidence: 0.95, reviewStatus: 'AUTO',
  };
  if (input.routeType !== 3) return null;

  const marshrutkaName = MARSHRUTKA_NAME.test(name);
  const busName = BUS_NAME.test(name);
  if (marshrutkaName && !busName) return {
    classifiedType: 'marshrutka', serviceClass: 'MARSHRUTKA', vehicleClass: null,
    evidenceLevel: 'NAME_MARKER', evidenceSource: 'GTFS route name contains an exact marshrutka/minibus marker',
    confidence: 0.8, reviewStatus: 'REVIEW_REQUIRED',
  };
  if (busName && !marshrutkaName) return {
    classifiedType: 'bus', serviceClass: 'BUS', vehicleClass: null,
    evidenceLevel: 'NAME_MARKER', evidenceSource: 'GTFS route name contains an explicit bus marker',
    confidence: 0.75, reviewStatus: 'REVIEW_REQUIRED',
  };

  return {
    classifiedType: 'bus_unspecified', serviceClass: 'UNRESOLVED', vehicleClass: null,
    evidenceLevel: 'UNRESOLVED', evidenceSource: marshrutkaName && busName
      ? 'GTFS type and route name contain conflicting service markers'
      : 'GTFS route_type=3 does not distinguish bus from marshrutka',
    confidence: 0.4, reviewStatus: 'REVIEW_REQUIRED',
  };
}
