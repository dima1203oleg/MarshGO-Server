import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProbeReport, refreshProviderHealth } from '../server/mobility/healthMonitor';
import type { ConnectionReport } from '../server/mobility/types';

const GBFS_FIXTURE_URL = 'https://gbfs-api-fixture.invalid/zelectra';

const outageReport = {
  health: 'offline',
  error: 'Host cannot be resolved',
  checks: [{ name: 'Feed accessible', ok: false, detail: 'Host cannot be resolved' }],
  counts: {},
  responseMs: 296,
};

const validatedGbfsReport = {
  health: 'healthy',
  checks: [
    { name: 'Feed accessible', ok: true },
    { name: 'Valid GBFS discovery', ok: true, detail: '9 feeds' },
    { name: 'Vehicles', ok: true, detail: '2 valid, 0 rejected' },
  ],
  counts: { feeds: 9, vehicles: 2 },
  responseMs: 40,
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

const gbfsRow = (over: Record<string, unknown> = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Zelectra — е-самокати (GBFS 3.0)',
  source_type: 'gbfs',
  feed_url: GBFS_FIXTURE_URL,
  health: 'degraded',
  last_report: null,
  ...over,
});

describe('GBFS sources recover to healthy without an admin validation', () => {
  before(() => { process.env.MARSHGO_API_TEST_FIXTURE_MODE = '1'; });
  after(() => { delete process.env.MARSHGO_API_TEST_FIXTURE_MODE; });

  it('promotes a degraded GBFS source once the scheduled pass fully validates its lightweight feeds', async () => {
    const updates: CapturedUpdate[] = [];
    const pool = stubPool([gbfsRow({ last_report: outageReport })], updates);
    const result = await refreshProviderHealth(pool, () => undefined);
    assert.deepEqual(result, { checked: 1, healthy: 1, degraded: 0, offline: 0 },
      'DEFECT: a live GBFS feed stays degraded forever, so nearby inventory selects zero providers');
    const [, health, lastError, reportJson] = updates[0].params as [string, string, string | null, string];
    assert.equal(health, 'healthy');
    assert.equal(lastError, null);
    const report = JSON.parse(reportJson);
    assert.equal('error' in report, false, 'the stale outage must not survive a validated recovery');
    assert.deepEqual(report.counts, validatedGbfsReport.counts, 'validated counts must persist so later reachability passes keep the source healthy');
    assert.deepEqual(report.checks, validatedGbfsReport.checks);
  });

  it('keeps a recovered GBFS source healthy on the next scheduled pass', async () => {
    const updates: CapturedUpdate[] = [];
    const stored = { ...validatedGbfsReport, checks: [{ name: 'Feed accessible', ok: true, detail: 'HTTP 200' }] };
    const pool = stubPool([gbfsRow({ health: 'healthy', last_report: stored })], updates);
    const result = await refreshProviderHealth(pool, () => undefined);
    assert.deepEqual(result, { checked: 1, healthy: 1, degraded: 0, offline: 0 });
  });

  it('records an unreachable GBFS feed as offline with its error', async () => {
    const updates: CapturedUpdate[] = [];
    const pool = stubPool([gbfsRow({ feed_url: 'https://marshgo-gbfs-recovery.invalid/gbfs', last_report: validatedGbfsReport })], updates);
    const result = await refreshProviderHealth(pool, () => undefined);
    assert.deepEqual(result, { checked: 1, healthy: 0, degraded: 0, offline: 1 });
    const [, health, lastError] = updates[0].params as [string, string, string | null];
    assert.equal(health, 'offline');
    assert.equal(lastError, 'Discovery feed is unreachable');
  });

  it('does not promote heavy static feeds on reachability alone', async () => {
    const updates: CapturedUpdate[] = [];
    const pool = stubPool([gbfsRow({ source_type: 'gtfs', feed_url: 'https://gtfs-api-fixture.invalid/lviv.zip', last_report: null })], updates);
    const result = await refreshProviderHealth(pool, () => undefined);
    assert.deepEqual(result, { checked: 1, healthy: 0, degraded: 1, offline: 0 },
      'full static-archive validation stays an explicit admin action');
  });
});

describe('mergeProbeReport keeps validated evidence during reachability probes', () => {
  it('does not downgrade an existing validated report when only reachability was probed', () => {
    const reachable: ConnectionReport = {
      health: 'degraded',
      checks: [
        { name: 'Feed accessible', ok: true, detail: 'HTTP 200' },
        { name: 'GBFS schema validation', ok: false, detail: 'Deferred to explicit provider validation' },
      ],
      counts: {},
      responseMs: 12,
    };
    const merged = mergeProbeReport(validatedGbfsReport, reachable);
    assert.deepEqual(merged.checks, validatedGbfsReport.checks);
    assert.deepEqual(merged.counts, validatedGbfsReport.counts);
  });
});