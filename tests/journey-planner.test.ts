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

test('plans complete routes across distinct platform IDs when a measured transfer connects them', () => {
  const first = option('minibus', 'A', 'C', 0, 3600, 3000, 480);
  const second = option('community', 'C2', 'B', 4500, 6000, 15000);
  const routes = planJourneys({
    options: [first, second], originNodeId: 'A', destinationNodeId: 'B', departureAt: at(0),
    strategy: 'BALANCED', connections: createConnectionMap([
      { fromNodeId: 'C', toNodeId: 'C2', connection: connection(180, 240) },
    ]), minimumTransferBufferSeconds: 120,
  });

  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].legs.map((leg) => leg.id), ['minibus', 'community']);
  assert.equal(routes[0].priceMinor, 18000);
  assert.equal(routes[0].transfers, 1);
  assert.equal(routes[0].etaUncertaintySeconds, 480);
  assert.equal(routes[0].walkingMeters, 240);
  assert.equal(routes[0].legs[1].connectionFromPrevious?.walkingSeconds, 180);
});

test('fails closed for missing or infeasible transfer evidence and incomplete destination paths', () => {
  const first = option('first', 'A', 'C', 0, 3600, 3000, 480);
  const second = option('second', 'C2', 'B', 4300, 6000, 15000);
  const input = {
    options: [first, second], originNodeId: 'A', destinationNodeId: 'B', departureAt: at(0),
    strategy: 'FASTEST' as const, minimumTransferBufferSeconds: 120,
  };
  assert.equal(planJourneys({ ...input, connections: new Map() }).length, 0);
  assert.equal(planJourneys({
    ...input,
    connections: createConnectionMap([{ fromNodeId: 'C', toNodeId: 'C2', connection: connection(180, 240) }]),
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

test('does not continue past the requested destination to append extra legs', () => {
  const direct = option('direct', 'A', 'B', 0, 3600, 5000);
  const onward = option('onward', 'B', 'C', 3900, 5000, 1000);
  const routes = planJourneys({
    options: [direct, onward], originNodeId: 'A', destinationNodeId: 'B', departureAt: at(0),
    strategy: 'CHEAPEST', minimumTransferBufferSeconds: 0,
    connections: createConnectionMap([{ fromNodeId: 'B', toNodeId: 'B', connection: connection(0, 0) }]),
  });
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].legs.map((leg) => leg.id), ['direct']);
});

test('never returns a route that revisits an earlier network node', () => {
  const direct = option('direct', 'A', 'B', 0, 1200, 1000);
  const out = option('loop-out', 'A', 'C', 0, 300, 0);
  const back = option('loop-back', 'C', 'A', 600, 900, 0);
  const cheaperAfterLoop = option('cheap-after-loop', 'A', 'B', 1200, 1800, 0);
  const routes = planJourneys({
    options: [direct, out, back, cheaperAfterLoop], originNodeId: 'A', destinationNodeId: 'B', departureAt: at(0),
    strategy: 'CHEAPEST', minimumTransferBufferSeconds: 0,
    connections: createConnectionMap([
      { fromNodeId: 'A', toNodeId: 'A', connection: connection(0, 0) },
      { fromNodeId: 'C', toNodeId: 'C', connection: connection(0, 0) },
    ]),
  });

  assert.ok(routes.length > 0);
  assert.ok(routes.every((route) => {
    const nodes = [route.legs[0].originNodeId, ...route.legs.map((leg) => leg.destinationNodeId)];
    return new Set(nodes).size === nodes.length;
  }));
});

test('counts initial wait and access walking door-to-door without counting walking as a transfer', () => {
  const access = option('access-walk', 'A', 'H', 0, 600, 0);
  access.mode = 'WALK';
  access.distanceMeters = 400;
  const firstRide = option('bus-1', 'H', 'M', 900, 1800, 1000);
  const secondRide = option('bus-2', 'M', 'B', 2400, 3600, 1000);
  const routes = planJourneys({
    options: [access, firstRide, secondRide], originNodeId: 'A', destinationNodeId: 'B', departureAt: at(0),
    strategy: 'BALANCED', minimumTransferBufferSeconds: 0,
    connections: createConnectionMap([
      { fromNodeId: 'H', toNodeId: 'H', connection: connection(0, 0) },
      { fromNodeId: 'M', toNodeId: 'M', connection: connection(0, 0) },
    ]),
  });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].durationSeconds, 3600);
  assert.equal(routes[0].departureAt.getTime(), at(0).getTime());
  assert.equal(routes[0].walkingMeters, 400);
  assert.equal(routes[0].transfers, 1);
});

test('rental modes require a verified, provider-scoped pickup and return session', () => {
  const scooterStart = option('scooter-1', 'A', 'B', 0, 600, 100);
  scooterStart.mode = 'SCOOTER'; scooterStart.providerId = 'zelectra';
  scooterStart.rental = { sessionId: 's1', mode: 'SCOOTER', pickupLocationId: 'z1', dropoffLocationId: 'z2', networkId: 'zelectra-66', returnRule: 'FREE_FLOATING_ZONE', confirmationLevel: 'VERIFIED', availabilityStatus: 'AVAILABLE' };
  const bicycle = option('bike', 'B2', 'C', 900, 1800, 200);
  bicycle.mode = 'BICYCLE'; bicycle.providerId = 'bikenow';
  bicycle.rental = { sessionId: 'b1', mode: 'BICYCLE', pickupLocationId: 'b1', dropoffLocationId: 'b2', networkId: 'bikenow-network', returnRule: 'ANY_NETWORK_LOCATION', confirmationLevel: 'VERIFIED', availabilityStatus: 'AVAILABLE' };
  const scooterEnd = option('scooter-2', 'C2', 'D', 2100, 2700, 100);
  scooterEnd.mode = 'SCOOTER'; scooterEnd.providerId = 'zelectra';
  scooterEnd.rental = { sessionId: 's2', mode: 'SCOOTER', pickupLocationId: 'z3', dropoffLocationId: 'z4', networkId: 'zelectra-66', returnRule: 'FREE_FLOATING_ZONE', confirmationLevel: 'VERIFIED', availabilityStatus: 'AVAILABLE' };
  const input = {
    options: [scooterStart, bicycle, scooterEnd], originNodeId: 'A', destinationNodeId: 'D', departureAt: at(0),
    strategy: 'BALANCED' as const, minimumTransferBufferSeconds: 0,
    connections: createConnectionMap([
      { fromNodeId: 'B', toNodeId: 'B2', connection: connection(120, 80) },
      { fromNodeId: 'C', toNodeId: 'C2', connection: connection(120, 80) },
    ]),
  };
  const result = planJourneys(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.legs.map((leg) => leg.providerId), ['zelectra','bikenow','zelectra']);

  const conditional = { ...bicycle, rental: { ...bicycle.rental!, confirmationLevel: 'CONDITIONAL' as const } };
  assert.equal(planJourneys({ ...input, options: [scooterStart, conditional, scooterEnd] }).length, 0);
  const looseBike = { ...bicycle, rental: undefined };
  assert.equal(planJourneys({ ...input, options: [scooterStart, looseBike, scooterEnd] }).length, 0);
});
