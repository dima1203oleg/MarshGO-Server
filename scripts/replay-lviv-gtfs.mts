import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const zipPath = process.env.GTFS_REPLAY_ZIP;
if (!zipPath) throw new Error('Set GTFS_REPLAY_ZIP to a frozen Lviv GTFS archive.');
const require = createRequire(resolve(process.cwd(), 'package.json'));
const { unzipSync } = require('fflate');
const { parseGtfsTimetable, findGtfsItinerariesWithStats, rankGtfsItinerariesForCandidateSampling } =
  await import(pathToFileURL(resolve(process.cwd(), 'server/journey/gtfsTimetable.ts')).href);
const archive = readFileSync(zipPath);
const archiveSha256 = createHash('sha256').update(archive).digest('hex');
const expectedSha256 = process.env.GTFS_REPLAY_EXPECTED_SHA256;
if (expectedSha256 && archiveSha256 !== expectedSha256) {
  throw new Error(`Frozen GTFS SHA mismatch: expected ${expectedSha256}, got ${archiveSha256}`);
}
const files = Object.fromEntries(Object.entries(unzipSync(archive))
  .filter(([name]) => !name.endsWith('/')).map(([name, bytes]) => [name, bytes]));
const feed = parseGtfsTimetable(files, new Date('2026-10-22T08:00:00.000Z'));
const parseCoordinates = (value: string | undefined, fallback: [number, number]) => {
  if (!value) return fallback;
  const coordinates = value.split(',').map(Number);
  if (coordinates.length !== 2 || coordinates.some((coordinate) => !Number.isFinite(coordinate))) {
    throw new Error('GTFS_REPLAY_ORIGIN and GTFS_REPLAY_DESTINATION must be lon,lat pairs.');
  }
  return coordinates as [number, number];
};
const origin = parseCoordinates(process.env.GTFS_REPLAY_ORIGIN, [24.008217, 49.864885]);
const destination = parseCoordinates(process.env.GTFS_REPLAY_DESTINATION, [24.0175835, 49.8013165]);
const traceRouteIds = new Set((process.env.GTFS_REPLAY_TRACE_ROUTE_IDS ?? '')
  .split(',').map((routeId) => routeId.trim()).filter(Boolean));
const retainedTripGroupsByRoute = new Map<string, Map<string, { serviceDate: string; tripId: string; segments: number }>>();
const graphObserver = traceRouteIds.size > 0
  ? (graph: { segments: readonly { journey: { routeId: string; serviceDate: string; tripId: string } }[] }) => {
    for (const { journey } of graph.segments) {
      if (!traceRouteIds.has(journey.routeId)) continue;
      const routeGroups = retainedTripGroupsByRoute.get(journey.routeId) ?? new Map();
      retainedTripGroupsByRoute.set(journey.routeId, routeGroups);
      const key = `${journey.serviceDate}:${journey.tripId}`;
      const group = routeGroups.get(key) ?? { serviceDate: journey.serviceDate, tripId: journey.tripId, segments: 0 };
      group.segments += 1;
      routeGroups.set(key, group);
    }
  }
  : undefined;
