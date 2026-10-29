import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const archivePath = process.env.GTFS_REPLAY_ZIP;
if (!archivePath) throw new Error('Set GTFS_REPLAY_ZIP to a frozen Lviv GTFS archive.');

const require = createRequire(resolve(process.cwd(), 'package.json'));
const { unzipSync } = require('fflate');
const { parseGtfsTimetable, findGtfsItinerariesWithStats } =
  await import(pathToFileURL(resolve(process.cwd(), 'server/journey/gtfsTimetable.ts')).href);
const { scoreJourneys } = await import(pathToFileURL(resolve(process.cwd(), 'server/journey/scoring.ts')).href);

const archive = readFileSync(archivePath);
const archiveSha256 = createHash('sha256').update(archive).digest('hex');
const expectedSha256 = process.env.GTFS_REPLAY_EXPECTED_SHA256;
if (expectedSha256 && archiveSha256 !== expectedSha256) {
  throw new Error(`Frozen GTFS SHA mismatch: expected ${expectedSha256}, got ${archiveSha256}`);
}

const files = Object.fromEntries(Object.entries(unzipSync(archive))
  .filter(([name]) => !name.endsWith('/')).map(([name, bytes]) => [name, bytes]));
const feed = parseGtfsTimetable(files, new Date('2026-10-22T08:00:00.000Z'));
const queryStart = new Date('2026-10-23T05:00:00.000Z');
const queryEnd = new Date('2026-10-23T05:30:00.000Z');
const now = new Date('2026-10-22T08:00:00.000Z');
const cases = [
  { id: 'holosko-sykhiv', origin: [24.008217, 49.864885] as [number, number], destination: [24.0175835, 49.8013165] as [number, number] },
  { id: 'naukova-sykhiv', origin: [23.982540, 49.805403] as [number, number], destination: [24.058326, 49.791880] as [number, number] },
  { id: 'rynok-dubliany', origin: [24.032271, 49.841463] as [number, number], destination: [24.086526, 49.904511] as [number, number] },
];

for (const routeCase of cases) {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
  const startedAt = performance.now();
  const result = findGtfsItinerariesWithStats(feed, {
    providerId: 'lviv-frozen-replay', providerName: 'Lviv frozen GTFS', providerCity: 'Львів',
    origin: routeCase.origin, destination: routeCase.destination,
    earliestDeparture: queryStart, latestDeparture: queryEnd, now,
    maximumJourneySeconds: 6 * 60 * 60, maximumTransfers: 2,
    maximumAccessWalkingMeters: 900, maximumEgressWalkingMeters: 1000,
    maximumTransferWalkingMeters: 400, minimumTransferBufferSeconds: 180,
    maximumWaitSeconds: 4 * 60 * 60, limit: 100,
  });
  const candidates = result.itineraries.map((journey) => ({
    id: journey.id,
    durationSeconds: journey.durationSeconds,
    priceMinor: journey.fare?.currency === 'UAH' ? journey.fare.priceMinor : null,
    transfers: journey.transfers,
    walkingMeters: journey.walkingMeters,
    reliability: null,
    transferRisk: journey.transfers > 0 ? 0.25 : 0,
    comfort: null,
    legs: journey.segments.map((segment) => ({ mode: segment.mode })),
  }));
  const winners = Object.fromEntries((['FASTEST', 'CHEAPEST', 'BALANCED'] as const)
    .map((strategy) => [strategy, scoreJourneys(candidates, strategy)[0]?.journey.id ?? null]));
  console.log(JSON.stringify({
    case: routeCase.id,
    archiveSha256,
    runtime: process.version,
    elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
    heapUsedBytes: process.memoryUsage().heapUsed,
    rssBytes: process.memoryUsage().rss,
    returned: result.itineraries.length,
    uniqueTripChains: new Set(result.itineraries.map((item) => item.segments.map((segment) => segment.tripId).join('>'))).size,
    uniqueRouteChains: new Set(result.itineraries.map((item) => item.segments.map((segment) => segment.routeId).join('>'))).size,
    resultHash: createHash('sha256').update(result.itineraries.map(({ id }) => id).join('\n')).digest('hex'),
    winners,
    searchTruncated: result.searchTruncated,
    resultLimitReached: result.resultLimitReached,
  }));
}
