import assert from 'node:assert/strict';
import test from 'node:test';
import { RedisRateLimitStore } from '../server/redisRateLimitStore';

test('shared rate limits fail closed when Redis is unavailable', async () => {
  const store = new RedisRateLimitStore(() => undefined);
  store.init?.({ windowMs: 60_000 } as never);
  await assert.rejects(store.increment('127.0.0.1'), /Shared rate-limit Redis is unavailable/);
});
