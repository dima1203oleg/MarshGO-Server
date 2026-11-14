import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProbeReport, refreshProviderHealth } from '../server/mobility/healthMonitor';
import type { ConnectionReport } from '../server/mobility/types';

const reachableProbe: ConnectionReport = {
  health: 'degraded',
  checks: [
    { name: 'Feed accessible', ok: true, detail: 'HTTP 200, application/x-protobuf' },
    { name: 'GTFS_RT schema validation', ok: false, detail: 'Deferred to explicit provider validation' },
  ],
  counts: {},
  responseMs: 168,
};

const outageReport = {
  health: 'offline',
  error: 'Host cannot be resolved',
  checks: [{ name: 'Feed accessible', ok: false, detail: 'Host cannot be resolved' }],
  counts: {},
  responseMs: 296,
};

const validatedReport = {
  health: 'healthy',
  checks: [
    { name: 'Feed accessible', ok: true, detail: 'HTTP 200, application/x-protobuf' },
    { name: 'GTFS_RT schema validation', ok: true, detail: '211 vehicle entities' },
  ],
  counts: { vehicles: 211, freshVehiclePositions: 192 },
  responseMs: 121,
  sourceVersion: 'a'.repeat(64),
};

interface CapturedUpdate { sql: string; params: unknown[] }

function stubPool(rows: Array<Record<string, unknown>>, updates: CapturedUpdate[]) {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (/^\s*SELECT/i.test(sql)) return { rows };
      updates.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as import('pg').Pool;
}

const providerRow = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Львівавтодор — realtime позиції (GTFS-RT)',
  source_type: 'gtfs_rt',
  feed_url: 'https://gtfs-api-fixture.invalid/lviv.zip',
  health: 'degraded',
  last_report: null,
  ...over,
});

describe('provider health report merging', () => {
  it('drops the previous outage assertion when a later probe reaches the feed', () => {
    const merged = mergeProbeReport(outageReport, reachableProbe);
    assert.equal('error' in merged, false, 'a recovered report must not still claim the host cannot be resolved');
    assert.deepEqual(merged.checks, reachableProbe.checks, 'the failed reachability check is superseded by the fresh one');
    assert.deepEqual(merged.health_probe, reachableProbe);
  });

  it('keeps full-validation checks and counts while clearing a stale error string', () => {
    const merged = mergeProbeReport({ ...validatedReport, error: 'fetch failed' }, reachableProbe);
    assert.equal('error' in merged, false);
    assert.deepEqual(merged.checks, validatedReport.checks, 'validated evidence is not downgraded to a reachability probe');
    assert.deepEqual(merged.counts, validatedReport.counts);
    assert.equal(merged.sourceVersion, validatedReport.sourceVersion);
  });

  it('still records a genuine outage with its own checks and error', () => {
    const merged = mergeProbeReport(validatedReport, { ...reachableProbe, health: 'offline', error: 'Host cannot be resolved', checks: outageReport.checks });
    assert.equal(merged.error, 'Host cannot be resolved');
    assert.deepEqual(merged.checks, outageReport.checks);
    assert.deepEqual(merged.counts, validatedReport.counts, 'historical validated counts survive an outage');
  });

  it('carries a new sourceVersion and tolerates an empty stored report', () => {
    const merged = mergeProbeReport(null, { ...reachableProbe, sourceVersion: 'b'.repeat(64) });
    assert.equal(merged.sourceVersion, 'b'.repeat(64));
    assert.deepEqual(merged.health_probe, { ...reachableProbe, sourceVersion: 'b'.repeat(64) });
  });
});

describe('refreshProviderHealth persistence', () => {
  before(() => { process.env.MARSHGO_API_TEST_FIXTURE_MODE = '1'; });
  after(() => { delete process.env.MARSHGO_API_TEST_FIXTURE_MODE; });

  it('writes a recovered report without the stale outage and with a null last_error', async () => {
    const updates: CapturedUpdate[] = [];
    const pool = stubPool([providerRow({ last_report: outageReport })], updates);
    const result = await refreshProviderHealth(pool, () => undefined, ['11111111-1111-4111-8111-111111111111']);
    assert.deepEqual(result, { checked: 1, healthy: 0, degraded: 1, offline: 0 });
    assert.equal(updates.length, 1);
    const [id, health, lastError, reportJson] = updates[0].params as [string, string, string | null, string];
    assert.equal(id, '11111111-1111-4111-8111-111111111111');
    assert.equal(health, 'degraded', 'reachability alone does not promote an unvalidated feed to healthy');
    assert.equal(lastError, null);
    const report = JSON.parse(reportJson);
    assert.equal('error' in report, false, 'DEFECT: last_report still asserts the old DNS failure');
    assert.equal(report.checks[0].ok, true, 'DEFECT: last_report still shows the failed reachability check');
    assert.ok(report.health_probe, 'the fresh probe is stored separately');
    assert.match(updates[0].sql, /jsonb_build_object\('last_probe_at',now\(\)\)/, 'probe time stays database-authoritative');
  });

  it('keeps a previously validated healthy feed healthy and preserves its checks', async () => {
    const updates: CapturedUpdate[] = [];
    const pool = stubPool([providerRow({ health: 'healthy', last_report: validatedReport })], updates);
    const result = await refreshProviderHealth(pool, () => undefined);
    assert.deepEqual(result, { checked: 1, healthy: 1, degraded: 0, offline: 0 });
    const report = JSON.parse(updates[0].params[3] as string);
    assert.deepEqual(report.checks, validatedReport.checks);
    assert.deepEqual(report.counts, validatedReport.counts);
    assert.equal(updates[0].params[2], null);
  });

  it('records an unreachable feed as offline with its error', async () => {
    const updates: CapturedUpdate[] = [];
    const pool = stubPool([providerRow({ feed_url: 'https://marshgo-health-stale-report.invalid/feed', last_report: validatedReport })], updates);
    const result = await refreshProviderHealth(pool, () => undefined);
    assert.deepEqual(result, { checked: 1, healthy: 0, degraded: 0, offline: 1 });
    const [, health, lastError, reportJson] = updates[0].params as [string, string, string | null, string];
    assert.equal(health, 'offline');
    assert.equal(lastError, 'Host cannot be resolved');
    const report = JSON.parse(reportJson);
    assert.equal(report.error, 'Host cannot be resolved');
    assert.equal(report.checks[0].ok, false);
    assert.deepEqual(report.counts, validatedReport.counts);
  });
});
