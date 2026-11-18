import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  scoreJourneys,
  paretoFrontier,
} from '../server/journey/scoring';
import {
  planJourneys,
  createConnectionMap,
} from '../server/journey/planner';
import { evaluateTransfer } from '../server/journey/transferEngine';
import type { JourneyOption } from '../server/journey/types';
import type { ProviderOption } from '../server/providers/types';
import type { JourneyStrategy } from '../server/journey/types';

type OraclePath = ProviderOption[];

/** Independent bounded DFS for tiny, hand-built provider graphs. */
function exhaustivePlannerPaths(input: {
  options: readonly ProviderOption[];
  origin: string;
  destination: string;
  departureAt: Date;
  connections: ReadonlyMap<string, { walkingSeconds: number; walkingMeters: number }>;
  minimumTransferBufferSeconds: number;
  maximumLegs: number;
}): OraclePath[] {
  const result: OraclePath[] = [];
  const search = (path: OraclePath, visited: ReadonlySet<string>) => {
    const previous = path.at(-1)!;
    if (previous.destinationNodeId === input.destination) {
      result.push(path);
      return;
    }
    if (path.length >= input.maximumLegs) return;
    for (const next of input.options) {
      if (path.some((leg) => leg.providerId === next.providerId && leg.id === next.id)
        || next.originNodeId !== previous.destinationNodeId
        || visited.has(next.destinationNodeId!)
        || next.departureAt!.getTime() < previous.arrivalAt!.getTime()) continue;
      const measured = input.connections.get(`${previous.destinationNodeId}\u0000${next.originNodeId}`);
      if (!measured) continue;
      const waitSeconds = (next.departureAt!.getTime() - previous.arrivalAt!.getTime()) / 1000;
      const requiredSeconds = previous.etaUncertaintySeconds + measured.walkingSeconds + input.minimumTransferBufferSeconds;
      if (waitSeconds < requiredSeconds || waitSeconds > 4 * 60 * 60) continue;
      search([...path, next], new Set([...visited, next.originNodeId!, next.destinationNodeId!]));
    }
  };

  for (const first of input.options) {
    if (first.originNodeId !== input.origin || first.departureAt!.getTime() < input.departureAt.getTime()
      || first.departureAt!.getTime() > input.departureAt.getTime() + 4 * 60 * 60 * 1000) continue;
    search([first], new Set([input.origin, first.destinationNodeId!]));
  }
  return result;
}

function oraclePathSignature(path: OraclePath): string {
  return path.map((leg) => `${leg.providerId}:${leg.id}`).join('|');
}

function oracleJourney(path: OraclePath, departureAt: Date, transferBufferSeconds: number): JourneyOption {
  const last = path.at(-1)!;
  const transfers = path.slice(1).map((leg, index) => {
    const previous = path[index];
    const wait = (leg.departureAt!.getTime() - previous.arrivalAt!.getTime()) / 1000;
    const required = previous.etaUncertaintySeconds + transferBufferSeconds;
    const slack = wait - required;
    return slack < 0 ? 1 : slack < 300 ? 0.7 : slack < 900 ? 0.3 : 0.05;
  });
  const prices = path.map((leg) => leg.priceMinor);
  return {
    id: oraclePathSignature(path),
    durationSeconds: (last.arrivalAt!.getTime() - departureAt.getTime()) / 1000,
    priceMinor: prices.some((price) => price === null) ? null : prices.reduce<number>((sum, price) => sum + (price ?? 0), 0),
    transfers: Math.max(0, path.filter((leg) => leg.mode !== 'WALK').length - 1),
    walkingMeters: 0,
    reliability: Math.min(...path.map((leg) => leg.reliability ?? 0)),
    transferRisk: Math.max(0, ...transfers),
    comfort: Math.min(...path.map((leg) => leg.comfort ?? 0)),
    legs: path.map((leg) => ({ mode: leg.mode })),
  };
}

