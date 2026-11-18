import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { parseNominatimSuggestions, parsePhotonSuggestions, parsePlaceBias, reverseGeocode, suggestPlaces, GeocodingUnavailableError } from '../server/geocoding';

type GeocodingEnvKey = 'NODE_ENV' | 'GEOCODING_PROVIDER' | 'GEOCODING_ENGINE_URL' | 'GEOCODING_REVERSE_URL' | 'GEOCODING_FORWARD_LOCATION_BIAS';

async function withGeocodingEnvironment<T>(
  overrides: Partial<Record<GeocodingEnvKey, string>>,
  run: () => Promise<T>,
): Promise<T> {
  const keys = Object.keys(overrides) as GeocodingEnvKey[];
  const original = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) process.env[key as GeocodingEnvKey] = value;
    }
    return await run();
  } finally {
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function closeTestServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server?.listening) { resolve(); return; }
    server.close(error => error ? reject(error) : resolve());
  });
}

describe('Nominatim-compatible place search adapter', () => {
  let server: Server | undefined;
  const originalUrl = process.env.GEOCODING_ENGINE_URL;
  const originalReverseUrl = process.env.GEOCODING_REVERSE_URL;
  const originalKey = process.env.GEOCODING_API_KEY;
  const originalProvider = process.env.GEOCODING_PROVIDER;
  const originalForwardBias = process.env.GEOCODING_FORWARD_LOCATION_BIAS;
  const originalEnvironment = process.env.NODE_ENV;

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
    if (originalForwardBias === undefined) delete process.env.GEOCODING_FORWARD_LOCATION_BIAS;
    else process.env.GEOCODING_FORWARD_LOCATION_BIAS = originalForwardBias;
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

  it('parses an optional WGS84 location bias and ignores malformed coordinates', () => {
    assert.deepEqual(parsePlaceBias('49.794117', '24.057585'), { latitude: 49.794117, longitude: 24.057585 });
    assert.deepEqual(parsePlaceBias('90', '-180'), { latitude: 90, longitude: -180 });
    for (const [latitude, longitude] of [
      [undefined, undefined], ['49', undefined], ['north', '24'], ['91', '24'], ['49', '181'], ['', '24'],
    ]) assert.equal(parsePlaceBias(latitude, longitude), undefined);
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

  it('forwards location bias only after explicit privacy opt-in', async () => {
    const requests: URL[] = [];
    server = createServer((request, response) => {
      requests.push(new URL(request.url ?? '/', 'http://localhost'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('[]');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const environment = { NODE_ENV: 'test', GEOCODING_PROVIDER: 'nominatim', GEOCODING_ENGINE_URL: `http://127.0.0.1:${address.port}/search` };
    const bias = { latitude: 49.794117, longitude: 24.057585 };
    await withGeocodingEnvironment({ ...environment, GEOCODING_FORWARD_LOCATION_BIAS: 'true' }, () => suggestPlaces('Сихів', bias));
    await withGeocodingEnvironment({ ...environment, GEOCODING_FORWARD_LOCATION_BIAS: 'false' }, () => suggestPlaces('Сихів', bias));
    assert.equal(requests[0].searchParams.get('viewbox'), '23.9276,49.8841,24.1876,49.7041');
    assert.equal(requests[1].searchParams.has('viewbox'), false);
    assert.equal(requests[1].searchParams.has('lat'), false);
    assert.equal(requests[1].searchParams.has('lon'), false);
    await closeTestServer(server);
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

  it('refuses the public Photon demo endpoint in production', async () => {
    await withGeocodingEnvironment({
      NODE_ENV: 'production',
      GEOCODING_PROVIDER: 'photon',
      GEOCODING_ENGINE_URL: 'https://photon.komoot.io/api/',
    }, () => assert.rejects(
      () => suggestPlaces('Львів'),
      (error: unknown) => error instanceof GeocodingUnavailableError && /evaluation-only/i.test(error.message),
    ));
  });

  it('refuses public Photon for production reverse geocoding before making a request', async () => {
    await withGeocodingEnvironment({
      NODE_ENV: 'production',
      GEOCODING_PROVIDER: 'photon',
      GEOCODING_REVERSE_URL: 'https://photon.komoot.io/reverse',
    }, () => assert.rejects(
      () => reverseGeocode(49.84, 24.03),
      (error: unknown) => error instanceof GeocodingUnavailableError && /evaluation-only/i.test(error.message),
    ));
  });

  it('asks the provider for structured addresses', async () => {
    let askedForDetails: string | null = 'missing';
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      askedForDetails = url.searchParams.get('addressdetails');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('[]');
    });
    try {
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      await withGeocodingEnvironment({
        NODE_ENV: 'test',
        GEOCODING_PROVIDER: 'nominatim',
        GEOCODING_ENGINE_URL: `http://127.0.0.1:${address.port}/search`,
      }, async () => {
        await suggestPlaces('Київ');
        assert.equal(askedForDetails, '1');
      });
    } finally {
      await closeTestServer(server);
      server = undefined;
    }
  });

  it('uses the Photon GeoJSON contract and filters results to Ukraine', async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      assert.equal(url.pathname, '/api/');
      assert.equal(url.searchParams.get('q'), 'вулиця Коперника, Львів');
      assert.equal(url.searchParams.get('countrycode'), 'UA');
      assert.equal(url.searchParams.get('bbox'), '22.137,44.386,40.228,52.379');
      assert.equal(url.searchParams.get('limit'), '6');
      assert.equal(url.searchParams.has('format'), false);
      assert.equal(url.searchParams.has('addressdetails'), false);
      assert.equal(url.searchParams.has('countrycodes'), false);
      response.writeHead(200, { 'content-type': 'application/geo+json' });
      response.end(JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { countrycode: 'UA', osm_type: 'W', osm_id: 123, street: 'вулиця Коперника', housenumber: '3', city: 'Львів' },
            geometry: { type: 'Point', coordinates: [24.03, 49.84] },
          },
          {
            type: 'Feature',
            properties: { countrycode: 'PE', osm_type: 'W', osm_id: 456, name: 'Lviv' },
            geometry: { type: 'Point', coordinates: [-76.2, -12.0] },
          },
        ],
      }));
    });
    try {
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      await withGeocodingEnvironment({
        NODE_ENV: 'test',
        GEOCODING_PROVIDER: 'photon',
        GEOCODING_ENGINE_URL: `http://127.0.0.1:${address.port}/api/`,
      }, async () => {
        assert.deepEqual(await suggestPlaces('вулиця Коперника, Львів'), [
          { label: 'вулиця Коперника, 3, Львів', latitude: 49.84, longitude: 24.03, providerId: 'w:123' },
        ]);
      });
    } finally {
      await closeTestServer(server);
      server = undefined;
    }
  });

  it('rejects malformed Photon collections and ignores invalid/out-of-range features', () => {
    assert.throws(() => parsePhotonSuggestions([]), GeocodingUnavailableError);
    const places = parsePhotonSuggestions({
      features: [
        { properties: { countrycode: 'UA', osm_type: 'N', osm_id: 1, name: 'Львів' }, geometry: { type: 'Point', coordinates: [24.03, 49.84] } },
        { properties: { countrycode: 'UA', osm_type: 'N', osm_id: 2, name: 'Некоректна точка' }, geometry: { type: 'Point', coordinates: [24.03, 99] } },
        { properties: { countrycode: 'UA', osm_type: 'N', osm_id: 3, name: 'Без геометрії' }, geometry: { type: 'LineString', coordinates: [] } },
      ],
    });
    assert.deepEqual(places, [{ label: 'Львів', latitude: 49.84, longitude: 24.03, providerId: 'n:1' }]);
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
