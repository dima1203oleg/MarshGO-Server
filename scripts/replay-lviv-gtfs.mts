import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const zipPath = process.env.GTFS_REPLAY_ZIP;
if (!zipPath) throw new Error('Set GTFS_REPLAY_ZIP to a frozen Lviv GTFS archive.');
const sourceRoot = resolve(process.env.REPLAY_SOURCE_ROOT ?? process.cwd());
const candidateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(sourceRoot, 'package.json'));
const { unzipSync } = require('fflate');
const { parseGtfsTimetable, findGtfsItinerariesWithStats } =
  await import(pathToFileURL(resolve(sourceRoot, 'server/journey/gtfsTimetable.ts')).href);
const { toRankedGtfsItinerary } =
  await import(pathToFileURL(resolve(candidateRoot, 'server/journey/gtfsRanking.ts')).href);
const { selectStrategyAlternatives, strategiesWithComparablePrices } =
  await import(pathToFileURL(resolve(sourceRoot, 'server/journey/scoring.ts')).href);
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
const departureStartUtc = process.env.GTFS_REPLAY_DEPARTURE_START_UTC ?? '2026-10-23T05:00:00.000Z';
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(departureStartUtc)) {
  throw new Error('GTFS_REPLAY_DEPARTURE_START_UTC must be an ISO 8601 UTC timestamp ending in Z.');
}
const earliestDeparture = new Date(departureStartUtc);
if (!Number.isFinite(earliestDeparture.getTime())) throw new Error('GTFS replay departure start is invalid.');
const departureWindowMinutes = Number(process.env.GTFS_REPLAY_DEPARTURE_WINDOW_MINUTES ?? '30');
if (!Number.isInteger(departureWindowMinutes) || departureWindowMinutes < 1 || departureWindowMinutes > 180) {
  throw new Error('GTFS_REPLAY_DEPARTURE_WINDOW_MINUTES must be an integer from 1 to 180.');
}
const objectiveReservoirSearchStepsValue = process.env.GTFS_REPLAY_OBJECTIVE_RESERVOIR_SEARCH_STEPS;
const objectiveReservoirSearchSteps = objectiveReservoirSearchStepsValue === undefined || objectiveReservoirSearchStepsValue === ''
  ? undefined
  : Number(objectiveReservoirSearchStepsValue);
if (objectiveReservoirSearchSteps !== undefined
  && (!Number.isSafeInteger(objectiveReservoirSearchSteps) || objectiveReservoirSearchSteps < 1 || objectiveReservoirSearchSteps > 200_000)) {
  throw new Error('GTFS_REPLAY_OBJECTIVE_RESERVOIR_SEARCH_STEPS must be an integer from 1 to 200000.');
}
const latestDeparture = new Date(earliestDeparture.getTime() + departureWindowMinutes * 60_000);
const traceRouteIds = new Set((process.env.GTFS_REPLAY_TRACE_ROUTE_IDS ?? '')
  .split(',').map((routeId) => routeId.trim()).filter(Boolean));
const traceTripIds = new Set((process.env.GTFS_REPLAY_TRACE_TRIP_IDS ?? '')
  .split(',').map((tripId) => tripId.trim()).filter(Boolean));
const traceTripChains = (process.env.GTFS_REPLAY_TRACE_TRIP_CHAINS ?? '')
  .split(',').map((tripChain) => tripChain.trim()).filter(Boolean);
const traceCandidateTripIds = new Set((process.env.GTFS_REPLAY_TRACE_CANDIDATE_TRIP_IDS ?? '')
  .split(',').map((tripId) => tripId.trim()).filter(Boolean));
