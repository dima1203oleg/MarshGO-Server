import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedBestK } from '../server/journey/boundedTripRetention';

test('bounded segment sample keeps the best K candidates independent of enumeration order', () => {
  const candidates = [
    { id: 'late', cost: 80 }, { id: 'near', cost: 10 }, { id: 'middle', cost: 40 },
    { id: 'far', cost: 90 }, { id: 'early', cost: 10 }, { id: 'other', cost: 60 },
  ];
  const compare = (left: typeof candidates[number], right: typeof candidates[number]) => left.cost - right.cost
    || left.id.localeCompare(right.id);
  const sample = (items: typeof candidates) => {
    const best = new BoundedBestK(3, compare);
    for (const candidate of items) best.consider(candidate);
    return best.toSortedArray().map(({ id }) => id);
  };

  assert.deepEqual(sample(candidates), ['early', 'near', 'middle']);
  assert.deepEqual(sample([...candidates].reverse()), ['early', 'near', 'middle']);
});

test('bounded segment sample rejects invalid capacities', () => {
  assert.throws(() => new BoundedBestK(0, (left: number, right: number) => left - right), /positive safe integer/);
});
