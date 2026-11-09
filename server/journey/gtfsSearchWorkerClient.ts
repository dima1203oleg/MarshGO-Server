import { Worker } from 'node:worker_threads';
import { isAbsolute } from 'node:path';
import type { GtfsItinerarySearchInput, GtfsItinerarySearchResult, GtfsStopArrival } from './gtfsTimetable';
import { resolveGtfsWorkerHeapCeiling } from './gtfsWorkerMemory';

export interface GtfsWorkerProvider {
  id: string;
  name: string;
  city: string;
  feedUrl: string;
  realtimeUrl?: string;
}

export interface GtfsWorkerMetroSources {
  stationSource: { id: string; name: string; feed_url: string; source_ref?: string | null };
  routeSource: { id: string; name: string; city: string; feed_url: string; source_ref?: string | null; last_sync_at?: Date | null };
  scheduleSources: Array<{ id: string; name: string; feed_url: string; source_ref?: string | null }>;
}

export interface GtfsWorkerGroup {
  id: string;
  timezone: string;
  sources: Array<{ providerId: string; providerName: string; providerCity: string }>;
  routeTypes: string[];
  hasMetro: boolean;
  transferStops: Array<{ name: string; coordinates: [number, number]; endpoint: 'origin' | 'destination' }>;
}

export interface GtfsWorkerStopArrivals {
  arrivals: GtfsStopArrival[];
  stopKnown: boolean;
  scheduleUpdatedAt: Date;
  realtimeStatus: 'AVAILABLE' | 'STALE' | 'UNAVAILABLE' | 'NOT_CONFIGURED' | 'TEMPORARILY_UNAVAILABLE';
  realtimeUpdatedAt?: Date;
  realtimeFeedTimestamp?: Date;
}

export interface GtfsWorkerTripMetadata {
  trips: Array<[string, { routeId: string; directionId?: string }]>
  stopTimes: Array<[string, Array<{ stopId: string; sourceStopId?: string; sequence: number }>]>
}

export interface GtfsWorkerDiagnostics {
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  externalBytes: number;
  feedCache: { entries: number; estimatedBytes: number };
  groupCacheEntries: number;
}

interface SearchResult {
  descriptors: GtfsWorkerGroup[];
  errors: Array<{ providerId?: string; name: string; kind: 'schedule' | 'realtime'; detail?: string }>;
  searches: Array<GtfsItinerarySearchResult & { groupId: string }>;
}

interface WorkerResponse<T> {
  id: number;
  ok: boolean;
  value?: T;
  error?: string;
}

