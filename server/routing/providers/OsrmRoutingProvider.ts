import { routeRequestSchema, routeResultSchema, type RoutingProvider, type RouteRequest, type ProviderHealth } from '../../../shared/navigation/contracts';
import { encodePolyline6, boundsOf } from '../../../shared/navigation/geometry';
import { RoutingUnavailableError } from './osrmTransport';
import { requestOsrmRoute, type RoutingPriority } from '../osrmGateway';
export class OsrmRoutingProvider implements RoutingProvider {
  readonly id = 'osrm';
  private lastHealth: ProviderHealth;
  constructor(private readonly url?: string, private readonly timeoutMs = 10000) {
    this.lastHealth={ status:'UNAVAILABLE',checkedAt:new Date().toISOString(),message:'Not checked' };
  }
  capabilities() { return { profiles:['CAR'], alternatives:false,traffic:false,matrix:false }; }
  async health() { return {...this.lastHealth}; }
  async route(input: RouteRequest, priority: RoutingPriority = 'interactive') {
    const validation=routeRequestSchema.safeParse(input);
    if(!validation.success) throw new RoutingUnavailableError('Invalid route request', 'ROUTING_INVALID_RESPONSE');
    const request=validation.data;
    if(request.profile.mode!=='CAR' || Object.keys(request.profile).length>1 || request.alternatives) throw new RoutingUnavailableError('Profile constraints unsupported by this OSRM deployment','ROUTING_UNSUPPORTED_PROFILE');
    const started=Date.now();
    try {
      const raw=await requestOsrmRoute([request.origin,...request.waypoints ?? [],request.destination],this.url,{
        timeoutMs:this.timeoutMs, profile:request.profile.mode, priority,
        cacheParameters:{profile:request.profile, departureAt:request.departureAt ?? null, alternatives:request.alternatives ?? false, language:request.language ?? null},
      });
      const result=routeResultSchema.parse({ id:request.requestId,provider:this.id, geometry:{encoding:'polyline6',value:encodePolyline6(raw.geometry)},
        bounds:boundsOf(raw.geometry), distanceMeters:raw.distanceMeters,durationSeconds:raw.durationSeconds,durationWithoutTrafficSeconds:raw.durationSeconds,
        trafficAware:false, legs:raw.legs ?? [], maneuvers:raw.maneuvers ?? [], confidence:'BASELINE',calculatedAt:raw.calculatedAt ?? new Date().toISOString(),routeVersion:1,
        ...(process.env.OSRM_GRAPH_VERSION ? { mapDataVersion:process.env.OSRM_GRAPH_VERSION } : {}) });
      this.lastHealth={status:'HEALTHY',checkedAt:new Date().toISOString(),latencyMs:Date.now()-started}; return result;
    } catch(error) { this.lastHealth={status:'UNAVAILABLE',checkedAt:new Date().toISOString(),latencyMs:Date.now()-started}; throw error; }
  }
}
