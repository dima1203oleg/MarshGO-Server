import 'dotenv/config';
import { Pool } from 'pg';
import { testProviderConnection } from './connection';
import { commercialUseFromLicense, hasVerifiedCommercialFeedRights } from './licensePolicy';
import { enabledStatusForHealth, selectUkraineSeedEntries } from './seedScopes';
import { kyivOpenDataCatalog, ukraineCatalog, ukraineCatalogWave2 } from './ukraineCatalog';

/** Idempotent: registers every catalogue source, tests the open ones and enables those that are healthy. */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const scope = process.argv[2] ?? 'all';
    const catalog = [...ukraineCatalog, ...ukraineCatalogWave2, ...kyivOpenDataCatalog];
    const entries = selectUkraineSeedEntries(scope, catalog);
    if (!entries) throw new Error('Supported seed scopes: all, --kyiv-metro, --verified-live, --verified-gtfs-rt, --verified-gtfs-schedule, --verified-kyiv-gtfs-schedule, --verified-lviv-gtfs-schedule, --verified-ivano-frankivsk-gtfs-schedule, --verified-stryi-uzhhorod-gtfs-schedule, --candidate-gtfs-csv, --candidate-gtfs-bundle, --candidate-live-json');
    const strictLiveScope = ['--verified-live', '--verified-gtfs-schedule', '--verified-kyiv-gtfs-schedule', '--verified-lviv-gtfs-schedule', '--verified-ivano-frankivsk-gtfs-schedule', '--verified-stryi-uzhhorod-gtfs-schedule', '--candidate-gtfs-csv', '--candidate-gtfs-bundle', '--candidate-live-json'].includes(scope);
    for (const entry of entries) {
      const commercialUse = entry.access === 'open' ? commercialUseFromLicense(entry.license) : null;
      const { rows } = await pool.query<{ id: string; status: string }>(
        `INSERT INTO mobility_providers(name,city,provider_type,source_type,feed_url,realtime_url,vehicle_position_url,priority,access,license,update_frequency,coverage,source_ref,country,commercial_use,attribution_required,discovery_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'UA',$14,$15,$16)
         ON CONFLICT (name,city) DO UPDATE SET feed_url=EXCLUDED.feed_url,realtime_url=COALESCE(EXCLUDED.realtime_url,mobility_providers.realtime_url),vehicle_position_url=COALESCE(EXCLUDED.vehicle_position_url,mobility_providers.vehicle_position_url),access=EXCLUDED.access,license=EXCLUDED.license,update_frequency=EXCLUDED.update_frequency,coverage=EXCLUDED.coverage,source_ref=EXCLUDED.source_ref,commercial_use=EXCLUDED.commercial_use,attribution_required=EXCLUDED.attribution_required,discovery_status=EXCLUDED.discovery_status,updated_at=now()
         RETURNING id,status`,
        [entry.name, entry.city, entry.providerType, entry.sourceType, entry.feedUrl, entry.realtimeUrl ?? null, entry.vehiclePositionUrl ?? null, entry.priority ?? 100, entry.access, entry.license ?? null, entry.updateFrequency ?? null, entry.coverage, entry.sourceRef,
          commercialUse,
          entry.access === 'open' && Boolean(entry.license), entry.access === 'requires_partner_access' ? 'REQUIRES_PARTNERSHIP' : entry.access === 'open' && Boolean(entry.license) ? 'VALIDATED' : 'DISCOVERED'],
      );
      const provider = rows[0];
      // Canonicalize the operator link for the public Zelectra GBFS system so
      // its live inventory and geofences join the confirmed rental network.
      if (entry.providerType === 'scooter' && entry.sourceType === 'gbfs'
        && entry.feedUrl.replace(/\/$/, '') === 'https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs') {
        await pool.query("UPDATE mobility_providers SET operator_id='zelectra' WHERE id=$1 AND operator_id IS DISTINCT FROM 'zelectra'", [provider.id]);
      }
      if (entry.access !== 'open' || !entry.license || !hasVerifiedCommercialFeedRights(entry.license)) {
        const licenseError = commercialUse === false
          ? 'COMMERCIAL_USE_PROHIBITED: ліцензія не дозволяє комерційне повторне використання'
          : 'LICENSE_UNVERIFIED: комерційні права на дані не підтверджені';
        await pool.query(`UPDATE mobility_providers SET health='offline',last_error=$2,last_checked_at=now(),status='disabled',discovery_status=$3 WHERE id=$1`,
          [provider.id, entry.access === 'requires_credentials' ? 'REQUIRES_CREDENTIALS: потрібен ключ API від оператора' : entry.access === 'requires_partner_access' ? 'REQUIRES_PARTNERSHIP: потрібні права доступу від партнера' : entry.access === 'insecure_endpoint' ? 'INSECURE_ENDPOINT: джерело доступне лише по http, не підключено' : licenseError, entry.access === 'requires_partner_access' ? 'REQUIRES_PARTNERSHIP' : 'DISCOVERED']);
        console.log(`registered (${entry.access}): ${entry.name}`);
        continue;
      }
      const report = await testProviderConnection({ id: provider.id, name: entry.name, source_type: entry.sourceType, feed_url: entry.feedUrl, country: 'UA' });
      const status = enabledStatusForHealth(report.health, strictLiveScope);
      await pool.query(
        `UPDATE mobility_providers SET health=$2,last_checked_at=now(),last_sync_at=CASE WHEN $2='healthy' THEN now() ELSE last_sync_at END,last_error=$3,last_report=$4,
           status=$5,discovery_status=CASE WHEN $2='healthy' THEN 'ENABLED' ELSE 'TEMPORARILY_UNAVAILABLE' END,
           attribution_required=CASE WHEN $2='healthy' THEN true ELSE attribution_required END,
           last_verified_at=CASE WHEN $2='healthy' THEN now() ELSE last_verified_at END,updated_at=now() WHERE id=$1`,
        [provider.id, report.health, report.error ?? null, JSON.stringify(report), status],
      );
      console.log(`${report.health.padEnd(8)} ${status.padEnd(8)} ${entry.name} ${JSON.stringify(report.counts)}`);
    }
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
