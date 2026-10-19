import { createHash, randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { z } from 'zod';

type RedisClient = ReturnType<typeof createClient>;
type RedisLike = Pick<RedisClient, 'get' | 'set' | 'del' | 'eval' | 'pTTL'> & { readonly isReady?: boolean };
type CacheCategory = string;
type CacheOptions<T = unknown> = {
  ttlMs: number;
  ttlForValue?: (value: T) => number;
  maxL2Bytes?: number;
  l1TtlMs?: number;
  lockTtlMs?: number;
  waitForLockMs?: number;
  scope?: string;
  /** Disable cross-process Redis reads, locks, and writes when the source has no stable version. */
  shared?: boolean;
};

const releaseLockScript = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]));
};

export function canonicalCacheJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

export function cacheKey(category: CacheCategory, parameters: unknown): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(category)) throw new TypeError('cache category is invalid');
  const hash = createHash('sha256').update(canonicalCacheJson(parameters)).digest('hex');
  return `marshgo:cache:v1:${category}:${hash}`;
}

export type CacheStats = {
  l1Hits: number; l1Misses: number; l2Hits: number; l2Misses: number;
  localCoalesced: number; distributedCoalesced: number; loads: number;
  loadErrors: number; l2Errors: number; invalidEntries: number; evictions: number;
  lockTimeouts: number; l1Entries: number; l1Bytes: number; redisConnected: boolean;
  l2ReadLatencyMs: number; l2ReadCount: number; l2WriteLatencyMs: number; l2WriteCount: number;
};

const defaultStats = (): CacheStats => ({
  l1Hits: 0, l1Misses: 0, l2Hits: 0, l2Misses: 0, localCoalesced: 0, distributedCoalesced: 0,
  loads: 0, loadErrors: 0, l2Errors: 0, invalidEntries: 0, evictions: 0, lockTimeouts: 0,
  l1Entries: 0, l1Bytes: 0, redisConnected: false, l2ReadLatencyMs: 0, l2ReadCount: 0,
  l2WriteLatencyMs: 0, l2WriteCount: 0,
});

/** Fail-open, bounded L1 + optional isolated Redis L2 cache for non-authoritative data. */
export class CacheService {
  private readonly l1 = new Map<string, { expiresAt: number; payload: string; bytes: number }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly stats = defaultStats();
  private readonly l2ReadSamples: number[] = [];
  private readonly l2WriteSamples: number[] = [];
  private redis: RedisLike | undefined;
  private redisOwned: RedisClient | undefined;
  private l1Bytes = 0;

  constructor(private readonly limits: { maxEntries?: number; maxBytes?: number } = {}) {}

