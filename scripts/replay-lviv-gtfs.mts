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
const startedAt = performance.now();
const result = findGtfsItinerariesWithStats(feed, {
  providerId: 'lviv-frozen-replay', providerName: 'Lviv frozen GTFS', providerCity: 'Львів',
  origin, destination,
  earliestDeparture: new Date('2026-10-23T05:00:00.000Z'),
  latestDeparture: new Date('2026-10-23T05:30:00.000Z'),
  maximumJourneySeconds: 6 * 60 * 60, maximumTransfers: 2,
  maximumAccessWalkingMeters: 900, maximumEgressWalkingMeters: 1000,
  maximumTransferWalkingMeters: 400, minimumTransferBufferSeconds: 180,
  maximumWaitSeconds: 4 * 60 * 60, limit: 100,
  now: new Date('2026-10-22T08:00:00.000Z'),
});
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
  uniqueRouteChains: new Set(result.itineraries.map((item) => item.segments.map((segment) => segment.routeId).join(','))).size,
  strategyCandidates: { balanced: signature(balanced), fastest: signature(fastest), cheapest: signature(cheapest) },
  searchTruncated: details.searchTruncated,
  candidateGraphTruncated: details.candidateGraphTruncated,
  truncation: result.truncation,
}, null, 2));