if (traceCandidateTripIds.size > 2) {
  throw new Error('GTFS_REPLAY_TRACE_CANDIDATE_TRIP_IDS accepts at most two trip IDs.');
}
const debugDiagnosticsEnabled = process.env.GTFS_REPLAY_DEBUG_DIAGNOSTICS !== 'false';
if (!debugDiagnosticsEnabled && [traceTripChains.length, traceRouteIds.size, traceTripIds.size, traceCandidateTripIds.size].some((size) => size > 0)) {
  throw new Error('GTFS_REPLAY_DEBUG_DIAGNOSTICS=false cannot be combined with trace inputs.');
}
const retainedTripGroupsByRoute = new Map<string, Map<string, { serviceDate: string; tripId: string; segments: number }>>();
const retainedSegmentsByTripId = new Map<string, Map<string, {
  routeId: string;
  serviceDate: string;
  tripId: string;
  originStopId: string;
  destinationStopId: string;
  departureAt: string;
  arrivalAt: string;
}>>();
let targetChainGraphTrace: Record<string, unknown> | undefined;
const graphObserver = traceRouteIds.size > 0 || traceTripIds.size > 0
  ? (graph: { segments: readonly { id: string; journey: {
    providerId: string; routeId: string; serviceDate: string; tripId: string;
    originStop: { id: string }; destinationStop: { id: string };
    departureAt: Date; arrivalAt: Date;
  } }[]; firstLegIds: readonly string[];
    successors(previousId: string, remainingLegs: number): readonly string[];
    transferDecision(previousId: string, nextId: string): { feasible: boolean; requiredSeconds: number;
      minimumBufferSeconds: number; measure: { walkingMeters: number; walkingSeconds: number } };
  }) => {
    if (traceTripChains.length > 0) {
      const tripKey = (journey: { providerId: string; serviceDate: string; tripId: string }) =>
        `${journey.providerId}:${journey.serviceDate}:${journey.tripId}`;
      const byId = new Map(graph.segments.map((segment) => [segment.id, segment]));
      targetChainGraphTrace = Object.fromEntries(traceTripChains.map((tripChain) => {
        const targetTrips = tripChain.split('>');
        const targetSegments = targetTrips.map((key) => graph.segments
          .filter((segment) => tripKey(segment.journey) === key));
        const firstLegIds = new Set(graph.firstLegIds);
        const firstCandidates = targetSegments[0]?.filter((segment) => firstLegIds.has(segment.id)) ?? [];
        let paths = firstCandidates.map((segment) => [segment.id]);
        const transitions = [];
        for (let index = 0; index < targetTrips.length - 1; index++) {
          const nextIds = new Set((targetSegments[index + 1] ?? []).map((segment) => segment.id));
          const matchingEdges: Array<Record<string, unknown>> = [];
          const nextPaths: string[][] = [];
          for (const path of paths) {
            const previousId = path.at(-1)!;
            const previous = byId.get(previousId)!;
            for (const nextId of graph.successors(previousId, targetTrips.length - index - 1)) {
              if (!nextIds.has(nextId)) continue;
              const next = byId.get(nextId)!;
              const availableSeconds = Math.floor((next.journey.departureAt.getTime()
                - previous.journey.arrivalAt.getTime()) / 1000);
              const decision = graph.transferDecision(previousId, nextId);
              matchingEdges.push({ previous: previousId, next: nextId,
                fromStopId: previous.journey.destinationStop.id, toStopId: next.journey.originStop.id,
                previousArrivalAt: previous.journey.arrivalAt.toISOString(),
                nextDepartureAt: next.journey.departureAt.toISOString(), availableSeconds,
                withinWaitHorizon: availableSeconds >= 0 && availableSeconds <= 4 * 60 * 60,
                transferFeasible: decision.feasible, requiredSeconds: decision.requiredSeconds,
                minimumBufferSeconds: decision.minimumBufferSeconds,
                walkingMeters: decision.measure.walkingMeters, walkingSeconds: decision.measure.walkingSeconds });
              if (availableSeconds >= 0 && availableSeconds <= 4 * 60 * 60 && decision.feasible) {
                nextPaths.push([...path, nextId]);
              }
            }
          }
          transitions.push({ fromTrip: targetTrips[index], toTrip: targetTrips[index + 1],
            predecessorStates: paths.length, matchingSuccessorEdges: matchingEdges.length, edges: matchingEdges });
          paths = nextPaths;
        }
        return [tripChain, { retainedSegmentCounts: targetSegments.map((segments) => segments.length),
          firstLegCandidateCount: firstCandidates.length, feasiblePathCount: paths.length,
          paths: paths.slice(0, 16), transitions }];
      }));
    }
    for (const { id, journey } of graph.segments) {
      if (traceRouteIds.has(journey.routeId)) {
        const routeGroups = retainedTripGroupsByRoute.get(journey.routeId) ?? new Map();
        retainedTripGroupsByRoute.set(journey.routeId, routeGroups);
        const key = `${journey.serviceDate}:${journey.tripId}`;
        const group = routeGroups.get(key) ?? { serviceDate: journey.serviceDate, tripId: journey.tripId, segments: 0 };
        group.segments += 1;
        routeGroups.set(key, group);
      }
      if (!traceTripIds.has(journey.tripId)) continue;
      const tripSegments = retainedSegmentsByTripId.get(journey.tripId) ?? new Map();
      retainedSegmentsByTripId.set(journey.tripId, tripSegments);
      tripSegments.set(id, {
        routeId: journey.routeId,
        serviceDate: journey.serviceDate,
        tripId: journey.tripId,
        originStopId: journey.originStop.id,
        destinationStopId: journey.destinationStop.id,
        departureAt: journey.departureAt.toISOString(),
        arrivalAt: journey.arrivalAt.toISOString(),
      });
    }
  }
  : undefined;
