import test from 'node:test';
import assert from 'node:assert/strict';
import { gtfsArchiveSha256, gtfsSourceSha256ForRoute } from '../server/journey/gtfsTimetable';

test('GTFS archive provenance is a stable SHA-256 of the exact bytes', () => {
  assert.equal(gtfsArchiveSha256(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('merged route provenance selects its source archive hash and direct feeds use the feed hash', () => {
  const feed = {
    staticFeedSha256: 'archive-sha-direct',
    providersByRoute: new Map([['provider-2:route-7', {
      id: 'provider-2', name: 'Provider 2', city: 'Львів', fetchedAt: new Date(0), staticFeedSha256: 'archive-sha-provider-2',
    }]]),
  };

  assert.equal(gtfsSourceSha256ForRoute(feed, 'provider-2:route-7'), 'archive-sha-provider-2');
  assert.equal(gtfsSourceSha256ForRoute(feed, 'route-1'), 'archive-sha-direct');
});
