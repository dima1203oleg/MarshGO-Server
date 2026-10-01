import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { parseNominatimSuggestions, parsePhotonSuggestions, reverseGeocode, suggestPlaces, GeocodingUnavailableError } from '../server/geocoding';

describe('Nominatim-compatible place search adapter', () => {
  let server: Server | undefined;
  const originalUrl = process.env.GEOCODING_ENGINE_URL;
  const originalReverseUrl = process.env.GEOCODING_REVERSE_URL;
  const originalKey = process.env.GEOCODING_API_KEY;
  const originalEnvironment = process.env.NODE_ENV;
  const originalProvider = process.env.GEOCODING_PROVIDER;

  after(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    if (originalUrl === undefined) delete process.env.GEOCODING_ENGINE_URL;
    else process.env.GEOCODING_ENGINE_URL = originalUrl;
    if (originalReverseUrl === undefined) delete process.env.GEOCODING_REVERSE_URL;
    else process.env.GEOCODING_REVERSE_URL = originalReverseUrl;
    if (originalKey === undefined) delete process.env.GEOCODING_API_KEY;
    else process.env.GEOCODING_API_KEY = originalKey;
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
    if (originalProvider === undefined) delete process.env.GEOCODING_PROVIDER;
    else process.env.GEOCODING_PROVIDER = originalProvider;
  });

  it('parses Photon GeoJSON results and rejects results outside Ukraine', () => {
    assert.deepEqual(parsePhotonSuggestions({ features: [
      { properties: { osm_type: 'R', osm_id: 42, countrycode: 'UA', name: 'Стрий', state: 'Львівська область', country: 'Україна' }, geometry: { coordinates: [23.856, 49.258] } },
      { properties: { osm_type: 'R', osm_id: 43, countrycode: 'PL', name: 'Стрий' }, geometry: { coordinates: [22, 50] } },
    ] }), [{ label: 'Стрий, Львівська область, Україна', latitude: 49.258, longitude: 23.856, providerId: 'R:42' }]);
  });

  it('uses Photon search-as-you-type response format and limits results to Ukraine', async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      assert.equal(url.searchParams.get('q'), 'Київ');
      assert.equal(url.searchParams.get('bbox'), '22,44,41,53');
      assert.equal(url.searchParams.get('limit'), '6');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ features: [
        { properties: { osm_type: 'R', osm_id: 1, countrycode: 'UA', name: 'Київ', country: 'Україна' }, geometry: { coordinates: [30.524, 50.45] } },
      ] }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_PROVIDER = 'photon';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/api`;
    assert.deepEqual(await suggestPlaces('Київ'), [{ label: 'Київ, Україна', latitude: 50.45, longitude: 30.524, providerId: 'R:1' }]);
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('validates provider records and filters invalid coordinates', () => {
    assert.deepEqual(parseNominatimSuggestions([
      { place_id: 42, display_name: 'Стрий, Львівська область, Україна', lat: '49.258', lon: '23.856' },
      { place_id: 43, display_name: 'Invalid', lat: '92', lon: '24' },
      { place_id: 44, display_name: '', lat: '49', lon: '24' },
    ]), [{ label: 'Стрий, Львівська область, Україна', latitude: 49.258, longitude: 23.856, providerId: '42' }]);
  });

  it('queries an isolated provider contract and restricts suggestions to Ukraine', async () => {
    process.env.GEOCODING_PROVIDER = 'nominatim';
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      assert.equal(url.searchParams.get('q'), 'Стрий');
      assert.equal(url.searchParams.get('countrycodes'), 'ua');
      assert.equal(url.searchParams.get('limit'), '6');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ place_id: 1, display_name: 'Стрий, Україна', lat: '49.258', lon: '23.856' }]));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/search`;
    assert.deepEqual(await suggestPlaces('Стрий'), [{ label: 'Стрий, Україна', latitude: 49.258, longitude: 23.856, providerId: '1' }]);
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('reverse geocodes coordinates through a bounded Ukrainian provider request', async () => {
    process.env.GEOCODING_PROVIDER = 'nominatim';
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      assert.equal(url.pathname, '/reverse');
      assert.equal(url.searchParams.get('lat'), '49.25');
      assert.equal(url.searchParams.get('lon'), '23.85');
      assert.equal(url.searchParams.get('accept-language'), 'uk');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ place_id: 7, display_name: 'Стрий, Україна', lat: '49.25', lon: '23.85' }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_REVERSE_URL = `http://127.0.0.1:${address.port}/reverse`;
    assert.deepEqual(await reverseGeocode(49.25, 23.85), {
      label: 'Стрий, Україна', latitude: 49.25, longitude: 23.85, providerId: '7',
    });
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('fails closed when the geocoder is not configured', async () => {
    delete process.env.GEOCODING_ENGINE_URL;
    await assert.rejects(() => suggestPlaces('Стрий'), GeocodingUnavailableError);
  });
});
