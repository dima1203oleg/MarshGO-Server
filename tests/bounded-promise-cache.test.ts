import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedPromiseCache } from '../server/journey/boundedPromiseCache';

test('bounded async cache coalesces loads, refreshes LRU order, and evicts by count and estimated weight', async () => {
  const cache = new BoundedPromiseCache<string>(2, 10, 100, 10);
  let loads = 0;
  const load = async (value: string) => { loads += 1; return value; };
  const weight = () => 4;

  const [first, coalesced] = await Promise.all([
    cache.getOrLoad('a', () => load('A'), weight, 0),
    cache.getOrLoad('a', () => load('wrong'), weight, 0),
  ]);
  assert.equal(first, 'A');
  assert.equal(coalesced, 'A');
  assert.equal(loads, 1);
  await cache.getOrLoad('b', () => load('B'), weight, 1);
  await cache.getOrLoad('a', () => load('wrong'), weight, 2);
  await cache.getOrLoad('c', () => load('C'), () => 7, 3);
  assert.equal(cache.size, 1);
  assert.equal(cache.weight, 7);
  assert.equal(await cache.getOrLoad('a', () => load('A2'), weight, 4), 'A2');
  assert.equal(loads, 4);
});

test('bounded async cache expires entries and refuses to retain one value larger than its budget', async () => {
  const cache = new BoundedPromiseCache<string>(4, 8, 10, 5);
  let loads = 0;
  const load = async (value: string) => { loads += 1; return value; };
  await cache.getOrLoad('large', () => load('large'), () => 9, 0);
  assert.equal(cache.size, 0);
  await cache.getOrLoad('small', () => load('small'), () => 4, 0);
  assert.equal(cache.size, 1);
  assert.equal(await cache.getOrLoad('small', () => load('unexpected'), () => 4, 9), 'small');
  await cache.getOrLoad('small', () => load('expired'), () => 4, 10);
  assert.equal(loads, 3);
});
