import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { layerFailures, type LayerOutcome } from '../server/mobility/transportLayers';

// Layer responses used to say only "1 provider failed". On the Lviv viewport that
// number flipped between 0 and 1 minute to minute and named nobody, so an operator
// could not tell the known-broken Львівський trip_updates feed apart with a transient
// outage, and could not tell a provider fault from a MARSHGO decode bug.
const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');

const outcomes = (): LayerOutcome[] => [
  { layer: 'positions', ok: true, row: { id: 'a', name: 'Львів — GTFS-RT positions', source_type: 'gtfs_rt' } },
  { layer: 'positions', ok: false, reason: 'invalid_data', row: { id: 'b', name: 'Львівський — trip updates', source_type: 'gtfs_rt' } },
  { layer: 'route_index', ok: false, row: { id: 'c', name: 'Україна — Єдиний реєстр перевезень', source_type: 'gtfs' } },
];

describe('transport layer failure reporting', () => {
  it('names every failed provider with its layer and a safe reason code', () => {
    const failures = layerFailures(outcomes());
    assert.deepEqual(failures.map((item) => item.id), ['b', 'c']);
    assert.deepEqual(failures.map((item) => item.layer), ['positions', 'route_index']);
    assert.equal(failures[0].reason, 'invalid_data');
    assert.equal(failures[1].reason, 'error', 'an outcome without a classified reason must not claim a specific fault');
    assert.deepEqual(failures.map((item) => item.name), ['Львівський', 'Україна'], 'the client sees the provider, not the " — layer" suffix');
  });

  it('keeps a signed feed URL out of the client-visible payload', () => {
    const withUrl = layerFailures([{ ...outcomes()[1], reason: 'GET https://api.example.com/feed?key=SECRET_KEY_VALUE failed' } as LayerOutcome]);
    assert.ok(!JSON.stringify(withUrl).includes('SECRET_KEY_VALUE'));
  });

  it('reports failures as a named list plus a count on every layer endpoint', () => {
    const emissions = source.split('\n').filter((line) => line.includes('failedProviders:'));
    assert.ok(emissions.length >= 6, `expected every layer response to report failures, saw ${emissions.length}`);
    for (const line of emissions) {
      assert.ok(!/failedProviders:\s*[^,}]*\.length/.test(line), `count-only reporting returned: ${line.trim()}`);
    }
    assert.equal((source.match(/failedProviders: (?:layerFailures|failures|failedOutcomes)/g) ?? []).length, emissions.length,
      'every list must come from layerFailures so a provider is identified and redacted the same way');
    assert.equal((source.match(/failedProviderCount:/g) ?? []).length, emissions.length, 'each list needs a numeric count for dashboards');
  });

  it('carries the failing provider identity into the vehicles response', () => {
    assert.match(source, /meta:\s*\{\s*failedProviders:\s*layerFailures\(\[\.\.\.indexes,\s*\.\.\.geoJsonNetworks,\s*\.\.\.settled\]\)/);
  });
});
