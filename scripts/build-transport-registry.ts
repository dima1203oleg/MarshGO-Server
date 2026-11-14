import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ukraineCatalog, ukraineCatalogWave2, ukraineCatalogWave3, kyivOpenDataCatalog, type CatalogEntry } from '../server/mobility/ukraineCatalog';
import { initialMobilityOperators } from '../server/mobility/providerRegistry';
import { canEnableCommercialProvider } from '../server/mobility/licensePolicy';

type Evidence = 'VERIFIED' | 'VERIFIED_LIVE' | 'EMPTY' | 'NONE_OBSERVED' | 'UNAVAILABLE' | 'NOT_APPLICABLE' | 'NOT_MEASURED' | 'BLOCKED_EXTERNAL';

interface ProbeRow { state: string; measurementAt: string | null; counts?: Record<string, number>; responseMs?: number; skipped?: boolean; skipReason?: string; failed?: string[]; checks?: { name: string; ok: boolean }[] }

/** Canonical catalog: Base + Wave 2 + Wave 3 + Kyiv open data. */
const catalog: CatalogEntry[] = [...ukraineCatalog, ...ukraineCatalogWave2, ...ukraineCatalogWave3, ...kyivOpenDataCatalog];

const databaseSnapshot = null;

function probeFromRun(path: string) {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    checkedAt?: string; exportedAt?: string; source?: string;
    catalog: { name: string; state: string; measurementAt?: string; skipped?: boolean; skipReason?: string; reason?: string; counts?: Record<string, number>; responseMs?: number; checks?: { name: string; ok: boolean; detail?: string }[] }[];
  };
  const source = raw.source ?? 'npm run acceptance:transport-feeds';
  const byName: Record<string, ProbeRow> = {};
  for (const row of raw.catalog) {
    const skipped = row.skipped || row.state === 'SKIPPED';
    // A monitor timestamp cannot date the parser counts retained in last_report.
    const measurementAt = row.measurementAt ?? (source === 'npm run acceptance:transport-feeds' ? raw.checkedAt : null);
    byName[row.name] = {
      state: skipped ? 'SKIPPED' : row.state,
      measurementAt: !skipped && row.state !== 'NOT_PROBED' && measurementAt && Number.isFinite(Date.parse(measurementAt)) ? measurementAt : null,
      skipped,
      skipReason: row.skipReason ?? row.reason,
      counts: row.counts,
      responseMs: row.responseMs,
      checks: row.checks,
      failed: (row.checks ?? []).filter((check) => !check.ok).map((check) => `${check.name}${check.detail ? `: ${check.detail}` : ''}`),
    };
  }
  return { checkedAt: raw.checkedAt ?? null, exportedAt: raw.exportedAt ?? null, source, byName };
}

