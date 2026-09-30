import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderOption } from '../server/providers/types';
import { createConnectionMap, planJourneys, type RouteConnection } from '../server/journey/planner';

const base = Date.parse('2026-10-01T08:00:00Z');
const at = (seconds: number) => new Date(base + seconds * 1000);

function option(
  id: string, originNodeId: string, destinationNodeId: string,
  departure: number, arrival: number, price: number, uncertainty = 0,
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

function connection(walkingSeconds: number, walkingMeters = 100): RouteConnection {
  return { walkingSeconds, walkingMeters, source: 'routing-fixture', measuredAt: at(0) };
}

test('plans only complete multi-leg routes with canonical nodes and routed transfers', () => {
  const first = option('minibus', 'A', 'C', 0, 3600, 3000, 480);
  const second = option('community', 'C', 'B', 4500, 6000, 15000);
  const routes = planJourneys({
    options: [first, second], originNodeId: 'A', destinationNodeId: 'B', departureAt: at(0),
    strategy: 'BALANCED', connections: createConnectionMap([
      { fromNodeId: 'C', toNodeId: 'C', connection: connection(0, 0) },
    ]), minimumTransferBufferSeconds: 120,
  });

  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].legs.map((leg) => leg.id), ['minibus', 'community']);
  assert.equal(routes[0].priceMinor, 18000);
  assert.equal(routes[0].transfers, 1);
  assert.equal(routes[0].etaUncertaintySeconds, 480);
});

test('fails closed for missing or infeasible transfer evidence and incomplete destination paths', () => {
  const first = option('first', 'A', 'C', 0, 3600, 3000, 480);
  const second = option('second', 'C', 'B', 3900, 6000, 15000);
  const input = {
    options: [first, second], originNodeId: 'A', destinationNodeId: 'B', departureAt: at(0),
    strategy: 'FASTEST' as const, minimumTransferBufferSeconds: 120,
  };
  assert.equal(planJourneys({ ...input, connections: new Map() }).length, 0);
  assert.equal(planJourneys({
    ...input,
    connections: createConnectionMap([{ fromNodeId: 'C', toNodeId: 'C2', connection: connection(0) }]),
  }).length, 0);
  assert.throws(() => createConnectionMap([
    { fromNodeId: 'C', toNodeId: 'C2', connection: { ...connection(-1) } },
  ]), /valid measured walking data/);
});

test('preserves unknown price and ranks a faster connected itinerary ahead of a slower one', () => {
  const busA = option('bus-a', 'A', 'B', 0, 7200, 10000);
  const taxiA = option('taxi-a', 'A', 'C', 0, 1800, 20000);
  const community = option('community', 'C', 'B', 2400, 4200, 10000);
  community.priceMinor = null;
  community.priceMinMinor = 8000;
  community.priceMaxMinor = 14000;
  const routes = planJourneys({
    options: [busA, taxiA, community], originNodeId: 'A', destinationNodeId: 'B', departureAt: at(0),
    strategy: 'FASTEST', minimumTransferBufferSeconds: 120,
    connections: createConnectionMap([{ fromNodeId: 'C', toNodeId: 'C', connection: connection(0, 0) }]),
  });
  assert.equal(routes.length, 2);
  assert.equal(routes[0].legs[0].id, 'taxi-a');
  assert.equal(routes[0].priceMinor, null);
  assert.equal(routes[0].priceMinMinor, 28000);
  assert.equal(routes[0].priceMaxMinor, 34000);
  assert.equal(routes[1].priceMinor, 10000);
});
