import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { lazyEventLabelSearch } from '../tests/helpers/gtfs-lazy-event-label-search';

const zipPath = process.env.GTFS_REPLAY_ZIP;
if (!zipPath) throw new Error('Set GTFS_REPLAY_ZIP to a frozen Lviv GTFS archive.');
const require = createRequire(resolve(process.cwd(), 'package.json'));
const { unzipSync } = require('fflate');
const { parseGtfsTimetable, findGtfsItinerariesWithStats } =
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
const input = {
  providerId: 'lviv-frozen-replay', providerName: 'Lviv frozen GTFS', providerCity: 'Львів',
  origin: [24.008217, 49.864885] as [number, number], destination: [24.0175835, 49.8013165] as [number, number],
  earliestDeparture: new Date('2026-10-23T05:00:00.000Z'),
  latestDeparture: new Date('2026-10-23T05:30:00.000Z'),
  maximumJourneySeconds: 6 * 60 * 60, maximumTransfers: 2,
  maximumAccessWalkingMeters: 900, maximumEgressWalkingMeters: 1000,
  maximumTransferWalkingMeters: 400, minimumTransferBufferSeconds: 180,
  maximumWaitSeconds: 4 * 60 * 60, limit: 100,
  now: new Date('2026-10-22T08:00:00.000Z'),
};
let selectedStops: { origins: readonly string[]; destinations: readonly string[] } | undefined;
const production = findGtfsItinerariesWithStats(feed, input, {}, (graph) => {
  selectedStops = { origins: graph.originStopIds, destinations: graph.destinationStopIds };
});
if (!selectedStops) throw new Error('Production search did not expose its stop-selection snapshot.');

const startedAt = performance.now();
const eventResult = lazyEventLabelSearch(feed, {
  originStopIds: selectedStops.origins,
  destinationStopIds: selectedStops.destinations,
  serviceDates: ['20261022', '20261023'],
  earliestDeparture: input.earliestDeparture,
  latestDeparture: input.latestDeparture,
  journeyEndAt: new Date(input.earliestDeparture.getTime() + input.maximumJourneySeconds * 1000),
  maximumJourneySeconds: input.maximumJourneySeconds,
  maximumTransfers: input.maximumTransfers,
  maximumWaitSeconds: input.maximumWaitSeconds,
  transferRadiusMeters: input.maximumTransferWalkingMeters,
  minimumTransferBufferSeconds: input.minimumTransferBufferSeconds,
  providerId: input.providerId,
  providerName: input.providerName,
  providerCity: input.providerCity,
  maximumExpandedLabels: Number(process.env.MAX_EXPANDED_LABELS ?? 10_000),
});

const paths = [...eventResult.identities.values()];
const tripChains = new Set(paths.map((path) => path.tripIds.join('>')));
const routeChains = new Set(paths.map((path) => path.path.map((leg) => leg.journey.routeId).join('>')));
const identityHash = createHash('sha256').update(paths.map((path) => path.identity).sort().join('\n')).digest('hex');
console.log(JSON.stringify({
  archiveSha256,
  runtime: process.version,
  maxExpandedLabels: Number(process.env.MAX_EXPANDED_LABELS ?? 10_000),
  eventSearchMs: Number((performance.now() - startedAt).toFixed(2)),
  heapUsedBytes: process.memoryUsage().heapUsed,
  rssBytes: process.memoryUsage().rss,
  selectedOriginStops: selectedStops.origins.length,
  selectedDestinationStops: selectedStops.destinations.length,
  legacySearchTruncated: production.searchTruncated,
  legacyCandidateGraphTruncated: production.candidateGraphTruncated,
  indexedBoardingExpansions: eventResult.materializedBoardingExpansions,
  projectedSegmentCount: eventResult.materializedLegs,
  expandedLabels: eventResult.expandedLabels,
  eventSearchTruncated: eventResult.searchTruncated,
  destinationPaths: paths.length,
  uniqueTripChains: tripChains.size,
  uniqueRouteChains: routeChains.size,
  identityHash,
}, null, 2));