const startedAt = performance.now();
const searchDiagnosticsByStage: Record<string, Record<string, unknown>> = {};
const searchTimingsByStage: Record<string, { elapsedMs?: number; heapUsedBytes?: number; rssBytes?: number }> = {};
let searchCandidateTrace: unknown;
let searchCandidateTraceError: string | undefined;
const originalConsoleInfo = console.info.bind(console);
const previousDebugSetting = process.env.MARSHGO_GTFS_SEARCH_DEBUG;
const previousTraceSetting = process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS;
const previousCandidateTraceSetting = process.env.MARSHGO_GTFS_SEARCH_TRACE_CANDIDATE_TRIPS;
if (debugDiagnosticsEnabled) process.env.MARSHGO_GTFS_SEARCH_DEBUG = '1';
else delete process.env.MARSHGO_GTFS_SEARCH_DEBUG;
if (process.env.GTFS_REPLAY_TRACE_TRIP_CHAINS) {
  process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS = process.env.GTFS_REPLAY_TRACE_TRIP_CHAINS;
} else {
  delete process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS;
}
if (process.env.GTFS_REPLAY_TRACE_CANDIDATE_TRIP_IDS) {
  process.env.MARSHGO_GTFS_SEARCH_TRACE_CANDIDATE_TRIPS = process.env.GTFS_REPLAY_TRACE_CANDIDATE_TRIP_IDS;
} else {
  delete process.env.MARSHGO_GTFS_SEARCH_TRACE_CANDIDATE_TRIPS;
}
console.info = (...args: unknown[]) => {
  if (typeof args[0] === 'string') {
    try {
      const record = JSON.parse(args[0]) as Record<string, unknown>;
      if (record.event === 'gtfs.search.debug') {
        if (typeof record.stage === 'string' && ['segments-built', 'reachability-built', 'itineraries-ranked'].includes(record.stage)) {
          const timing = {
            ...(typeof record.elapsedMs === 'number' ? { elapsedMs: record.elapsedMs } : {}),
            ...(typeof record.heapUsedBytes === 'number' ? { heapUsedBytes: record.heapUsedBytes } : {}),
            ...(typeof record.rssBytes === 'number' ? { rssBytes: record.rssBytes } : {}),
          };
          if (Object.keys(timing).length > 0) searchTimingsByStage[record.stage] = timing;
          const { elapsedMs: _elapsedMs, heapUsedBytes: _heapUsedBytes, rssBytes: _rssBytes, ...stable } = record;
          searchDiagnosticsByStage[record.stage] = stable;
          if (record.stage === 'segments-built' && typeof record.debugCandidateTripTrace === 'string') {
            try {
              const trace = JSON.parse(record.debugCandidateTripTrace) as Record<string, unknown>;
              if (!Array.isArray(trace.candidates) || trace.candidates.length > 64) {
                searchCandidateTraceError = 'Candidate trace must contain at most 64 candidate rows.';
              } else {
                searchCandidateTrace = trace;
              }
            } catch (error) {
              searchCandidateTraceError = error instanceof Error ? error.message : String(error);
            }
          }
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
    earliestDeparture,
    latestDeparture,
    maximumJourneySeconds: 6 * 60 * 60, maximumTransfers: 2,
    maximumAccessWalkingMeters: 900, maximumEgressWalkingMeters: 1000,
    maximumTransferWalkingMeters: 400, minimumTransferBufferSeconds: 180,
    maximumWaitSeconds: 4 * 60 * 60, limit: 100,
    now: new Date('2026-10-22T08:00:00.000Z'),
  }, objectiveReservoirSearchSteps === undefined
    ? {}
    : { maxObjectiveReservoirSearchSteps: objectiveReservoirSearchSteps }, graphObserver);
} finally {
  console.info = originalConsoleInfo;
  if (previousDebugSetting === undefined) delete process.env.MARSHGO_GTFS_SEARCH_DEBUG;
  else process.env.MARSHGO_GTFS_SEARCH_DEBUG = previousDebugSetting;
  if (previousTraceSetting === undefined) delete process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS;
  else process.env.MARSHGO_GTFS_SEARCH_TRACE_TRIP_CHAINS = previousTraceSetting;
  if (previousCandidateTraceSetting === undefined) delete process.env.MARSHGO_GTFS_SEARCH_TRACE_CANDIDATE_TRIPS;
  else process.env.MARSHGO_GTFS_SEARCH_TRACE_CANDIDATE_TRIPS = previousCandidateTraceSetting;
}
if (process.env.GTFS_REPLAY_TRACE_CANDIDATE_TRIP_IDS && process.env.REPLAY_GROUP === 'candidate') {
  if (searchCandidateTraceError) throw new Error(`Invalid candidate trip trace: ${searchCandidateTraceError}`);
  if (searchCandidateTrace === undefined) {
    throw new Error('Candidate trip trace was requested but no candidate trace was emitted.');
  }
}
const rankedCandidates = result.itineraries.map(toRankedGtfsItinerary);
const userFacingStrategies = ['BALANCED', 'FASTEST', 'CHEAPEST'] as const;
const availableStrategies = strategiesWithComparablePrices(rankedCandidates, userFacingStrategies);
const strategyRecommendations = selectStrategyAlternatives(rankedCandidates, availableStrategies, 1);
const winnerFor = (strategy: typeof userFacingStrategies[number]) =>
  strategyRecommendations.find((candidate) => candidate.strategyRanks?.[strategy] === 1)?.journey;
const signature = (item: typeof rankedCandidates[number] | undefined) => item?.id ?? null;
const winnerSummary = (strategy: typeof userFacingStrategies[number]) => {
  const item = winnerFor(strategy);
  if (!item) return null;
  return {
    id: item.id,
    departureAt: item.itinerary.departureAt.toISOString(),
    arrivalAt: item.itinerary.arrivalAt.toISOString(),
    durationSeconds: item.durationSeconds,
    priceMinor: item.priceMinor,
    transfers: item.transfers,
    walkingMeters: item.walkingMeters,
    modes: item.legs.map((leg) => leg.mode),
    routeIds: item.itinerary.segments.map((segment) => `${segment.providerId}:${segment.routeId}`),
    tripIds: item.itinerary.segments.map((segment) => `${segment.providerId}:${segment.tripId}`),
  };
};
const details = result as typeof result & Record<string, unknown>;
console.log(JSON.stringify({
  comparisonGroup: process.env.REPLAY_GROUP ?? null,
  revision: process.env.REPLAY_REF ?? null,
  iteration: process.env.BENCH_ITER ?? null,
  origin,
  destination,
  departureWindow: [earliestDeparture.toISOString(), latestDeparture.toISOString()],
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
  rankingMethod: 'production-paretoFrontier+selectStrategyAlternatives',
  rankingScope: 'gtfs-only-candidates; shared with API projection and scorer',
  objectiveReservoirSearchSteps: objectiveReservoirSearchSteps ?? 25_000,
  availableStrategies,
  strategyCandidates: {
    balanced: signature(winnerFor('BALANCED')),
    fastest: signature(winnerFor('FASTEST')),
    cheapest: signature(winnerFor('CHEAPEST')),
  },
  strategyWinners: {
    BALANCED: winnerSummary('BALANCED'),
    FASTEST: winnerSummary('FASTEST'),
    CHEAPEST: winnerSummary('CHEAPEST'),
  },
  searchTruncated: details.searchTruncated,
  candidateGraphTruncated: details.candidateGraphTruncated,
  truncation: result.truncation,
  ...(traceRouteIds.size > 0 ? { retainedTripGroupsByRoute: Object.fromEntries([...traceRouteIds].sort()
    .map((routeId) => [routeId, [...(retainedTripGroupsByRoute.get(routeId)?.values() ?? [])]
      .sort((left, right) => left.serviceDate.localeCompare(right.serviceDate)
        || left.tripId.localeCompare(right.tripId))])) } : {}),
  ...(traceTripIds.size > 0 ? { retainedSegmentsByTripId: Object.fromEntries([...traceTripIds].sort()
    .map((tripId) => [tripId, [...(retainedSegmentsByTripId.get(tripId)?.values() ?? [])]
      .sort((left, right) => left.departureAt.localeCompare(right.departureAt)
        || left.originStopId.localeCompare(right.originStopId)
        || left.destinationStopId.localeCompare(right.destinationStopId))])) } : {}),
  ...(targetChainGraphTrace ? { targetChainGraphTrace } : {}),
  ...(searchCandidateTrace !== undefined ? { searchCandidateTrace } : {}),
  searchDiagnosticsByStage,
  searchTimingsByStage,
}, null, 2));
