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

test('unknown seed scope is rejected before any database or provider work', () => {
  assert.equal(selectMobilitySeedEntries(catalog, '--all-cities-ish'), null);
});

test('only a new source with validated commercial access gets an enabled default', () => {
  assert.equal(initialMobilityProviderStatus(true), 'enabled');
  assert.equal(initialMobilityProviderStatus(false), 'disabled');
});
