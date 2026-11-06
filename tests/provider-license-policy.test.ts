import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canEnableCommercialProvider, commercialUseFromLicense } from '../server/mobility/licensePolicy';

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
