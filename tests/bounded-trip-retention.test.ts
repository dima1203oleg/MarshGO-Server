import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedBestK, BoundedDiverseBestK, redistributeBoundedCandidates, retainBoundedTripGroup, type BoundedTripGroup } from '../server/journey/boundedTripRetention';

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

test('bounded GTFS retention evicts whole lower-priority trip groups', () => {
  const retained: BoundedTripGroup<string>[] = [
    { key: 'trip-a', priority: 1, segments: ['a-1', 'a-2', 'a-3'] },
    { key: 'trip-b', priority: 2, segments: ['b-1', 'b-2'] },
  ];

  const result = retainBoundedTripGroup(retained,
    { key: 'trip-c', priority: 0, segments: ['c-1', 'c-2', 'c-3', 'c-4'] }, 5, 5);

  assert.deepEqual(result, { segments: 4, retained: true });
  assert.deepEqual(retained.map((trip) => trip.key), ['trip-c']);
  assert.equal(retained[0].segments.length, 4, 'all stop-pair segments from a retained trip stay together');
});

test('bounded GTFS retention rejects a worse trip without mutating the graph sample', () => {
  const retained: BoundedTripGroup<string>[] = [
    { key: 'trip-a', priority: 1, segments: ['a-1', 'a-2'] },
    { key: 'trip-b', priority: 2, segments: ['b-1', 'b-2'] },
  ];
  const before = structuredClone(retained);

  const result = retainBoundedTripGroup(retained,
    { key: 'trip-worse', priority: 3, segments: ['w-1', 'w-2'] }, 4, 5);

  assert.deepEqual(result, { segments: 4, retained: false });
  assert.deepEqual(retained, before);
});

test('bounded GTFS retention does not split an oversized trip to fill the remaining slots', () => {
  const retained: BoundedTripGroup<string>[] = [
    { key: 'trip-a', priority: 1, segments: ['a-1', 'a-2', 'a-3'] },
  ];

  const result = retainBoundedTripGroup(retained,
    { key: 'trip-b', priority: 0, segments: ['b-1', 'b-2', 'b-3'] }, 3, 5);

  assert.deepEqual(result, { segments: 3, retained: true });
  assert.deepEqual(retained.map((trip) => trip.key), ['trip-b']);
});

test('redistributes unused bounded graph capacity fairly and deterministically', () => {
  const retained = new Map([['a', ['a-1']], ['b', ['b-1']]]);
  const overflow = new Map([['b', ['b-1', 'b-2', 'b-3']], ['a', ['a-1', 'a-2', 'a-3']]]);
  const result = redistributeBoundedCandidates(retained, overflow, 6, 3, (candidate) => candidate);

  assert.deepEqual([...result.routes], [['a', ['a-1', 'a-2', 'a-3']], ['b', ['b-1', 'b-2', 'b-3']]]);
  assert.equal(result.added, 4);
  assert.equal([...result.routes.values()].flat().length, 6);
});

test('redistribution respects per-route and total bounds and ignores duplicate candidates', () => {
  const result = redistributeBoundedCandidates(
    new Map([['busy', ['keep-1', 'keep-2']], ['other', ['keep-3']]]),
    new Map([['busy', ['keep-1', 'extra-1', 'extra-2', 'extra-3']], ['other', ['keep-3', 'extra-4']]]),
    5, 3, (candidate) => candidate,
  );

  assert.deepEqual([...result.routes], [['busy', ['keep-1', 'keep-2', 'extra-1']], ['other', ['keep-3', 'extra-4']]]);
  assert.equal(result.added, 2);
});

test('hub-diverse bounded reservoir prevents duplicate early-hub candidates from monopolizing cap=2', () => {
  type Candidate = { id: string; hub: string; cost: number };
  const compare = (a: Candidate, b: Candidate) => a.cost - b.cost || a.id.localeCompare(b.id);
  const reservoir = new BoundedDiverseBestK<Candidate>(2, compare, (c) => c.hub, (c) => c.id);

  // Two candidates for the same early hub
  assert.equal(reservoir.consider({ id: 'hub-a-early', hub: 'hub-a', cost: 10 }), true);
  assert.equal(reservoir.consider({ id: 'hub-a-second', hub: 'hub-a', cost: 20 }), true);
  assert.equal(reservoir.length, 2);

  // A third candidate arriving for a distinct hub, but with higher cost than both hub-a candidates
  assert.equal(reservoir.consider({ id: 'hub-b-candidate', hub: 'hub-b', cost: 30 }), true);
  assert.equal(reservoir.length, 2, 'cap of 2 is never exceeded');

  const retained = reservoir.toSortedArray();
  assert.deepEqual(retained.map((c) => c.id), ['hub-a-early', 'hub-b-candidate'],
    'the duplicate hub-a candidate must be evicted to admit the distinct hub-b candidate');

  // Duplicate candidate already retained is rejected and does not exceed cap
  assert.equal(reservoir.consider({ id: 'hub-a-early', hub: 'hub-a', cost: 10 }), false);
  assert.equal(reservoir.length, 2, 'cap is still never exceeded after duplicate insertion');

  // Another candidate for hub-b that is worse than hub-b-candidate is rejected
  assert.equal(reservoir.consider({ id: 'hub-b-worse', hub: 'hub-b', cost: 40 }), false);
  assert.equal(reservoir.length, 2);

  // Another distinct hub candidate that is worse than both hub-a-early and hub-b-candidate
  assert.equal(reservoir.consider({ id: 'hub-c-candidate', hub: 'hub-c', cost: 50 }), false);
  assert.equal(reservoir.length, 2);
  assert.deepEqual(reservoir.toSortedArray().map((c) => c.id), ['hub-a-early', 'hub-b-candidate']);
});