function capabilities(entry: CatalogEntry, probe: ProbeRow | undefined): Record<string, Evidence> {
  const counts = probe?.counts ?? {};
  const measured = Boolean(probe?.measurementAt) && ['HEALTHY', 'DEGRADED'].includes(probe?.state ?? '');
  const hasStatic = entry.sourceType === 'gtfs' || entry.sourceType === 'geojson';
  const hasTimetable = entry.sourceType === 'gtfs' || entry.sourceType === 'rest';
  const hasLive = entry.sourceType === 'gtfs_rt' || entry.sourceType === 'json' || entry.sourceType === 'gbfs';
  const unavailable: Evidence = probe?.state === 'OFFLINE' ? 'UNAVAILABLE' : 'NOT_MEASURED';
  const freshHeader = counts.ageSeconds !== undefined && counts.ageSeconds >= 0 && counts.ageSeconds <= 90;
  const staticEvidence: Evidence = !hasStatic ? 'NOT_APPLICABLE' : !measured ? unavailable
    : entry.sourceType === 'gtfs' && (counts.stops ?? 0) > 0 && (counts.routes ?? 0) > 0 ? 'VERIFIED' : 'NOT_MEASURED';
  const timetableEvidence: Evidence = !hasTimetable ? 'NOT_APPLICABLE' : !measured ? unavailable
    : entry.sourceType === 'gtfs' && (counts.trips ?? 0) > 0 && probe?.checks?.some((check) => check.name === 'Scheduled service in next 7 days' && check.ok) ? 'VERIFIED' : 'NOT_MEASURED';
  const liveEvidence: Evidence = !hasLive ? 'NOT_APPLICABLE' : !measured ? unavailable
    : freshHeader && (counts.freshVehiclePositions ?? 0) > 0 ? 'VERIFIED_LIVE'
    : counts.vehicles === 0 ? 'EMPTY' : 'NOT_MEASURED';
  const arrivalEvidence: Evidence = entry.sourceType !== 'gtfs_rt' ? 'NOT_APPLICABLE' : !measured ? unavailable
    : freshHeader && (counts.tripUpdates ?? 0) > 0 ? 'VERIFIED_LIVE' : counts.tripUpdates === 0 ? 'NONE_OBSERVED' : 'NOT_MEASURED';
  const alertEvidence: Evidence = entry.sourceType !== 'gtfs_rt' ? 'NOT_APPLICABLE' : !measured ? unavailable
    : freshHeader && (counts.alerts ?? 0) > 0 ? 'VERIFIED_LIVE' : counts.alerts === 0 ? 'NONE_OBSERVED' : 'NOT_MEASURED';
  const blocked = !canEnableCommercialProvider(entry.access, entry.license);
  const downgrade = (value: Evidence): Evidence => blocked && value !== 'NOT_APPLICABLE' ? 'BLOCKED_EXTERNAL' : value;
  return {
    staticNetwork: downgrade(staticEvidence),
    timetables: downgrade(timetableEvidence),
    livePositions: downgrade(liveEvidence),
    arrivalPredictions: downgrade(arrivalEvidence),
    serviceAlerts: downgrade(alertEvidence),
    // No feed-level fare file, price list or booking endpoint was verified in this audit pass.
    pricing: 'NOT_MEASURED',
    seatAvailability: entry.providerType === 'scooter' && entry.sourceType === 'gbfs' ? 'NOT_MEASURED' : 'NOT_APPLICABLE',
    reservation: 'NOT_MEASURED',
    cancellation: 'NOT_MEASURED',
    deepLink: 'NOT_MEASURED',
  };
}

const argv = process.argv.slice(2);
const probeArgIndex = argv.indexOf('--probe');
if (probeArgIndex < 0 || !argv[probeArgIndex + 1] || argv[probeArgIndex + 1].startsWith('--')) throw new Error('An explicit --probe <json> artifact is required');
const probePath = resolve(argv[probeArgIndex + 1]);
const probeRun = probeFromRun(probePath);

const feeds = catalog.map((entry, index) => {
  const probe = probeRun.byName[entry.name];
  return {
    id: `feed-${String(index + 1).padStart(2, '0')}`,
    name: entry.name,
    city: entry.city,
    providerType: entry.providerType,
    sourceType: entry.sourceType,
    feedUrl: entry.feedUrl,
    access: entry.access,
    license: entry.license ?? null,
    updateFrequency: entry.updateFrequency ?? null,
    coverageClaim: entry.coverage,
    sourceRef: entry.sourceRef,
    priority: entry.priority ?? null,
    capabilities: capabilities(entry, probe),
    probe: {
      measurementAt: probe?.measurementAt ?? null,
      source: probeRun.source,
      state: probe?.state ?? 'NOT_PROBED',
      skipReason: probe?.skipReason ?? null,
      responseMs: probe?.responseMs ?? null,
      reportedCounts: probe?.counts ?? {},
      failedChecks: probe?.failed ?? [],
    },
    productUse: {
      adapterSupported: ['gtfs', 'gtfs_rt', 'json', 'gbfs', 'geojson', 'rest'].includes(entry.sourceType),
      runtimeEligibility: 'NOT_MEASURED',
      routing: 'NOT_MEASURED',
      evidenceNote: 'Parsing and reachability do not establish activation, current service, a valid journey or booking availability.',
    },
  };
});

