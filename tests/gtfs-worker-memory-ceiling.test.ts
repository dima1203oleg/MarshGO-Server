import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_GTFS_WORKER_HEAP_MB, MAX_GTFS_WORKER_HEAP_MB, resolveGtfsWorkerHeapCeiling } from '../server/journey/gtfsWorkerMemory';
import { GtfsSearchWorkerClient } from '../server/journey/gtfsSearchWorkerClient';

const ACCEPTANCE_CONTAINER_BYTES = 1_887_436_800; // the measured `mg-cp6b-api` cgroup: 1800 MiB
const missing = () => { throw new Error('ENOENT'); };

test('no container limit and no operator value leaves Node\'s own default alone', () => {
  assert.equal(resolveGtfsWorkerHeapCeiling({}, missing), undefined);
  assert.equal(resolveGtfsWorkerHeapCeiling({ MARSHGO_GTFS_WORKER_MAX_OLD_SPACE_MB: '   ' }, missing), undefined);
});

test('the derived ceiling is a fixed share of the real cgroup limit, in MiB', () => {
  const files = new Map([['/sys/fs/cgroup/memory.max', String(ACCEPTANCE_CONTAINER_BYTES)]]);
  const ceiling = resolveGtfsWorkerHeapCeiling({}, (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error('ENOENT');
    return value;
  });
  assert.deepEqual(ceiling, { maxOldGenerationSizeMb: 1_080, source: 'cgroup', containerLimitBytes: ACCEPTANCE_CONTAINER_BYTES });
  // Measured on this container: both isolates default to 1496 MiB each, i.e. 2992 MiB of ceiling
  // against 1800 MiB of memory, which is why an oversized search killed the whole API instead of
  // raising a catchable error. The bound must therefore sit below the container limit.
  assert.ok(ceiling.maxOldGenerationSizeMb * 1048576 < ACCEPTANCE_CONTAINER_BYTES);
});

test('unlimited cgroups do not produce a fake ceiling', () => {
  const read = (files: Record<string, string>) => (path: string): string => {
    const value = files[path];
    if (value === undefined) throw new Error('ENOENT');
    return value;
  };
  assert.equal(resolveGtfsWorkerHeapCeiling({}, read({ '/sys/fs/cgroup/memory.max': 'max\n' })), undefined);
  assert.equal(resolveGtfsWorkerHeapCeiling({}, read({ '/sys/fs/cgroup/memory.limit_in_bytes': '9223372036854771712' })), undefined);
  // A 512 MiB container would derive 307 MiB, below the floor: applying it would break legitimate
  // searches, so the operator must opt in explicitly instead.
  assert.equal(resolveGtfsWorkerHeapCeiling({}, read({ '/sys/fs/cgroup/memory.max': String(512 * 1048576) })), undefined);
});

test('an explicit operator value wins over the container and is validated the same way as the other knobs', () => {
  const files = new Map([['/sys/fs/cgroup/memory.max', String(ACCEPTANCE_CONTAINER_BYTES)]]);
  const readFile = (path: string): string => {
    const value = files.get(path);
    if (value === undefined) throw new Error('ENOENT');
    return value;
  };
  assert.deepEqual(resolveGtfsWorkerHeapCeiling({ MARSHGO_GTFS_WORKER_MAX_OLD_SPACE_MB: '700' }, readFile),
    { maxOldGenerationSizeMb: 700, source: 'env' });
  assert.equal(resolveGtfsWorkerHeapCeiling({ MARSHGO_GTFS_WORKER_MAX_OLD_SPACE_MB: '2e3' }, readFile)?.maxOldGenerationSizeMb, 2_000);
  assert.equal(resolveGtfsWorkerHeapCeiling({ MARSHGO_GTFS_WORKER_MAX_OLD_SPACE_MB: '99999' }, readFile)?.maxOldGenerationSizeMb, MAX_GTFS_WORKER_HEAP_MB);
  for (const value of ['abc', '0', '-4', '250.5', '1e309', 'NaN', String(MIN_GTFS_WORKER_HEAP_MB - 1)]) {
    assert.equal(resolveGtfsWorkerHeapCeiling({ MARSHGO_GTFS_WORKER_MAX_OLD_SPACE_MB: value }, readFile), undefined, value);
  }
});

test('the applied ceiling reaches the real GTFS worker isolate instead of only the parent', async () => {
  const MiB = (bytes: number) => Math.round(bytes / 1048576);
  const previous = process.env.MARSHGO_GTFS_WORKER_MAX_OLD_SPACE_MB;
  const limitedClient = new GtfsSearchWorkerClient();
  let limited;
  try {
    process.env.MARSHGO_GTFS_WORKER_MAX_OLD_SPACE_MB = String(MIN_GTFS_WORKER_HEAP_MB);
    limited = await limitedClient.diagnostics();
    assert.ok(limited.heapLimitBytes > 0);
    // `maxOldGenerationSizeMb` bounds the old generation; the reported isolate ceiling adds the
    // code/new space, measured on this machine as +96 MiB.
    assert.ok(MiB(limited.heapLimitBytes) >= MIN_GTFS_WORKER_HEAP_MB && MiB(limited.heapLimitBytes) <= MIN_GTFS_WORKER_HEAP_MB + 192,
      `expected a ceiling near ${MIN_GTFS_WORKER_HEAP_MB} MiB, got ${MiB(limited.heapLimitBytes)} MiB`);
  } finally {
    await limitedClient.close();
    if (previous === undefined) delete process.env.MARSHGO_GTFS_WORKER_MAX_OLD_SPACE_MB;
    else process.env.MARSHGO_GTFS_WORKER_MAX_OLD_SPACE_MB = previous;
  }

  const unlimitedClient = new GtfsSearchWorkerClient();
  try {
    const control = await unlimitedClient.diagnostics();
    assert.ok(control.heapLimitBytes > limited.heapLimitBytes * 2,
      `negative control: without the operator value the isolate keeps Node's default (${MiB(control.heapLimitBytes)} MiB vs ${MiB(limited.heapLimitBytes)} MiB)`);
  } finally {
    await unlimitedClient.close();
  }
});
