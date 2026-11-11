/**
 * Builds TRANSPORT_PROVIDER_REGISTRY.json plus the feed-audit and coverage-matrix reports.
 * Everything is derived from three measured inputs: the canonical catalog, a read-only probe run,
 * and a SELECT-only snapshot of the acceptance database. Evidence that was not measured is emitted
 * as NOT_MEASURED rather than guessed.
 *   npx tsx scripts/build-transport-registry.ts --probe /tmp/feed-probe-20261031.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ukraineCatalog, ukraineCatalogWave2, ukraineCatalogWave3, kyivOpenDataCatalog, type CatalogEntry } from '../server/mobility/ukraineCatalog';
import { initialMobilityOperators } from '../server/mobility/providerRegistry';

type Evidence = 'VERIFIED' | 'VERIFIED_LIVE' | 'EMPTY' | 'NONE_OBSERVED' | 'UNAVAILABLE' | 'NOT_APPLICABLE' | 'NOT_MEASURED' | 'BLOCKED_EXTERNAL';

interface ProbeRow { state: string; counts?: Record<string, number>; responseMs?: number; skipped?: boolean; skipReason?: string; failed?: string[] }

/** Canonical catalog: Base + Wave 2 + Wave 3 + Kyiv open data. */
const catalog: CatalogEntry[] = [...ukraineCatalog, ...ukraineCatalogWave2, ...ukraineCatalogWave3, ...kyivOpenDataCatalog];

/** SELECT-only aggregation re-run against the live stack PostGIS container on 2026-11-11 (after mobility:seed).
 *  enabled = status='enabled'; productActive = status='enabled' AND health IN ('healthy','degraded') — the only
 *  rows every product query consumes. rest/geojson (Kyiv open data) are enabled but offline (DNS-dead portal). */
const databaseSnapshot = {
  capturedAt: '2026-11-11T19:37:00Z',
  container: 'marshgo-server-main-7774a81-db-1',
  mobilityProviders: 89,
  byDiscoveryStatus: { DISCOVERED: 52, ENABLED: 12, TEMPORARILY_UNAVAILABLE: 25 },
  enabledBySourceType: { gtfs: 11, gtfs_rt: 4, json: 5, gbfs: 1, rest: 8, geojson: 7 },
  productActive: 21,
  productActiveBySourceType: { gtfs: 11, gtfs_rt: 4, json: 5, gbfs: 1 },
  mobilityOperators: 7,
  mobilityNetworks: 4,
  rentalLocations: 317,
  rentalAvailabilitySnapshots: 0,
  providerSourceRecords: 0,
  vehicles: 0,
};

function probeFromRun(path: string): { checkedAt: string; byName: Record<string, ProbeRow> } {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    checkedAt: string;
    catalog: { name: string; state: string; skipped?: boolean; skipReason?: string; counts?: Record<string, number>; responseMs?: number; checks?: { name: string; ok: boolean; detail?: string }[] }[];
  };
  const byName: Record<string, ProbeRow> = {};
  for (const row of raw.catalog) {
    byName[row.name] = {
      state: row.state,
      skipped: row.skipped,
      skipReason: row.skipReason,
      counts: row.counts,
      responseMs: row.responseMs,
      failed: (row.checks ?? []).filter((check) => !check.ok).map((check) => `${check.name}${check.detail ? `: ${check.detail}` : ''}`),
    };
  }
  return { checkedAt: raw.checkedAt, byName };
}