const operators = initialMobilityOperators.map((operator) => ({
  providerId: operator.providerId,
  name: operator.providerName,
  group: operator.providerGroup,
  dataSource: operator.dataSource,
  sourceUrl: operator.sourceUrl,
  integrationStatus: operator.integrationStatus,
  enabled: operator.enabled,
  bookingMethod: operator.bookingMethod,
  pricingCapability: operator.pricingCapability,
  liveAvailabilityCapability: operator.liveAvailabilityCapability,
  commercialPermissions: operator.commercialPermissions,
  attributionRequirements: operator.attributionRequirements,
}));

const formatSupport = [
  { format: 'GTFS (ZIP)', adapter: 'server/mobility/gtfs.ts + server/journey/gtfsTimetable.ts', implemented: true },
  { format: 'GTFS-Realtime (protobuf)', adapter: 'server/mobility/gtfsRealtime.ts', implemented: true },
  { format: 'GBFS v2/v3 (vehicle rental/geofences)', adapter: 'server/mobility/gbfs.ts, gbfsGeofences.ts, micromobilityFeatures.ts', implemented: true },
  { format: 'JSON vehicle lists', adapter: 'server/mobility/jsonVehicles.ts', implemented: true },
  { format: 'GeoJSON geometry', adapter: 'server/mobility/transportLayers.ts (sourceType geojson)', implemented: true },
  { format: 'REST table (ArcGIS/CKAN)', adapter: 'server/mobility/kyivSchedule.ts, kyivMetroTimetable.ts', implemented: true },
  { format: 'TSV price catalog', adapter: 'server/mobility/kiwitaxiTsv.ts', implemented: true },
  { format: 'CSV (generic)', adapter: 'none', implemented: false },
  { format: 'XML', adapter: 'none', implemented: false },
  { format: 'SIRI / SIRI-2', adapter: 'none', implemented: false },
  { format: 'NeTEx', adapter: 'none', implemented: false },
  { format: 'GTFS-RT Trip Updates cache', adapter: 'server/journey/gtfsRealtime.ts + server/cache/cacheService.ts (L1; Redis when configured, not durable history)', implemented: true },
  { format: 'GTFS-RT Service Alerts entity count', adapter: 'server/mobility/gtfsRealtime.ts (counts only; no product alert delivery established)', implemented: true },
];

const registry = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  generator: 'scripts/build-transport-registry.ts',
  productStatus: 'NOT_RELEASED',
  evidenceRule: 'Capabilities describe dated measurements in the supplied artifact, not current runtime availability. Undated counts remain diagnostics only.',
  sources: {
    catalog: 'server/mobility/ukraineCatalog.ts (canonical, 88 rows: Base + Wave 2 + Wave 3 + Kyiv open data); legacy root copy holds a 43-row subset',
    probe: probePath,
    operators: 'server/mobility/providerRegistry.ts',
    database: 'NOT_MEASURED',
    provenance: probeRun.source,
    artifactReportedAt: probeRun.checkedAt,
    exportedAt: probeRun.exportedAt,
  },
  inventory: {
    catalogRows: catalog.length,
    probeResultRows: feeds.filter((feed) => !['SKIPPED', 'NOT_PROBED'].includes(feed.probe.state)).length,
    datedMeasurementRows: feeds.filter((feed) => feed.probe.measurementAt !== null).length,
    byState: feeds.reduce<Record<string, number>>((acc, feed) => ({ ...acc, [feed.probe.state]: (acc[feed.probe.state] ?? 0) + 1 }), {}),
    blockedOnAccess: feeds.filter((feed) => !canEnableCommercialProvider(feed.access, feed.license)).length,
    verifiedRouting: 'NOT_MEASURED',
    feedsWithLivePositions: feeds.filter((feed) => feed.capabilities.livePositions === 'VERIFIED_LIVE').length,
    feedsWithArrivalPredictions: feeds.filter((feed) => feed.capabilities.arrivalPredictions === 'VERIFIED_LIVE').length,
    feedsWithServiceAlerts: feeds.filter((feed) => feed.capabilities.serviceAlerts === 'VERIFIED_LIVE').length,
    feedsWithVerifiedPricing: feeds.filter((feed) => feed.capabilities.pricing === 'VERIFIED').length,
    feedsWithReservation: feeds.filter((feed) => feed.capabilities.reservation === 'VERIFIED').length,
  },
  ingestionFormats: formatSupport,
  databaseSnapshot,
  operators,
  feeds,
};

