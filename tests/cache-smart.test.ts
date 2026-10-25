import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { CacheService, cacheKey } from '../server/cache/cacheService';

type Entry = { value: string; expiresAt: number };
class SharedRedis {
  readonly isReady = true;
  readonly values = new Map<string, Entry>();
  async get(key: string) { const entry = this.values.get(key); if (!entry || entry.expiresAt <= Date.now()) { this.values.delete(key); return null; } return entry.value; }
  async set(key: string, value: string, options?: { NX?: boolean; PX?: number }) {
    const entry = this.values.get(key);
    const prior = entry && entry.expiresAt > Date.now() ? entry.value : null;
    if (options?.NX && prior !== null) return null;
    this.values.set(key, { value, expiresAt: Date.now() + (options?.PX ?? 60_000) });
    return 'OK';
  }
  async pTTL(key: string) { const entry = this.values.get(key); return entry ? Math.max(-2, entry.expiresAt - Date.now()) : -2; }
  async del(keys: string | string[]) { let removed = 0; for (const key of Array.isArray(keys) ? keys : [keys]) removed += Number(this.values.delete(key)); return removed; }
  async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
    const [key] = options.keys; const [owner] = options.arguments;
    if (this.values.get(key!)?.value !== owner) return 0;
    this.values.delete(key!); return 1;
  }
}

const resultSchema = z.object({ value: z.number().int() });
const options = { ttlMs: 60_000, lockTtlMs: 3000, waitForLockMs: 1500 };

test('coalesces identical requests in one process and uses canonical parameter key order', async () => {
  const cache = new CacheService();
  let loads = 0;
  const loader = async () => { loads += 1; await new Promise((resolve) => setTimeout(resolve, 15)); return { value: 42 }; };
  const [a, b] = await Promise.all([
    cache.getOrLoad('route', { origin: [24, 50], profile: { mode: 'CAR', avoidTolls: false } }, resultSchema, options, loader),
    cache.getOrLoad('route', { profile: { avoidTolls: false, mode: 'CAR' }, origin: [24, 50] }, resultSchema, options, loader),
  ]);
  assert.deepEqual([a, b], [{ value: 42 }, { value: 42 }]);
  assert.equal(loads, 1);
  assert.equal(cache.snapshot().localCoalesced, 1);
  assert.equal(cacheKey('test', { a: 1, b: 2 }), cacheKey('test', { b: 2, a: 1 }));
});

test('coalesces 100 identical requests across two API-cache instances through Redis lock and L2', async () => {
  const redis = new SharedRedis();
  const instances = [new CacheService(), new CacheService()];
  instances.forEach((instance) => instance.setRedisClient(redis as never));
  let loads = 0;
  const calls = Array.from({ length: 100 }, (_, index) => instances[index % 2]!.getOrLoad(
    'road_geometry', { points: [[24, 50], [24.1, 50.1]], graphVersion: 'graph-2026-10' }, resultSchema,
    { ...options, maxL2Bytes: 4096 },
    async () => { loads += 1; await new Promise((resolve) => setTimeout(resolve, 35)); return { value: 1 }; },
  ));
  const results = await Promise.all(calls);
  assert.equal(results.length, 100);
  assert.ok(results.every((result) => result.value === 1));
  assert.equal(loads, 1);
  assert.ok(instances.reduce((sum, instance) => sum + instance.snapshot().distributedCoalesced, 0) > 0);
  assert.match(instances[1]!.toPrometheus(), /marshgo_cache_l2_hits_total/);
});

test('fails open on Redis outage, serves bounded L1, and validates cached data before returning it', async () => {
  const failingRedis = {
    isReady: true,
    async get() { throw new Error('offline'); }, async set() { throw new Error('offline'); },
    async pTTL() { throw new Error('offline'); }, async del() { throw new Error('offline'); }, async eval() { throw new Error('offline'); },
  };
  const cache = new CacheService({ maxEntries: 2, maxBytes: 2048 });
  cache.setRedisClient(failingRedis as never);
  let loads = 0;
  const loader = async () => ({ value: ++loads });
  const params = { id: 'fallback' };
  assert.deepEqual(await cache.getOrLoad('route', params, resultSchema, options, loader), { value: 1 });
  assert.deepEqual(await cache.getOrLoad('route', params, resultSchema, options, loader), { value: 1 });
  assert.equal(loads, 1);
  assert.equal(cache.snapshot().l2Errors > 0, true);
  assert.equal(cache.snapshot().l1Hits, 1);
});

test('unversioned static sources stay local and never read or write shared Redis', async () => {
  const redis = new SharedRedis();
  const cache = new CacheService();
  cache.setRedisClient(redis as never);
  let loads = 0;
  const params = { providerId: 'provider-a', version: null };
  const load = () => cache.getOrLoad('gtfs_network', params, resultSchema, { ...options, shared: false }, async () => ({ value: ++loads }));
  assert.deepEqual(await load(), { value: 1 });
  assert.equal(redis.values.size, 0);
  assert.deepEqual(await load(), { value: 1 });
  assert.equal(loads, 1);
  assert.equal(redis.values.size, 0);
});

test('invalidates by semantic key and evicts LRU entries at configured bounds', async () => {
  const cache = new CacheService({ maxEntries: 2, maxBytes: 2048 });
  for (const id of ['a', 'b']) await cache.getOrLoad('lookup', { id }, resultSchema, options, async () => ({ value: id.charCodeAt(0) }));
  await cache.getOrLoad('lookup', { id: 'a' }, resultSchema, options, async () => ({ value: 0 }));
  await cache.getOrLoad('lookup', { id: 'c' }, resultSchema, options, async () => ({ value: 99 }));
  assert.equal(cache.snapshot().l1Entries, 2);
  assert.equal(cache.snapshot().evictions, 1);
  await cache.invalidate('lookup', { id: 'a' });
  let loads = 0;
  await cache.getOrLoad('lookup', { id: 'a' }, resultSchema, options, async () => ({ value: ++loads }));
  assert.equal(loads, 1);
});

test('rejects malformed cached structures and does not cache loader failures', async () => {
  const redis = new SharedRedis();
  const cache = new CacheService();
  cache.setRedisClient(redis as never);
  const parameters = { id: 'malformed' };
  const key = cacheKey('lookup', { parameters });
  await redis.set(key, JSON.stringify({ value: 'not a number' }), { PX: 10_000 });
  let loads = 0;
  const value = await cache.getOrLoad('lookup', parameters, resultSchema, options, async () => ({ value: ++loads }));
  assert.deepEqual(value, { value: 1 });
  assert.equal(cache.snapshot().invalidEntries, 1);
  await assert.rejects(() => cache.getOrLoad('lookup', { id: 'failure' }, resultSchema, options, async () => { throw new Error('upstream failed'); }));
  assert.equal(cache.snapshot().loadErrors, 1);
});