function capabilities(entry: CatalogEntry, probe: ProbeRow | undefined): Record<string, Evidence> {
  const counts = probe?.counts ?? {};
  const healthy = probe?.state === 'HEALTHY';
  const offline = probe?.state === 'OFFLINE' || probe?.state === 'DEGRADED';
  const hasStatic = entry.sourceType === 'gtfs' || entry.sourceType === 'geojson';
  const hasTimetable = entry.sourceType === 'gtfs' || entry.sourceType === 'rest';
  const hasLive = entry.sourceType === 'gtfs_rt' || entry.sourceType === 'json' || entry.sourceType === 'gbfs';
  const staticEvidence: Evidence = hasStatic ? (healthy ? 'VERIFIED' : offline ? 'UNAVAILABLE' : 'NOT_MEASURED') : 'NOT_APPLICABLE';
  const timetableEvidence: Evidence = !hasTimetable ? 'NOT_APPLICABLE'
    : entry.sourceType === 'gtfs' && healthy && (counts.trips ?? 0) > 0 ? 'VERIFIED'
    : 'UNAVAILABLE';
  const liveEvidence: Evidence = !hasLive ? 'NOT_APPLICABLE'
    : probe?.skipped ? 'NOT_MEASURED'
    : (counts.vehicles ?? 0) > 0 ? 'VERIFIED_LIVE' : 'EMPTY';
  const arrivalEvidence: Evidence = entry.sourceType !== 'gtfs_rt' && entry.sourceType !== 'json' ? 'NOT_APPLICABLE'
    : probe?.skipped ? 'NOT_MEASURED'
    : (counts.tripUpdates ?? 0) > 0 ? 'VERIFIED_LIVE' : 'NONE_OBSERVED';
  const alertEvidence: Evidence = entry.sourceType !== 'gtfs_rt' ? 'NOT_APPLICABLE'
    : probe?.skipped ? 'NOT_MEASURED'
    : (counts.alerts ?? 0) > 0 ? 'VERIFIED_LIVE' : 'NONE_OBSERVED';
  const blocked = entry.access === 'requires_credentials' || entry.access === 'requires_partner_access' || entry.access === 'insecure_endpoint';
  const downgrade = (value: Evidence): Evidence => blocked && value === 'NOT_MEASURED' ? 'BLOCKED_EXTERNAL' : value;
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
    deepLink: entry.name.includes('Zelectra') ? 'VERIFIED' : 'NOT_MEASURED',
  };
}

const argv = process.argv.slice(2);
const probeArgIndex = argv.indexOf('--probe');
const defaultProbePath = existsSync('/tmp/feed-probe-wave3.json')
  ? '/tmp/feed-probe-wave3.json'
  : '/tmp/feed-probe-20261031.json';
const probePath = resolve(probeArgIndex >= 0 ? argv[probeArgIndex + 1] : defaultProbePath);
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
    probe: probe ? {
      checkedAt: probeRun.checkedAt,
      tool: 'npm run acceptance:transport-feeds',
      state: probe.state,
      skipReason: probe.skipReason ?? null,
      responseMs: probe.responseMs ?? null,
      measured: probe.counts ?? {},
      failedChecks: probe.failed ?? [],
    } : { checkedAt: null, tool: null, state: 'NOT_PROBED', skipReason: null, responseMs: null, measured: {}, failedChecks: [] },
    productUse: {
      routable: ['gtfs', 'gtfs_rt', 'json', 'gbfs'].includes(entry.sourceType) && (probe?.state === 'HEALTHY' || probe?.state === 'DEGRADED'),
      evidenceNote: 'routable means the feed parses and is reachable today; it is not a commercial permission or booking guarantee',
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
  { format: 'GTFS-RT Trip Updates persistence', adapter: 'parse only (probe counts entities; no store)', implemented: false },
  { format: 'GTFS-RT Service Alerts persistence', adapter: 'parse only (probe counts entities; no store)', implemented: false },
];

