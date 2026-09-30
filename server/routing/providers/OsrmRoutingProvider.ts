import { routeRequestSchema, routeResultSchema, type RoutingProvider, type RouteRequest, type ProviderHealth } from '../../../shared/navigation/contracts';
import { encodePolyline6, boundsOf } from '../../../shared/navigation/geometry';
import { fetchOsrmRoute, RoutingUnavailableError } from './osrmTransport';
export class OsrmRoutingProvider implements RoutingProvider {
  readonly id = 'osrm';
  private lastHealth: ProviderHealth;
  constructor(private readonly url?: string, private readonly timeoutMs = 10000) {
    this.lastHealth={ status:'UNAVAILABLE',checkedAt:new Date().toISOString(),message:'Not checked' };
  }
  capabilities() { return { profiles:['CAR'], alternatives:false,traffic:false,matrix:false }; }
  async health() { return {...this.lastHealth}; }
  async route(input: RouteRequest) {
    const validation=routeRequestSchema.safeParse(input);
    if(!validation.success) throw new RoutingUnavailableError('Invalid route request', 'ROUTING_INVALID_RESPONSE');
    const request=validation.data;
    if(request.profile.mode!=='CAR' || Object.keys(request.profile).length>1 || request.alternatives) throw new RoutingUnavailableError('Profile constraints unsupported by this OSRM deployment','ROUTING_UNSUPPORTED_PROFILE');
    const started=Date.now();
    try {
      const raw=await fetchOsrmRoute([request.origin,...request.waypoints ?? [],request.destination],this.url,this.timeoutMs);
      const result=routeResultSchema.parse({ id:request.requestId,provider:this.id, geometry:{encoding:'polyline6',value:encodePolyline6(raw.geometry)},
        bounds:boundsOf(raw.geometry), distanceMeters:raw.distanceMeters,durationSeconds:raw.durationSeconds,durationWithoutTrafficSeconds:raw.durationSeconds,
        trafficAware:false, legs:raw.legs ?? [], maneuvers:raw.maneuvers ?? [], confidence:'BASELINE',calculatedAt:new Date().toISOString(),routeVersion:1 });
      this.lastHealth={status:'HEALTHY',checkedAt:new Date().toISOString(),latencyMs:Date.now()-started}; return result;
    } catch(error) { this.lastHealth={status:'UNAVAILABLE',checkedAt:new Date().toISOString(),latencyMs:Date.now()-started}; throw error; }
  }
}
