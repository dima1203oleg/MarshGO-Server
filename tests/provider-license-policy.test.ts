import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commercialUseFromLicense, hasVerifiedCommercialFeedRights } from '../server/mobility/licensePolicy';

test('only recognized licenses or explicit permission establish commercial reuse', () => {
  assert.equal(commercialUseFromLicense('CC BY 4.0'), true);
  assert.equal(commercialUseFromLicense('ODbL (OpenStreetMap-derived)'), true);
  assert.equal(commercialUseFromLicense('commercial use permitted; attribution required'), true);
  assert.equal(commercialUseFromLicense('CC BY-NC 4.0'), false);
  assert.equal(commercialUseFromLicense('Open data portal; terms not stated'), null);
  assert.equal(commercialUseFromLicense(null), null);
});

test('provider feeds require verified commercial reuse rights before enablement', () => {
  assert.equal(hasVerifiedCommercialFeedRights('CC BY 4.0'), true);
  assert.equal(hasVerifiedCommercialFeedRights('Creative Commons Attribution'), true);
  assert.equal(hasVerifiedCommercialFeedRights('OwnNet Source License 1.1'), false);
  assert.equal(hasVerifiedCommercialFeedRights('OwnNet Source License 1.1 (commercial use permitted; mdb-3615)'), false);
  assert.equal(hasVerifiedCommercialFeedRights('terms linked but not inspected'), false);
  assert.equal(hasVerifiedCommercialFeedRights(null), false);
});
