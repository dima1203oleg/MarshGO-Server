import { z } from 'zod';
export const coordinateSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export type Coordinate = z.infer<typeof coordinateSchema>; // longitude, latitude everywhere
export const instantSchema = z.iso.datetime({ offset: true });
export const locationFixSchema = z.object({
  longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90),
  accuracyMeters: z.number().nonnegative().max(10000), altitudeMeters: z.number().optional(),
  altitudeAccuracyMeters: z.number().nonnegative().optional(), headingDegrees: z.number().min(0).max(360).optional(),
  speedMps: z.number().nonnegative().max(150).optional(), capturedAtClient: instantSchema,
  receivedAtServer: instantSchema.optional(), source: z.enum(['gps','network','fused','simulated']),
});
export type LocationFix = z.infer<typeof locationFixSchema>;
export type MatchedLocation = LocationFix & { confidence: number; distanceFromRouteMeters: number; distanceAlongRouteMeters: number; matchingProvider: string };
export const maneuverSchema = z.object({
  id: z.string().min(1), type: z.enum(['DEPART','TURN','CONTINUE','MERGE','EXIT','ROUNDABOUT','UTURN','ARRIVE','PICKUP','DROPOFF']),
  modifier: z.enum(['LEFT','SLIGHT_LEFT','SHARP_LEFT','RIGHT','SLIGHT_RIGHT','SHARP_RIGHT','STRAIGHT','UTURN']).optional(),
  location: coordinateSchema, distanceMeters: z.number().nonnegative(), durationSeconds: z.number().nonnegative(),
  streetName: z.string().optional(), exitNumber: z.number().int().positive().optional(),
  bearingBefore: z.number().optional(), bearingAfter: z.number().optional(),
  lanes: z.array(z.object({ indications: z.array(z.string()), valid: z.boolean() })).optional(),
});
export type Maneuver = z.infer<typeof maneuverSchema>;
export const routeResultSchema = z.object({
  id: z.string().min(1), provider: z.string().min(1), providerRouteId: z.string().optional(),
  geometry: z.object({ encoding: z.literal('polyline6'), value: z.string().min(4).max(2000000).regex(/^[?-~]+$/) }),
  bounds: z.tuple([coordinateSchema, coordinateSchema]), distanceMeters: z.number().nonnegative(), durationSeconds: z.number().nonnegative(),
  durationWithoutTrafficSeconds: z.number().nonnegative().optional(), trafficDelaySeconds: z.number().nonnegative().optional(),
  trafficAware: z.boolean(), legs: z.array(z.object({ distanceMeters: z.number().nonnegative(), durationSeconds: z.number().nonnegative() })),
  maneuvers: z.array(maneuverSchema), confidence: z.enum(['BASELINE','ESTIMATED','TRAFFIC_AWARE','LIVE']),
  calculatedAt: instantSchema, routeVersion: z.number().int().positive(), mapDataVersion: z.string().optional(), providerDataVersion: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type RouteResult = z.infer<typeof routeResultSchema>;
export const vehicleProfileSchema = z.object({
  mode: z.enum(['CAR','TAXI','VAN','EV']), heightCm: z.number().positive().optional(), widthCm: z.number().positive().optional(), weightKg: z.number().positive().optional(),
  avoidTolls: z.boolean().optional(), avoidFerries: z.boolean().optional(), avoidUnpaved: z.boolean().optional(),
  ev: z.object({ batteryCapacityWh: z.number().positive().optional(), currentSocPercent: z.number().min(0).max(100).optional(), minimumArrivalSocPercent: z.number().min(0).max(100).optional() }).optional(),
});
export const routeRequestSchema = z.object({ origin: coordinateSchema, destination: coordinateSchema, waypoints: z.array(coordinateSchema).max(30).optional(),
  profile: vehicleProfileSchema, departureAt: instantSchema.optional(), alternatives: z.boolean().optional(), language: z.string().max(20).optional(), requestId: z.string().min(1).max(128) });
export type RouteRequest = z.infer<typeof routeRequestSchema>;
export type ProviderHealth = { status: 'HEALTHY'|'DEGRADED'|'UNAVAILABLE'; latencyMs?: number; checkedAt: string; message?: string };
export interface RoutingProvider {
  readonly id: string;
  capabilities(): { profiles: string[]; alternatives: boolean; traffic: boolean; matrix: boolean };
  route(request: RouteRequest): Promise<RouteResult>;
  health(): Promise<ProviderHealth>;
}
export type NavigationStop = { id: string; kind: 'PICKUP'|'DROPOFF'|'DESTINATION'; coordinate: Coordinate; label: string };
export type EtaEstimate = { arrivalAt: string; remainingSeconds: number; baselineSeconds: number; trafficDelaySeconds?: number; uncertaintySeconds: number; confidence: number; source: 'BASELINE'|'TRAFFIC'|'LIVE_PROGRESS'|'HYBRID' };
export const ownershipSchema = z.object({ ownerType: z.enum(['USER','ORGANIZATION','PROVIDER']), ownerId: z.string().min(1), actorUserId: z.string().optional() });
export type Ownership = z.infer<typeof ownershipSchema>;
export const domainEventSchema = z.object({ eventId: z.string().uuid(), type: z.string().min(1), schemaVersion: z.number().int().positive(), aggregateType: z.string(), aggregateId: z.string(), aggregateVersion: z.number().int().nonnegative(), occurredAt: instantSchema, payload: z.record(z.string(), z.unknown()) });
export type DomainEvent<T> = Omit<z.infer<typeof domainEventSchema>, 'payload'> & { payload: T };
