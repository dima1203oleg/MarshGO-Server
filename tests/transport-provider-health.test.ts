import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layerFailures, providerFailureReason, type LayerOutcome } from '../server/mobility/transportLayers';
import { UnsafeUrlError } from '../server/mobility/safeFetch';

const row = (id: string, name: string, source_type = 'gtfs_rt') => ({ id, name, source_type });
const outcome = (layer: string, ok: boolean, extra: Partial<LayerOutcome> = {}): LayerOutcome => ({
  layer, ok, row: extra.row ?? row('p1', 'Львів — GTFS-RT positions'), ...extra,
});

describe('provider failure reporting', () => {
  it('classifies provider errors into a safe vocabulary', () => {
    assert.equal(providerFailureReason(new Error('This operation was aborted')), 'timeout');
    assert.equal(providerFailureReason(new Error('fetch failed')), 'network_error');
    assert.equal(providerFailureReason(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })), 'timeout');
    assert.equal(providerFailureReason(new Error('fetch failed, cause: read ECONNREFUSED 127.0.0.1:443')), 'network_error');
    assert.equal(providerFailureReason(new Error('Invalid status line: 403 Forbidden')), 'access_denied');
    assert.equal(providerFailureReason(new Error('HTTP 404')), 'not_found');
    assert.equal(providerFailureReason(new Error('Read error or unexpected end of file')), 'invalid_data');
    assert.equal(providerFailureReason(new Error('unknown geojson transport mode: funicular')), 'unsupported_feed');
    assert.equal(providerFailureReason('nope'), 'error');
  });

  it('keeps a signed feed URL out of the client-visible reason', () => {
    const detail = providerFailureReason(new Error('GET https://api.example.com/gtfs-rt?key=SECRET_KEY_VALUE returned 500'));
    assert.equal(detail, 'provider_unavailable');
    assert.ok(!detail.includes('SECRET_KEY_VALUE'));
  });

  it('reports each failed provider with the layer that broke', () => {
    const failures = layerFailures([
      outcome('route_index', true),
      outcome('positions', false, { reason: 'timeout', row: row('lviv_rt', 'Львів — trip updates') }),
      outcome('positions', false, { row: row('kyiv_rt', 'Київ', 'json') }),
    ]);
    assert.deepEqual(failures, [
      { id: 'lviv_rt', name: 'Львів', sourceType: 'gtfs_rt', layer: 'positions', reason: 'timeout' },
      { id: 'kyiv_rt', name: 'Київ', sourceType: 'json', layer: 'positions', reason: 'error' },
    ]);
  });

  it('separates a rate limit and a rejected feed URL from a provider outage', () => {
    assert.equal(providerFailureReason(new Error('HTTP 429')), 'rate_limited');
    assert.equal(providerFailureReason(new Error('Too Many Requests')), 'rate_limited');
    assert.equal(providerFailureReason(new UnsafeUrlError('Host resolves to a private address')), 'feed_url_rejected');
    assert.equal(providerFailureReason(new Error('Feed is too large')), 'feed_too_large');
    assert.equal(providerFailureReason(new Error('HTTP 503')), 'provider_unavailable');
  });

  it('names a truncated or undecodable body as its own failure class', () => {
    assert.equal(providerFailureReason(new TypeError('terminated')), 'truncated_response');
    assert.equal(providerFailureReason(new Error('Feed response is incomplete (2 of 9 bytes)')), 'truncated_response');
    assert.equal(providerFailureReason(new RangeError('index out of range: 155921 + 1 > 155921')), 'invalid_data');
  });

  it('returns an empty list when every provider answered', () => {
    assert.deepEqual(layerFailures([outcome('route_index', true), outcome('positions', true)]), []);
  });
});
