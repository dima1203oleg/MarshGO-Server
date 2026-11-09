import assert from 'node:assert/strict';
import test from 'node:test';
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
