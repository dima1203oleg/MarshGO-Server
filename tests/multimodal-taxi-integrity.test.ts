import assert from 'node:assert/strict';
import { it } from 'node:test';
import { composeUkraineMultimodalChains } from '../server/journey/multimodalChainEngine';
import type { JourneyTransportType } from '../server/journey/types';

const origin = { name: 'Центр Львова', coordinates: [24.0315, 49.8418] as [number, number] };
const destination = { name: 'Залізничний вокзал', coordinates: [24.0000, 49.8390] as [number, number] };
const roadRoute = {
  geometry: [[24.0315, 49.8418], [24.0200, 49.8450], [24.0000, 49.8390]] as [number, number][],
  distanceMeters: 3_100,
  durationSeconds: 720,
};

function input(allowedTransportTypes: JourneyTransportType[] = ['taxi']) {
  return {
    origin,
    destination,
    departureAt: new Date('2026-11-15T08:00:00.000Z'),
    passengers: 1,
    strategy: 'BALANCED' as const,
    preferences: { allowPublicTransport: true, allowedTransportTypes },
  };
}

it('returns only a road-route estimate when no taxi quote or availability exists', async () => {
  const journeys = await composeUkraineMultimodalChains(input(), {
    getRoadRoute: async () => roadRoute,
  });
  const taxi = journeys.find((journey) => journey.legs.some((leg) => leg.mode === 'TAXI'));

  assert.ok(taxi);
  assert.equal(taxi.source, 'road-route-estimate');
  assert.equal(taxi.providerName, 'Орієнтовний маршрут таксі');
  assert.equal(taxi.totalPriceMinor, null);
  assert.equal(taxi.estimatedPriceMinMinor, null);
  assert.equal(taxi.estimatedPriceMaxMinor, null);
  assert.equal(taxi.reliabilityScore, null);
  assert.equal(taxi.comfortScore, null);
  assert.deepEqual(taxi.legs[0]?.routeGeometry, roadRoute.geometry);

  const leg = taxi.legs[0];
  assert.equal(leg?.priceMinor, null);
  assert.equal(leg?.priceStatus, 'UNKNOWN');
  assert.equal(leg?.availabilityStatus, 'UNKNOWN');
  assert.equal(leg?.source, 'road-route-estimate');
  assert.equal(leg?.metadata?.durationStatus, 'ESTIMATED');
  assert.equal(leg?.metadata?.providerQuote, false);
  assert.equal('pickupMinutes' in (leg?.metadata ?? {}), false);
  assert.equal('vehicleClasses' in (leg?.metadata ?? {}), false);
});

it('does not invent a taxi route when the road router has no route', async () => {
  const journeys = await composeUkraineMultimodalChains(input(), {
    getRoadRoute: async () => { throw new Error('no road route'); },
  });

  assert.equal(journeys.some((journey) => journey.legs.some((leg) => leg.mode === 'TAXI')), false);
});

it('preserves router-supplied geometry while keeping an unquoted taxi connector unknown', async () => {
  const longTrip = {
    ...input(['taxi', 'metro']),
    origin: { name: 'Західний край Києва', coordinates: [30.2, 50.5] as [number, number] },
    destination: { name: 'ст. м. Лісова', coordinates: [30.645731, 50.464686] as [number, number] },
  };
  let routedGeometry: [number, number][] | undefined;
  const journeys = await composeUkraineMultimodalChains(longTrip, {
    getRoadRoute: async (from, to) => {
      routedGeometry = [from, [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 + 0.002], to];
      return { geometry: routedGeometry, distanceMeters: 7_500, durationSeconds: 1_200 };
    },
  });
  const chain = journeys.find((journey) => journey.id.startsWith('chain:taxi-metro:'));

  assert.ok(chain, 'expected a taxi-to-metro chain from router-supplied geometry and the static metro graph');
  assert.equal(chain.totalPriceMinor, null);
  const taxiLegs = chain.legs.filter((leg) => leg.mode === 'TAXI');
  assert.equal(taxiLegs.length, 1);

  for (const leg of taxiLegs) {
    assert.equal(leg.priceMinor, null);
    assert.equal(leg.priceStatus, 'UNKNOWN');
    assert.equal(leg.availabilityStatus, 'UNKNOWN');
    assert.equal(leg.source, 'road-route-estimate');
    assert.deepEqual(leg.routeGeometry, routedGeometry);
    assert.deepEqual(leg.routeGeometry?.[0], leg.origin.coordinates);
    assert.deepEqual(leg.routeGeometry?.at(-1), leg.destination.coordinates);
  }
});
