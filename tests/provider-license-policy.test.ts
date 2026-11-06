import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canEnableCommercialProvider, commercialUseFromLicense } from '../server/mobility/licensePolicy';
import { ukraineCatalog } from '../server/mobility/ukraineCatalog';

test('only recognized licenses or explicit permission establish commercial reuse', () => {
  assert.equal(commercialUseFromLicense('CC BY 4.0'), true);
  assert.equal(commercialUseFromLicense('ODbL (OpenStreetMap-derived)'), true);
  assert.equal(commercialUseFromLicense('commercial use permitted; attribution required'), true);
  assert.equal(commercialUseFromLicense('CC BY-NC 4.0'), false);
  assert.equal(commercialUseFromLicense('Open data portal; terms not stated'), null);
  assert.equal(commercialUseFromLicense(null), null);
});

test('provider activation fails closed unless the source explicitly allows commercial use', () => {
  assert.equal(canEnableCommercialProvider('open', 'CC BY 4.0'), true);
  assert.equal(canEnableCommercialProvider('open', 'ODbL (OpenStreetMap-derived)'), true);
  assert.equal(canEnableCommercialProvider('open', 'Open data portal; terms not stated'), false);
  assert.equal(canEnableCommercialProvider('open', null), false);
  assert.equal(canEnableCommercialProvider('requires_partner_access', 'CC BY 4.0'), false);
  assert.equal(canEnableCommercialProvider('open', 'CC BY-NC 4.0'), false);
});

test('Stryi municipal GTFS records its official CC BY attribution and remains schedule-only', () => {
  const stryi = ukraineCatalog.find((entry) => entry.sourceRef.includes('mdb:ua-stryi-gtfs-2932'));

  assert.ok(stryi);
  assert.equal(stryi.access, 'open');
  assert.equal(canEnableCommercialProvider(stryi.access, stryi.license), true);
  assert.match(stryi.license ?? '', /data\.loda\.gov\.ua\/dataset\/7b9ddbc6-df4b-4d2e-9567-af66ede840cc/);
  assert.match(stryi.coverage, /live-позиції, тарифи та бронювання цим GTFS не підтверджуються/i);
});
