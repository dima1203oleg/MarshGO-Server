import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ukraineCatalog, ukraineCatalogWave2, ukraineCatalogWave3, kyivOpenDataCatalog } from '../server/mobility/ukraineCatalog';
import { canEnableCommercialProvider, commercialUseFromLicense } from '../server/mobility/licensePolicy';

const catalog = [...ukraineCatalog, ...ukraineCatalogWave2, ...ukraineCatalogWave3, ...kyivOpenDataCatalog];

interface ProbeResult {
  name: string;
  city: string;
  sourceType: string;
  state: 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'SKIPPED';
  counts?: Record<string, number>;
  bbox?: number[];
  responseMs?: number;
  checks?: unknown[];
  error?: string;
  reason?: string;
}

function sqlEscape(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  return `'${String(val).replace(/'/g, "''")}'`;
}

function main() {
  const argv = process.argv.slice(2);
  const isApply = argv.includes('--apply');
  const probeFile = argv.find((a, i) => argv[i - 1] === '--probe') || '/tmp/feed-probe-wave3.json';

  const probeData = JSON.parse(readFileSync(probeFile, 'utf8')) as {
    catalog: ProbeResult[];
  };
  const probeByNameCity = new Map<string, ProbeResult>();
  for (const item of probeData.catalog) {
    probeByNameCity.set(`${item.name}__${item.city}`, item);
  }

  const sqlStatements: string[] = ['BEGIN;'];
  let planEnabled = 0;
  let planDisabled = 0;
  let planDiscovered = 0;

  for (const entry of catalog) {
    const key = `${entry.name}__${entry.city}`;
    const probe = probeByNameCity.get(key);

    const commercialUse = entry.access === 'open' ? commercialUseFromLicense(entry.license) : null;
    const attributionRequired = entry.access === 'open' && Boolean(entry.license);

    const licenseAllowsCommercialUse = canEnableCommercialProvider(entry.access, entry.license);
    let discoveryStatus = entry.access === 'requires_partner_access'
      ? 'REQUIRES_PARTNERSHIP'
      : licenseAllowsCommercialUse
        ? 'VALIDATED'
        : 'DISCOVERED';

    let health = 'unknown';
    let status = 'disabled';
    let error: string | null = null;
    let reportJson = '{}';

    if (!licenseAllowsCommercialUse) {
      health = 'offline';
      status = 'disabled';
      error = entry.access === 'requires_credentials'
        ? 'REQUIRES_CREDENTIALS: потрібен ключ API від оператора'
        : entry.access === 'requires_partner_access'
          ? 'REQUIRES_PARTNERSHIP: умови комерційного використання не підтверджені'
          : entry.access === 'insecure_endpoint'
            ? 'INSECURE_ENDPOINT: джерело доступне лише по http, не підключено'
            : commercialUse === false
              ? 'NONCOMMERCIAL_LICENSE: commercial reuse is not permitted'
              : 'LICENSE_UNVERIFIED: explicit commercial-use terms are required before enabling';
      discoveryStatus = entry.access === 'requires_partner_access' ? 'REQUIRES_PARTNERSHIP' : 'DISCOVERED';
      planDiscovered++;
    } else if (probe) {
      health = probe.state.toLowerCase();
      error = probe.error ?? null;
      reportJson = JSON.stringify(probe);
      if (probe.state === 'HEALTHY') {
        status = 'enabled';
        discoveryStatus = 'ENABLED';
        planEnabled++;
      } else if (probe.state === 'DEGRADED') {
        status = 'enabled';
        discoveryStatus = 'ENABLED'; // Keep degraded feeds with live vehicles enabled so users can see them
        planEnabled++;
      } else {
        status = 'disabled';
        discoveryStatus = 'TEMPORARILY_UNAVAILABLE';
        planDisabled++;
      }
    } else {
      planDiscovered++;
    }

    const insertSql = `
INSERT INTO mobility_providers (
  name, city, provider_type, source_type, feed_url, realtime_url, vehicle_position_url,
  priority, access, license, update_frequency, coverage, source_ref, country,
  commercial_use, attribution_required, discovery_status, health, status, last_error, last_report,
  last_checked_at, last_sync_at, last_verified_at, updated_at
) VALUES (
  ${sqlEscape(entry.name)},
  ${sqlEscape(entry.city)},
  ${sqlEscape(entry.providerType)},
  ${sqlEscape(entry.sourceType)},
  ${sqlEscape(entry.feedUrl)},
  ${sqlEscape(entry.realtimeUrl ?? null)},
  ${sqlEscape(entry.vehiclePositionUrl ?? null)},
  ${entry.priority ?? 100},
  ${sqlEscape(entry.access)},
  ${sqlEscape(entry.license ?? null)},
  ${sqlEscape(entry.updateFrequency ?? null)},
  ${sqlEscape(entry.coverage)},
  ${sqlEscape(entry.sourceRef)},
  'UA',
  ${sqlEscape(commercialUse)},
  ${attributionRequired ? 'TRUE' : 'FALSE'},
  ${sqlEscape(discoveryStatus)},
  ${sqlEscape(health)},
  ${sqlEscape(status)},
  ${sqlEscape(error)},
  ${sqlEscape(reportJson)}::jsonb,
  now(),
  ${health === 'healthy' || health === 'degraded' ? 'now()' : 'NULL'},
  ${health === 'healthy' || health === 'degraded' ? 'now()' : 'NULL'},
  now()
)
ON CONFLICT (name, city) DO UPDATE SET
  feed_url = EXCLUDED.feed_url,
  realtime_url = COALESCE(EXCLUDED.realtime_url, mobility_providers.realtime_url),
  vehicle_position_url = COALESCE(EXCLUDED.vehicle_position_url, mobility_providers.vehicle_position_url),
  access = EXCLUDED.access,
  license = EXCLUDED.license,
  update_frequency = EXCLUDED.update_frequency,
  coverage = EXCLUDED.coverage,
  source_ref = EXCLUDED.source_ref,
  commercial_use = EXCLUDED.commercial_use,
  attribution_required = EXCLUDED.attribution_required,
  discovery_status = EXCLUDED.discovery_status,
  health = EXCLUDED.health,
  status = EXCLUDED.status,
  last_error = EXCLUDED.last_error,
  last_report = EXCLUDED.last_report,
  last_checked_at = now(),
  last_sync_at = CASE WHEN EXCLUDED.health IN ('healthy', 'degraded') THEN now() ELSE mobility_providers.last_sync_at END,
  last_verified_at = CASE WHEN EXCLUDED.health IN ('healthy', 'degraded') THEN now() ELSE mobility_providers.last_verified_at END,
  updated_at = now();
`;
    sqlStatements.push(insertSql);

    if (entry.providerType === 'scooter' && entry.sourceType === 'gbfs'
      && entry.feedUrl.replace(/\/$/, '') === 'https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs') {
      sqlStatements.push(`UPDATE mobility_providers SET operator_id='zelectra' WHERE name=${sqlEscape(entry.name)} AND city=${sqlEscape(entry.city)};`);
    }
  }

  sqlStatements.push('COMMIT;');

  if (!isApply) {
    console.log(`[DRY RUN] Acceptance DB sync plan generated:`);
    console.log(`  - Total catalog entries: ${catalog.length}`);
    console.log(`  - Planned ENABLED: ${planEnabled}`);
    console.log(`  - Planned TEMPORARILY_UNAVAILABLE: ${planDisabled}`);
    console.log(`  - Planned DISCOVERED / REQUIRES_PARTNERSHIP: ${planDiscovered}`);
    console.log(`  - Target container: marshgo-acceptance-db-1`);
    console.log(`\nDry run completed with no DB changes. To execute, pass --apply flag.`);
    return;
  }

  const getCount = (): string => {
    const res = spawnSync('docker', ['exec', 'marshgo-acceptance-db-1', 'psql', '-U', 'marshgo', '-d', 'marshgo', '-t', '-A', '-c', 'SELECT count(*) FROM mobility_providers;'], {
      encoding: 'utf8',
    });
    return (res.stdout || '').trim();
  };

  const beforeCount = getCount();

  const combinedSql = sqlStatements.join('\n');
  const res = spawnSync('docker', ['exec', '-i', 'marshgo-acceptance-db-1', 'psql', '-U', 'marshgo', '-d', 'marshgo'], {
    input: combinedSql,
    encoding: 'utf8',
  });

  if (res.error || res.status !== 0) {
    console.error('Failed to sync acceptance DB:', res.stderr || res.error);
    process.exit(1);
  }

  const afterCount = getCount();
  console.log(`Successfully synced acceptance DB! Count before: ${beforeCount}, Count after: ${afterCount}`);
}

main();
