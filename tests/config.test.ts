import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRuntimeConfig } from '../server/config';

const validProductionConfig: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'a'.repeat(64),
  CORS_ORIGINS: 'https://marshgo.example,capacitor://localhost',
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: 'ACplaceholder',
  TWILIO_AUTH_TOKEN: 'test-placeholder',
  TWILIO_FROM_NUMBER: '+10000000000',
};

describe('runtime production configuration', () => {
  it('accepts explicit production origins and configured real SMS provider', () => {
    assert.doesNotThrow(() => validateRuntimeConfig(validProductionConfig));
  });

  it('does not apply production restrictions to development', () => {
    assert.doesNotThrow(() => validateRuntimeConfig({ NODE_ENV: 'development', AUTH_DEV_OTP: 'true' }));
  });

  it('rejects development auth bypass in production', () => {
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, AUTH_DEV_BYPASS: 'true' }), /development authentication/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, AUTH_DEV_OTP: 'true' }), /development authentication/);
  });

  it('requires strong sessions, explicit secure origins, and real SMS credentials', () => {
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, SESSION_SECRET: 'short' }), /32 bytes/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, CORS_ORIGINS: undefined }), /CORS_ORIGINS is required/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, CORS_ORIGINS: 'http://localhost:3000' }), /HTTPS web origins/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, CORS_ORIGINS: '*' }), /explicit production origins/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, SMS_PROVIDER: undefined }), /SMS_PROVIDER=twilio/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, TWILIO_AUTH_TOKEN: undefined }), /TWILIO_AUTH_TOKEN is required/);
  });
});
