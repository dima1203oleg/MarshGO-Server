import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { SmsProviderUnavailableError, sendVerificationCode } from '../server/sms';

const original = { ...process.env };
const originalFetch = globalThis.fetch;
afterEach(() => {
  for (const key of ['NODE_ENV', 'AUTH_DEV_OTP', 'SMS_PROVIDER', 'GETOTP_API_KEY']) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  globalThis.fetch = originalFetch;
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

  it('fails closed for the unverified GetOtp adapter without making a network request', async () => {
    process.env.NODE_ENV = 'test';
    process.env.SMS_PROVIDER = 'getotp';
    process.env.GETOTP_API_KEY = 'test-only-placeholder';
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('unexpected network call');
    }) as typeof fetch;

    await assert.rejects(sendVerificationCode('+380671110001', '123456'), SmsProviderUnavailableError);
    assert.equal(fetchCalled, false);
  });
});
