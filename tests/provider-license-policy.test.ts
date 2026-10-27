import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commercialUseFromLicense } from '../server/mobility/licensePolicy';
import { ukraineCatalog } from '../server/mobility/ukraineCatalog';

test('only recognized licenses or explicit permission establish commercial reuse', () => {
  assert.equal(commercialUseFromLicense('CC BY 4.0'), true);
  assert.equal(commercialUseFromLicense('ODbL (OpenStreetMap-derived)'), true);
  assert.equal(commercialUseFromLicense('commercial use permitted; attribution required'), true);
  assert.equal(commercialUseFromLicense('CC BY-NC 4.0'), false);
  assert.equal(commercialUseFromLicense('Open data portal; terms not stated'), null);
  assert.equal(commercialUseFromLicense(null), null);
});

test('Lviv static GTFS records its verified commercial license and required attribution', () => {
  const lvivStaticFeed = ukraineCatalog.find((entry) => entry.city === 'Львів' && entry.sourceType === 'gtfs');

  assert.ok(lvivStaticFeed);
  assert.match(lvivStaticFeed.license ?? '', /CC BY 4\.0/);
  assert.equal(commercialUseFromLicense(lvivStaticFeed.license), true);
  assert.match(lvivStaticFeed.license ?? '', /data\.gov\.ua\/dataset\/lviv-public-transport-gtfs-real-time/);
});
