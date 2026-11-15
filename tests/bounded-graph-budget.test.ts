import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allocateBoundedGraphBudgets } from '../server/journey/boundedGraphBudget';

describe('bounded GTFS graph budgets', () => {
  it('distributes capacity by demand without exceeding estimated route supply', () => {
    const budgets = allocateBoundedGraphBudgets(new Map([
      ['frequent-line', 1_000], ['ordinary-line', 10], ['low-frequency-line', 10],
    ]), 100, 40);

    assert.equal([...budgets.values()].reduce((sum, value) => sum + value, 0), 60);
    assert.equal(budgets.get('frequent-line'), 40);
    assert.equal(budgets.get('ordinary-line'), 10);
    assert.equal(budgets.get('low-frequency-line'), 10);
    assert.ok([...budgets.values()].every((value) => value >= 1 && value <= 40));
  });

  it('is deterministic across map insertion order and distributes equal remainders by stable ID', () => {
    const first = allocateBoundedGraphBudgets(new Map([['z', 10], ['a', 10]]), 7, 10);
    const reversed = allocateBoundedGraphBudgets(new Map([['a', 10], ['z', 10]]), 7, 10);
    assert.deepEqual([...first], [['a', 4], ['z', 3]]);
    assert.deepEqual([...reversed], [...first]);
  });

  it('does not assign more graph slots than estimated candidate supply', () => {
    const budgets = allocateBoundedGraphBudgets(new Map([['a', 10], ['b', 5], ['c', 1]]), 100, 10);
    assert.deepEqual([...budgets.values()], [10, 5, 1]);
    assert.equal([...budgets.values()].reduce((sum, value) => sum + value, 0), 16);
  });

  it('keeps all estimated route supply and leaves only surplus global capacity unused', () => {
    const budgets = allocateBoundedGraphBudgets(new Map([['small-line', 2], ['large-line', 100]]), 200, 50);

    assert.deepEqual([...budgets], [['large-line', 100], ['small-line', 2]]);
    assert.equal([...budgets.values()].reduce((sum, value) => sum + value, 0), 102);
  });

  it('does not discard route demand under the per-route ceiling when global capacity is available', () => {
    const budgets = allocateBoundedGraphBudgets(new Map([['lviv-A20', 9_390]]), 100_000, 5_000);

    assert.equal(budgets.get('lviv-A20'), 9_390);
  });

  it('retains the per-route ceiling when aggregate estimated demand exceeds the global budget', () => {
    const demand = new Map(Array.from({ length: 24 }, (_, index) => [`route-${index}`, 5_000] as const));
    const budgets = allocateBoundedGraphBudgets(demand, 100_000, 5_000);

    assert.equal([...budgets.values()].reduce((sum, value) => sum + value, 0), 100_000);
    assert.ok([...budgets.values()].every((value) => value <= 5_000));
  });

  it('filters non-positive demand and validates the hard bounds', () => {
    assert.deepEqual(allocateBoundedGraphBudgets(new Map([['none', 0], ['negative', -1]]), 10, 5), new Map());
    assert.throws(() => allocateBoundedGraphBudgets(new Map(), -1, 5), /bounds are invalid/);
    assert.throws(() => allocateBoundedGraphBudgets(new Map(), 5, 0), /bounds are invalid/);
  });
});
