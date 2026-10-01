import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRuntimeConfig } from '../server/config';

const validProductionConfig: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  TRUST_PROXY_HOPS: '2',
  SESSION_SECRET: 'a'.repeat(64),
  CORS_ORIGINS: 'https://marshgo.example,capacitor://localhost',
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: 'ACplaceholder',
  TWILIO_AUTH_TOKEN: 'test-placeholder',
  TWILIO_FROM_NUMBER: '+10000000000',
  OSRM_URL: 'https://router.marshgo.example/route/v1/driving',
  GEOCODING_ENGINE_URL: 'https://geocoder.marshgo.example/search',
  GEOCODING_REVERSE_URL: 'https://geocoder.marshgo.example/reverse',
  MAP_RENDERER: 'maplibre',
  MAP_DATA_PROVIDER: 'marshgo',
  ROUTING_PRIMARY: 'osrm',
  TRAFFIC_PROVIDER: 'none',
  MAP_STYLE_MANIFEST_URL: 'https://maps.marshgo.example/manifests/style.json',
  MAP_DATA_MANIFEST_URL: 'https://maps.marshgo.example/manifests/data.json',
};

describe('runtime production configuration', () => {
  it('accepts explicit production origins and configured real SMS provider', () => {
    assert.doesNotThrow(() => validateRuntimeConfig(validProductionConfig));
  });

  it('does not apply production restrictions to development', () => {
    assert.doesNotThrow(() => validateRuntimeConfig({ NODE_ENV: 'development', AUTH_DEV_OTP: 'true' }));
  });

  it('requires an explicit, bounded trusted proxy topology in production', () => {
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, TRUST_PROXY_HOPS: undefined }), /TRUST_PROXY_HOPS is required/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, TRUST_PROXY_HOPS: '1.5' }), /integer from 0 to 5/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, TRUST_PROXY_HOPS: '6' }), /integer from 0 to 5/);
    assert.doesNotThrow(() => validateRuntimeConfig({ ...validProductionConfig, TRUST_PROXY_HOPS: '0' }));
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

  it('fails closed when production map/routing assets or provider settings are incompatible', () => {
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, OSRM_URL: 'http://localhost:5000/route' }), /OSRM_URL must be a public HTTPS URL/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, MAP_STYLE_MANIFEST_URL: undefined }), /MAP_STYLE_MANIFEST_URL is required/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, ROUTING_PRIMARY: 'here' }), /only configured production routing provider/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, HERE_TRAFFIC_ENABLED: 'true' }), /provider adapter is implemented/);
    assert.throws(() => validateRuntimeConfig({ ...validProductionConfig, TRAFFIC_PROVIDER: 'tomtom' }), /only configured traffic provider/);
  });
});
