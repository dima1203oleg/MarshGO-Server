import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adminGrantAllowed, configuredAdminPhones, shouldGrantAdmin } from '../server/adminPhones';

const phones = '+380969999070, +380964066661, 0969999070, not-a-phone';

describe('configured admin phones', () => {
  it('keeps only valid E.164 numbers', () => {
    assert.deepEqual([...configuredAdminPhones({ ADMIN_PHONES: phones })].sort(), ['+380964066661', '+380969999070']);
    assert.equal(configuredAdminPhones({}).size, 0);
  });

  it('grants admin only to listed phones when OTP delivery is real', () => {
    const production = { NODE_ENV: 'production', ADMIN_PHONES: phones } as NodeJS.ProcessEnv;
    assert.equal(shouldGrantAdmin('+380969999070', production), true);
    assert.equal(shouldGrantAdmin('+380671110001', production), false);
  });

  it('never grants admin while the development OTP is visible in the UI', () => {
    const dev = { NODE_ENV: 'development', AUTH_DEV_OTP: 'true', ADMIN_PHONES: phones } as NodeJS.ProcessEnv;
    assert.equal(adminGrantAllowed(dev), false);
    assert.equal(shouldGrantAdmin('+380969999070', dev), false);
  });
});
