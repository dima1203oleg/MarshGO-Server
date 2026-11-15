import assert from 'node:assert/strict';
import { it } from 'node:test';
import { composeUkraineMultimodalChains } from '../server/journey/multimodalChainEngine';

const pairs = [
  { name: 'Київ', origin: [30.5234, 50.4501], destination: [30.6100, 50.4300] },
  { name: 'Одеса', origin: [30.7233, 46.4825], destination: [30.7412, 46.4400] },
] as const;

for (const pair of pairs) {
  it(`never invents a rental bike or scooter ride without a live fleet (${pair.name})`, async () => {
    const chains = await composeUkraineMultimodalChains({
      origin: { name: 'A', coordinates: [...pair.origin] },
      destination: { name: 'B', coordinates: [...pair.destination] },
      departureAt: new Date(Date.now() + 3600_000),
      passengers: 1,
      strategy: 'BALANCED',
      preferences: { allowPublicTransport: true, allowedTransportTypes: ['bike', 'scooter'] },
    });
    const rentalLegs = chains.flatMap((chain) => chain.legs).filter((leg) => leg.mode === 'BICYCLE' || leg.mode === 'SCOOTER');
    assert.deepEqual(rentalLegs, []);
  });
}
