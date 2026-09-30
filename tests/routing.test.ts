import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { getRoadRoute, getRoadRouteThroughPoints, RoutingUnavailableError } from '../server/routing';

describe('OSRM-compatible routing adapter', () => {
  let server: Server | undefined;
  const originalUrl = process.env.ROUTING_ENGINE_URL;

  after(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    if (originalUrl === undefined) delete process.env.ROUTING_ENGINE_URL;
    else process.env.ROUTING_ENGINE_URL = originalUrl;
  });

  it('parses road geometry, distance, and duration from a local contract fixture', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'Ok', routes: [{
        distance: 10400,
        duration: 930,
        geometry: { type: 'LineString', coordinates: [[23.86, 49.25], [23.95, 49.51], [24.03, 49.84]] },
      }] }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.ROUTING_ENGINE_URL = `http://127.0.0.1:${address.port}/route/v1/driving`;
    assert.deepEqual(await getRoadRoute([23.86, 49.25], [24.03, 49.84]), {
      geometry: [[23.86, 49.25], [23.95, 49.51], [24.03, 49.84]],
      distanceMeters: 10400,
      durationSeconds: 930,
    });
  });

  it('sends ordered pickup and dropoff waypoints to the road routing provider', async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    const requested: string[] = [];
    server = createServer((request, response) => {
      requested.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'Ok', routes: [{
        distance: 18500, duration: 1200,
        geometry: { type: 'LineString', coordinates: [[24,49],[24.2,49.2],[24.5,49.5],[25,50]] },
      }] }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.ROUTING_ENGINE_URL = `http://127.0.0.1:${address.port}/route/v1/driving`;
    const route = await getRoadRouteThroughPoints([[24,49],[24.2,49.2],[24.5,49.5],[25,50]]);
    assert.deepEqual(route.geometry, [[24,49],[24.2,49.2],[24.5,49.5],[25,50]]);
    assert.equal(route.distanceMeters, 18500);
    assert.match(requested[0], /24,49;24\.2,49\.2;24\.5,49\.5;25,50\?/);
  });

  it('does not invent a route when the provider is unavailable', async () => {
    delete process.env.ROUTING_ENGINE_URL;
    await assert.rejects(() => getRoadRoute([23.86, 49.25], [24.03, 49.84]), RoutingUnavailableError);
  });
});
