import assert from 'node:assert/strict';
import { it } from 'node:test';
import { composeUkraineMultimodalChains } from '../server/journey/multimodalChainEngine';
import type { JourneyTransportType } from '../server/journey/types';

const origin = { name: 'Центр Львова', coordinates: [24.0315, 49.8418] as [number, number] };
const destination = { name: 'Залізничний вокзал', coordinates: [24.0000, 49.8390] as [number, number] };

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

it('does not return a taxi candidate without an authorized provider adapter', async () => {
  const journeys = await composeUkraineMultimodalChains(input());

  assert.equal(
    journeys.some((journey) => journey.legs.some((leg) => leg.mode === 'TAXI')),
    false,
    'road geometry alone cannot establish a taxi service, availability, or quote',
  );
  assert.equal(journeys.some((journey) => journey.source === 'road-route-estimate'), false);
});

it('does not fabricate a taxi-to-metro connector from static metro data', async () => {
  const journeys = await composeUkraineMultimodalChains({
    ...input(['taxi', 'metro']),
    origin: { name: 'Західний край Києва', coordinates: [30.2, 50.5] as [number, number] },
    destination: { name: 'ст. м. Лісова', coordinates: [30.645731, 50.464686] as [number, number] },
  });

  assert.equal(
    journeys.some((journey) => journey.legs.some((leg) => leg.mode === 'TAXI')),
    false,
    'a static metro graph does not verify an external taxi provider',
  );
  assert.equal(journeys.some((journey) => journey.id.startsWith('chain:taxi-metro:')), false);
});
