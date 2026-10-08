import { testGbfsConnection } from './gbfs';
import { testGtfsConnection } from './gtfs';
import { testGtfsRealtimeConnection } from './gtfsRealtime';
import { testJsonVehiclesConnection } from './jsonVehicles';
import { probeUrl, UnsafeUrlError } from './safeFetch';
import type { ConnectionReport } from './types';

export async function testProviderConnection(provider: { id: string; source_type: string; feed_url: string }): Promise<ConnectionReport> {
  if (provider.source_type === 'gbfs') return testGbfsConnection(provider.id, provider.feed_url);
  if (provider.source_type === 'gtfs') return testGtfsConnection(provider.feed_url);
  if (provider.source_type === 'gtfs_rt') return testGtfsRealtimeConnection(provider.feed_url);
  if (provider.source_type === 'json') return testJsonVehiclesConnection(provider.feed_url);
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
