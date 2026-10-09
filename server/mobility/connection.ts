import { testGbfsConnection } from './gbfs';
import { testGtfsConnection } from './gtfs';
import { testGtfsRealtimeConnection } from './gtfsRealtime';
import { testJsonVehiclesConnection } from './jsonVehicles';
import { fetchJson, probeUrl, UnsafeUrlError } from './safeFetch';
import { buildGeoJsonNetwork, geoJsonMode } from './transportLayers';
import { testKyivScheduleConnection } from './kyivSchedule';
import type { ConnectionReport } from './types';

export async function testProviderConnection(provider: { id: string; name?: string; source_type: string; feed_url: string }): Promise<ConnectionReport> {
  if (provider.source_type === 'gbfs') return testGbfsConnection(provider.id, provider.feed_url);
  if (provider.source_type === 'gtfs') return testGtfsConnection(provider.feed_url);
  if (provider.source_type === 'gtfs_rt') return testGtfsRealtimeConnection(provider.feed_url);
  if (provider.source_type === 'json') return testJsonVehiclesConnection(provider.feed_url);
  if (provider.source_type === 'geojson') {
    const started = Date.now();
    try {
      const { data, ms } = await fetchJson(provider.feed_url, 15000);
      const features = data && typeof data === 'object' && Array.isArray((data as { features?: unknown }).features) ? (data as { features: unknown[] }).features : null;
      if (!features) throw new Error('Response is not a GeoJSON FeatureCollection');
      const valid = features.filter((feature) => {
        if (!feature || typeof feature !== 'object') return false;
        const geometry = (feature as { geometry?: { type?: string; coordinates?: unknown } }).geometry;
        return geometry?.type === 'Point' || geometry?.type === 'LineString';
      }).length;
      const mode = geoJsonMode(provider.name ?? '');
      const network = mode ? buildGeoJsonNetwork(data, mode) : null;
      const ok = valid > 0;
      return { health: ok ? 'healthy' : 'degraded', checks: [
        { name: 'GeoJSON FeatureCollection', ok: true, detail: `${features.length} features` },
        { name: 'Supported route/station geometries', ok, detail: `${valid} usable features` },
      ], counts: { features: features.length, ...(mode && network?.routes.length ? { [`routes_${mode}`]: network.routes.length } : {}), ...(mode && network?.stops.length ? { [`stops_${mode}`]: network.stops.length } : {}) }, responseMs: ms, ...(network?.bbox ? { bbox: network.bbox } : {}), ...(ok ? {} : { error: 'No supported GeoJSON features' }) };
    } catch (error) {
      const message = error instanceof UnsafeUrlError ? error.message : error instanceof Error ? error.message : 'GeoJSON feed is unreachable';
      return { health: 'offline', checks: [{ name: 'GeoJSON feed', ok: false, detail: message }], counts: {}, responseMs: Date.now() - started, error: message };
    }
  }
  if (provider.source_type === 'rest' && provider.name?.startsWith('Київ — ') && /розклад|перший\/останній|інтервали|години роботи/.test(provider.name)) {
    const started = Date.now();
    try { return await testKyivScheduleConnection(provider.feed_url); }
    catch (error) {
      const message = error instanceof UnsafeUrlError ? error.message : error instanceof Error ? error.message : 'Kyiv schedule API is unreachable';
      return { health: 'offline', checks: [{ name: 'Kyiv Open Data schedule API', ok: false, detail: message }], counts: {}, responseMs: Date.now() - started, error: message };
    }
  }
  const started = Date.now();
  try {
    const probe = await probeUrl(provider.feed_url);
    const ok = probe.status >= 200 && probe.status < 300;
    return {
      health: ok ? 'degraded' : 'offline',
      checks: [
        { name: 'Feed accessible', ok, detail: `HTTP ${probe.status}${probe.contentType ? `, ${probe.contentType}` : ''}` },
        { name: `${provider.source_type.toUpperCase()} schema validation`, ok: false, detail: 'Validator for this source type is not implemented yet' },
      ],
      counts: {}, responseMs: probe.ms,
      ...(ok ? {} : { error: `Feed returned HTTP ${probe.status}` }),
    };
  } catch (error) {
    const message = error instanceof UnsafeUrlError ? error.message : 'Feed is unreachable';
    return { health: 'offline', checks: [{ name: 'Feed accessible', ok: false, detail: message }], counts: {}, responseMs: Date.now() - started, error: message };
  }
}
