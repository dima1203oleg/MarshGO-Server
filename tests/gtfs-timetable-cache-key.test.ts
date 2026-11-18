import test from 'node:test';
import assert from 'node:assert/strict';
import { gtfsTimetableCacheKey } from '../server/journey/gtfsTimetable';

test('GTFS timetable cache identity follows provider source and timezone', () => {
  const urlWithCredential = 'https://feeds.example/old.zip?token=private-source-token';
  const original = gtfsTimetableCacheKey('provider-1', urlWithCredential, 'Europe/Kyiv');

  assert.equal(original, gtfsTimetableCacheKey('provider-1', urlWithCredential, 'Europe/Kyiv'));
  assert.equal(original.includes('private-source-token'), false, 'cache keys do not retain source credentials');
  assert.notEqual(original, gtfsTimetableCacheKey('provider-1', 'https://feeds.example/new.zip', 'Europe/Kyiv'));
  assert.notEqual(original, gtfsTimetableCacheKey('provider-1', 'https://feeds.example/old.zip', 'Europe/Warsaw'));
  assert.notEqual(original, gtfsTimetableCacheKey('provider-2', 'https://feeds.example/old.zip', 'Europe/Kyiv'));
});
