import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createClient } from 'redis';
import { CacheService } from '../server/cache/cacheService';
import { z } from 'zod';

const redisUrl = process.env.CACHE_TEST_REDIS_URL;

test('independent API cache services coalesce identical work through a real Redis L2', { skip: !redisUrl }, async (t) => {
  const clients = [createClient({ url: redisUrl }), createClient({ url: redisUrl })];
  await Promise.all(clients.map((client) => client.connect()));
  t.after(async () => { await Promise.all(clients.map((client) => client.quit().catch(() => undefined))); });
  const services = [new CacheService(), new CacheService()];
  services.forEach((service, index) => service.setRedisClient(clients[index]! as never));
  const parameters = { origin: [30.5234, 50.4501], destination: [30.6139, 50.4547], graphVersion: `integration-${randomUUID()}` };
  const schema = z.object({ value: z.number().int() });
  let upstream = 0;
  const values = await Promise.all(Array.from({ length: 100 }, (_, index) => services[index % 2]!.getOrLoad(
    'road_geometry', parameters, schema, { ttlMs: 15_000, l1TtlMs: 5000, lockTtlMs: 5000, waitForLockMs: 4500 },
    async () => { upstream += 1; await new Promise((resolve) => setTimeout(resolve, 100)); return { value: 17 }; },
  )));
  assert.equal(upstream, 1);
  assert.ok(values.every((item) => item.value === 17));
  await services[0]!.invalidate('road_geometry', parameters);
});

test('separate Node.js processes share an L2 lock and execute one equivalent loader', { skip: !redisUrl }, async (t) => {
  const runId = randomUUID();
  const counterKey = `cache-test-counter:${runId}`;
  const parent = createClient({ url: redisUrl });
  await parent.connect();
  t.after(async () => { await parent.del(counterKey); await parent.quit().catch(() => undefined); });
  const runWorker = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/cache-worker.ts'], {
      cwd: process.cwd(), env: { ...process.env, CACHE_TEST_REDIS_URL: redisUrl, CACHE_TEST_RUN_ID: runId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part: string) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part: string) => { stderr += part; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`cache worker exited ${code}: ${stderr}`)));
  });
  const workers = await Promise.all([runWorker(), runWorker()]);
  assert.ok(workers.every((output) => JSON.parse(output).count === 50 && JSON.parse(output).allValid));
  assert.equal(await parent.get(counterKey), '1');
});
