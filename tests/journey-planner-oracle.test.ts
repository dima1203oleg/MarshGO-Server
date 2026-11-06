import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderOption } from '../server/providers/types';
import { createConnectionMap, planJourneys, type RouteConnection } from '../server/journey/planner';
import type { JourneyStrategy } from '../server/journey/types';
import { JOURNEY_SCORE_WEIGHTS, TRANSFER_TIME_PENALTY_SECONDS } from '../server/journey/scoring';

/**
 * Independent exhaustive oracle for the journey composer. The reference enumerates every
 * simple path a small synthetic graph admits under the documented contract (measured
 * connections, transfer arithmetic, wait and leg budgets, node-revisit rule), summarizes
 * each path from first principles, and derives the Pareto frontier and strategy ordering
 * from the published scoring contract. Nothing here calls planner/scoring helpers except
 * the weight constants, which are the product contract the oracle verifies the application of.
 */

const base = Date.parse('2026-10-01T08:00:00Z');
const at = (seconds: number) => new Date(base + seconds * 1000);

function option(
  id: string, originNodeId: string, destinationNodeId: string,
  departure: number, arrival: number, price: number | null, uncertainty = 0,
): ProviderOption {
  return {
    id, providerId: 'test-provider', providerType: 'fixture', mode: 'BUS',
    originNodeId, destinationNodeId,
    origin: { name: originNodeId, coordinates: [24, 49] },
    destination: { name: destinationNodeId, coordinates: [24, 49] },
    departureAt: at(departure), arrivalAt: at(arrival), durationSeconds: arrival - departure,
    etaUncertaintySeconds: uncertainty, distanceMeters: 1000, priceMinor: price,
    priceMinMinor: price, priceMaxMinor: price, currency: 'UAH', priceStatus: 'LOCKED',
    availability: 'AVAILABLE', reliability: 0.9, comfort: 0.8,
    sourceFreshAt: at(0), dataSource: 'test-fixture', metadata: {},
  };
}

function connection(walkingSeconds: number, walkingMeters = 0): RouteConnection {
  return { walkingSeconds, walkingMeters, source: 'routing-fixture', measuredAt: at(0) };
}

interface OracleInput {
  options: readonly ProviderOption[];
  originNodeId: string;
  destinationNodeId: string;
  departureAt: Date;
  connections: ReadonlyMap<string, RouteConnection>;
  minimumTransferBufferSeconds: number;
  boardingGraceSeconds: number;
  maximumLegs: number;
  maximumWaitSeconds: number;
}

interface OraclePath {
  signature: string;
  legIds: string[];
  durationSeconds: number;
  priceMinor: number | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  transfers: number;
  walkingMeters: number;
  etaUncertaintySeconds: number;
  riskMetric: number;
  comfortMetric: number;
  comfortKnown: boolean;
}

const connectionKey = (from: string, to: string) => `${from}\u0000${to}`;

type RoutableOracleOption = ProviderOption & {
  originNodeId: string;
  destinationNodeId: string;
  departureAt: Date;
  arrivalAt: Date;
};

/** Mirrors the composer's published option-validation contract, not its code. */
function oracleValid(option: ProviderOption): option is RoutableOracleOption {
  if (typeof option.originNodeId !== 'string' || typeof option.destinationNodeId !== 'string'
    || !(option.departureAt instanceof Date) || !(option.arrivalAt instanceof Date)) return false;
  return Boolean(option.id && option.providerId
    && option.originNodeId !== option.destinationNodeId
    && Number.isFinite(option.departureAt.getTime()) && Number.isFinite(option.arrivalAt.getTime())
    && option.arrivalAt >= option.departureAt
    && Number.isInteger(option.etaUncertaintySeconds) && option.etaUncertaintySeconds >= 0
    && (option.priceMinor === null || (Number.isSafeInteger(option.priceMinor) && option.priceMinor >= 0))
    && (option.distanceMeters === null || (Number.isInteger(option.distanceMeters) && option.distanceMeters >= 0))
    && option.availability !== 'UNAVAILABLE' && option.availability !== 'BLOCKED_EXTERNAL' && option.availability !== 'UNKNOWN');
}