type QueuedRequest = {
  payload: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/** Production request budget; measured cold multi-feed parses land just under this on the preview box. */
const DEFAULT_WORKER_REQUEST_TIMEOUT_MS = 90_000;

/** One bounded worker owns GTFS parsing and CPU-bound itinerary searches for this API process. */
export class GtfsSearchWorkerClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; done: () => void; timer: NodeJS.Timeout }>();
  /**
   * Requests whose caller-facing promise already rejected on timeout but whose work is still
   * finishing inside the live worker. The dispatch slot is held until the worker reports that
   * id back (or the settle deadline/errors force a restart), so a single slow cold parse no
   * longer terminates the worker and throws away the parsed-feed cache that every follow-up
   * request needs.
   */
  private abandoned = new Map<number, { done: () => void; timer: NodeJS.Timeout }>();
  private queue: QueuedRequest[] = [];
  private busy = false;
  private closed = false;
  private readonly maxQueuedRequests = 8;
  private heapCeilingAnnounced = false;

  constructor(private readonly testFixtureDirectory?: string, readonly requestTimeoutMs = DEFAULT_WORKER_REQUEST_TIMEOUT_MS) {
    if (testFixtureDirectory && !isAbsolute(testFixtureDirectory)) {
      throw new TypeError('GTFS test fixture directory must be absolute');
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new TypeError('GTFS worker request timeout must be a positive integer of milliseconds');
    }
  }

  async search(input: GtfsItinerarySearchInput, providers: GtfsWorkerProvider[], metro?: GtfsWorkerMetroSources): Promise<SearchResult> {
    return this.enqueue<SearchResult>({ type: 'search', input, providers, ...(metro ? { metro } : {}) });
  }

  async searchGroup(groupId: string, input: GtfsItinerarySearchInput): Promise<GtfsItinerarySearchResult> {
    return this.enqueue<GtfsItinerarySearchResult>({ type: 'search-group', groupId, input });
  }

  async stopArrivals(provider: GtfsWorkerProvider, stopId: string, now: Date, limit: number, filters: { routeId?: string; headsign?: string } = {}): Promise<GtfsWorkerStopArrivals> {
    return this.enqueue<GtfsWorkerStopArrivals>({ type: 'stop-arrivals', provider, stopId, now, limit, ...filters });
  }

  async tripMetadata(provider: GtfsWorkerProvider, tripIds: string[]): Promise<GtfsWorkerTripMetadata> {
    return this.enqueue<GtfsWorkerTripMetadata>({ type: 'trip-metadata', provider, tripIds });
  }

  /** Internal operational diagnostics, not mounted as a public HTTP endpoint. */
  async diagnostics(collectGarbage = false): Promise<GtfsWorkerDiagnostics> {
    return this.enqueue<GtfsWorkerDiagnostics>({ type: 'diagnostics', collectGarbage });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    this.failWorker(new Error('GTFS search worker closed'));
    for (const request of this.queue.splice(0)) request.reject(new Error('GTFS search worker closed'));
    if (worker) await worker.terminate();
  }

  private enqueue<T>(payload: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('GTFS search worker is closed'));
    if (this.queue.length + (this.busy ? 1 : 0) >= this.maxQueuedRequests) {
      return Promise.reject(new Error('GTFS search capacity is temporarily full'));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ payload, resolve: (value) => resolve(value as T), reject });
      this.drain();
    });
  }

  /** Overridable for deterministic tests of the queue and timeout behaviour. */
  protected createWorker(): Worker {
    const heapCeiling = resolveGtfsWorkerHeapCeiling();
    if (!this.heapCeilingAnnounced) {
      this.heapCeilingAnnounced = true;
      console.info(JSON.stringify({
        event: heapCeiling?.authoritative === false ? 'gtfs.worker.memory_ceiling_shadowed' : 'gtfs.worker.memory_ceiling',
        ...(heapCeiling ?? { source: 'node-default' as const }),
      }));
    }
    return new Worker(new URL('./gtfsSearchWorker.mjs', import.meta.url), {
      workerData: { testFixtureDirectory: this.testFixtureDirectory },
      ...(heapCeiling ? { resourceLimits: { maxOldGenerationSizeMb: heapCeiling.maxOldGenerationSizeMb } } : {}),
    });
  }

  private async ensureWorker(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = this.createWorker();
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('GTFS search worker startup timed out')), 10_000);
      worker.on('message', (message: WorkerResponse<unknown> & { type?: string }) => {
        if (message.type === 'ready') { clearTimeout(timer); resolve(); return; }
        const entry = this.pending.get(message.id);
        if (!entry) {
          // A response for a request whose caller already timed out: the worker stayed alive to
          // finish it, so its parsed-feed cache is warm again and the dispatch slot can move on.
          const abandonedEntry = this.abandoned.get(message.id);
          if (abandonedEntry) {
            clearTimeout(abandonedEntry.timer);
            this.abandoned.delete(message.id);
            abandonedEntry.done();
          }
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error ?? 'GTFS worker request failed'));
        entry.done();
      });
      worker.on('error', (error) => { this.failWorker(error); reject(error); });
      worker.on('exit', (code) => {
        if (code !== 0) this.failWorker(new Error(`GTFS search worker exited (${code})`));
      });
    }).catch((error: unknown) => {
      this.worker = null;
      this.ready = null;
      throw error instanceof Error ? error : new Error('GTFS search worker failed to start');
    });
    return this.ready;
  }

  private async drain(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    const request = this.queue.shift()!;
    try {
      await this.ensureWorker();
      const worker = this.worker;
      if (!worker) throw new Error('GTFS search worker is unavailable');
      const id = this.nextId++;
      let markDone!: () => void;
      const done = new Promise<void>((resolve) => { markDone = resolve; });
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new Error('GTFS search worker request timed out'));
        // Do not terminate on the first timeout: the planner and feed fetchers are internally
        // bounded, so the abandoned request still finishes and leaves the parsed feeds warm for
        // the next one. The dispatch slot stays held until that response arrives; only if the
        // worker never reports back within a second equal window is it restarted.
        const settleTimer = setTimeout(() => {
          if (!this.abandoned.delete(id)) return;
          pending.done();
          this.failWorker(new Error('GTFS search worker request timed out'));
        }, this.requestTimeoutMs);
        this.abandoned.set(id, { done: pending.done, timer: settleTimer });
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: request.resolve, reject: request.reject, done: markDone, timer });
      try { worker.postMessage({ id, ...request.payload }); }
      catch (error) {
        const pending = this.pending.get(id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error instanceof Error ? error : new Error('GTFS worker post failed')); pending.done(); }
      }
      await done;
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error('GTFS worker request failed'));
    } finally {
      this.busy = false;
      void this.drain();
    }
  }

  private failWorker(error: Error): void {
    const worker = this.worker;
    this.ready = null;
    this.worker = null;
    if (worker) void worker.terminate();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); entry.done(); }
    this.pending.clear();
    for (const entry of this.abandoned.values()) { clearTimeout(entry.timer); entry.done(); }
    this.abandoned.clear();
  }
}

const testFixtureMode = process.env.MARSHGO_API_TEST_FIXTURE_MODE === '1';
if (testFixtureMode && process.env.NODE_ENV === 'production') {
  throw new Error('GTFS API test fixtures cannot be enabled in production');
}
const testFixtureDirectory = testFixtureMode ? process.env.MARSHGO_GTFS_TEST_FIXTURE_DIR : undefined;
if (testFixtureMode && (!testFixtureDirectory || !isAbsolute(testFixtureDirectory))) {
  throw new Error('GTFS API test fixture mode requires an absolute fixture directory');
}
export const gtfsSearchWorker = new GtfsSearchWorkerClient(testFixtureDirectory);
