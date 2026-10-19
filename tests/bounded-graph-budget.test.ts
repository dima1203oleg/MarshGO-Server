import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allocateBoundedGraphBudgets } from '../server/journey/boundedGraphBudget';

describe('bounded GTFS graph budgets', () => {
  it('distributes spare capacity by demand while respecting global and per-route caps', () => {
    const budgets = allocateBoundedGraphBudgets(new Map([
      ['frequent-line', 1_000], ['ordinary-line', 10], ['low-frequency-line', 10],
    ]), 100, 40);

    assert.equal([...budgets.values()].reduce((sum, value) => sum + value, 0), 100);
    assert.equal(budgets.get('frequent-line'), 40);
    assert.ok((budgets.get('ordinary-line') ?? 0) < 40);
    assert.ok((budgets.get('low-frequency-line') ?? 0) < 40);
    assert.ok([...budgets.values()].every((value) => value >= 1 && value <= 40));
  });

  it('is deterministic across map insertion order and distributes equal remainders by stable ID', () => {
    const first = allocateBoundedGraphBudgets(new Map([['z', 1], ['a', 1]]), 7, 10);
    const reversed = allocateBoundedGraphBudgets(new Map([['a', 1], ['z', 1]]), 7, 10);
    assert.deepEqual([...first], [['a', 4], ['z', 3]]);
    assert.deepEqual([...reversed], [...first]);
  });

  it('does not exceed the global budget when routes exceed the maximum route cap', () => {
    const budgets = allocateBoundedGraphBudgets(new Map([['a', 10], ['b', 5], ['c', 1]]), 100, 10);
    assert.deepEqual([...budgets.values()], [10, 10, 10]);
    assert.equal([...budgets.values()].reduce((sum, value) => sum + value, 0), 30);
  });

  it('filters non-positive demand and validates the hard bounds', () => {
    assert.deepEqual(allocateBoundedGraphBudgets(new Map([['none', 0], ['negative', -1]]), 10, 5), new Map());
    assert.throws(() => allocateBoundedGraphBudgets(new Map(), -1, 5), /bounds are invalid/);
    assert.throws(() => allocateBoundedGraphBudgets(new Map(), 5, 0), /bounds are invalid/);
  });
});