const outRoot = resolve(import.meta.dirname!, '..');
const docsRoot = resolve(outRoot, 'docs');
mkdirSync(docsRoot, { recursive: true });
writeFileSync(resolve(outRoot, 'TRANSPORT_PROVIDER_REGISTRY.json'), `${JSON.stringify(registry, null, 2)}\n`);

const cell = (value: string | number) => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const table = (headers: string[], rows: (string | number)[][]) =>
  `| ${headers.map(cell).join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n${rows.map((row) => `| ${row.map(cell).join(' | ')} |`).join('\n')}`;

const feedRows = feeds.map((feed) => [
  feed.name, feed.city, feed.sourceType, feed.probe.state,
  feed.probe.measurementAt ?? 'NOT_MEASURED',
  Object.entries(feed.probe.reportedCounts).map(([key, value]) => `${key}=${value}`).join(', ') || '—',
  feed.capabilities.staticNetwork, feed.capabilities.livePositions, feed.capabilities.arrivalPredictions,
  feed.probe.failedChecks.join('; ') || feed.probe.skipReason || '—',
]);

writeFileSync(resolve(docsRoot, 'TRANSPORT_FEED_AUDIT.md'), `# MARSHGO — TRANSPORT FEED AUDIT

**Generated:** ${registry.generatedAt}
**Generator:** \`scripts/build-transport-registry.ts\` (re-run: \`npx tsx scripts/build-transport-registry.ts --probe <json>\`)
**Product status:** NOT_RELEASED
**Artifact source:** ${probeRun.source}
**Artifact reported timestamp:** ${probeRun.checkedAt ?? 'NOT_MEASURED'}
**Export timestamp:** ${probeRun.exportedAt ?? 'NOT_MEASURED'}
**Evidence rule:** ${registry.evidenceRule}

## 1. Headline numbers

${table(['Metric', 'Value'], [
  ['Catalog rows (canonical server repo)', registry.inventory.catalogRows],
  ['Non-skipped result rows (not necessarily dated)', registry.inventory.probeResultRows],
  ['Dated measurement rows', registry.inventory.datedMeasurementRows],
  ['HEALTHY', registry.inventory.byState.HEALTHY ?? 0],
  ['DEGRADED', registry.inventory.byState.DEGRADED ?? 0],
  ['OFFLINE', registry.inventory.byState.OFFLINE ?? 0],
  ['SKIPPED (license / access / endpoint policy)', registry.inventory.byState.SKIPPED ?? 0],
  ['Verified product routing', registry.inventory.verifiedRouting],
  ['Feeds with live vehicle positions', registry.inventory.feedsWithLivePositions],
  ['Feeds with arrival predictions (trip updates)', registry.inventory.feedsWithArrivalPredictions],
  ['Feeds with service alerts', registry.inventory.feedsWithServiceAlerts],
  ['Feeds with verified pricing', registry.inventory.feedsWithVerifiedPricing],
  ['Feeds with reservation/booking', registry.inventory.feedsWithReservation],
])}

## 2. Per-feed evidence

Reported counts are retained for diagnosis, including undated values. Missing measurement timestamps, invalid/future ages and missing per-vehicle freshness never become VERIFIED_LIVE. Static and realtime evidence are independent.

${table(['Feed', 'City', 'Type', 'Reported state', 'Measurement time', 'Reported counts (may be undated)', 'Static network', 'Fresh positions at measurement', 'Trip updates at measurement', 'Failed checks / skip reason'], feedRows)}

## 3. Ingestion adapters actually present in code

${table(['Format', 'Adapter', 'Implemented'], formatSupport.map((item) => [item.format, item.adapter, item.implemented ? 'yes' : '**no**']))}

## 4. Database and runtime eligibility

**NOT_MEASURED.** This generator does not query the running database. Activation, persistence, fares, reservations and route completeness require separate evidence; no database counts are embedded in the generator.

## 5. Partner/operator registry (\`server/mobility/providerRegistry.ts\`)

${table(['Operator', 'Group', 'Data source', 'Integration status', 'Enabled', 'Booking', 'Pricing'], operators.map((operator) => [operator.name, operator.group, operator.dataSource, operator.integrationStatus, operator.enabled ? 'yes' : 'no', operator.bookingMethod, operator.pricingCapability]))}

## 6. Evidence boundaries

The operator table above contains code declarations, not measured availability. A feed count or an HTTP response proves neither a working journey nor a bookable vehicle. Missing evidence is not evidence that a mode is absent from Ukraine. Failed checks and skip reasons are preserved in full above.
`);

