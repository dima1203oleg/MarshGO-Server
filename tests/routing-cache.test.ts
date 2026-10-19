import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { calculateCanonicalRoute } from '../server/routing';

test('100 identical OSRM requests with distinct request IDs share one upstream calculation', async (t) => {
  const originalGraphVersion = process.env.OSRM_GRAPH_VERSION;
  const originalOsrmUrl = process.env.OSRM_URL;
  const originalRoutingUrl = process.env.ROUTING_ENGINE_URL;
  let upstreamRequests = 0;
  const server: Server = createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'Ok', routes: [{ distance: 4200, duration: 550,
      geometry: { type: 'LineString', coordinates: [[24.111001, 50.111001], [24.151001, 50.151001]] },
      legs: [{ distance: 4200, duration: 550, steps: [] }],
    }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  process.env.OSRM_URL = `http://127.0.0.1:${address.port}/route/v1/driving`;
  process.env.OSRM_GRAPH_VERSION = 'test-graph-cache-contract-2026-10';
  t.after(async () => {
    if (originalGraphVersion === undefined) delete process.env.OSRM_GRAPH_VERSION;
    else process.env.OSRM_GRAPH_VERSION = originalGraphVersion;
    if (originalOsrmUrl === undefined) delete process.env.OSRM_URL;
    else process.env.OSRM_URL = originalOsrmUrl;
    if (originalRoutingUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = originalRoutingUrl;
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const results = await Promise.all(Array.from({ length: 100 }, (_, index) => calculateCanonicalRoute({
    origin: [24.111001, 50.111001], destination: [24.151001, 50.151001], profile: { mode: 'CAR' }, requestId: `request-${index}`,
  })));
  assert.equal(upstreamRequests, 1);
  assert.equal(new Set(results.map((result) => result.id)).size, 100);
  assert.equal(new Set(results.map((result) => result.calculatedAt)).size, 1);
  assert.ok(results.every((result) => result.mapDataVersion === 'test-graph-cache-contract-2026-10'));
});
