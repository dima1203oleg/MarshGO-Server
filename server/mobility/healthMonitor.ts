import type { Pool } from 'pg';
import { testProviderConnection } from './connection';

/**
 * Re-checks every enabled open source and stores its current health. It never changes `status`: enabling or disabling
 * a provider is an administrator's decision. "degraded" (reachable but empty, e.g. a realtime feed at night) stays usable;
 * "offline" sources are skipped by the map layers and availability until a later check finds them again.
 */
export async function refreshProviderHealth(pool: Pool, log: (entry: Record<string, unknown>) => void = () => undefined) {
  const { rows } = await pool.query<{ id: string; name: string; source_type: string; feed_url: string }>(
    `SELECT id,name,source_type,feed_url FROM mobility_providers WHERE status='enabled' AND access='open' ORDER BY last_checked_at NULLS FIRST LIMIT 100`);
  let healthy = 0, degraded = 0, offline = 0;
  for (const provider of rows) {
    try {
      const report = await testProviderConnection(provider);
      await pool.query(
        `UPDATE mobility_providers SET health=$2,last_checked_at=now(),last_sync_at=CASE WHEN $2='healthy' THEN now() ELSE last_sync_at END,last_error=$3,
           last_report=CASE WHEN $2='offline' THEN last_report || jsonb_build_object('checks',$4::jsonb->'checks','error',$3::text) ELSE $4::jsonb END,updated_at=now() WHERE id=$1`,
        [provider.id, report.health, report.error ?? null, JSON.stringify(report)]);
      if (report.health === 'healthy') healthy++; else if (report.health === 'degraded') degraded++; else offline++;
    } catch (error) {
      offline++;
      log({ level: 'error', event: 'mobility.health_check_failed', providerId: provider.id, message: error instanceof Error ? error.message : 'unknown' });
    }
  }
  log({ level: 'info', event: 'mobility.health_refreshed', checked: rows.length, healthy, degraded, offline });
  return { checked: rows.length, healthy, degraded, offline };
}
