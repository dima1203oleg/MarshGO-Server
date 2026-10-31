import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Classifying a live vehicle reads the static feed's route index. Building that index on the request path downloads the
// provider's whole GTFS zip, so the first poll after a cache expiry blocked for seconds. The fix is a background warm-up,
// and it only works while the cached index outlives one refresh interval — these two properties are the contract.
const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
const layers = readFileSync(new URL('../server/mobility/transportLayers.ts', import.meta.url), 'utf8');
const warmup = source.slice(source.indexOf('const transportIndexIntervalMs'), source.indexOf('transportIndexStart.unref()'));

describe('transport route index warm-up', () => {
  it('runs a background refresh that can be tuned and switched off', () => {
    assert.match(warmup, /TRANSPORT_INDEX_REFRESH_MS/);
    assert.match(warmup, /TRANSPORT_INDEX_REFRESH_DISABLED === 'true'/);
    assert.match(warmup, /Math\.max\(60_000,/, 'the interval needs a floor so a typo cannot turn warm-up into a download loop');
  });

  it('warms providers one at a time and never overlaps itself', () => {
    assert.ok(!warmup.includes('Promise.all'), 'parallel warm-up would fetch every national feed at once');
    assert.match(warmup, /for \(const row of rows\)[\s\S]*await cachedGtfsRouteTypes/);
    assert.match(warmup, /if \(transportIndexRun\) return transportIndexRun/);
    assert.match(warmup, /finally\(\(\) => \{ transportIndexRun = undefined; \}\)/);
  });

  it('keeps the cached index longer than the longest practical refresh interval', () => {
    const l1Match = layers.match(/cachedGtfsRouteTypes[\s\S]{0,700}?l1TtlMs:\s*(\d+) \* 60_000/);
    assert.ok(l1Match, 'the route index cache must declare an explicit L1 lifetime');
    assert.ok(Number(l1Match[1]) >= 20, `L1 must outlive a refresh cycle, got ${l1Match[1]} minutes`);
  });
});