  async connect(url = process.env.REDIS_CACHE_URL): Promise<boolean> {
    if (!url) return false;
    if (this.redis?.isReady) return true;
    let client: RedisClient | undefined;
    try {
      client = createClient({ url, socket: { connectTimeout: 1500, reconnectStrategy: (retries) => Math.min(250 * Math.max(1, retries), 3000) } });
      client.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'cache.redis_error', message: error.message })));
      await client.connect();
      this.redisOwned = client;
      this.redis = client;
      return true;
    } catch (error) {
      if (client?.isOpen) await client.quit().catch(() => undefined);
      this.stats.l2Errors += 1;
      console.error(JSON.stringify({ level: 'warn', event: 'cache.redis_connect_failed', message: error instanceof Error ? error.message : 'unknown_error' }));
      return false;
    }
  }

  /** Test/embedded hook. A client supplied here remains owned by the caller. */
  setRedisClient(client: RedisLike | undefined): void { this.redis = client; }

  async close(): Promise<void> {
    const client = this.redisOwned;
    this.redisOwned = undefined;
    this.redis = undefined;
    if (client?.isOpen) await client.quit().catch(() => undefined);
  }

  async getOrLoad<T>(
    category: CacheCategory,
    parameters: unknown,
    schema: z.ZodType<T>,
    options: CacheOptions<T>,
    loader: () => Promise<T>,
  ): Promise<T> {
    const key = cacheKey(category, { parameters, ...(options.scope ? { scope: options.scope } : {}) });
    const ttl = Math.max(0, Math.floor(options.ttlMs));
    if (!ttl) return loader();
    const hit = await this.read<T>(key, schema, options.shared !== false);
    if (hit !== undefined) return hit;

    const existing = this.inFlight.get(key);
    if (existing) {
      this.stats.localCoalesced += 1;
      return schema.parse(JSON.parse(JSON.stringify(await existing)));
    }
    const work = this.loadWithLock(key, schema, { ...options, ttlMs: ttl }, loader);
    this.inFlight.set(key, work);
    try { return await work; }
    finally { if (this.inFlight.get(key) === work) this.inFlight.delete(key); }
  }

  async invalidate(category: CacheCategory, parameters: unknown, scope?: string): Promise<void> {
    const key = cacheKey(category, { parameters, ...(scope ? { scope } : {}) });
    this.removeL1(key);
    try { if (this.isRedisReady()) await this.redis!.del([key]); }
    catch { this.stats.l2Errors += 1; }
  }

  snapshot(): CacheStats {
    return { ...this.stats, l1Entries: this.l1.size, l1Bytes: this.l1Bytes, redisConnected: this.isRedisReady() };
  }

  toPrometheus(): string {
    const s = this.snapshot();
    const counters: Array<[string, number]> = [
      ['l1_hits_total', s.l1Hits], ['l1_misses_total', s.l1Misses], ['l2_hits_total', s.l2Hits], ['l2_misses_total', s.l2Misses],
      ['singleflight_local_total', s.localCoalesced], ['singleflight_distributed_total', s.distributedCoalesced],
      ['loader_calls_total', s.loads], ['loader_errors_total', s.loadErrors], ['redis_errors_total', s.l2Errors],
      ['invalid_entries_total', s.invalidEntries], ['evictions_total', s.evictions], ['lock_timeouts_total', s.lockTimeouts],
    ];
    return [
      ...counters.map(([name, value]) => `marshgo_cache_${name} ${value}`),
      `marshgo_cache_l1_entries ${s.l1Entries}`, `marshgo_cache_l1_bytes ${s.l1Bytes}`,
      `marshgo_cache_redis_connected ${Number(s.redisConnected)}`,
      `marshgo_cache_l2_read_latency_ms_sum ${s.l2ReadLatencyMs}`, `marshgo_cache_l2_read_total ${s.l2ReadCount}`,
      `marshgo_cache_l2_write_latency_ms_sum ${s.l2WriteLatencyMs}`, `marshgo_cache_l2_write_total ${s.l2WriteCount}`,
      ...this.quantileMetrics('l2_read', this.l2ReadSamples), ...this.quantileMetrics('l2_write', this.l2WriteSamples),
    ].join('\n') + '\n';
  }

  private async loadWithLock<T>(key: string, schema: z.ZodType<T>, options: CacheOptions<T>, loader: () => Promise<T>): Promise<T> {
    const redis = options.shared === false ? undefined : this.isRedisReady() ? this.redis : undefined;
    if (!redis) return this.loadAndStore(key, schema, options, loader);
    const lockKey = `${key}:lock`;
    const owner = randomUUID();
    const lockTtl = Math.max(1000, Math.min(60_000, options.lockTtlMs ?? 15_000));
    const waitMs = Math.max(0, Math.min(30_000, options.waitForLockMs ?? 5_000));
    const deadline = Date.now() + waitMs;
    let ownsLock = false;
    try {
      while (true) {
        const hit = await this.read<T>(key, schema);
        if (hit !== undefined) return hit;
        try { ownsLock = (await redis.set(lockKey, owner, { NX: true, PX: lockTtl })) === 'OK'; }
        catch { this.stats.l2Errors += 1; break; }
        if (ownsLock) {
          // Another caller may have populated L2 between the previous read and SET NX.
          const raced = await this.read<T>(key, schema);
          if (raced !== undefined) return raced;
          return await this.loadAndStore(key, schema, options, loader);
        }
        if (Date.now() >= deadline) {
          this.stats.lockTimeouts += 1;
          break;
        }
        this.stats.distributedCoalesced += 1;
        const remaining = Math.max(1, deadline - Date.now());
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining) + Math.floor(Math.random() * 20)));
      }
      return await this.loadAndStore(key, schema, options, loader);
    } finally {
      if (ownsLock) {
        try { await redis.eval(releaseLockScript, { keys: [lockKey], arguments: [owner] }); }
        catch { this.stats.l2Errors += 1; }
      }
    }
  }

  private async loadAndStore<T>(key: string, schema: z.ZodType<T>, options: CacheOptions<T>, loader: () => Promise<T>): Promise<T> {
    this.stats.loads += 1;
    try {
      const value = schema.parse(await loader());
      const payload = JSON.stringify(value);
      const ttlMs = Math.max(0, Math.floor(options.ttlForValue?.(value) ?? options.ttlMs));
      if (ttlMs <= 0) return schema.parse(JSON.parse(payload));
      const l1Ttl = Math.max(1, Math.min(ttlMs, options.l1TtlMs ?? ttlMs));
      this.storeL1(key, payload, l1Ttl);
      const redis = options.shared === false ? undefined : this.isRedisReady() ? this.redis : undefined;
      const maxL2Bytes = Math.max(1024, Math.min(64 * 1024 * 1024, options.maxL2Bytes ?? (Number(process.env.CACHE_L2_MAX_ENTRY_BYTES) || 2 * 1024 * 1024)));
      if (redis && Buffer.byteLength(payload) <= maxL2Bytes) {
        const started = Date.now();
        try { await redis.set(key, payload, { PX: this.jitter(ttlMs) }); }
        catch { this.stats.l2Errors += 1; }
        finally {
          const elapsed = Date.now() - started;
          this.stats.l2WriteLatencyMs += elapsed; this.stats.l2WriteCount += 1; this.recordSample(this.l2WriteSamples, elapsed);
        }
      }
      return schema.parse(JSON.parse(payload));
    } catch (error) {
      this.stats.loadErrors += 1;
      throw error;
    }
  }

  private async read<T>(key: string, schema: z.ZodType<T>, shared = true): Promise<T | undefined> {
    const now = Date.now();
    const local = this.l1.get(key);
    if (local && local.expiresAt > now) {
      this.l1.delete(key); this.l1.set(key, local); this.stats.l1Hits += 1;
      try { return schema.parse(JSON.parse(local.payload)); }
      catch { this.stats.invalidEntries += 1; this.removeL1(key); }
    } else {
      if (local) this.removeL1(key);
      this.stats.l1Misses += 1;
    }
    const redis = shared && this.isRedisReady() ? this.redis : undefined;
    if (!redis) return undefined;
    const started = Date.now();
    let payload: string | null;
    try { payload = await redis.get(key); }
    catch {
      this.stats.l2Errors += 1;
      return undefined;
    }
    if (payload === null) { this.stats.l2Misses += 1; this.stats.l2ReadLatencyMs += Date.now() - started; this.stats.l2ReadCount += 1; return undefined; }
    try {
      schema.parse(JSON.parse(payload));
      this.stats.l2Hits += 1;
      try {
        const remainingTtl = await redis.pTTL(key);
        if (remainingTtl > 0) this.storeL1(key, payload, Math.min(60_000, remainingTtl));
      } catch { this.stats.l2Errors += 1; }
      return schema.parse(JSON.parse(payload));
    } catch {
      this.stats.invalidEntries += 1;
      try { await redis.del([key]); } catch { this.stats.l2Errors += 1; }
      return undefined;
    } finally {
      const elapsed = Date.now() - started;
      this.stats.l2ReadLatencyMs += elapsed; this.stats.l2ReadCount += 1; this.recordSample(this.l2ReadSamples, elapsed);
    }
  }

  private storeL1(key: string, payload: string, ttlMs: number): void {
    const bytes = Buffer.byteLength(payload);
    const maxEntries = Math.max(1, Math.min(100_000, this.limits.maxEntries ?? (Number(process.env.CACHE_L1_MAX_ENTRIES) || 5000)));
    const maxBytes = Math.max(1024, Math.min(512 * 1024 * 1024, this.limits.maxBytes ?? (Number(process.env.CACHE_L1_MAX_BYTES) || 16 * 1024 * 1024)));
    this.removeL1(key);
    if (bytes > maxBytes) return;
    while (this.l1.size >= maxEntries || this.l1Bytes + bytes > maxBytes) {
      const oldest = this.l1.keys().next().value as string | undefined;
      if (!oldest) break;
      this.removeL1(oldest); this.stats.evictions += 1;
    }
    this.l1.set(key, { expiresAt: Date.now() + ttlMs, payload, bytes });
    this.l1Bytes += bytes;
  }

  private removeL1(key: string): void {
    const item = this.l1.get(key);
    if (!item) return;
    this.l1.delete(key); this.l1Bytes = Math.max(0, this.l1Bytes - item.bytes);
  }

  private isRedisReady(): boolean { return this.redis !== undefined && this.redis.isReady !== false; }
  private jitter(ttlMs: number): number { return Math.max(1, Math.floor(ttlMs * (0.9 + Math.random() * 0.2))); }
  private recordSample(samples: number[], value: number) { samples.push(value); if (samples.length > 2048) samples.shift(); }
  private quantileMetrics(name: string, samples: number[]): string[] {
    if (!samples.length) return [];
    const sortedSamples = [...samples].sort((a, b) => a - b);
    return [0.5, 0.95, 0.99].map((quantile) =>
      `marshgo_cache_l2_${name}_latency_ms{quantile="${quantile.toFixed(2)}"} ${sortedSamples[Math.min(sortedSamples.length - 1, Math.ceil(sortedSamples.length * quantile) - 1)]}`,
    );
  }
}

export const smartCache = new CacheService();
