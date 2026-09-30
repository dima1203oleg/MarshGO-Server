import type { TrafficProvider } from './TrafficProvider';
export class NoTrafficProvider implements TrafficProvider {
  readonly id='none';
  async getFlow() { return []; }
  async getIncidents() { return []; }
  async health() { return { status:'UNAVAILABLE' as const,checkedAt:new Date().toISOString(),message:'Traffic is not enabled' }; }
}
