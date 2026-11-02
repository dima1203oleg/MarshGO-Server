import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { GtfsCandidateGraphSnapshot } from '../server/journey/gtfsTimetable';

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
const earliestDeparture = new Date(process.env.GTFS_REPLAY_EARLIEST_DEPARTURE ?? '2026-10-23T05:00:00.000Z');
const latestDeparture = new Date(process.env.GTFS_REPLAY_LATEST_DEPARTURE ?? '2026-10-23T05:30:00.000Z');
if (!Number.isFinite(earliestDeparture.getTime()) || !Number.isFinite(latestDeparture.getTime())
  || latestDeparture < earliestDeparture) {
  throw new Error('GTFS_REPLAY_EARLIEST_DEPARTURE and GTFS_REPLAY_LATEST_DEPARTURE must be valid ordered timestamps.');
}
const resultLimit = Number(process.env.GTFS_REPLAY_RESULT_LIMIT ?? 100);
if (!Number.isSafeInteger(resultLimit) || resultLimit < 1 || resultLimit > 100) {
  throw new Error('GTFS_REPLAY_RESULT_LIMIT must be an integer from 1 to 100.');
}
const targetTripIds = (process.env.GTFS_REPLAY_TARGET_TRIP_CHAIN ?? '').split('>').filter(Boolean);
const traceTargetGraph = process.env.GTFS_REPLAY_TRACE_TARGET_GRAPH === '1' && targetTripIds.length >= 2;
let targetGraphTrace: Record<string, unknown> | null = null;
const observeTargetGraph = traceTargetGraph ? (snapshot: GtfsCandidateGraphSnapshot) => {
  const journeyById = new Map(snapshot.segments.map(({ id, journey }) => [id, journey] as const));
  const segmentInstances = Object.fromEntries(targetTripIds.map((tripId) => [tripId,
    snapshot.segments.filter(({ journey }) => journey.tripId === tripId).length]));
  const examples: Array<Record<string, unknown>> = [];
  const maximumTraceSteps = 10_000;
  let traceSteps = 0;
  let traceTruncated = false;
  let completeTargetPaths = 0;
  let transferFeasibleTargetPaths = 0;

  const visit = (path: string[], nextIndex: number, transfersFeasible: boolean) => {
    if (traceTruncated) return;
    const previousId = path.at(-1)!;
    if (nextIndex >= targetTripIds.length) {
      const last = journeyById.get(previousId);
      if (!last || !snapshot.destinationStopIds.includes(last.destinationStop.id)) return;
      completeTargetPaths++;
      if (transfersFeasible) transferFeasibleTargetPaths++;
      if (examples.length < 3) {
        examples.push({
          segments: path.map((id) => {
            const journey = journeyById.get(id)!;
            return {
              tripId: journey.tripId,
              fromStopId: journey.originStop.id,
              toStopId: journey.destinationStop.id,
              departureAt: journey.departureAt.toISOString(),
              arrivalAt: journey.arrivalAt.toISOString(),
            };
          }),
          transfersFeasible,
        });
      }
      return;
    }

    const remainingLegs = targetTripIds.length - nextIndex;
    for (const nextId of snapshot.successors(previousId, remainingLegs)) {
      if (traceSteps >= maximumTraceSteps) {
        traceTruncated = true;
        return;
      }
      traceSteps++;
      if (journeyById.get(nextId)?.tripId !== targetTripIds[nextIndex]) continue;
      const decision = snapshot.transferDecision(previousId, nextId);
      visit([...path, nextId], nextIndex + 1, transfersFeasible && decision.feasible);
    }
  };

  for (const firstId of snapshot.firstLegIds) {
    if (journeyById.get(firstId)?.tripId === targetTripIds[0]) visit([firstId], 1, true);
  }
  targetGraphTrace = {
    targetTripIds,
    segmentInstances,
    firstLegInstances: snapshot.firstLegIds.filter((id) => journeyById.get(id)?.tripId === targetTripIds[0]).length,
    completeTargetPaths,
    transferFeasibleTargetPaths,
    traceSteps,
    traceTruncated,
    examples,
  };
} : undefined;
const startedAt = performance.now();
const result = findGtfsItinerariesWithStats(feed, {
  providerId: 'lviv-frozen-replay', providerName: 'Lviv frozen GTFS', providerCity: 'Львів',
  origin, destination,
  earliestDeparture,
  latestDeparture,
  maximumJourneySeconds: 6 * 60 * 60, maximumTransfers: 2,
  maximumAccessWalkingMeters: 900, maximumEgressWalkingMeters: 1000,
  maximumTransferWalkingMeters: 400, minimumTransferBufferSeconds: 180,
  maximumWaitSeconds: 4 * 60 * 60, limit: resultLimit,
  now: new Date('2026-10-22T08:00:00.000Z'),
}, {}, observeTargetGraph);
const fastest = [...result.itineraries].sort((a, b) => a.durationSeconds - b.durationSeconds || a.id.localeCompare(b.id))[0];
const cheapest = [...result.itineraries].filter((item) => item.fare?.currency === 'UAH')
  .sort((a, b) => a.fare!.priceMinor - b.fare!.priceMinor || a.durationSeconds - b.durationSeconds || a.id.localeCompare(b.id))[0];
const balanced = rankGtfsItinerariesForCandidateSampling(result.itineraries)[0];
const signature = (item: typeof result.itineraries[number] | undefined) => item?.id ?? null;
const details = result as typeof result & Record<string, unknown>;
console.log(JSON.stringify({
  iteration: process.env.BENCH_ITER ?? null,
  origin,
  destination,
  earliestDeparture: earliestDeparture.toISOString(),
  latestDeparture: latestDeparture.toISOString(),
  resultLimit,
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
  targetTripChain: targetTripIds.length ? {
    tripIds: targetTripIds,
    returned: result.itineraries.some((itinerary) => itinerary.segments.map((segment) => segment.tripId).join('>')
      === targetTripIds.join('>')),
  } : null,
  targetGraphTrace,
  searchTruncated: details.searchTruncated,
  resultLimitReached: result.resultLimitReached,
  candidateGraphTruncated: details.candidateGraphTruncated,
  truncation: result.truncation,
}, null, 2));
