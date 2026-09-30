import crypto from 'node:crypto';
import type { Store } from 'express-rate-limit';
import type { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

const incrementScript = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return hits
`;

const decrementScript = `
local hits = redis.call('DECR', KEYS[1])
if hits <= 0 then redis.call('DEL', KEYS[1]) end
return hits
`;

/** Shared fixed-window counter. Client identifiers are hashed before reaching Redis. */
export class RedisRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 0;

  constructor(private readonly getClient: () => RedisClient | undefined, prefix = 'marshgo:rate-limit:v1:') {
    this.prefix = prefix;
  }

  init(options: Parameters<NonNullable<Store['init']>>[0]) {
    this.windowMs = options.windowMs;
  }

  private getBucket(key: string, now = Date.now()) {
    if (!Number.isFinite(this.windowMs) || this.windowMs < 1) throw new Error('Rate-limit store has not been initialized');
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    const digest = crypto.createHash('sha256').update(key).digest('hex');
    return { key: `${this.prefix}${windowStart}:${digest}`, resetTime: new Date(windowStart + this.windowMs) };
  }

  private redis() {
    const client = this.getClient();
    if (!client?.isReady) throw new Error('Shared rate-limit Redis is unavailable');
    return client;
  }

  async increment(key: string) {
    const bucket = this.getBucket(key);
    const totalHits = await this.redis().eval(incrementScript, {
      keys: [bucket.key],
      arguments: [String(this.windowMs + 60_000)],
    });
    return { totalHits: Number(totalHits), resetTime: bucket.resetTime };
  }

  async decrement(key: string) {
    const bucket = this.getBucket(key);
    await this.redis().eval(decrementScript, { keys: [bucket.key], arguments: [] });
  }

  async resetKey(key: string) {
    const bucket = this.getBucket(key);
    await this.redis().del(bucket.key);
  }
}
