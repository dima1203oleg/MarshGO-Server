import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { CacheService } from '../server/cache/cacheService';

const schema = z.object({ value: z.number().int() });
const params = { providerId: 'lviv' };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('serves the expired snapshot immediately and refetches it in the background', async () => {
  const cache = new CacheService();
  let loads = 0;
  const slowLoader = async () => { loads += 1; await wait(60); return { value: loads }; };
  // The TTL has to outlast the loader, otherwise the freshly refreshed entry expires again before the test can read it.
  const options = { ttlMs: 500, l1TtlMs: 500, staleTtlMs: 60_000 };

  assert.deepEqual(await cache.getOrLoad('gtfs_network', params, schema, options, slowLoader), { value: 1 });
  await wait(560);

  const started = Date.now();
  assert.deepEqual(await cache.getOrLoad('gtfs_network', params, schema, options, slowLoader), { value: 1 });
  const staleLatency = Date.now() - started;
  assert.ok(staleLatency < 50, `a stale read must not wait for the loader, waited ${staleLatency} ms`);
  assert.equal(cache.snapshot().staleHits, 1);
  assert.equal(cache.snapshot().backgroundRevalidations, 1);
  assert.equal(loads, 2);

  await wait(120);
  assert.deepEqual(await cache.getOrLoad('gtfs_network', params, schema, options, slowLoader), { value: 2 });
  assert.equal(loads, 2);
  assert.equal(cache.snapshot().loadErrors, 0);
});

test('overlapping stale reads start exactly one background refresh', async () => {
  const cache = new CacheService();
  let loads = 0;
  const options = { ttlMs: 40, l1TtlMs: 40, staleTtlMs: 60_000 };
  const loader = async () => { loads += 1; await wait(200); return { value: loads }; };
  await cache.getOrLoad('gtfs_network', params, schema, options, loader);
  await wait(60);

  const results = await Promise.all(Array.from({ length: 5 }, () => cache.getOrLoad('gtfs_network', params, schema, options, loader)));
  assert.deepEqual(results, Array.from({ length: 5 }, () => ({ value: 1 })));
  assert.equal(loads, 2);
  assert.equal(cache.snapshot().backgroundRevalidations, 1);
});

test('a failing loader keeps serving the last good snapshot instead of breaking the request', async () => {
  const cache = new CacheService();
  const options = { ttlMs: 40, l1TtlMs: 40, staleTtlMs: 60_000 };
  let loads = 0;
  assert.deepEqual(await cache.getOrLoad('gtfs_network', params, schema, options, async () => ({ value: ++loads })), { value: 1 });
  await wait(60);

  const failing = async (): Promise<{ value: number }> => { loads += 1; throw new Error('provider timed out'); };
  assert.deepEqual(await cache.getOrLoad('gtfs_network', params, schema, options, failing), { value: 1 });
  await wait(30);
  assert.equal(cache.snapshot().backgroundRevalidationErrors, 1);
  assert.deepEqual(await cache.getOrLoad('gtfs_network', params, schema, options, failing), { value: 1 });
});

test('stale serving is opt-in: without a stale window the request still waits for the loader', async () => {
  const cache = new CacheService();
  let loads = 0;
  const loader = async () => { loads += 1; await wait(80); return { value: loads }; };
  assert.deepEqual(await cache.getOrLoad('gtfs_network', params, schema, { ttlMs: 30, l1TtlMs: 30 }, loader), { value: 1 });
  await wait(50);
  assert.deepEqual(await cache.getOrLoad('gtfs_network', params, schema, { ttlMs: 30, l1TtlMs: 30 }, loader), { value: 2 });
  assert.equal(loads, 2);
  assert.equal(cache.snapshot().staleHits, 0);
  assert.equal(cache.snapshot().backgroundRevalidations, 0);
});

test('the route-type index is the opted-in category', () => {
  const source = readFileSync(new URL('../server/mobility/transportLayers.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('export function cachedGtfsRouteTypes'), source.indexOf('export function gtfsRouteTypesCacheKey'));
  assert.match(block, /staleTtlMs:\s*\d+/, 'the vehicle-classification index must declare a stale window');
  assert.doesNotMatch(block, /staleTtlMs:\s*0\b/);
});

test('a stale cycle is visible in the server log and leaks no request parameters', async () => {
  const cache = new CacheService();
  const lines: string[] = [];
  const original = console.info;
  console.info = (line?: unknown) => { lines.push(String(line)); };
  try {
    let loads = 0;
    const loader = async () => { loads += 1; await wait(30); return { value: loads }; };
    await cache.getOrLoad('gtfs_route_types', params, schema, { ttlMs: 40, l1TtlMs: 40, staleTtlMs: 60_000 }, loader);
    await wait(60);
    await cache.getOrLoad('gtfs_route_types', params, schema, { ttlMs: 40, l1TtlMs: 40, staleTtlMs: 60_000 }, loader);
    await wait(80);
  } finally { console.info = original; }

  const events = lines.map((line) => JSON.parse(line) as { event: string; category: string; staleForMs?: number; durationMs?: number });
  const served = events.filter((event) => event.event === 'cache.stale_served');
  const revalidated = events.filter((event) => event.event === 'cache.background_revalidated');
  assert.equal(served.length, 1);
  assert.equal(served[0]!.category, 'gtfs_route_types');
  assert.ok((served[0]!.staleForMs ?? -1) >= 0, 'the log must say how old the served snapshot was');
  assert.equal(revalidated.length, 1);
  assert.ok((revalidated[0]!.durationMs ?? 0) > 0);
  assert.ok(!lines.some((line) => line.includes('lviv')), 'cache logs must not carry the cache parameters');
});
