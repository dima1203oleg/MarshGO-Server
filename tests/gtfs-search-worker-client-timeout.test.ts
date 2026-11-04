import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { GtfsSearchWorkerClient } from '../server/journey/gtfsSearchWorkerClient';

/**
 * Deterministic fake for the GTFS search worker: it answers each dispatched request after a
 * scripted delay (Infinity = never) so the queue's timeout handling can be exercised without
 * a real 90-second budget or a real feed parse.
 */
class FakeWorker extends EventEmitter {
  readonly received: unknown[] = [];
  terminated = false;

  constructor(private readonly respondAfter: number[]) {
    super();
  }

  postMessage(message: { id?: number }): void {
    const index = this.received.length;
    this.received.push(message);
    if (typeof message.id !== 'number') return;
    const delay = this.respondAfter[index] ?? 0;
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(() => this.emit('message', {
      id: message.id, ok: true,
      value: { rssBytes: 4096, heapUsedBytes: 2048, externalBytes: 512, feedCache: { entries: 1, estimatedBytes: 2048 }, groupCacheEntries: 0 },
    }), delay);
    timer.unref();
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

class ScriptedClient extends GtfsSearchWorkerClient {
  readonly workers: FakeWorker[] = [];

  constructor(private readonly scripts: Array<{ respondAfter: number[] }>) {
    super(undefined, 100);
  }

  protected override createWorker(): Worker {
    const script = this.workers.length < this.scripts.length ? this.scripts[this.workers.length] : { respondAfter: [0] };
    const worker = new FakeWorker(script.respondAfter);
    this.workers.push(worker);
    const readyTimer = setTimeout(() => worker.emit('message', { type: 'ready' }), 0);
    readyTimer.unref();
    return worker as unknown as Worker;
  }
}

const delay = (ms: number) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); });

test('a timed-out request keeps the warm worker and the queue waits for that request to settle', async () => {
  const client = new ScriptedClient([{ respondAfter: [150, 5] }]);
  try {
    await assert.rejects(client.diagnostics(), /GTFS search worker request timed out/);
    const worker = client.workers[0];
    assert.equal(worker.terminated, false, 'the first timeout must not terminate the parsed-feed cache');
    assert.equal(worker.received.length, 1);

    const second = client.diagnostics();
    await delay(30);
    assert.equal(worker.received.length, 1, 'a follow-up request must not be dispatched while the abandoned request is still running');

    const value = await second;
    assert.equal(worker.terminated, false);
    assert.equal(worker.received.length, 2, 'the follow-up dispatches on the same warm worker once the abandoned request reports back');
    assert.equal(client.workers.length, 1);
    assert.equal(value.rssBytes, 4096);
  } finally {
    await client.close();
  }
});

test('a worker that never reports the abandoned request is restarted and the queue survives', async () => {
  const client = new ScriptedClient([{ respondAfter: [Number.POSITIVE_INFINITY] }, { respondAfter: [0] }]);
  try {
    await assert.rejects(client.diagnostics(), /GTFS search worker request timed out/);
    const second = client.diagnostics();
    const value = await second;
    assert.equal(client.workers[0].terminated, true, 'a stuck abandoned worker is terminated after the settle window');
    assert.equal(client.workers.length, 2);
    assert.equal(value.groupCacheEntries, 0);
  } finally {
    await client.close();
  }
});

test('the production client keeps the measured 90-second request budget and rejects invalid timeouts', () => {
  const productionClient = new GtfsSearchWorkerClient();
  assert.equal(productionClient.requestTimeoutMs, 90_000);
  assert.throws(() => new GtfsSearchWorkerClient(undefined, 0), TypeError);
  assert.throws(() => new GtfsSearchWorkerClient(undefined, 1.5), TypeError);
});
