import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { isGeocoderReady, parseNominatimSuggestions, parsePhotonSuggestions, probeGeocoder, resetGeocoderReadinessCache, reverseGeocode, suggestPlaces, GeocodingUnavailableError } from '../server/geocoding';

describe('Nominatim-compatible place search adapter', () => {
  let server: Server | undefined;
  const originalUrl = process.env.GEOCODING_ENGINE_URL;
  const originalReverseUrl = process.env.GEOCODING_REVERSE_URL;
  const originalKey = process.env.GEOCODING_API_KEY;
  const originalProvider = process.env.GEOCODING_PROVIDER;
  const originalForwardLocationBias = process.env.GEOCODING_FORWARD_LOCATION_BIAS;
  const originalEnvironment = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.GEOCODING_PROVIDER = 'nominatim';
    delete process.env.GEOCODING_FORWARD_LOCATION_BIAS;
    resetGeocoderReadinessCache();
  });

  it('keeps API readiness healthy for an optional geocoder outage and fails only when required', () => {
    for (const state of ['ok', 'unreachable', 'misconfigured', 'unconfigured'] as const) {
      assert.equal(isGeocoderReady(false, state), true, `optional geocoder state: ${state}`);
      assert.equal(isGeocoderReady(true, state), state === 'ok', `required geocoder state: ${state}`);
    }
  });

  after(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    if (originalUrl === undefined) delete process.env.GEOCODING_ENGINE_URL;
    else process.env.GEOCODING_ENGINE_URL = originalUrl;
    if (originalReverseUrl === undefined) delete process.env.GEOCODING_REVERSE_URL;
    else process.env.GEOCODING_REVERSE_URL = originalReverseUrl;
    if (originalKey === undefined) delete process.env.GEOCODING_API_KEY;
    else process.env.GEOCODING_API_KEY = originalKey;
    if (originalProvider === undefined) delete process.env.GEOCODING_PROVIDER;
    else process.env.GEOCODING_PROVIDER = originalProvider;
    if (originalForwardLocationBias === undefined) delete process.env.GEOCODING_FORWARD_LOCATION_BIAS;
    else process.env.GEOCODING_FORWARD_LOCATION_BIAS = originalForwardLocationBias;
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
  });

  it('validates provider records and filters invalid coordinates', () => {
    assert.deepEqual(parseNominatimSuggestions([
      { place_id: 42, display_name: 'Стрий, Львівська область, Україна', lat: '49.258', lon: '23.856' },
      { place_id: 43, display_name: 'Invalid', lat: '92', lon: '24' },
      { place_id: 44, display_name: '', lat: '49', lon: '24' },
    ]), [{ label: 'Стрий, Львівська область, Україна', latitude: 49.258, longitude: 23.856, providerId: '42' }]);
  });

  it('parses Photon GeoJSON, requires Ukrainian provenance and deduplicates by label', () => {
    assert.deepEqual(parsePhotonSuggestions({ features: [
      {
        properties: { name: 'Львів', city: 'Львів', state: 'Львівська область', countrycode: 'UA', osm_type: 'R', osm_id: 123 },
        geometry: { type: 'Point', coordinates: [24.0297, 49.8397] },
      },
      {
        properties: { name: 'Lviv', city: 'Lviv', countrycode: 'GB', osm_type: 'N', osm_id: 456 },
        geometry: { type: 'Point', coordinates: [-3.2, 55.9] },
      },
      {
        properties: { name: 'Львів', city: 'Львів', state: 'Львівська область', countrycode: 'ua', osm_type: 'W', osm_id: 789 },
        geometry: { type: 'Point', coordinates: [24.03, 49.84] },
      },
      {
        properties: { name: 'Bad coordinates', countrycode: 'UA', osm_type: 'N', osm_id: 999 },
        geometry: { type: 'Point', coordinates: [181, 49] },
      },
      {
        properties: { name: 'Non-point geometry', countrycode: 'UA', osm_type: 'N', osm_id: 1000 },
        geometry: { type: 'LineString', coordinates: [[24, 49], [25, 50]] },
      },
    ] }), [{ label: 'Львів, Львівська область', latitude: 49.8397, longitude: 24.0297, providerId: 'r:123' }]);
    assert.throws(() => parsePhotonSuggestions({ type: 'FeatureCollection', features: 'invalid' }), GeocodingUnavailableError);
  });

  it('requests Photon search with Ukrainian country filter and map bias', async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      assert.equal(url.pathname, '/api');
      assert.equal(url.searchParams.get('q'), 'Львів');
      assert.equal(url.searchParams.get('countrycode'), 'UA');
      assert.equal(url.searchParams.get('bbox'), '22.137,44.386,40.228,52.379');
      assert.equal(url.searchParams.has('lang'), false, 'public Photon currently rejects lang=uk');
      assert.equal(url.searchParams.get('limit'), '6');
      assert.equal(url.searchParams.get('lat'), '49.8397');
      assert.equal(url.searchParams.get('lon'), '24.0297');
      assert.equal(url.searchParams.get('zoom'), '12');
      response.writeHead(200, { 'content-type': 'application/geo+json' });
      response.end(JSON.stringify({ type: 'FeatureCollection', features: [{
        type: 'Feature',
        properties: { name: 'Львів', city: 'Львів', state: 'Львівська область', countrycode: 'UA', osm_type: 'R', osm_id: 123 },
        geometry: { type: 'Point', coordinates: [24.0297, 49.8397] },
      }] }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_PROVIDER = 'photon';
    process.env.GEOCODING_FORWARD_LOCATION_BIAS = 'true';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/api`;
    assert.deepEqual(await suggestPlaces('Львів', { latitude: 49.8397, longitude: 24.0297 }), [
      { label: 'Львів, Львівська область', latitude: 49.8397, longitude: 24.0297, providerId: 'r:123' },
    ]);
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('does not forward caller coordinates to Photon unless explicitly enabled', async () => {
    let observed: URL | undefined;
    server = createServer((request, response) => {
      observed = new URL(request.url ?? '/', 'http://localhost');
      response.writeHead(200, { 'content-type': 'application/geo+json' });
      response.end(JSON.stringify({ type: 'FeatureCollection', features: [] }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_PROVIDER = 'photon';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/api`;

    await suggestPlaces('Львів', { latitude: 49.8397, longitude: 24.0297 });

    assert.ok(observed);
    assert.equal(observed.searchParams.get('q'), 'Львів');
    assert.equal(observed.searchParams.has('lat'), false);
    assert.equal(observed.searchParams.has('lon'), false);
    assert.equal(observed.searchParams.has('zoom'), false);
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('reverse geocodes through Photon GeoJSON when selected', async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      assert.equal(url.pathname, '/reverse');
      assert.equal(url.searchParams.get('lat'), '49.25');
      assert.equal(url.searchParams.get('lon'), '23.85');
      assert.equal(url.searchParams.has('countrycode'), false, 'Photon reverse rejects countrycode filtering');
      response.writeHead(200, { 'content-type': 'application/geo+json' });
      response.end(JSON.stringify({ type: 'FeatureCollection', features: [{
        type: 'Feature',
        properties: { name: 'Стрийський вокзал', city: 'Стрий', state: 'Львівська область', countrycode: 'UA', osm_type: 'N', osm_id: 456 },
        geometry: { type: 'Point', coordinates: [23.85, 49.25] },
      }] }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_PROVIDER = 'photon';
    process.env.GEOCODING_REVERSE_URL = `http://127.0.0.1:${address.port}/reverse`;
    assert.deepEqual(await reverseGeocode(49.25, 23.85), {
      label: 'Стрийський вокзал, Стрий', latitude: 49.25, longitude: 23.85, providerId: 'n:456',
    });
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('queries an isolated provider contract and restricts suggestions to Ukraine', async () => {
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

  it('biases suggestions toward the caller locality without filtering it', async () => {
    const seen: string[] = [];
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      seen.push(url.searchParams.get('viewbox') ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ place_id: 1, display_name: 'Залізничний вокзал, Львів', lat: '49.839', lon: '24.030' }]));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_FORWARD_LOCATION_BIAS = 'true';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/search`;
    await suggestPlaces('залізничний вокзал', { latitude: 49.8397, longitude: 24.0297 });
    assert.equal(seen[0], '23.8997,49.9297,24.1597,49.7497');
    await suggestPlaces('залізничний вокзал');
    assert.equal(seen[1], '');
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('does not forward caller locality to Nominatim-compatible providers by default', async () => {
    let observed: URL | undefined;
    server = createServer((request, response) => {
      observed = new URL(request.url ?? '/', 'http://localhost');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([]));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/search`;

    await suggestPlaces('вокзал', { latitude: 49.8397, longitude: 24.0297 });

    assert.ok(observed);
    assert.equal(observed.searchParams.get('q'), 'вокзал');
    assert.equal(observed.searchParams.has('viewbox'), false);
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('reverse geocodes coordinates through a bounded Ukrainian provider request', async () => {
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
    try {
      assert.deepEqual(await reverseGeocode(49.25, 23.85), {
        label: 'Стрий, Україна', latitude: 49.25, longitude: 23.85, providerId: '7',
      });
    } finally {
      if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
  });

  it('fails closed when the geocoder is not configured', async () => {
    delete process.env.GEOCODING_ENGINE_URL;
    await assert.rejects(() => suggestPlaces('Стрий'), GeocodingUnavailableError);
  });

  it('refuses autocomplete against the public Nominatim instance', async () => {
    process.env.GEOCODING_PROVIDER = 'nominatim';
    process.env.GEOCODING_ENGINE_URL = 'https://nominatim.openstreetmap.org/search';
    await assert.rejects(() => suggestPlaces('Стрий'), /Public Nominatim does not support place autocomplete/);
  });

  it('asks the provider for structured addresses', async () => {
    let askedForDetails: string | null = 'missing';
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      askedForDetails = url.searchParams.get('addressdetails');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('[]');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/search`;
    await suggestPlaces('Київ');
    assert.equal(askedForDetails, '1');
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('reports a provider outage as an unavailable geocoder, not a crash', async () => {
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_ENGINE_URL = 'http://127.0.0.1:1/search';
    await assert.rejects(() => suggestPlaces('Львів'), GeocodingUnavailableError);
  });

  it('maps a non-OK provider response to a geocoder outage', async () => {
    server = createServer((_request, response) => {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('bad gateway');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/search`;
    await assert.rejects(() => suggestPlaces('Львів'), /Geocoder request failed/);
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('maps a malformed provider body to a geocoder outage instead of a 500', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"truncated":');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/search`;
    await assert.rejects(() => suggestPlaces('Львів'), /Geocoder returned invalid JSON/);
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('keeps an empty provider answer as an empty list', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('[]');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/search`;
    assert.deepEqual(await suggestPlaces('Зззз'), []);
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('reports readiness from configuration and a cached live probe', async () => {
    delete process.env.GEOCODING_ENGINE_URL;
    resetGeocoderReadinessCache();
    assert.equal((await probeGeocoder()).state, 'unconfigured');

    let requests = 0;
    server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ place_id: 7, display_name: 'Львів, Україна', lat: '49.8397', lon: '24.0297' }]));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_ENGINE_URL = `http://127.0.0.1:${address.port}/search`;
    resetGeocoderReadinessCache();
    const first = await probeGeocoder();
    assert.equal(first.state, 'ok');
    assert.equal(first.state === 'ok' ? first.results : -1, 1);
    await probeGeocoder();
    assert.equal(requests, 1, 'readiness probe is cached between health checks');
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('distinguishes an unreachable geocoder from a misconfigured one', async () => {
    process.env.NODE_ENV = 'test';
    process.env.GEOCODING_ENGINE_URL = 'http://127.0.0.1:1/search';
    resetGeocoderReadinessCache();
    assert.equal((await probeGeocoder()).state, 'unreachable');

    process.env.GEOCODING_ENGINE_URL = 'https://nominatim.openstreetmap.org/search';
    resetGeocoderReadinessCache();
    assert.equal((await probeGeocoder()).state, 'misconfigured');
  });
});

describe('short place labels', () => {
  const city = {
    place_id: 192146642, name: 'Київ', addresstype: 'city',
    display_name: 'Київ, Україна', lat: '50.4500336', lon: '30.5241361',
    address: { city: 'Київ', state: 'Київ', country: 'Україна' },
  };
  const crimeanVillage = {
    place_id: 203488119, addresstype: 'hamlet',
    display_name: 'Львів, Семисотське сільське поселення, Керченський район, Автономна Республіка Крим, Україна',
    lat: '45.2606004', lon: '35.4732144',
    // The provider files the hromada under `city`, so following `city` would hide that this is Crimea.
    address: { hamlet: 'Львів', city: 'Семисотське сільське поселення', county: 'Керченський район', state: 'Автономна Республіка Крим', country: 'Україна' },
  };
  // Three OSM elements of the same house, all within ~40 m of each other.
  const chernivtsiHouse = (placeId: number, lat: string, lon: string) => ({
    place_id: placeId, addresstype: 'house',
    display_name: '46, Головна вулиця, Старе Місто, Чернівці, Чернівецька міська громада, Чернівецький район, Чернівецька область, 58002, Україна',
    lat, lon,
    address: { road: 'Головна вулиця', house_number: '46', suburb: 'Старе Місто', city: 'Чернівці', state: 'Чернівецька область', country: 'Україна' },
  });

  it('keeps only the place and the region that separates equally named places', () => {
    const labels = parseNominatimSuggestions([city, crimeanVillage]).map((place) => place.label);
    assert.deepEqual(labels, ['Київ', 'Львів, Автономна Республіка Крим']);
  });

  it('collapses the same address into one choice', () => {
    const places = parseNominatimSuggestions([
      chernivtsiHouse(191289985, '48.2895749', '25.9340922'),
      chernivtsiHouse(191422011, '48.2896114', '25.9343379'),
      chernivtsiHouse(190894588, '48.2896586', '25.9341087'),
    ]);
    assert.deepEqual(places.map((place) => place.label), ['Головна вулиця, 46, Чернівці']);
    assert.equal(places.length, 1);
  });

  // A long street is cut into OSM segments kilometres apart, so a coordinate bucket cannot merge them;
  // the passenger still sees one name and cannot tell the rows apart.
  it('collapses one street split across distant segments', () => {
    const naukova = (placeId: number, lat: string, lon: string) => ({
      place_id: placeId, name: 'вулиця Наукова', addresstype: 'road',
      display_name: 'вулиця Наукова, Одеса, Україна', lat, lon,
      address: { road: 'вулиця Наукова', city: 'Одеса', country: 'Україна' },
    });
    const places = parseNominatimSuggestions([
      naukova(501, '46.4600000', '30.7000000'),
      naukova(502, '46.4900000', '30.7400000'),
      naukova(503, '46.5200000', '30.7900000'),
      naukova(504, '46.4700000', '30.7100000'),
    ]);
    assert.equal(places.length, 1);
    assert.equal(places[0]?.providerId, '501');
  });

  it('shows a street for a street and the venue for a venue', () => {
    const [road] = parseNominatimSuggestions([{
      place_id: 301, name: 'вулиця Наукова', addresstype: 'road',
      display_name: 'вулиця Наукова, Франківський район, Львів, Україна', lat: '49.8347', lon: '24.0155',
      address: { road: 'вулиця Наукова', suburb: 'Франківський район', city: 'Львів', state: 'Львівська область', country: 'Україна' },
    }]);
    const [venue] = parseNominatimSuggestions([{
      place_id: 302, name: 'Львівська політехніка', addresstype: 'university',
      display_name: 'Львівська політехніка, 2, вулиця Карпінського, Львів, Україна', lat: '49.8390', lon: '24.0297',
      address: { road: 'вулиця Карпінського', house_number: '2', city: 'Львів', state: 'Львівська область', country: 'Україна' },
    }]);
    assert.equal(road?.label, 'вулиця Наукова, Львів');
    assert.equal(venue?.label, 'Львівська політехніка, Львів');
  });

  it('truncates a long venue name but keeps its city', () => {
    const [place] = parseNominatimSuggestions([{
      place_id: 401, name: 'Навчально-науковий інститут аерокосмічних технологій імені академіка Корольова', addresstype: 'building',
      display_name: 'Інститут, Львів, Україна', lat: '49.8390', lon: '24.0297',
      address: { city: 'Львів', state: 'Львівська область', country: 'Україна' },
    }]);
    assert.ok(place);
    assert.ok(place.label.length <= 64, `${place.label.length}: ${place.label}`);
    assert.ok(place.label.endsWith(', Львів'), place.label);
  });
});
