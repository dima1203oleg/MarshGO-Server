import type { Pool } from 'pg';
import { probeProviderReachability } from './connection';
import type { ConnectionReport } from './types';

interface StoredProviderReport {
  counts?: Record<string, number>;
  checks?: Array<{ name?: string; ok?: boolean; detail?: string }>;
  error?: string | null;
  [key: string]: unknown;
}

/** A recovered probe must not leave the previous outage asserted beside its own success in one report. */
export function mergeProbeReport(stored: StoredProviderReport | null, probe: ConnectionReport): StoredProviderReport {
  const next: StoredProviderReport = { ...(stored ?? {}) };
  if (probe.health === 'offline') {
    next.checks = probe.checks;
    next.error = probe.error ?? null;
  } else {
    next.health_probe = probe;
    delete next.error;
    const staleReachabilityFailure = (stored?.checks ?? []).some((check) => check?.name === 'Feed accessible' && check.ok === false);
    if (staleReachabilityFailure) next.checks = probe.checks;
  }
  if (probe.sourceVersion) next.sourceVersion = probe.sourceVersion;
  return next;
}

/**
 * Performs a bounded reachability pass for enabled sources. It never downloads and parses full static feeds in the API
 * request process; full schema validation is an explicit admin action. It never changes `status`, which is an
 * administrator's decision. A reachable source with a previous validated report stays healthy; otherwise it stays
 * degraded until a full validation is completed. Offline sources are skipped until a later probe finds them again.
 */
export async function refreshProviderHealth(
  pool: Pool,
  log: (entry: Record<string, unknown>) => void = () => undefined,
  providerIds?: readonly string[],
) {
  const requestedBatchSize = Number(process.env.MOBILITY_HEALTH_BATCH_SIZE) || 25;
  const batchSize = Math.max(1, Math.min(100, Math.floor(requestedBatchSize)));
  const requestedConcurrency = Number(process.env.MOBILITY_HEALTH_CONCURRENCY) || 4;
  const concurrency = Math.max(1, Math.min(8, Math.floor(requestedConcurrency)));
  const { rows } = await pool.query<{
    id: string; name: string; source_type: string; feed_url: string; health: string;
    last_report: StoredProviderReport | null;
  }>(
    `SELECT id,name,source_type,feed_url,health,last_report FROM mobility_providers
      WHERE status='enabled' AND access='open' AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[]))
      ORDER BY last_checked_at NULLS FIRST LIMIT $1`, [batchSize, providerIds ?? null]);
  let healthy = 0, degraded = 0, offline = 0;
  for (let offset = 0; offset < rows.length; offset += concurrency) {
    await Promise.all(rows.slice(offset, offset + concurrency).map(async (provider) => {
      try {
        const report = await probeProviderReachability(provider);
        const hasValidatedReport = Boolean(provider.last_report?.counts && Object.keys(provider.last_report.counts).length > 0);
        const health = report.health === 'offline' ? 'offline' : provider.health === 'healthy' && hasValidatedReport ? 'healthy' : 'degraded';
        const nextReport = mergeProbeReport(provider.last_report, report);
        await pool.query(
          `UPDATE mobility_providers SET health=$2,last_checked_at=now(),last_error=$3,
             last_report=$4::jsonb || jsonb_build_object('last_probe_at',now()),
             updated_at=now() WHERE id=$1`,
          [provider.id, health, report.error ?? null, JSON.stringify(nextReport)]);
        if (health === 'healthy') healthy++; else if (health === 'degraded') degraded++; else offline++;
      } catch (error) {
        offline++;
        log({ level: 'error', event: 'mobility.health_check_failed', providerId: provider.id, message: error instanceof Error ? error.message : 'unknown' });
      }
    }));
  }
  const result = { checked: rows.length, healthy, degraded, offline };
  log({ level: 'info', event: 'mobility.health_refreshed', ...result, batchSize, concurrency });
  return result;
}