function transferRiskValue(slackSeconds: number): number {
  return slackSeconds < 300 ? 0.7 : slackSeconds < 900 ? 0.3 : 0.05;
}

function summarizePath(legs: RoutableOracleOption[], transferWalkMeters: number[], transferSlacks: number[], input: OracleInput): OraclePath {
  const last = legs.at(-1)!;
  const durationSeconds = Math.max(0, Math.floor((last.arrivalAt.getTime() - input.departureAt.getTime()) / 1000));
  const priceMinor = legs.every((leg) => leg.priceMinor !== null)
    ? legs.reduce((sum, leg) => sum + leg.priceMinor!, 0) : null;
  const priceMinMinor = legs.every((leg) => leg.priceMinMinor !== null)
    ? legs.reduce((sum, leg) => sum + leg.priceMinMinor!, 0) : null;
  const priceMaxMinor = legs.every((leg) => leg.priceMaxMinor !== null)
    ? legs.reduce((sum, leg) => sum + leg.priceMaxMinor!, 0) : null;
  const boarded = legs.filter((leg) => leg.mode !== 'WALK').length;
  const walkingMeters = transferWalkMeters.reduce((sum, meters) => sum + meters, 0)
    + legs.reduce((sum, leg) => sum + (leg.mode === 'WALK' ? leg.distanceMeters ?? 0 : 0), 0);
  const reliabilityValues = legs.map((leg) => leg.reliability).filter((value): value is number => value !== null);
  const comfortValues = legs.map((leg) => leg.comfort).filter((value): value is number => value !== null);
  const reliability = reliabilityValues.length === legs.length ? Math.min(...reliabilityValues) : null;
  const comfortKnown = comfortValues.length === legs.length;
  const transferRisk = transferSlacks.reduce((risk, slack) => Math.max(risk, transferRiskValue(slack)), 0);
  return {
    signature: legs.map((leg) => `${leg.providerId}:${leg.id}`).join('|'),
    legIds: legs.map((leg) => leg.id),
    durationSeconds, priceMinor, priceMinMinor, priceMaxMinor,
    transfers: Math.max(0, boarded - 1), walkingMeters,
    etaUncertaintySeconds: legs.reduce((sum, leg) => sum + leg.etaUncertaintySeconds, 0),
    riskMetric: Math.max(transferRisk, reliability === null ? 1 : 1 - reliability),
    comfortMetric: comfortKnown ? 1 - Math.min(...comfortValues) : 0.5,
    comfortKnown,
  };
}

/** Exhaustive DFS over every feasible simple path; independent of the production walk(). */
function enumerateOraclePaths(input: OracleInput): OraclePath[] {
  const valid = input.options.filter(oracleValid);
  const paths: OraclePath[] = [];
  const maxDeparture = input.departureAt.getTime() + input.maximumWaitSeconds * 1000;

  const extend = (legs: RoutableOracleOption[], walkMeters: number[], slacks: number[], visited: Set<string>): void => {
    const previous = legs.at(-1)!;
    if (previous.destinationNodeId === input.destinationNodeId) {
      paths.push(summarizePath(legs, walkMeters, slacks, input));
      return;
    }
    if (legs.length >= input.maximumLegs) return;
    for (const next of valid) {
      if (legs.some((leg) => leg.providerId === next.providerId && leg.id === next.id)) continue;
      if (visited.has(next.destinationNodeId)) continue;
      if (visited.has(next.originNodeId) && next.originNodeId !== previous.destinationNodeId) continue;
      if (next.departureAt.getTime() < previous.arrivalAt.getTime()) continue;
      const link = input.connections.get(connectionKey(previous.destinationNodeId, next.originNodeId));
      if (!link) continue;
      const availableSeconds = Math.floor((next.departureAt.getTime() - previous.arrivalAt.getTime()) / 1000);
      if (availableSeconds > input.maximumWaitSeconds) continue;
      const requiredSeconds = previous.etaUncertaintySeconds + link.walkingSeconds
        + input.minimumTransferBufferSeconds + input.boardingGraceSeconds;
      const slackSeconds = availableSeconds - requiredSeconds;
      if (slackSeconds < 0) continue;
      const nextVisited = new Set(visited);
      nextVisited.add(next.originNodeId);
      nextVisited.add(next.destinationNodeId);
      extend([...legs, next], [...walkMeters, link.walkingMeters], [...slacks, slackSeconds], nextVisited);
    }
  };

  for (const first of valid) {
    if (first.originNodeId !== input.originNodeId) continue;
    if (first.departureAt.getTime() < input.departureAt.getTime() || first.departureAt.getTime() > maxDeparture) continue;
    extend([first], [], [], new Set([input.originNodeId, first.destinationNodeId]));
  }
  return paths;
}

