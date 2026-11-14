import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedPromiseCache } from '../server/journey/boundedPromiseCache';
import { gtfsTimetableCacheKey } from '../server/journey/gtfsTimetable';

test('GTFS timetable cache keys change when a provider feed URL or parser timezone changes', async () => {
  const cache = new BoundedPromiseCache<string>(4, 100, 60_000, 1_000);
  const providerId = 'provider-1';
  const firstUrl = 'https://feeds.example.ua/lviv.zip?token=first-secret';
  const nextUrl = 'https://feeds.example.ua/lviv-current.zip?token=second-secret';
  const key = gtfsTimetableCacheKey(providerId, firstUrl, 'Europe/Kyiv');
  const sameConfigurationKey = gtfsTimetableCacheKey(providerId, firstUrl, 'Europe/Kyiv');
  const updatedUrlKey = gtfsTimetableCacheKey(providerId, nextUrl, 'Europe/Kyiv');
  const updatedTimezoneKey = gtfsTimetableCacheKey(providerId, firstUrl, 'Europe/Warsaw');

  assert.equal(key, sameConfigurationKey);
  assert.notEqual(key, updatedUrlKey);
  assert.notEqual(key, updatedTimezoneKey);
  assert.equal(key.includes('first-secret'), false);
  assert.equal(updatedUrlKey.includes('second-secret'), false);

  await cache.getOrLoad(key, async () => 'old schedule', () => 1, 0);
  const updatedSchedule = await cache.getOrLoad(updatedUrlKey, async () => 'updated schedule', () => 1, 1);
  assert.equal(updatedSchedule, 'updated schedule');
  assert.equal(cache.size, 2);
});
