import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import { fetchOsrmRoute, RoutingUnavailableError } from '../server/routing/providers/osrmTransport';

describe('OSRM foot endpoint snapping', () => {
  let server: Server | undefined;

  after(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  });

  async function listen(responseBody: unknown): Promise<string> {
    if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseBody));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}/route/v1/foot`;
  }

  const from: [number, number] = [23.9937023, 49.8399296];
  const to: [number, number] = [24.001, 49.841];

  it('rejects an OSRM Ok response whose endpoint snapped far from the requested foot anchor', async () => {
    const endpoint = await listen({ code: 'Ok', routes: [{ distance: 1200, duration: 900,
      geometry: { type: 'LineString', coordinates: [from, [23.8, 49.5]] } }] });

    await assert.rejects(
      fetchOsrmRoute([from, to], endpoint),
      (error: unknown) => error instanceof RoutingUnavailableError && /snapped an endpoint/.test(error.message),
    );
  });

  it('accepts a foot route whose geometry endpoints are within the measured snap tolerance', async () => {
    const endpoint = await listen({ code: 'Ok', routes: [{ distance: 900, duration: 720,
      geometry: { type: 'LineString', coordinates: [[23.99372, 49.83994], [24.00103, 49.84102]] } }] });

    const route = await fetchOsrmRoute([from, to], endpoint);
    assert.equal(route.distanceMeters, 900);
    assert.equal(route.geometry.length, 2);
  });

  it('does not apply the pedestrian snap limit to a road-profile URL', async () => {
    const endpoint = (await listen({ code: 'Ok', routes: [{ distance: 10_000, duration: 900,
      geometry: { type: 'LineString', coordinates: [from, [23.8, 49.5]] } }] }))
      .replace('/foot', '/driving');

    const route = await fetchOsrmRoute([from, to], endpoint);
    assert.equal(route.distanceMeters, 10_000);
  });
});