function oracleMetrics(path: OraclePath): number[] {
  return [path.durationSeconds, path.priceMinor ?? 0, path.transfers, path.walkingMeters, path.riskMetric, path.comfortMetric];
}

function oracleDominates(a: OraclePath, b: OraclePath): boolean {
  if ((a.priceMinor === null) !== (b.priceMinor === null)) return false;
  if (a.comfortKnown !== b.comfortKnown) return false;
  const ma = oracleMetrics(a), mb = oracleMetrics(b);
  return ma.every((value, index) => value <= mb[index]!) && ma.some((value, index) => value < mb[index]!);
}

function oracleFrontier(paths: OraclePath[]): OraclePath[] {
  return paths.filter((candidate) => !paths.some((other) => other !== candidate && oracleDominates(other, candidate)));
}

function normalized(value: number, min: number, max: number): number {
  return max === min ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** The published weighted-score contract, applied to the frontier exactly as the composer does. */
function oracleScore(path: OraclePath, frontier: OraclePath[], strategy: JourneyStrategy): number {
  const weights = JOURNEY_SCORE_WEIGHTS[strategy];
  const times = frontier.map((p) => p.durationSeconds + p.transfers * TRANSFER_TIME_PENALTY_SECONDS);
  const prices = frontier.map((p) => p.priceMinor ?? Number.MAX_SAFE_INTEGER);
  const transfers = frontier.map((p) => p.transfers);
  const walks = frontier.map((p) => p.walkingMeters);
  const risks = frontier.map((p) => p.riskMetric);
  const comforts = frontier.map((p) => p.comfortMetric);
  const range = (values: number[]): [number, number] => [Math.min(...values), Math.max(...values)];
  const [minTime, maxTime] = range(times);
  const [minPrice, maxPrice] = range(prices);
  const [minTransfers, maxTransfers] = range(transfers);
  const [minWalk, maxWalk] = range(walks);
  const [minRisk, maxRisk] = range(risks);
  const [minComfort, maxComfort] = range(comforts);
  return normalized(path.durationSeconds + path.transfers * TRANSFER_TIME_PENALTY_SECONDS, minTime, maxTime) * weights.time
    + normalized(path.priceMinor ?? Number.MAX_SAFE_INTEGER, minPrice, maxPrice) * weights.price
    + normalized(path.transfers, minTransfers, maxTransfers) * weights.transfers
    + normalized(path.walkingMeters, minWalk, maxWalk) * weights.walking
    + normalized(path.riskMetric, minRisk, maxRisk) * weights.risk
    + normalized(path.comfortMetric, minComfort, maxComfort) * weights.comfort;
}

function oracleOrdering(frontier: OraclePath[], strategy: JourneyStrategy): OraclePath[] {
  const scored = frontier.map((path) => ({ path, score: oracleScore(path, frontier, strategy) }));
  scored.sort((a, b) => {
    if (strategy === 'FASTEST' && a.path.durationSeconds !== b.path.durationSeconds) {
      return a.path.durationSeconds - b.path.durationSeconds;
    }
    if (strategy === 'CHEAPEST') {
      if (a.path.priceMinor === null && b.path.priceMinor !== null) return 1;
      if (a.path.priceMinor !== null && b.path.priceMinor === null) return -1;
      if (a.path.priceMinor !== null && b.path.priceMinor !== null && a.path.priceMinor !== b.path.priceMinor) {
        return a.path.priceMinor - b.path.priceMinor;
      }
    }
    return a.score - b.score || (a.path.signature < b.path.signature ? -1 : a.path.signature > b.path.signature ? 1 : 0);
  });
  return scored.map(({ path }) => path);
}

function selfConnections(nodes: readonly string[], extra: Array<{ from: string; to: string; link: RouteConnection }> = []) {
  return createConnectionMap([
    ...nodes.map((node) => ({ fromNodeId: node, toNodeId: node, connection: connection(0, 0) })),
    ...extra.map(({ from, to, link }) => ({ fromNodeId: from, toNodeId: to, connection: link })),
  ]);
}

function assertMatchesOracle(input: OracleInput, strategy: JourneyStrategy): void {
  const paths = enumerateOraclePaths(input);
  const frontier = oracleFrontier(paths);
  const expected = oracleOrdering(frontier, strategy);
  const actual = planJourneys({
    options: input.options, originNodeId: input.originNodeId, destinationNodeId: input.destinationNodeId,
    departureAt: input.departureAt, strategy, connections: input.connections,
    minimumTransferBufferSeconds: input.minimumTransferBufferSeconds,
    boardingGraceSeconds: input.boardingGraceSeconds, maximumLegs: input.maximumLegs,
    maximumWaitSeconds: input.maximumWaitSeconds, maximumResults: 200,
  });
  assert.deepEqual(actual.map((journey) => journey.id), expected.map((path) => path.signature),
    `strategy ${strategy}: composer output must equal the oracle frontier in contract order`);
  const bySignature = new Map(paths.map((path) => [path.signature, path]));
  for (const journey of actual) {
    const reference = bySignature.get(journey.id)!;
    assert.ok(reference, `composer returned a path the oracle cannot enumerate: ${journey.id}`);
    assert.equal(journey.durationSeconds, reference.durationSeconds, `duration for ${journey.id}`);
    assert.equal(journey.priceMinor, reference.priceMinor, `price for ${journey.id} (unknown must stay null, never zero)`);
    assert.equal(journey.priceMinMinor, reference.priceMinMinor, `priceMin for ${journey.id}`);
    assert.equal(journey.priceMaxMinor, reference.priceMaxMinor, `priceMax for ${journey.id}`);
    assert.equal(journey.transfers, reference.transfers, `transfers for ${journey.id}`);
    assert.equal(journey.walkingMeters, reference.walkingMeters, `walking for ${journey.id}`);
    assert.equal(journey.etaUncertaintySeconds, reference.etaUncertaintySeconds, `uncertainty for ${journey.id}`);
    for (let index = 1; index < journey.legs.length; index += 1) {
      const leg = journey.legs[index]!;
      const previous = journey.legs[index - 1]!;
      assert.ok(leg.connectionFromPrevious, `leg ${index} of ${journey.id} must carry measured connection evidence`);
      assert.ok(leg.transferBefore?.feasible, `transfer before leg ${index} of ${journey.id} must be feasible`);
      const departureAt = leg.departureAt;
      const previousArrivalAt = previous.arrivalAt;
      assert.ok(departureAt instanceof Date, `leg ${index} of ${journey.id} must have a scheduled departure`);
      assert.ok(previousArrivalAt instanceof Date, `leg ${index - 1} of ${journey.id} must have a scheduled arrival`);
      assert.ok(departureAt.getTime() >= previousArrivalAt.getTime(), `leg ${index} of ${journey.id} must be temporally connected`);
    }
  }
  if (expected.length > 0) {
    const winner = actual[0]!;
    if (strategy === 'FASTEST') {
      assert.equal(winner.durationSeconds, Math.min(...paths.map((path) => path.durationSeconds)),
        'FASTEST must win with the true minimum door-to-door duration over every feasible path');
    }
    if (strategy === 'CHEAPEST') {
      const knownPrices = paths.map((path) => path.priceMinor).filter((price): price is number => price !== null);
      if (knownPrices.length > 0) {
        assert.equal(winner.priceMinor, Math.min(...knownPrices),
          'CHEAPEST must win with the true minimum known fare; an unknown fare is never a zero competitor');
      }
    }
  }
}

test('oracle: a three-leg-only graph is composed completely with unknown fare preserved', () => {
  const first = option('o1', 'O', 'A', 0, 600, 500);
  const second = option('a1', 'A2', 'B', 1020, 1500, 300, 120);
  const third = option('b1', 'B', 'D', 1800, 2400, null);
  const decoy = option('o2', 'O', 'B', 0, 1700, 900);
  const input: OracleInput = {
    options: [first, second, third, decoy], originNodeId: 'O', destinationNodeId: 'D', departureAt: at(0),
    connections: selfConnections(['O', 'A', 'A2', 'B', 'D'], [{ from: 'A', to: 'A2', link: connection(120, 150) }]),
    minimumTransferBufferSeconds: 120, boardingGraceSeconds: 0, maximumLegs: 3, maximumWaitSeconds: 3600,
  };
  const paths = enumerateOraclePaths(input);
  assert.deepEqual(paths.map((path) => path.legIds), [['o1', 'a1', 'b1']],
    'the fixture admits exactly one feasible path and it has three legs');
  for (const strategy of ['FASTEST', 'CHEAPEST', 'BALANCED'] as const) {
    assertMatchesOracle(input, strategy);
  }
  const [journey] = planJourneys({
    options: input.options, originNodeId: 'O', destinationNodeId: 'D', departureAt: at(0),
    strategy: 'BALANCED', connections: input.connections, minimumTransferBufferSeconds: 120, maximumLegs: 3,
  });
  assert.ok(journey);
  assert.equal(journey.priceMinor, null, 'an unknown leg fare keeps the whole journey fare unknown');
  assert.equal(journey.priceMinMinor, null);
  assert.equal(journey.transfers, 2);
  assert.equal(journey.walkingMeters, 150);
  assert.equal(journey.durationSeconds, 2400);
});

test('oracle: direct, one-transfer and two-transfer paths coexist and each strategy picks the mathematical winner', () => {
  const direct = option('direct', 'O', 'D', 600, 3600, 2000);
  const cheapFirst = option('cheap-1', 'O', 'H', 0, 1200, 400);
  const cheapSecond = option('cheap-2', 'H', 'D', 1500, 4200, 400);
  const fastFirst = option('fast-1', 'O', 'P', 0, 300, 900);
  const fastSecond = option('fast-2', 'P', 'Q', 420, 800, 900);
  const fastThird = option('fast-3', 'Q', 'D', 920, 1500, 900);
  const input: OracleInput = {
    options: [direct, cheapFirst, cheapSecond, fastFirst, fastSecond, fastThird],
    originNodeId: 'O', destinationNodeId: 'D', departureAt: at(0),
    connections: selfConnections(['O', 'H', 'P', 'Q', 'D']),
    minimumTransferBufferSeconds: 120, boardingGraceSeconds: 0, maximumLegs: 3, maximumWaitSeconds: 3600,
  };
  const paths = enumerateOraclePaths(input);
  assert.equal(paths.length, 3, 'direct, 2-leg and 3-leg paths are all feasible');
  for (const strategy of ['FASTEST', 'CHEAPEST', 'BALANCED'] as const) assertMatchesOracle(input, strategy);
  const fastest = planJourneys({ ...input, strategy: 'FASTEST', options: input.options, connections: input.connections, maximumResults: 200 });
  const cheapest = planJourneys({ ...input, strategy: 'CHEAPEST', options: input.options, connections: input.connections, maximumResults: 200 });
  assert.deepEqual(fastest[0]!.legs.map((leg) => leg.id), ['fast-1', 'fast-2', 'fast-3'], 'FASTEST is the 3-leg chain');
  assert.deepEqual(cheapest[0]!.legs.map((leg) => leg.id), ['cheap-1', 'cheap-2'], 'CHEAPEST is the 2-leg chain');
  assert.equal(cheapest[0]!.priceMinor, 800);
});

test('oracle: an unknown fare never ranks as zero against a known fare', () => {
  const unknownFast = option('unknown-fast', 'O', 'D', 0, 900, null);
  const knownSlow = option('known-slow', 'O', 'D', 0, 3000, 5000);
  const input: OracleInput = {
    options: [unknownFast, knownSlow], originNodeId: 'O', destinationNodeId: 'D', departureAt: at(0),
    connections: selfConnections(['O', 'D']),
    minimumTransferBufferSeconds: 120, boardingGraceSeconds: 0, maximumLegs: 3, maximumWaitSeconds: 3600,
  };
  assertMatchesOracle(input, 'CHEAPEST');
  assertMatchesOracle(input, 'FASTEST');
  const cheapest = planJourneys({ ...input, strategy: 'CHEAPEST', options: input.options, connections: input.connections });
  assert.equal(cheapest[0]!.id, 'test-provider:known-slow', 'CHEAPEST must prefer the known 5000 fare over an unknown fare');
  assert.equal(cheapest[0]!.priceMinor, 5000);
  const unknown = cheapest.find((journey) => journey.id === 'test-provider:unknown-fast');
  assert.ok(unknown, 'the unknown-fare journey stays available to other strategies');
  assert.equal(unknown.priceMinor, null, 'unknown fare must never become zero');
  const fastest = planJourneys({ ...input, strategy: 'FASTEST', options: input.options, connections: input.connections });
  assert.equal(fastest[0]!.id, 'test-provider:unknown-fast');
  assert.equal(fastest[0]!.priceMinor, null);
});

test('oracle: transfer windows, wait caps, leg caps and result truncation follow the contract', () => {
  const first = option('first', 'O', 'H', 0, 1200, 500, 240);
  const tight = option('tight', 'H', 'D', 1500, 2400, 500);
  const feasible = option('feasible', 'H', 'D', 1620, 2700, 700);
  const late = option('late', 'H', 'D', 6000, 7000, 100);
  const early = option('early', 'O', 'D', -600, 600, 100);
  const beyondWindow = option('beyond-window', 'O', 'D', 4000, 5000, 100);
  const connections = selfConnections(['O', 'H', 'D'], [{ from: 'H', to: 'D', link: connection(0, 0) }]);
  const input: OracleInput = {
    options: [first, tight, feasible, late, early, beyondWindow],
    originNodeId: 'O', destinationNodeId: 'D', departureAt: at(0), connections,
    minimumTransferBufferSeconds: 120, boardingGraceSeconds: 60, maximumLegs: 2, maximumWaitSeconds: 3600,
  };
  const paths = enumerateOraclePaths(input);
  assert.deepEqual(paths.map((path) => path.legIds).sort(), [['first', 'feasible']],
    'tight misses the buffer+grace+uncertainty window, late misses the wait cap, early and beyond-window miss the first-departure window');
  assertMatchesOracle(input, 'BALANCED');
  const full = planJourneys({ ...input, strategy: 'BALANCED', options: input.options, connections, maximumResults: 200 });
  for (const cap of [1, 2]) {
    const capped = planJourneys({ ...input, strategy: 'BALANCED', options: input.options, connections, maximumResults: cap });
    assert.deepEqual(capped.map((journey) => journey.id), full.slice(0, cap).map((journey) => journey.id),
      `maximumResults=${cap} must return the exact prefix of the uncapped ordering`);
  }
  const threeLegAllowed = planJourneys({ ...input, strategy: 'BALANCED', options: input.options, connections, maximumLegs: 3, maximumResults: 200 });
  assert.deepEqual(threeLegAllowed.map((journey) => journey.id), full.map((journey) => journey.id),
    'raising the leg cap on a 2-leg-only graph changes nothing');
});

test('oracle: seeded random small graphs agree with exhaustive enumeration on frontier, order and summaries', () => {
  let state = 0x5EED;
  const rand = () => {
    state |= 0; state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)]!;
  const nodes = ['O', 'A', 'A2', 'B', 'D'] as const;
  const connections = selfConnections(nodes, [{ from: 'A', to: 'A2', link: connection(120, 150) }]);
  const strategies = ['FASTEST', 'CHEAPEST', 'BALANCED'] as const;
  let nonEmptyGraphs = 0;
  let graphsThreeLeg = 0;
  const iterations = 80;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const grace = rand() < 0.5 ? 0 : 60;
    const options: ProviderOption[] = [];
    // Every even iteration seeds an O→A→B→D skeleton whose transfer gaps are provably
    // feasible (slack >= 0 by construction), so 3-leg coverage is guaranteed rather than
    // left to random luck. Fares, uncertainty, grace and the extra random options still
    // vary, and the odd iterations stay fully random for infeasible/negative cases.
    const skeletonChain = iteration % 2 === 0;
    if (skeletonChain) {
      const chainNodes = ['O', 'A', 'B', 'D'];
      let cursor = Math.floor(rand() * 600);
      for (let leg = 0; leg < 3; leg += 1) {
        const ride = 300 + Math.floor(rand() * 600);
        const uncertainty = pick([0, 60, 120, 240]);
        const price = rand() < 0.25 ? null : Math.floor(rand() * 5000);
        options.push(option(`chain-${leg}`, chainNodes[leg]!, chainNodes[leg + 1]!, cursor, cursor + ride, price, uncertainty));
        const required = uncertainty + 120 + grace;
        cursor += ride + required + Math.floor(rand() * 600);
      }
    }
    const count = (skeletonChain ? 2 : 4) + Math.floor(rand() * 5);
    for (let index = 0; index < count; index += 1) {
      const from = pick(nodes);
      let to = pick(nodes);
      if (to === from) to = nodes[(nodes.indexOf(from) + 1) % nodes.length]!;
      const departure = Math.floor(rand() * 3600);
      const arrival = departure + 300 + Math.floor(rand() * 2400);
      const price = rand() < 0.25 ? null : Math.floor(rand() * 5000);
      const candidate = option(`opt-${index}`, from, to, departure, arrival, price, pick([0, 60, 120, 240]));
      candidate.mode = pick(['BUS', 'TRAM', 'WALK'] as const);
      if (candidate.mode === 'WALK') candidate.distanceMeters = 100 + Math.floor(rand() * 700);
      if (rand() < 0.2) { candidate.reliability = null; candidate.comfort = null; }
      if (rand() < 0.1) candidate.availability = 'UNAVAILABLE';
      if (rand() < 0.08) { candidate.priceMinor = -5; candidate.priceMinMinor = null; candidate.priceMaxMinor = null; }
      options.push(candidate);
    }
    const input: OracleInput = {
      options, originNodeId: 'O', destinationNodeId: 'D', departureAt: at(0), connections,
      minimumTransferBufferSeconds: 120, boardingGraceSeconds: grace,
      maximumLegs: rand() < 0.5 ? 3 : 4, maximumWaitSeconds: 3600,
    };
    const paths = enumerateOraclePaths(input);
    if (paths.length > 0) nonEmptyGraphs += 1;
    if (paths.some((path) => path.legIds.length === 3)) graphsThreeLeg += 1;
    assertMatchesOracle(input, strategies[iteration % strategies.length]!);
  }
  assert.ok(nonEmptyGraphs >= 30, `random differential must exercise non-empty result sets, got ${nonEmptyGraphs}/${iterations}`);
  assert.ok(graphsThreeLeg >= 8, `random differential must exercise 3-leg paths, got ${graphsThreeLeg}/${iterations}`);
});
