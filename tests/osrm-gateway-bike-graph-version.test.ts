import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestOsrmRoute } from '../server/routing/osrmGateway';
import type { CacheService } from '../server/cache/cacheService';

const FROM: [number, number] = [24.03, 49.84];
const TO: [number, number] = [24.05, 49.83];

type CapturedKey = { graphVersion: unknown; profile: unknown; endpoint: unknown };

/** A recording cache that always loads: it captures the key the gateway built without needing Redis. */
function makeStubCache(calls: CapturedKey[]): CacheService {
  const stub = {
    getOrLoad: async (_category: unknown, parameters: unknown, _schema: unknown, _options: unknown, loader: () => Promise<unknown>) => {
      const input = parameters as { graphVersion?: unknown; profile?: unknown; endpoint?: unknown };
      calls.push({ graphVersion: input.graphVersion, profile: input.profile, endpoint: input.endpoint });
      return loader();
    },
  };
  return stub as unknown as CacheService;
}

const stubFetch = (t: { after: (fn: () => void) => void }, onRequest: () => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    onRequest();
    return {
      ok: true,
      json: async () => ({ code: 'Ok', routes: [{ distance: 500, duration: 120, geometry: { coordinates: [FROM, TO] } }] }),
    } as unknown as Response;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
};

const withEnv = (t: { after: (fn: () => void) => void }, values: Record<string, string | undefined>) => {
  const originals: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    originals[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

test('BIKE cache keys use BIKING_GRAPH_VERSION, which wins over the road graph version', async (t) => {
  withEnv(t, { BIKING_GRAPH_VERSION: 'bike-2026-11-10', OSRM_GRAPH_VERSION: 'car-2026-10-01' });
  const calls: CapturedKey[] = [];
  let fetches = 0;
  stubFetch(t, () => { fetches += 1; });
  await requestOsrmRoute([FROM, TO], 'http://bike:5000/route/v1/bike', { profile: 'BIKE', cacheService: makeStubCache(calls) });
  assert.equal(calls.length, 1, 'a versioned bike route must go through the cache');
  assert.equal(calls[0]!.graphVersion, 'bike-2026-11-10', `expected the cycling version in the key, got ${String(calls[0]!.graphVersion)}`);
  assert.equal(calls[0]!.profile, 'BIKE');
  assert.equal(fetches, 1);
});

test('bumping BIKING_GRAPH_VERSION yields a new bike cache key so stale geometry is not served', async (t) => {
  withEnv(t, { OSRM_GRAPH_VERSION: undefined, BIKING_GRAPH_VERSION: 'bike-v1' });
  const calls: CapturedKey[] = [];
  stubFetch(t, () => {});
  await requestOsrmRoute([FROM, TO], 'http://bike:5000/route/v1/bike', { profile: 'BIKE', cacheService: makeStubCache(calls) });
  process.env.BIKING_GRAPH_VERSION = 'bike-v2';
  await requestOsrmRoute([FROM, TO], 'http://bike:5000/route/v1/bike', { profile: 'BIKE', cacheService: makeStubCache(calls) });
  assert.deepEqual(calls.map((call) => call.graphVersion), ['bike-v1', 'bike-v2']);
  assert.notEqual(calls[0]!.graphVersion, calls[1]!.graphVersion);
});

test('with no cycling or road graph version the gateway bypasses cache and still routes', async (t) => {
  withEnv(t, { BIKING_GRAPH_VERSION: undefined, OSRM_GRAPH_VERSION: undefined, WALKING_GRAPH_VERSION: undefined });
  const calls: CapturedKey[] = [];
  let fetches = 0;
  stubFetch(t, () => { fetches += 1; });
  const route = await requestOsrmRoute([FROM, TO], 'http://bike:5000/route/v1/bike', { profile: 'BIKE', cacheService: makeStubCache(calls) });
  assert.equal(calls.length, 0, 'an unversioned graph must bypass the cache entirely');
  assert.equal(fetches, 1);
  assert.deepEqual(route.geometry, [FROM, TO]);
});

test('a foot route still keys on WALKING_GRAPH_VERSION (unchanged behavior)', async (t) => {
  withEnv(t, { WALKING_GRAPH_VERSION: 'foot-v9', BIKING_GRAPH_VERSION: 'bike-x', OSRM_GRAPH_VERSION: 'car-y' });
  const calls: CapturedKey[] = [];
  stubFetch(t, () => {});
  await requestOsrmRoute([FROM, TO], 'http://walk:5000/route/v1/foot', { profile: 'FOOT', cacheService: makeStubCache(calls) });
  assert.equal(calls[0]!.graphVersion, 'foot-v9');
  assert.equal(calls[0]!.profile, 'FOOT');
});
