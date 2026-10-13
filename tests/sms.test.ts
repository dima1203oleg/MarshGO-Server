import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { SmsProviderUnavailableError, sendVerificationCode } from '../server/sms';

const original = { ...process.env };
afterEach(() => {
  for (const key of ['NODE_ENV', 'AUTH_DEV_OTP', 'SMS_PROVIDER']) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
});

describe('SMS verification delivery', () => {
  it('returns the code only to local development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_DEV_OTP = 'true';
    assert.deepEqual(await sendVerificationCode('+380671110001', '123456'), { provider: 'development', testCode: '123456' });
  });

  it('never exposes the code outside development, even with the dev flags set', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_DEV_OTP = 'true';
    process.env.SMS_PROVIDER = 'development';
    await assert.rejects(sendVerificationCode('+380671110001', '123456'), SmsProviderUnavailableError);
  });
});