const modeDefinitions = [
  { mode: 'bus', label: 'Автобуси' },
  { mode: 'marshrutka', label: 'Маршрутки' },
  { mode: 'trolleybus', label: 'Тролейбуси' },
  { mode: 'tram', label: 'Трамваї' },
  { mode: 'metro', label: 'Метро' },
  { mode: 'train', label: 'Поїзди/електрички' },
  { mode: 'carpool', label: 'Попутки' },
  { mode: 'scooter', label: 'Самокати' },
  { mode: 'bike', label: 'Велосипеди' },
  { mode: 'taxi', label: 'Таксі' },
  { mode: 'carsharing', label: 'Каршеринг' },
  { mode: 'transfer', label: 'Трансфери' },
];

const citiesWith = (key: string, live: boolean) => [...new Set(feeds.filter((feed) => {
  const counts = feed.probe.reportedCounts;
  if ((counts[key] ?? 0) <= 0) return false;
  if (!live) return feed.capabilities.staticNetwork === 'VERIFIED';
  // Aggregate mode counts are usable only when every observed vehicle is fresh.
  return feed.capabilities.livePositions === 'VERIFIED_LIVE' && counts.freshVehiclePositions === counts.vehicles;
}).map((feed) => feed.city === 'Червоноград' ? 'Шептицький' : feed.city))];

const modeRows = modeDefinitions.map(({ mode, label }) => [
  label, 'NOT_MEASURED',
  citiesWith(`routes_${mode}`, false).join(', ') || 'NOT_MEASURED',
  citiesWith(`vehicles_${mode}`, true).join(', ') || 'NOT_MEASURED',
]);

writeFileSync(resolve(docsRoot, 'TRANSPORT_COVERAGE_MATRIX.md'), `# MARSHGO — 12-MODE TRANSPORT COVERAGE MATRIX

**Generated:** ${registry.generatedAt} · **Product status:** NOT_RELEASED
**Artifact source:** ${probeRun.source}
**Evidence rule:** ${registry.evidenceRule}

A static network is not a current timetable or a successful journey. Unknown vehicle types are not counted as buses. No verified city list means insufficient evidence, not proof that the category is absent from Ukraine.

${table(['Transport category', 'Verified product routing', 'Dated static-network evidence', 'Dated typed fresh-position evidence'], modeRows)}

## Acceptance chain per requirement

${table(['Stage', 'Status', 'Evidence'], [
  ['Source probe', 'PARTIAL', `${registry.inventory.probeResultRows} non-skipped result rows; ${registry.inventory.datedMeasurementRows} dated measurements; ${registry.inventory.byState.SKIPPED ?? 0} skipped`],
  ['Persistence and runtime eligibility', 'NOT_MEASURED', 'No database snapshot supplied'],
  ['Valid routing and completeness', 'NOT_MEASURED', 'Feed probe does not execute product journey acceptance'],
  ['Map rendering and navigation', 'NOT_MEASURED', 'Requires browser and device evidence'],
  ['Pricing, availability and booking', 'NOT_MEASURED', 'No transactional acceptance evidence supplied'],
])}

## What this means for the 12-category promise

All 12 categories remain subject to separate provider, runtime and end-to-end verification. No overall production-readiness or nationwide coverage claim follows from this artifact.
`);

console.log(JSON.stringify({ registry: 'TRANSPORT_PROVIDER_REGISTRY.json', ...registry.inventory }));