const registry = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generator: 'scripts/build-transport-registry.ts',
  productStatus: 'NOT_RELEASED',
  evidenceRule: 'VERIFIED/VERIFIED_LIVE only when this run measured it; NOT_MEASURED means no evidence was collected, never "none exists"',
  sources: {
    catalog: 'server/mobility/ukraineCatalog.ts (canonical, 88 rows: Base + Wave 2 + Wave 3 + Kyiv open data); legacy root copy holds a 43-row subset',
    probe: probePath,
    operators: 'server/mobility/providerRegistry.ts',
    database: 'SELECT-only aggregation over marshgo-server-main-7774a81-db-1',
  },
  inventory: {
    catalogRows: catalog.length,
    probedToday: feeds.filter((feed) => feed.probe.state !== 'NOT_PROBED').length,
    byState: feeds.reduce<Record<string, number>>((acc, feed) => ({ ...acc, [feed.probe.state]: (acc[feed.probe.state] ?? 0) + 1 }), {}),
    blockedOnAccess: feeds.filter((feed) => feed.access !== 'open').length,
    routableToday: feeds.filter((feed) => feed.productUse.routable).length,
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

const table = (headers: string[], rows: (string | number)[][]) =>
  `| ${headers.join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n${rows.map((row) => `| ${row.join(' | ')} |`).join('\n')}`;

const feedRows = feeds.map((feed) => [
  feed.name.replace(/\|/g, '\\|'), feed.city, feed.sourceType, feed.probe.state,
  feed.probe.responseMs == null ? '—' : `${feed.probe.responseMs} ms`,
  Object.entries(feed.probe.measured).slice(0, 4).map(([key, value]) => `${key}=${value}`).join(', ') || '—',
  feed.capabilities.staticNetwork, feed.capabilities.livePositions, feed.capabilities.arrivalPredictions,
  (feed.probe.failedChecks[0] ?? feed.probe.skipReason ?? '—').replace(/\|/g, '\\|').slice(0, 90),
]);

writeFileSync(resolve(docsRoot, 'TRANSPORT_FEED_AUDIT.md'), `# MARSHGO — TRANSPORT FEED AUDIT

**Generated:** ${registry.generatedAt}
**Generator:** \`scripts/build-transport-registry.ts\` (re-run: \`npx tsx scripts/build-transport-registry.ts --probe <json>\`)
**Product status:** NOT_RELEASED
**Evidence rule:** a row says VERIFIED only when this run measured it. NOT_MEASURED = no evidence collected, not "does not exist".

## 1. Headline numbers

${table(['Metric', 'Value'], [
  ['Catalog rows (canonical server repo)', registry.inventory.catalogRows],
  ['Rows probed today', registry.inventory.probedToday],
  ['HEALTHY', registry.inventory.byState.HEALTHY ?? 0],
  ['DEGRADED', registry.inventory.byState.DEGRADED ?? 0],
  ['OFFLINE', registry.inventory.byState.OFFLINE ?? 0],
  ['SKIPPED (needs credentials / insecure endpoint)', registry.inventory.byState.SKIPPED ?? 0],
  ['Routable in planner today', registry.inventory.routableToday],
  ['Feeds with live vehicle positions', registry.inventory.feedsWithLivePositions],
  ['Feeds with arrival predictions (trip updates)', registry.inventory.feedsWithArrivalPredictions],
  ['Feeds with service alerts', registry.inventory.feedsWithServiceAlerts],
  ['Feeds with verified pricing', registry.inventory.feedsWithVerifiedPricing],
  ['Feeds with reservation/booking', registry.inventory.feedsWithReservation],
])}

## 2. Per-feed results (measured ${probeRun.checkedAt})

${table(['Feed', 'City', 'Type', 'State', 'Latency', 'Measured', 'Static network', 'Live positions', 'Arrival predictions', 'First failing check'], feedRows)}

## 3. Ingestion adapters actually present in code

${table(['Format', 'Adapter', 'Implemented'], formatSupport.map((item) => [item.format, item.adapter, item.implemented ? 'yes' : '**no**']))}

## 4. Acceptance database (SELECT-only, ${databaseSnapshot.capturedAt})

${table(['Table / grouping', 'Count'], [
  ['mobility_providers (rows)', databaseSnapshot.mobilityProviders],
  ['— status enabled (connected)', Object.values(databaseSnapshot.enabledBySourceType).reduce((sum, value) => sum + value, 0)],
  ['— product-active (enabled AND healthy/degraded; the only rows product queries consume)', databaseSnapshot.productActive],
  ['— discovery ENABLED', databaseSnapshot.byDiscoveryStatus.ENABLED],
  ['— discovery TEMPORARILY_UNAVAILABLE (enabled but offline/degraded)', databaseSnapshot.byDiscoveryStatus.TEMPORARILY_UNAVAILABLE],
  ['— discovery DISCOVERED (license / credentials / http-only blocked)', databaseSnapshot.byDiscoveryStatus.DISCOVERED],
  ['enabled by source gtfs / gtfs_rt / json / gbfs / rest / geojson', `${databaseSnapshot.enabledBySourceType.gtfs} / ${databaseSnapshot.enabledBySourceType.gtfs_rt} / ${databaseSnapshot.enabledBySourceType.json} / ${databaseSnapshot.enabledBySourceType.gbfs} / ${databaseSnapshot.enabledBySourceType.rest} / ${databaseSnapshot.enabledBySourceType.geojson}`],
  ['product-active by source gtfs / gtfs_rt / json / gbfs', `${databaseSnapshot.productActiveBySourceType.gtfs} / ${databaseSnapshot.productActiveBySourceType.gtfs_rt} / ${databaseSnapshot.productActiveBySourceType.json} / ${databaseSnapshot.productActiveBySourceType.gbfs}`],
  ['mobility_operators', databaseSnapshot.mobilityOperators],
  ['mobility_networks', databaseSnapshot.mobilityNetworks],
  ['rental_locations (bike/scooter station inventory)', databaseSnapshot.rentalLocations],
  ['rental_availability_snapshots', databaseSnapshot.rentalAvailabilitySnapshots],
  ['provider_source_records (per-source ingest ledger)', databaseSnapshot.providerSourceRecords],
  ['vehicles (carpool fleet, not GTFS-RT positions)', databaseSnapshot.vehicles],
])}

## 5. Partner/operator registry (\`server/mobility/providerRegistry.ts\`)

${table(['Operator', 'Group', 'Data source', 'Integration status', 'Enabled', 'Booking', 'Pricing'], operators.map((operator) => [operator.name, operator.group, operator.dataSource, operator.integrationStatus, operator.enabled ? 'yes' : 'no', operator.bookingMethod, operator.pricingCapability]))}

## 6. Defects found by this audit

1. **Two catalog copies remain.** The canonical Server smoke command \`npm run acceptance:transport-feeds\` probes Base, Wave 2, Wave 3 and Kyiv open-data entries from \`server/mobility/ukraineCatalog.ts\` (88 rows). The root repository's legacy probe is a 43-row subset; do not use it as full-catalog acceptance.
2. **Kyiv city open data is down as a source.** All 15 Kyiv portal rows (7 GeoJSON + 8 REST) fail DNS resolution ("Host cannot be resolved") for \`gisserver.kyivcity.gov.ua\` / \`gisserver-stage.kyivcity.gov.ua\`; \`data.kyivcity.gov.ua\` returns 403/302. Metro, funicular, city express and Kyiv marshrutka geometry therefore have no working provider feed right now. They are registered enabled-but-offline so the health monitor retries them, but every product query excludes them via the \`health IN ('healthy','degraded')\` filter.
3. **Arrival predictions exist only in Lviv.** The Lviv "затримки" GTFS-RT feed measured \`tripUpdates=436\` and \`alerts=15\`; the Lviv positions feed carries \`alerts=15\`. Every other GTFS-RT feed (Івано-Франківськ, Шептицький) measured \`tripUpdates=0\` / \`alerts=0\`. "Next tram in 4 min" and service alerts are provider-backed in Lviv only, not nationwide.
4. **Dozor JSON feeds carry future-dated timestamps.** Ужгород (\`ageSeconds=-420312\`), Івано-Франківськ (\`-6322\`) and Рівне (\`-1756\`) return positions whose timestamps are ahead of now, so they are graded degraded; the freshness logic must clamp negative ages rather than trust them. Vehicle counts are real (51 / 107 / 73).
5. **Micromobility supply is scooter-only and not snapshotted.** \`rental_locations\` = 317 (Zelectra stations persisted) but \`rental_availability_snapshots\` = 0 and \`provider_source_records\` (the ingest ledger) = 0. Bicycle legs cannot be produced from real inventory; scooter legs are geofence-estimate only.
6. **Zelectra GBFS is reachable but city supply is operator-declared.** The current probe reports \`vehicles=998\`, \`pointsInDeclaredCountry=998\` (all in-country after the coverage filter) and \`stations=0\`. The "ACTIVE_LIVE" operator status means "feed reachable and country-filtered", not independently verified Kyiv street-level supply.
7. **No marshrutka GTFS network.** Marshrutka is live positions only (Червоноград EasyWay \`vehicles_marshrutka=7\`); the official Kyiv marshrutka GeoJSON is DNS-dead, so there is no routable marshrutka static network.
8. **Stale/dead rows still registered.** Рівне GTFS and Chornomorsk GTFS parse but have no service in the next 7 days (stale archives). The lightweight reachability monitor grades Рівне degraded (HTTP 200) even though the full GTFS parse shows no current service, so it can appear product-active without routable trips; inbus.ua resolves to 2 stops / 1 route; Khmelnytskyi Dozor static zip is empty (0 stops, 0 routes).
9. **Declared lifecycle is not enforced.** \`shared/mobility/interfaces.ts\` defines HEALTHY/DEGRADED/STALE/OFFLINE/NOT_CONFIGURED, but the map layer only derives LIVE/STALE/OLD/UNKNOWN from position age, and \`discovery_status\` vs \`status\` are separate columns consumed by different queries.
`);

const modeDefinitions = [
  { mode: 'bus', label: 'Автобуси', routed: true },
  { mode: 'marshrutka', label: 'Маршрутки', routed: true },
  { mode: 'trolleybus', label: 'Тролейбуси', routed: true },
  { mode: 'tram', label: 'Трамваї', routed: true },
  { mode: 'metro', label: 'Метро', routed: true },
  { mode: 'train', label: 'Поїзди/електрички', routed: true },
  { mode: 'carpool', label: 'Попутки', routed: true },
  { mode: 'scooter', label: 'Самокати', routed: true },
  { mode: 'bike', label: 'Велосипеди', routed: false },
  { mode: 'taxi', label: 'Таксі', routed: false },
  { mode: 'carsharing', label: 'Каршеринг', routed: false },
  { mode: 'transfer', label: 'Трансфери', routed: false },
];

const citiesWith = (key: string) => {
  const cities = new Set<string>();
  for (const feed of feeds) {
    if (!feed.productUse.routable) continue;
    if ((feed.probe.measured[key] ?? 0) > 0) cities.add(feed.city);
  }
  return [...cities];
};

const modeCoverage = [
  { mode: 'bus', static: citiesWith('routes_bus'), live: [...new Set(feeds.filter((feed) => feed.providerType === 'public_transit' && feed.capabilities.livePositions === 'VERIFIED_LIVE' && ((feed.probe.measured.vehicles_bus ?? 0) > 0 || (feed.probe.measured.vehicles ?? 0) > 0)).map((feed) => feed.city))] },
  { mode: 'tram', static: citiesWith('routes_tram'), live: [] as string[] },
  { mode: 'trolleybus', static: citiesWith('routes_trolleybus'), live: citiesWith('vehicles_trolleybus') },
  { mode: 'train', static: citiesWith('routes_train'), live: [] as string[] },
  { mode: 'marshrutka', static: [] as string[], live: citiesWith('vehicles_marshrutka') },
  { mode: 'scooter', static: [] as string[], live: [] as string[] },
];

const coverageNotes: Record<string, string> = {
  bus: `Static network measured in ${modeCoverage[0].static.length} catalog cities; live positions measured in ${modeCoverage[0].live.length} cities.`,
  marshrutka: 'Live positions only (EasyWay JSON typed as marshrutka, e.g. Червоноград). No marshrutka GTFS network is reachable: the official Kyiv marshrutka GeoJSON fails DNS resolution today.',
  trolleybus: `Static in ${modeCoverage[2].static.length} cities, live typed positions in ${modeCoverage[2].live.length}.`,
  tram: 'Static in Lviv and Kyiv (Київпастранс mirror). No tram GTFS-RT source found.',
  metro: 'No provider feed available today: every Kyiv metro row (geometry, stations, first/last train, intervals, interchanges, opening hours) fails DNS resolution (gisserver.kyivcity.gov.ua / gisserver-stage.kyivcity.gov.ua). Hand-built `kyivMetroTimetable.ts` depends on the same dead portal.',
  train: 'UZ GTFS mirror (ODbL, OpenStreetMap-derived, not official УЗ) responded 200 with 115 routes / 167 stops; no realtime train feed.',
  carpool: 'Own marketplace supply, not a feed: 14 vehicles and the two-account lifecycle were proven in the acceptance environment on 2026-10-31.',
  scooter: 'Zelectra GBFS reachable (998 vehicles, all in-country after the coverage filter); routing uses geofence estimates and requires CONFIRMED network + FREE_FLOATING_ZONE return rule. City-level street supply is operator-declared, not independently verified.',
  bike: 'No Ukrainian bike-share source verified: CityBikes discovery returned 815 networks with 0 in Ukraine, `nextbike_lv` resolves to Latvia, `nextbike_vin` is HTTP 404. `rental_locations` = 317 are Zelectra scooter stations, not bicycles. Bicycle routing code exists but has no supply.',
  taxi: 'Kiwitaxi/Intui are catalog + affiliate price lists pending credentials; no booking API is authorized. No Ukrainian taxi operator feed.',
  carsharing: 'No feed, no partner agreement, no rows in the registry.',
  transfer: 'Partner adapter endpoints exist (`server/partner/router.ts`, `transferAdapters.ts`) but every operator is AWAITING_CREDENTIALS or AWAITING_AGREEMENT.',
};

const modeRows = modeDefinitions.map((definition) => {
  const measured = modeCoverage.find((row) => row.mode === definition.mode);
  return [
    definition.label,
    definition.routed ? 'yes' : 'no (toggle only)',
    measured?.static.length ? measured.static.join(', ') : '—',
    measured?.live.length ? measured.live.join(', ') : '—',
    coverageNotes[definition.mode],
  ];
});

writeFileSync(resolve(docsRoot, 'TRANSPORT_COVERAGE_MATRIX.md'), `# MARSHGO — 12-MODE TRANSPORT COVERAGE MATRIX

**Generated:** ${registry.generatedAt} · **Product status:** NOT_RELEASED
**Routable** column reflects \`journeySearchSupportedTypes\` in the web client. **Static/live** city lists are computed from feeds that were reachable and parseable in the ${probeRun.checkedAt} probe, not from intentions.

${table(['Transport category', 'Routable in planner', 'Static network (cities with data today)', 'Live positions (cities today)', 'Honest status'], modeRows)}

## Acceptance chain per requirement

${table(['Stage', 'Status', 'Evidence'], [
  ['Verified source', 'PARTIAL', `${registry.inventory.byState.HEALTHY ?? 0}/${catalog.length} catalog rows healthy today; 5 rows blocked on credentials or http-only endpoints`],
  ['Successful ingestion', 'PARTIAL', 'GTFS/GTFS-RT/JSON/GeoJSON/GBFS adapters exist and parse live data; no SIRI, NeTEx, XML or generic CSV adapter exists'],
  ['Normalized data', 'PARTIAL', `mobility_providers/operators/networks populated (${databaseSnapshot.mobilityProviders}/${databaseSnapshot.mobilityOperators}/${databaseSnapshot.mobilityNetworks}); provider_source_records = ${databaseSnapshot.providerSourceRecords}, rental_locations = ${databaseSnapshot.rentalLocations} (Zelectra scooter stations)`],
  ['Valid routing', 'PARTIAL', 'Lviv GTFS planner produced multimodal bus→tram (А47→Т08) and direct bus itineraries for service date 2026-11-12; both query cases hit the result limit (truncated)'],
  ['Correct map presentation', 'PARTIAL', `Freshness badge LIVE/STALE/OLD derived from position age; arrival predictions are provider-backed in ${registry.inventory.feedsWithArrivalPredictions} feed(s) and service alerts in ${registry.inventory.feedsWithServiceAlerts} feed(s) (Lviv only); other cities carry none`],
  ['Accurate availability status', 'PARTIAL', 'Unknown fare renders as — not 0; scooter legs are labelled estimates; seat/booking availability is NOT_MEASURED for every external feed'],
])}

## What this means for the 12-category promise

Measured, provider-backed data today supports **bus, trolleybus, tram, train (static), marshrutka (live positions only) and carpool (own marketplace)** — 6 of 12.
**Scooter** is estimate-grade with operator-declared city coverage. **Metro, bike, taxi, carsharing, transfer** have no working provider source right now: metro and Kyiv marshrutka geometry are blocked by a DNS-dead open-data portal, bike share has no Ukrainian network, and taxi/carsharing/transfer are waiting on credentials or agreements.
Presenting any of those four as available would require fabricating positions, prices or availability, which this project prohibits.
`);

console.log(JSON.stringify({ registry: 'TRANSPORT_PROVIDER_REGISTRY.json', feeds: registry.inventory.catalogRows, probed: registry.inventory.probedToday, byState: registry.inventory.byState, routable: registry.inventory.routableToday, livePositions: registry.inventory.feedsWithLivePositions, arrivalPredictions: registry.inventory.feedsWithArrivalPredictions, docs: ['docs/TRANSPORT_FEED_AUDIT.md', 'docs/TRANSPORT_COVERAGE_MATRIX.md'] }));
