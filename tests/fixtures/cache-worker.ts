import { createClient } from 'redis';
import { z } from 'zod';
import { CacheService } from '../../server/cache/cacheService';

const redisUrl = process.env.CACHE_TEST_REDIS_URL;
const runId = process.env.CACHE_TEST_RUN_ID;
if (!redisUrl || !runId) throw new Error('CACHE_TEST_REDIS_URL and CACHE_TEST_RUN_ID are required');
const client = createClient({ url: redisUrl });
await client.connect();
const cache = new CacheService();
cache.setRedisClient(client as never);
const schema = z.object({ value: z.number().int() });
const results = await Promise.all(Array.from({ length: 50 }, () => cache.getOrLoad(
  'process_integration', { runId, graphVersion: 'test-v1' }, schema,
  { ttlMs: 15_000, lockTtlMs: 5_000, waitForLockMs: 4500 },
  async () => { await client.incr(`cache-test-counter:${runId}`); await new Promise((resolve) => setTimeout(resolve, 100)); return { value: 23 }; },
)));
console.log(JSON.stringify({ count: results.length, allValid: results.every((item) => item.value === 23) }));
await cache.close();
await client.quit();