const startedAt = performance.now();
const searchDiagnosticsByStage: Record<string, Record<string, unknown>> = {};
const originalConsoleInfo = console.info.bind(console);
const previousDebugSetting = process.env.MARSHGO_GTFS_SEARCH_DEBUG;
const previousTraceSetting = process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS;
process.env.MARSHGO_GTFS_SEARCH_DEBUG = '1';
if (process.env.GTFS_REPLAY_TRACE_TRIP_CHAINS) {
  process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS = process.env.GTFS_REPLAY_TRACE_TRIP_CHAINS;
} else {
  delete process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS;
}
console.info = (...args: unknown[]) => {
  if (typeof args[0] === 'string') {
    try {
      const record = JSON.parse(args[0]) as Record<string, unknown>;
      if (record.event === 'gtfs.search.debug') {
        if (typeof record.stage === 'string' && ['segments-built', 'reachability-built', 'itineraries-ranked'].includes(record.stage)) {
          const { elapsedMs: _elapsedMs, heapUsedBytes: _heapUsedBytes, rssBytes: _rssBytes, ...stable } = record;
          searchDiagnosticsByStage[record.stage] = stable;
        }
        return;
      }
    } catch {
      // Preserve unrelated diagnostic output rather than swallowing it.
    }
  }
  originalConsoleInfo(...args);
};
let result: ReturnType<typeof findGtfsItinerariesWithStats>;
try {
  result = findGtfsItinerariesWithStats(feed, {
    providerId: 'lviv-frozen-replay', providerName: 'Lviv frozen GTFS', providerCity: 'Львів',
    origin, destination,
    earliestDeparture: new Date('2026-10-23T05:00:00.000Z'),
    latestDeparture: new Date('2026-10-23T05:30:00.000Z'),
    maximumJourneySeconds: 6 * 60 * 60, maximumTransfers: 2,
    maximumAccessWalkingMeters: 900, maximumEgressWalkingMeters: 1000,
    maximumTransferWalkingMeters: 400, minimumTransferBufferSeconds: 180,
    maximumWaitSeconds: 4 * 60 * 60, limit: 100,
    now: new Date('2026-10-22T08:00:00.000Z'),
  }, {}, graphObserver);
} finally {
  console.info = originalConsoleInfo;
  if (previousDebugSetting === undefined) delete process.env.MARSHGO_GTFS_SEARCH_DEBUG;
  else process.env.MARSHGO_GTFS_SEARCH_DEBUG = previousDebugSetting;
  if (previousTraceSetting === undefined) delete process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS;
  else process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS = previousTraceSetting;
}
const fastest = [...result.itineraries].sort((a, b) => a.durationSeconds - b.durationSeconds || a.id.localeCompare(b.id))[0];
const cheapest = [...result.itineraries].filter((item) => item.fare?.currency === 'UAH')
  .sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor || a.durationSeconds - b.durationSeconds || a.id.localeCompare(b.id))[0];
const balanced = rankGtfsItinerariesForCandidateSampling(result.itineraries)[0];
const signature = (item: typeof result.itineraries[number] | undefined) => item?.id ?? null;
const details = result as typeof result & Record<string, unknown>;
console.log(JSON.stringify({
  comparisonGroup: process.env.REPLAY_GROUP ?? null,
  revision: process.env.REPLAY_REF ?? null,
  iteration: process.env.BENCH_ITER ?? null,
  origin,
  destination,
  archiveSha256,
  runtime: process.version,
  searchMs: Number((performance.now() - startedAt).toFixed(2)),
  heapUsedBytes: process.memoryUsage().heapUsed,
  rssBytes: process.memoryUsage().rss,
  returned: result.itineraries.length,
  idHash: createHash('sha256').update(result.itineraries.map(({ id }) => id).join('\n')).digest('hex'),
  uniqueTripChains: new Set(result.itineraries.map((item) => item.segments.map((segment) => segment.tripId).join(','))).size,
  tripChainIds: [...new Set(result.itineraries.map((item) => item.segments
    .map((segment) => `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>')))].sort(),
  uniqueRouteChains: new Set(result.itineraries.map((item) => item.segments.map((segment) => segment.routeId).join(','))).size,
  strategyCandidates: { balanced: signature(balanced), fastest: signature(fastest), cheapest: signature(cheapest) },
  searchTruncated: details.searchTruncated,
  candidateGraphTruncated: details.candidateGraphTruncated,
  truncation: result.truncation,
  ...(traceRouteIds.size > 0 ? { retainedTripGroupsByRoute: Object.fromEntries([...traceRouteIds].sort()
    .map((routeId) => [routeId, [...(retainedTripGroupsByRoute.get(routeId)?.values() ?? [])]
      .sort((left, right) => left.serviceDate.localeCompare(right.serviceDate)
        || left.tripId.localeCompare(right.tripId))])) } : {}),
  searchDiagnosticsByStage,
}, null, 2));
