import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bicycleRoutingEnabled, normalizeBikeEndpoint, routeBicyclePath } from '../server/journey/bicycleRoutes';

const FROM: [number, number] = [24.03, 49.84];
const TO: [number, number] = [24.05, 49.83];

const withBikeEnv = (value: string | undefined, restore: () => void) => {
  if (value === undefined) delete process.env.BIKING_ROUTING_URL;
  else process.env.BIKING_ROUTING_URL = value;
  return restore;
};

const okResponse = (coordinates: unknown, distance = 500, duration = 120) => ({
  ok: true,
  json: async () => ({ code: 'Ok', routes: [{ distance, duration, geometry: { coordinates } }] }),
});

test('bicycle routing fails closed when no cycling router is configured', async (t) => {
  const original = process.env.BIKING_ROUTING_URL;
  t.after(() => { withBikeEnv(original, () => {}); });
  withBikeEnv(undefined, () => {});
  assert.equal(bicycleRoutingEnabled(), false);
  let touched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { touched = true; return okResponse([FROM, TO]) as unknown as Response; }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  // No endpoint argument at all: must not reach a router, must not invent geometry.
  assert.equal(await routeBicyclePath(FROM, TO, ''), null);
  assert.equal(touched, false);
});

test('routes a bike leg through the configured cycling graph and keeps lon-lat order', async (t) => {
  const original = process.env.BIKING_ROUTING_URL;
  t.after(() => { withBikeEnv(original, () => {}); });
  withBikeEnv('http://bike:5000', () => {});
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = (async (input) => {
    seenUrl = String(input);
    return okResponse([[24.03, 49.84], [24.04, 49.835], [24.05, 49.83]]) as unknown as Response;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const path = await routeBicyclePath(FROM, TO);
  assert.ok(path);
  assert.deepEqual(path!.geometry, [[24.03, 49.84], [24.04, 49.835], [24.05, 49.83]]);
  assert.equal(path!.distanceMeters, 500);
  assert.ok(seenUrl.includes('/route/v1/bike/'), `expected bike profile path, got ${seenUrl}`);
});

test('normalizes a bare host and a /route/v1 base to the bike profile', () => {
  assert.equal(normalizeBikeEndpoint('http://bike:5000'), 'http://bike:5000/route/v1/bike');
  assert.equal(normalizeBikeEndpoint('http://bike:5000/route/v1'), 'http://bike:5000/route/v1/bike');
  assert.equal(normalizeBikeEndpoint('https://router.test/route/v1/bike'), 'https://router.test/route/v1/bike');
});

test('a transport outage or timeout degrades to null, never a fake path', async (t) => {
  const original = process.env.BIKING_ROUTING_URL;
  t.after(() => { withBikeEnv(original, () => {}); });
  withBikeEnv('http://bike:5000', () => {});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal(await routeBicyclePath(FROM, TO), null);

  const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  globalThis.fetch = (async () => { throw timeoutError; }) as typeof fetch;
  assert.equal(await routeBicyclePath(FROM, TO), null);
});

test('a 502 from the router is an outage, not a route', async (t) => {
  const original = process.env.BIKING_ROUTING_URL;
  t.after(() => { withBikeEnv(original, () => {}); });
  withBikeEnv('http://bike:5000', () => {});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal(await routeBicyclePath(FROM, TO), null);
});

test('NoRoute and malformed or out-of-range geometry are rejected as unusable', async (t) => {
  const original = process.env.BIKING_ROUTING_URL;
  t.after(() => { withBikeEnv(original, () => {}); });
  withBikeEnv('http://bike:5000', () => {});
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ code: 'NoRoute' }) }) as unknown as Response) as typeof fetch;
  assert.equal(await routeBicyclePath(FROM, TO), null);

  // A single coordinate is not a path.
  globalThis.fetch = (async () => okResponse([[24.03, 49.84]]) as unknown as Response) as typeof fetch;
  assert.equal(await routeBicyclePath(FROM, TO), null);

  // Longitude outside WGS84 bounds must not be trusted as street geometry.
  globalThis.fetch = (async () => okResponse([[24.03, 49.84], [181, 49.835]]) as unknown as Response) as typeof fetch;
  assert.equal(await routeBicyclePath(FROM, TO), null);
});

test('a stray graph answer that does not connect the endpoints is not real geometry', async (t) => {
  const original = process.env.BIKING_ROUTING_URL;
  t.after(() => { withBikeEnv(original, () => {}); });
  withBikeEnv('http://bike:5000', () => {});
  const originalFetch = globalThis.fetch;
  // OSRM snaps to its nearest edge anywhere on the graph and answers Ok; a far polyline is a
  // coverage failure, not a route the rider took.
  globalThis.fetch = (async () => okResponse([[30.5, 50.4], [30.6, 50.5]]) as unknown as Response) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal(await routeBicyclePath(FROM, TO), null);
});
