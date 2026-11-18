import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordResetTestModeEnabled } from '../server/auth/passwordResetPolicy';

test('password reset token issuance is unavailable outside explicit isolated test mode', () => {
  assert.equal(passwordResetTestModeEnabled({ NODE_ENV: 'production', AUTH_EXPOSE_RESET_TOKEN: 'true' }), false);
  assert.equal(passwordResetTestModeEnabled({ NODE_ENV: 'development', AUTH_EXPOSE_RESET_TOKEN: 'true' }), false);
  assert.equal(passwordResetTestModeEnabled({ NODE_ENV: 'test', AUTH_EXPOSE_RESET_TOKEN: undefined }), false);
  assert.equal(passwordResetTestModeEnabled({ NODE_ENV: 'test', AUTH_EXPOSE_RESET_TOKEN: 'false' }), false);
  assert.equal(passwordResetTestModeEnabled({ NODE_ENV: 'test', AUTH_EXPOSE_RESET_TOKEN: 'true' }), true);
});
