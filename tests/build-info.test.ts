import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getBuildInfo } from '../server/buildInfo';

describe('server build diagnostics', () => {
  it('reports only validated build metadata and a normalized environment', () => {
    const info = getBuildInfo({
      NODE_ENV: 'production',
      MARSHGO_BUILD_ID: 'release-2026.10.29',
      MARSHGO_BUILD_SHA: 'a'.repeat(40),
      MARSHGO_BUILD_TIME: '2026-10-29T09:30:00Z',
      MARSHGO_SOURCE_STATE: 'clean',
      DATABASE_URL: 'postgres://private.example/secret',
    } as NodeJS.ProcessEnv);

    assert.deepEqual({
      service: info.service,
      apiContract: info.apiContract,
      buildId: info.buildId,
      commitSha: info.commitSha,
      builtAt: info.builtAt,
      environment: info.environment,
      sourceState: info.sourceState,
    }, {
      service: 'MarshGO-Server',
      apiContract: 'v1',
      buildId: 'release-2026.10.29',
      commitSha: 'a'.repeat(40),
      builtAt: '2026-10-29T09:30:00.000Z',
      environment: 'production',
      sourceState: 'clean',
    });
    assert.equal(info.serviceVersion, '1.0.0');
    assert.match(info.instanceId, /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.stringify(info).includes('private.example'), false);
  });

  it('reports missing or malformed build identity as unknown without exposing supplied values', () => {
    const info = getBuildInfo({
      NODE_ENV: 'customer-production-eu-west-1',
      MARSHGO_BUILD_ID: '/etc/secrets',
      MARSHGO_BUILD_SHA: 'not-a-sha',
      MARSHGO_BUILD_TIME: 'not-a-date',
      MARSHGO_SOURCE_STATE: 'not-a-status',
    } as NodeJS.ProcessEnv);

    assert.equal(info.buildId, null);
    assert.equal(info.commitSha, null);
    assert.equal(info.builtAt, null);
    assert.equal(info.environment, 'unknown');
    assert.equal(info.sourceState, 'unknown');
    assert.equal(JSON.stringify(info).includes('/etc/secrets'), false);
  });
});