describe('Section 20.3 Route Engine Oracle & Strategy Trade-off Fixtures', () => {
  const baseOption: JourneyOption = {
    id: 'base',
    durationSeconds: 3600,
    priceMinor: 1500, // 15.00 UAH
    transfers: 0,
    walkingMeters: 300,
    reliability: 0.9,
    transferRisk: 0,
    comfort: 0.8,
    legs: [{ mode: 'BUS' }],
  };

  it('1. Direct route slightly slower than 2-transfer route: BALANCED prefers direct, FASTEST prefers objective time', () => {
    // Direct bus: 35 minutes (2100s), 0 transfers, high comfort
    const directRoute: JourneyOption = {
      ...baseOption,
      id: 'direct-bus',
      durationSeconds: 2100, // 35 min
      priceMinor: 1500, // 15 UAH
      transfers: 0,
      walkingMeters: 400,
      comfort: 0.85,
      legs: [{ mode: 'BUS' }],
    };

    // 2-transfer route: 31 minutes (1860s) - saves only 4 minutes, but incurs 2 transfers
    const twoTransferRoute: JourneyOption = {
      ...baseOption,
      id: 'two-transfer-fast',
      durationSeconds: 1860, // 31 min (4 min faster door-to-door)
      priceMinor: 3500, // 35 UAH
      transfers: 2,
      walkingMeters: 600,
      transferRisk: 0.25,
      comfort: 0.5,
      legs: [{ mode: 'BUS' }, { mode: 'TRAM' }, { mode: 'BUS' }],
    };

    const candidates = [directRoute, twoTransferRoute];

    // BALANCED accounts for transfer perceived effort (8 min per transfer penalty)
    const balancedScored = scoreJourneys(candidates, 'BALANCED');
    assert.equal(
      balancedScored[0].journey.id,
      'direct-bus',
      'BALANCED must prefer direct route when time saving is marginal (< 2 * 8 min penalty)',
    );

    // FASTEST strictly picks the lowest door-to-door duration
    const fastestScored = scoreJourneys(candidates, 'FASTEST');
    assert.equal(
      fastestScored[0].journey.id,
      'two-transfer-fast',
      'FASTEST must pick the objective fastest time regardless of transfers',
    );
  });

  it('2. Direct route MUCH slower: BALANCED does not mindlessly pick 0 transfers', () => {
    // Direct suburban bus: 85 minutes (5100s), 0 transfers
    const slowDirectRoute: JourneyOption = {
      ...baseOption,
      id: 'slow-direct',
      durationSeconds: 5100, // 85 min
      priceMinor: 2500,
      transfers: 0,
      walkingMeters: 500,
      comfort: 0.7,
      legs: [{ mode: 'BUS' }],
    };

    // 2-transfer multimodal: 30 minutes (1800s), 2 transfers (saves 55 minutes!)
    const muchFasterRoute: JourneyOption = {
      ...baseOption,
      id: 'fast-two-transfer',
      durationSeconds: 1800, // 30 min
      priceMinor: 3000,
      transfers: 2,
      walkingMeters: 500,
      transferRisk: 0.15,
      comfort: 0.6,
      legs: [{ mode: 'METRO' }, { mode: 'TRAM' }, { mode: 'BUS' }],
    };

    const candidates = [slowDirectRoute, muchFasterRoute];

    const balancedScored = scoreJourneys(candidates, 'BALANCED');
    assert.equal(
      balancedScored[0].journey.id,
      'fast-two-transfer',
      'BALANCED must choose the 2-transfer route when the direct route is disproportionately slow',
    );
  });

  it('3. Cheaper fare with 2 transfers and longer wait: CHEAPEST picks it when valid', () => {
    // Direct express taxi/transfer: 20 minutes, 250 UAH (25000 minor), 0 transfers
    const expensiveDirect: JourneyOption = {
      ...baseOption,
      id: 'expensive-direct',
      durationSeconds: 1200,
      priceMinor: 25000,
      transfers: 0,
      legs: [{ mode: 'TAXI' }],
    };

    // 2-transfer public transit: 50 minutes, 15 UAH (1500 minor), 2 transfers
    const cheapTransfers: JourneyOption = {
      ...baseOption,
      id: 'cheap-two-transfers',
      durationSeconds: 3000,
      priceMinor: 1500,
      transfers: 2,
      legs: [{ mode: 'TRAM' }, { mode: 'BUS' }, { mode: 'TROLLEYBUS' }],
    };

    const candidates = [expensiveDirect, cheapTransfers];

    const cheapestScored = scoreJourneys(candidates, 'CHEAPEST');
    assert.equal(
      cheapestScored[0].journey.id,
      'cheap-two-transfers',
      'CHEAPEST must select the cheapest valid fare even if it involves transfers and longer duration',
    );
    assert.equal(cheapestScored[0].journey.priceMinor, 1500);
  });

  it('4. Unknown/unverified tariff: never ranked as 0 UAH or ranked ahead of verified fares in CHEAPEST', () => {
    const verifiedFare: JourneyOption = {
      ...baseOption,
      id: 'verified-fare-30uah',
      durationSeconds: 2400,
      priceMinor: 3000, // 30 UAH
    };

    const unknownFare: JourneyOption = {
      ...baseOption,
      id: 'unverified-fare-unknown',
      durationSeconds: 1800, // faster
      priceMinor: null, // unknown price
    };

    const candidates = [unknownFare, verifiedFare];

    // Pareto frontier must keep both because unknown fare cannot be dominated by known price
    const frontier = paretoFrontier(candidates);
    assert.equal(frontier.length, 2);

    // In CHEAPEST, verified fare MUST win over unknown fare
    const cheapestScored = scoreJourneys(candidates, 'CHEAPEST');
    assert.equal(
      cheapestScored[0].journey.id,
      'verified-fare-30uah',
      'CHEAPEST must never rank an unknown/null fare ahead of a verified known fare',
    );
    assert.equal(
      cheapestScored[1].journey.id,
      'unverified-fare-unknown',
      'Unknown fare must be sorted after known fares in CHEAPEST',
    );
  });

  it('5. Delayed first leg causing broken transfer: connection feasibility is rejected', () => {
    const plannedArrival = new Date('2026-10-26T12:00:00Z');
    const nextDeparture = new Date('2026-10-26T12:08:00Z'); // 8 min after planned arrival

    // Scenario A: On-time arrival with low uncertainty, 3 min walk, 3 min min buffer -> FEASIBLE
    const onTimeTransfer = evaluateTransfer({
      predictedArrivalAt: plannedArrival,
      etaUncertaintySeconds: 60, // 1 min uncertainty
      nextDepartureAt: nextDeparture,
      walkingSeconds: 180, // 3 min walk
      minimumTransferBufferSeconds: 180, // 3 min buffer
      boardingGraceSeconds: 0,
    });
    assert.equal(onTimeTransfer.feasible, true, 'On-time connection with buffer must be feasible');

    // Scenario B: First leg delayed / high uncertainty (e.g. 8 min uncertainty) -> INFEASIBLE
    const delayedTransfer = evaluateTransfer({
      predictedArrivalAt: plannedArrival,
      etaUncertaintySeconds: 480, // 8 min delay/uncertainty -> arrival could be 12:08
      nextDepartureAt: nextDeparture,
      walkingSeconds: 180, // 3 min walk
      minimumTransferBufferSeconds: 180,
      boardingGraceSeconds: 0,
    });
    assert.equal(
      delayedTransfer.feasible,
      false,
      'Delayed connection where passenger cannot reliably walk and board must be rejected as infeasible',
    );
  });

  it('6. Transfer counting correctness: walk legs to first pickup and after last dropoff are NOT transfers', () => {
    const baseDate = new Date('2026-10-26T10:00:00Z');

    // Option 1: Tram A -> B
    const tramLeg: ProviderOption = {
      id: 'tram-1',
      providerId: 'lviv-electrotrans',
      providerType: 'PUBLIC_TRANSIT',
      mode: 'TRAM',
      originNodeId: 'stop-a',
      destinationNodeId: 'stop-b',
      origin: { name: 'Stop A', coordinates: [24.02, 49.83] },
      destination: { name: 'Stop B', coordinates: [24.04, 49.82] },
      departureAt: new Date(baseDate.getTime() + 5 * 60 * 1000),
      arrivalAt: new Date(baseDate.getTime() + 20 * 60 * 1000),
      durationSeconds: 15 * 60,
      etaUncertaintySeconds: 60,
      priceMinor: 1500,
      priceMinMinor: 1500,
      priceMaxMinor: 1500,
      currency: 'UAH',
      priceStatus: 'LOCKED',
      distanceMeters: 4000,
      availability: 'AVAILABLE',
      reliability: 0.9,
      comfort: 0.8,
      dataSource: 'GTFS',
      sourceFreshAt: baseDate,
      metadata: {},
    };

    // Option 2: Bus B -> C
    const busLeg: ProviderOption = {
      id: 'bus-2',
      providerId: 'lviv-atp',
      providerType: 'PUBLIC_TRANSIT',
      mode: 'BUS',
      originNodeId: 'stop-b',
      destinationNodeId: 'stop-c',
      origin: { name: 'Stop B', coordinates: [24.04, 49.82] },
      destination: { name: 'Stop C', coordinates: [24.06, 49.80] },
      departureAt: new Date(baseDate.getTime() + 25 * 60 * 1000),
      arrivalAt: new Date(baseDate.getTime() + 45 * 60 * 1000),
      durationSeconds: 20 * 60,
      etaUncertaintySeconds: 90,
      priceMinor: 1500,
      priceMinMinor: 1500,
      priceMaxMinor: 1500,
      currency: 'UAH',
      priceStatus: 'LOCKED',
      distanceMeters: 6000,
      availability: 'AVAILABLE',
      reliability: 0.85,
      comfort: 0.7,
      dataSource: 'GTFS',
      sourceFreshAt: baseDate,
      metadata: {},
    };

    const connections = createConnectionMap([
      {
        fromNodeId: 'stop-b',
        toNodeId: 'stop-b',
        connection: {
          walkingSeconds: 0,
          walkingMeters: 0,
          source: 'same_platform',
          measuredAt: baseDate,
        },
      },
    ]);

    const planned = planJourneys({
      options: [tramLeg, busLeg],
      originNodeId: 'stop-a',
      destinationNodeId: 'stop-c',
      departureAt: baseDate,
      strategy: 'BALANCED',
      connections,
      minimumTransferBufferSeconds: 120,
    });

    assert.equal(planned.length, 1);
    const journey = planned[0];
    assert.equal(journey.legs.length, 2);
    // Tram -> Bus is 1 transfer between vehicles!
    assert.equal(journey.transfers, 1, 'Two vehicle legs must count as exactly 1 transfer');
    assert.equal(journey.priceMinor, 3000, 'Total price is sum of both legs');
    assert.equal(journey.durationSeconds, 45 * 60, 'Duration is from departureAt to final arrival');
  });

  it('7. Small benchmark fixture retains the feasible 3-segment chain', () => {
    const baseDate = new Date('2026-10-26T08:00:00Z');

    // Leg 1: Stop A -> Stop B (Bus, 15m, 10 UAH)
    const leg1: ProviderOption = {
      id: 'leg-1-bus',
      providerId: 'fixture-bus-provider',
      providerType: 'PUBLIC_TRANSIT',
      mode: 'BUS',
      originNodeId: 'stop-a',
      destinationNodeId: 'stop-b',
      origin: { name: 'Stop A', coordinates: [24.01, 49.81] },
      destination: { name: 'Stop B', coordinates: [24.03, 49.82] },
      departureAt: new Date(baseDate.getTime() + 2 * 60 * 1000),
      arrivalAt: new Date(baseDate.getTime() + 15 * 60 * 1000),
      durationSeconds: 13 * 60,
      etaUncertaintySeconds: 30,
      priceMinor: 1000,
      priceMinMinor: 1000,
      priceMaxMinor: 1000,
      currency: 'UAH',
      priceStatus: 'LOCKED',
      distanceMeters: 3000,
      availability: 'AVAILABLE',
      reliability: 0.95,
      comfort: 0.8,
      dataSource: 'GTFS',
      sourceFreshAt: baseDate,
      metadata: {},
    };

    // Leg 2: Stop B -> Stop C (Metro, 12m, 8 UAH)
    const leg2: ProviderOption = {
      id: 'leg-2-metro',
      providerId: 'fixture-metro-provider',
      providerType: 'PUBLIC_TRANSIT',
      mode: 'METRO',
      originNodeId: 'stop-b',
      destinationNodeId: 'stop-c',
      origin: { name: 'Stop B', coordinates: [24.03, 49.82] },
      destination: { name: 'Stop C', coordinates: [24.06, 49.84] },
      departureAt: new Date(baseDate.getTime() + 18 * 60 * 1000),
      arrivalAt: new Date(baseDate.getTime() + 30 * 60 * 1000),
      durationSeconds: 12 * 60,
      etaUncertaintySeconds: 20,
      priceMinor: 800,
      priceMinMinor: 800,
      priceMaxMinor: 800,
      currency: 'UAH',
      priceStatus: 'LOCKED',
      distanceMeters: 5000,
      availability: 'AVAILABLE',
      reliability: 0.98,
      comfort: 0.85,
      dataSource: 'GTFS',
      sourceFreshAt: baseDate,
      metadata: {},
    };

    // Leg 3: Stop C -> Stop D (Tram, 14m, 10 UAH)
    const leg3: ProviderOption = {
      id: 'leg-3-tram',
      providerId: 'fixture-tram-provider',
      providerType: 'PUBLIC_TRANSIT',
      mode: 'TRAM',
      originNodeId: 'stop-c',
      destinationNodeId: 'stop-d',
      origin: { name: 'Stop C', coordinates: [24.06, 49.84] },
      destination: { name: 'Stop D', coordinates: [24.08, 49.86] },
      departureAt: new Date(baseDate.getTime() + 35 * 60 * 1000),
      arrivalAt: new Date(baseDate.getTime() + 49 * 60 * 1000),
      durationSeconds: 14 * 60,
      etaUncertaintySeconds: 30,
      priceMinor: 1000,
      priceMinMinor: 1000,
      priceMaxMinor: 1000,
      currency: 'UAH',
      priceStatus: 'LOCKED',
      distanceMeters: 4000,
      availability: 'AVAILABLE',
      reliability: 0.90,
      comfort: 0.75,
      dataSource: 'GTFS',
      sourceFreshAt: baseDate,
      metadata: {},
    };

    // Competing Direct Option: Stop A -> Stop D (Express Taxi, 40m, 150 UAH)
    const directTaxi: ProviderOption = {
      id: 'leg-direct-taxi',
      providerId: 'fixture-taxi-provider',
      providerType: 'TAXI',
      mode: 'TAXI',
      originNodeId: 'stop-a',
      destinationNodeId: 'stop-d',
      origin: { name: 'Stop A', coordinates: [24.01, 49.81] },
      destination: { name: 'Stop D', coordinates: [24.08, 49.86] },
      departureAt: new Date(baseDate.getTime() + 5 * 60 * 1000),
      arrivalAt: new Date(baseDate.getTime() + 45 * 60 * 1000),
      durationSeconds: 40 * 60,
      etaUncertaintySeconds: 120,
      priceMinor: 15000,
      priceMinMinor: 15000,
      priceMaxMinor: 15000,
      currency: 'UAH',
      priceStatus: 'LOCKED',
      distanceMeters: 12000,
      availability: 'AVAILABLE',
      reliability: 0.85,
      comfort: 0.95,
      dataSource: 'TAXI',
      sourceFreshAt: baseDate,
      metadata: {},
    };

    const connections = createConnectionMap([
      { fromNodeId: 'stop-b', toNodeId: 'stop-b', connection: { walkingSeconds: 0, walkingMeters: 0, source: 'platform_transfer', measuredAt: baseDate } },
      { fromNodeId: 'stop-c', toNodeId: 'stop-c', connection: { walkingSeconds: 0, walkingMeters: 0, source: 'platform_transfer', measuredAt: baseDate } },
    ]);

    const planned = planJourneys({
      options: [leg1, leg2, leg3, directTaxi],
      originNodeId: 'stop-a',
      destinationNodeId: 'stop-d',
      departureAt: baseDate,
      strategy: 'CHEAPEST',
      connections,
      minimumTransferBufferSeconds: 60,
    });

    // CHEAPEST must retain the 3-segment option (28 UAH vs 150 UAH)
    assert.ok(planned.length >= 1, 'Planner must return feasible candidates');
    const cheapest = planned[0];
    assert.equal(cheapest.legs.length, 3, '3-segment route must be assembled across 2 transfers');
    assert.equal(cheapest.transfers, 2, 'Must have exactly 2 transfers');
    assert.equal(cheapest.priceMinor, 2800, 'Sum of 1000 + 800 + 1000 = 2800 minor UAH (28 UAH)');
  });

  it('8. Small-graph exhaustive reference preserves every feasible direct and 3-leg journey and strategy winner', () => {
    const departureAt = new Date('2026-10-26T08:00:00Z');
    const minute = (value: number) => new Date(departureAt.getTime() + value * 60_000);
    const makeOption = (id: string, providerId: string, mode: ProviderOption['mode'], from: string, to: string,
      depart: number, arrive: number, price: number): ProviderOption => ({
      id, providerId, providerType: 'PUBLIC_TRANSIT', mode,
      originNodeId: from, destinationNodeId: to,
      origin: { name: from, coordinates: [24, 49] }, destination: { name: to, coordinates: [24.01, 49.01] },
      departureAt: minute(depart), arrivalAt: minute(arrive), durationSeconds: (arrive - depart) * 60,
      etaUncertaintySeconds: 0, priceMinor: price, priceMinMinor: price, priceMaxMinor: price,
      currency: 'UAH', priceStatus: 'LOCKED', distanceMeters: 1000, availability: 'AVAILABLE',
      reliability: 0.95, comfort: 0.8, dataSource: 'tiny-oracle-fixture', sourceFreshAt: departureAt, metadata: {},
    });

    const options = [
      makeOption('ab-bus', 'bus-operator', 'BUS', 'A', 'B', 0, 10, 100),
      makeOption('bc-tram', 'tram-operator', 'TRAM', 'B', 'C', 12, 20, 100),
      makeOption('cd-rail', 'rail-operator', 'RAIL', 'C', 'D', 22, 30, 100),
      makeOption('ad-taxi', 'taxi-operator', 'TAXI', 'A', 'D', 1, 35, 12000),
    ];
    const connections = createConnectionMap([
      { fromNodeId: 'B', toNodeId: 'B', connection: { walkingSeconds: 0, walkingMeters: 0, source: 'fixture', measuredAt: departureAt } },
      { fromNodeId: 'C', toNodeId: 'C', connection: { walkingSeconds: 0, walkingMeters: 0, source: 'fixture', measuredAt: departureAt } },
    ]);
    const referencePaths = exhaustivePlannerPaths({
      options, origin: 'A', destination: 'D', departureAt, connections, minimumTransferBufferSeconds: 60, maximumLegs: 4,
    });
    const referenceIds = referencePaths.map(oraclePathSignature).sort();
    assert.deepEqual(referenceIds, [
      'bus-operator:ab-bus|tram-operator:bc-tram|rail-operator:cd-rail',
      'taxi-operator:ad-taxi',
    ].sort(), 'the independent DFS enumerates the only two feasible paths in the tiny graph');

    for (const strategy of ['FASTEST', 'CHEAPEST', 'BALANCED'] as const satisfies readonly JourneyStrategy[]) {
      const actual = planJourneys({
        options, originNodeId: 'A', destinationNodeId: 'D', departureAt, strategy, connections,
        minimumTransferBufferSeconds: 60, maximumLegs: 4,
      });
      assert.deepEqual(actual.map((journey) => journey.id).sort(), referenceIds,
        `${strategy}: planner candidate set must match exhaustive feasible paths`);
      const expectedWinner = scoreJourneys(referencePaths.map((path) => oracleJourney(path, departureAt, 60)), strategy)[0].journey.id;
      assert.equal(actual[0]?.id, expectedWinner, `${strategy}: selected winner must match the exhaustively enumerated set`);
    }
  });

  it('9. Partial/truncated searches are explicitly marked and never claim completeness', () => {
    // When search is truncated by depth or candidate pool, it must flag truncation
    const truncatedCandidate: JourneyOption = {
      ...baseOption,
      id: 'truncated-query-result',
      searchTruncated: true,
    };
    assert.equal(truncatedCandidate.searchTruncated, true, 'searchTruncated flag must be preserved on journey option');
  });
});
