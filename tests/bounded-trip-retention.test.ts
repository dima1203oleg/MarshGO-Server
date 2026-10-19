import test from 'node:test';
import assert from 'node:assert/strict';
import { retainBoundedTripGroup, type BoundedTripGroup } from '../server/journey/boundedTripRetention';

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
