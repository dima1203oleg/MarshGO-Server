import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { fetchOsrmRoute } from '../server/routing/providers/osrmTransport';
import { calculateCanonicalRoute } from '../server/routing';

const previousUrl = process.env.OSRM_URL;
const previousVersion = process.env.OSRM_GRAPH_VERSION;
let upstreamRequests = 0;
const server = createServer((_request, response) => {
  upstreamRequests += 1;
  setTimeout(() => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'Ok', routes: [{ distance: 4200, duration: 550,
      geometry: { type: 'LineString', coordinates: [[30.5234, 50.4501], [30.6139, 50.4547]] }, legs: [{ distance: 4200, duration: 550, steps: [] }] }] }));
  }, 10);
});

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(2));
}

async function batch(task: (index: number) => Promise<unknown>) {
  const durations: number[] = [];
  await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const started = performance.now();
    await task(index);
    durations.push(performance.now() - started);
  }));
  return { requests: durations.length, p50Ms: percentile(durations, 0.50), p95Ms: percentile(durations, 0.95), p99Ms: percentile(durations, 0.99) };
}

try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local benchmark server did not start');
  const endpoint = `http://127.0.0.1:${address.port}/route/v1/driving`;
  process.env.OSRM_URL = endpoint;
  process.env.OSRM_GRAPH_VERSION = `benchmark-${randomUUID()}`;
  const points: [number, number][] = [[30.5234, 50.4501], [30.6139, 50.4547]];

  upstreamRequests = 0;
  const uncachedCold = await batch(() => fetchOsrmRoute(points, endpoint));
  const uncachedUpstream = upstreamRequests;

  upstreamRequests = 0;
  const smartCacheCold = await batch((index) => calculateCanonicalRoute({ origin: points[0], destination: points[1], profile: { mode: 'CAR' }, requestId: `cold-${index}` }));
  const smartCacheColdUpstream = upstreamRequests;

  upstreamRequests = 0;
  const smartCacheWarm = await batch((index) => calculateCanonicalRoute({ origin: points[0], destination: points[1], profile: { mode: 'CAR' }, requestId: `warm-${index}` }));
  const smartCacheWarmUpstream = upstreamRequests;

  console.log(JSON.stringify({ benchmark: 'local-osrm-fixture', concurrentIdenticalRequests: 100, fixtureDelayMs: 10,
    uncached: { ...uncachedCold, upstreamRequests: uncachedUpstream },
    smartCacheCold: { ...smartCacheCold, upstreamRequests: smartCacheColdUpstream },
    smartCacheWarm: { ...smartCacheWarm, upstreamRequests: smartCacheWarmUpstream },
    upstreamReductionPercent: Number(((1 - smartCacheColdUpstream / uncachedUpstream) * 100).toFixed(2)),
  }, null, 2));
} finally {
  if (previousUrl === undefined) delete process.env.OSRM_URL; else process.env.OSRM_URL = previousUrl;
  if (previousVersion === undefined) delete process.env.OSRM_GRAPH_VERSION; else process.env.OSRM_GRAPH_VERSION = previousVersion;
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}
