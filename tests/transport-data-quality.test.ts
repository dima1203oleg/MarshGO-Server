import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  aggregateDataQuality,
  scheduledDataQuality,
  selectFreshVehicles,
  vehicleDataQuality,
  type LiveVehicle,
} from '../server/mobility/transportLayers';
import { LIVE_MOBILITY_MAX_AGE_MS } from '../server/mobility/timestamps';

// ТЗ-MG-TRANSPORT-12 says a marker must say where its data came from and that a schedule must never
// be dressed up as live telemetry. Until now the transport layers returned bare geometry, so a client
// could not tell a GPS position stamped two seconds ago from an aged feed or a static route line.
const vehicle = (overrides: Partial<LiveVehicle>): LiveVehicle => ({
  id: 'lviv:1', lon: 24.03, lat: 49.8, type: 'tram', route: '1', bearing: null, speed: null,
  timestamp: new Date(), providerId: 'lviv', ...overrides,
});

describe('vehicle position quality', () => {
  it('labels a stamped position inside the freshness window as LIVE with its age', () => {
    const now = Date.UTC(2026, 9, 31, 19, 0, 0);
    const entry = vehicleDataQuality(new Date(now - 5_000), now);
    assert.deepEqual(entry, { level: 'LIVE', ageMs: 5_000 });
  });

  it('labels a position that aged past the window as STALE instead of dropping the truth', () => {
    const now = Date.UTC(2026, 9, 31, 19, 0, 0);
    const entry = vehicleDataQuality(new Date(now - LIVE_MOBILITY_MAX_AGE_MS - 1_000), now);
    assert.equal(entry.level, 'STALE');
    assert.ok((entry.ageMs ?? 0) > LIVE_MOBILITY_MAX_AGE_MS);
  });

  it('labels an unstamped position as ESTIMATED with no age rather than inventing one', () => {
    assert.deepEqual(vehicleDataQuality(null), { level: 'ESTIMATED', ageMs: null });
  });

  it('never serves an unstamped or aged position, so LIVE is the honest default', () => {
    const box = [24.0, 49.75, 24.1, 49.85] as [number, number, number, number];
    const selected = selectFreshVehicles([vehicle({}), vehicle({ timestamp: null }), vehicle({ timestamp: new Date(Date.now() - LIVE_MOBILITY_MAX_AGE_MS - 60_000) })], box, ['tram']);
    assert.equal(selected.vehicles.length, 1);
    assert.equal(selected.stale, 2);
  });
});

describe('response level quality summary', () => {
  it('says UNKNOWN when nothing is served instead of implying an empty live feed is live', () => {
    assert.equal(aggregateDataQuality([]).level, 'UNKNOWN');
  });

  it('reports the age spread of a live viewport', () => {
    const summary = aggregateDataQuality([
      { level: 'LIVE' as const, ageMs: 1_000 },
      { level: 'LIVE' as const, ageMs: 8_000 },
    ]);
    assert.equal(summary.level, 'LIVE');
    assert.deepEqual(summary.counts, { LIVE: 2 });
    assert.equal(summary.oldestAgeMs, 8_000);
    assert.equal(summary.newestAgeMs, 1_000);
    assert.equal(summary.freshnessWindowMs, LIVE_MOBILITY_MAX_AGE_MS);
  });

  it('lets the least fresh marker decide the headline while keeping the mix in counts', () => {
    const summary = aggregateDataQuality([
      { level: 'LIVE' as const, ageMs: 2_000 },
      { level: 'ESTIMATED' as const, ageMs: null },
      { level: 'STALE' as const, ageMs: 400_000 },
    ]);
    assert.equal(summary.level, 'STALE');
    assert.deepEqual(summary.counts, { LIVE: 1, ESTIMATED: 1, STALE: 1 });
    assert.equal(summary.oldestAgeMs, 400_000);
  });

  it('declares static route geometry as SCHEDULED, never as live data', () => {
    const summary = scheduledDataQuality(37);
    assert.equal(summary.level, 'SCHEDULED');
    assert.deepEqual(summary.counts, { SCHEDULED: 37 });
    assert.equal(summary.oldestAgeMs, null);
    assert.equal(scheduledDataQuality(0).level, 'UNKNOWN');
  });
});

describe('transport layer wiring', () => {
  const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');

  it('labels every served vehicle marker and the vehicles response', () => {
    const block = source.slice(source.indexOf(`app.get('/api/v1/transport/vehicles'`), source.indexOf(`app.get('/api/v1/transport/micromobility'`));
    assert.match(block, /dataQuality: qualities\[index\]!\.level/);
    assert.match(block, /positionAgeMs: qualities\[index\]!\.ageMs/);
    assert.match(block, /dataQuality: aggregateDataQuality\(qualities\)/);
  });

  it('labels the static route layer as scheduled data', () => {
    const block = source.slice(source.indexOf(`app.get('/api/v1/transport/routes'`), source.indexOf(`app.get('/api/v1/transport/stops'`));
    assert.match(block, /dataQuality: scheduledDataQuality\(served\.length\)/);
  });

  it('labels the stop layer too, so an empty viewport says UNKNOWN rather than going unlabelled', () => {
    const block = source.slice(source.indexOf(`app.get('/api/v1/transport/stops'`), source.indexOf(`app.get('/api/v1/transit/stops/`));
    assert.match(block, /dataQuality: scheduledDataQuality\(served\.length\)/);
    assert.match(block, /const served = features\.slice\(0, 2500\)/);
  });
});
