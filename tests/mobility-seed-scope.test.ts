import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canEnableCommercialProvider } from '../server/mobility/licensePolicy';
import { initialMobilityProviderStatus, selectMobilitySeedEntries } from '../server/mobility/seedScope';
import { kyivOpenDataCatalog, ukraineCatalog, ukraineCatalogWave2, ukraineCatalogWave3 } from '../server/mobility/ukraineCatalog';

const catalog = [...ukraineCatalog, ...ukraineCatalogWave2, ...ukraineCatalogWave3, ...kyivOpenDataCatalog];

test('all seed scope preserves the complete catalog', () => {
  const selected = selectMobilitySeedEntries(catalog, 'all');
  assert.deepEqual(selected, catalog);
  assert.notEqual(selected, catalog);
});

test('Lviv seed scope contains only the city feeds and includes static plus realtime sources', () => {
  const selected = selectMobilitySeedEntries(catalog, '--lviv');
  assert.ok(selected && selected.length > 0);
  assert.ok(selected.every((entry) => entry.city === 'Львів'));
  assert.ok(selected.some((entry) => entry.sourceType === 'gtfs'));
  assert.ok(selected.some((entry) => entry.sourceType === 'gtfs_rt'));
});

test('Kyiv metro scope remains restricted to Kyiv metro catalog entries', () => {
  const selected = selectMobilitySeedEntries(catalog, '--kyiv-metro');
  assert.ok(selected && selected.length > 0);
  assert.ok(selected.every((entry) => entry.city === 'Київ' && entry.name.toLocaleLowerCase('uk-UA').includes('метро')));
});

test('Kyiv marshrutka geometry uses the official production HTTPS ArcGIS layer and stays geometry-only', () => {
  const source = kyivOpenDataCatalog.find((entry) => entry.name.includes('маршрутки'));
  assert.ok(source);
  assert.equal(source.sourceType, 'geojson');
  assert.equal(source.access, 'open');
  assert.equal(new URL(source.feedUrl).hostname, 'gisserver.kyivcity.gov.ua');
  assert.match(new URL(source.feedUrl).pathname, /transport_public\/MapServer\/1\/query$/);
  assert.match(source.coverage, /без realtime, розкладу та бронювання/);

  const scooter = ukraineCatalog.find((entry) => entry.name.includes('Zelectra'));
  assert.ok(scooter);
  assert.equal(scooter.sourceType, 'gbfs');
  assert.equal(scooter.providerType, 'scooter');
  assert.equal(new URL(scooter.feedUrl).hostname, 'zelectra.rideatom.com');
});

test('focused Kyiv feed seed selects only the routeTaxi geometry and Zelectra GBFS records', () => {
  const selected = selectMobilitySeedEntries(catalog, '--kyiv-route-taxi-zelectra');
  assert.ok(selected);
  assert.equal(selected.length, 2);
  assert.ok(selected.some((entry) => entry.sourceType === 'geojson' && entry.name.includes('маршрутки')));
  assert.ok(selected.some((entry) => entry.sourceType === 'gbfs' && entry.name.includes('Zelectra')));
});

test('unknown seed scope is rejected before any database or provider work', () => {
  assert.equal(selectMobilitySeedEntries(catalog, '--all-cities-ish'), null);
});

test('only a new source with validated commercial access gets an enabled default', () => {
  assert.equal(initialMobilityProviderStatus(true), 'enabled');
  assert.equal(initialMobilityProviderStatus(false), 'disabled');
});

for (const feedUrl of [
  'https://track.ua-gis.com/gtfs/uzhhorod/static.zip',
  'https://city.dozor.tech/iv-frankivsk/gtfs/static.zip',
]) {
  test(`schedule dataset metadata alone cannot activate an unverified archive: ${feedUrl}`, () => {
    const entry = catalog.find((row) => row.feedUrl === feedUrl);
    assert.ok(entry);
    assert.equal(canEnableCommercialProvider(entry.access, entry.license), false);
    assert.equal(initialMobilityProviderStatus(canEnableCommercialProvider(entry.access, entry.license)), 'disabled');
  });
}

for (const status of ['enabled', 'disabled', 'paused']) {
  test(`catalog upsert preserves an existing ${status} decision in an in-memory SQL fixture`, () => {
    const source = readFileSync(new URL('../server/mobility/seedUkraine.ts', import.meta.url), 'utf8');
    const statements = [...source.matchAll(/`(INSERT INTO mobility_providers[\s\S]*?RETURNING id,status)`/g)];
    assert.equal(statements.length, 1);
    const db = new DatabaseSync(':memory:');
    try {
      db.function('now', () => '2026-11-12T00:00:00Z');
      db.exec(`CREATE TABLE mobility_providers (
        id TEXT DEFAULT 'fixture-provider', name TEXT, city TEXT, provider_type TEXT,
        source_type TEXT, feed_url TEXT, realtime_url TEXT, vehicle_position_url TEXT,
        priority INTEGER, access TEXT, license TEXT, update_frequency TEXT, coverage TEXT,
        source_ref TEXT, country TEXT, commercial_use INTEGER, attribution_required INTEGER,
        discovery_status TEXT, status TEXT, updated_at TEXT, UNIQUE(name, city)
      )`);
      const upsert = db.prepare(statements[0][1]);
      const values = ['fixture', 'fixture-city', 'public_transit', 'gtfs', 'https://example.test/old.zip', null,
        null, 10, 'open', null, null, 'fixture', 'fixture', 0, 0, 'DISCOVERED', status];
      const parameters = Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
      upsert.get(parameters);
      const refreshed = upsert.get({ ...parameters, '5': 'https://example.test/new.zip', '10': 'CC BY 4.0',
        '14': 1, '15': 1, '16': 'VALIDATED', '17': initialMobilityProviderStatus(true) });
      assert.equal(refreshed?.status, status);
      assert.equal(db.prepare('SELECT feed_url FROM mobility_providers').get()?.feed_url, 'https://example.test/new.zip');
      assert.equal(db.prepare('SELECT count(*) AS total FROM mobility_providers').get()?.total, 1);
    } finally {
      db.close();
    }
  });
}
