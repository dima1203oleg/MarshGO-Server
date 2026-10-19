/** LRU/TTL cache for asynchronous values, with a caller-supplied size estimate. */
export class BoundedPromiseCache<T> {
  private readonly entries = new Map<string, {
    promise: Promise<T>;
    expiresAt: number;
    weight: number;
  }>();
  private retainedWeight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly ttlMs: number,
    private readonly failureTtlMs: number,
  ) {
    if (![maxEntries, maxWeight, ttlMs, failureTtlMs].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error('Async cache bounds must be positive');
    }
  }

  get size(): number { return this.entries.size; }
  get weight(): number { return this.retainedWeight; }

  getOrLoad(key: string, load: () => Promise<T>, estimateWeight: (value: T) => number, now = Date.now()): Promise<T> {
    this.pruneExpired(now);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.promise;
    }

    const entry: { promise: Promise<T>; expiresAt: number; weight: number } = {
      promise: Promise.resolve().then(load), expiresAt: now + this.ttlMs, weight: 0,
    };
    this.entries.set(key, entry);
    entry.promise.then((value) => {
      if (this.entries.get(key) !== entry) return;
      const estimated = estimateWeight(value);
      if (!Number.isFinite(estimated) || estimated <= 0 || estimated > this.maxWeight) {
        this.delete(key, entry);
        return;
      }
      entry.weight = estimated;
      this.retainedWeight += estimated;
      this.evictToBounds(key);
    }, () => {
      if (this.entries.get(key) !== entry) return;
      entry.expiresAt = Date.now() + this.failureTtlMs;
    });
    this.evictToBounds();
    return entry.promise;
  }

  private evictToBounds(protectKey?: string): void {
    while (this.entries.size > this.maxEntries || this.retainedWeight > this.maxWeight) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      if (oldest === protectKey && this.entries.size === 1) {
        this.delete(oldest);
        break;
      }
      this.delete(oldest);
    }
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.delete(key, entry);
  }

  private delete(key: string, expected?: { weight: number }): void {
    const entry = this.entries.get(key);
    if (!entry || (expected && entry !== expected)) return;
    this.entries.delete(key);
    this.retainedWeight = Math.max(0, this.retainedWeight - entry.weight);
  }
}
