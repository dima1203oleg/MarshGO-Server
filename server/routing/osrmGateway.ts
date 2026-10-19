import { z } from 'zod';
import { maneuverSchema } from '../../shared/navigation/contracts';
import { CacheService, smartCache } from '../cache/cacheService';
import { fetchOsrmRoute, RoutingUnavailableError, type RoadRoute } from './providers/osrmTransport';

const coordinate = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
const roadRouteSchema = z.object({
  geometry: z.array(coordinate).min(2).max(250_000),
  distanceMeters: z.number().finite().positive(), durationSeconds: z.number().finite().positive(),
  legs: z.array(z.object({ distanceMeters: z.number().finite().positive(), durationSeconds: z.number().finite().positive() })).optional(),
  maneuvers: z.array(maneuverSchema).optional(),
  calculatedAt: z.iso.datetime({ offset: true }).optional(),
});

export type RoutingPriority = 'interactive' | 'navigation' | 'background';
type QueuedRoute<T> = { priority: number; sequence: number; task: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout };

class RoutingQueue {
  private active = 0;
  private nextSequence = 0;
  private readonly pending: Array<QueuedRoute<unknown>> = [];
  snapshot() { return { active: this.active, pending: this.pending.length }; }

  run<T>(task: () => Promise<T>, priority: RoutingPriority): Promise<T> {
    const concurrency = boundedInt(process.env.ROUTING_MAX_CONCURRENCY, 12, 1, 64);
    const queueLimit = boundedInt(process.env.ROUTING_MAX_QUEUE, 24, 0, 500);
    if (this.active < concurrency) return this.execute(task);
    if (this.pending.length >= queueLimit) { routingMetrics.queueRejected += 1; return Promise.reject(new RoutingUnavailableError('Routing capacity is temporarily full', 'ROUTING_RATE_LIMITED')); }
    const priorityValue = priority === 'navigation' ? 0 : priority === 'interactive' ? 1 : 2;
    return new Promise<T>((resolve, reject) => {
      const budgetMs = boundedInt(process.env.ROUTING_QUEUE_WAIT_MS, 2500, 100, 30_000);
      const queued = { priority: priorityValue, sequence: this.nextSequence++, task, resolve, reject, timer: setTimeout(() => {
        const index = this.pending.indexOf(queued as QueuedRoute<unknown>);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new RoutingUnavailableError('Routing queue wait budget exceeded', 'ROUTING_TIMEOUT'));
      }, budgetMs) } as QueuedRoute<T>;
      queued.timer.unref();
      this.pending.push(queued as QueuedRoute<unknown>);
      this.pending.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    });
  }

  private async execute<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1;
    try { return await task(); }
    finally {
      this.active -= 1;
      const next = this.pending.shift();
      if (next) {
        clearTimeout(next.timer);
        void this.execute(next.task).then(next.resolve, next.reject);
      }
    }
  }
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

const queue = new RoutingQueue();
const routingMetrics = { requests: 0, upstreamRequests: 0, queueRejected: 0, noGraphVersionBypasses: 0, upstreamDurationMs: 0, upstreamSamples: [] as number[] };
const roadTtlMs = () => boundedInt(process.env.CACHE_OSRM_TTL_MS, 6 * 60 * 60_000, 60 * 60_000, 24 * 60 * 60_000);
const footTtlMs = () => boundedInt(process.env.CACHE_WALKING_TTL_MS, 3 * 60 * 60_000, 60 * 60_000, 6 * 60 * 60_000);

/** Single controlled gateway for every OSRM-compatible request. Geometry is cached only with an explicit graph version. */
export async function requestOsrmRoute(
  points: [number, number][],
  endpoint: string | undefined,
  options: { timeoutMs?: number; profile: string; priority?: RoutingPriority; cacheParameters?: unknown; cacheService?: CacheService },
): Promise<RoadRoute & { calculatedAt?: string }> {
  routingMetrics.requests += 1;
  const cache = options.cacheService ?? smartCache;
  const graphVersion = options.profile === 'FOOT'
    ? process.env.WALKING_GRAPH_VERSION || process.env.OSRM_GRAPH_VERSION
    : process.env.OSRM_GRAPH_VERSION;
  const ttlMs = options.profile === 'FOOT' ? footTtlMs() : roadTtlMs();
  const routeInput = {
    provider: 'osrm', endpoint: endpoint ?? '', profile: options.profile,
    graphVersion: graphVersion?.trim() || 'uncached-no-graph-version',
    points: points.map(([longitude, latitude]) => [Object.is(longitude, -0) ? 0 : longitude, Object.is(latitude, -0) ? 0 : latitude]),
    options: options.cacheParameters ?? {},
  };
  const compute = async () => {
    const route = await queue.run(async () => {
      const started = Date.now();
      routingMetrics.upstreamRequests += 1;
      try { return await fetchOsrmRoute(points, endpoint, options.timeoutMs); }
      finally {
        const elapsed = Date.now() - started;
        routingMetrics.upstreamDurationMs += elapsed;
        routingMetrics.upstreamSamples.push(elapsed);
        if (routingMetrics.upstreamSamples.length > 2048) routingMetrics.upstreamSamples.shift();
      }
    }, options.priority ?? 'interactive');
    return { ...route, calculatedAt: new Date().toISOString() };
  };
  if (!graphVersion?.trim()) { routingMetrics.noGraphVersionBypasses += 1; return compute(); }
  return cache.getOrLoad('road_geometry', routeInput, roadRouteSchema, {
    ttlMs, l1TtlMs: options.profile === 'FOOT' ? 5 * 60_000 : 10 * 60_000,
    lockTtlMs: options.timeoutMs ? Math.max(1000, options.timeoutMs + 1500) : 15_000,
    waitForLockMs: Math.max(1500, (options.timeoutMs ?? 10_000) + 2_000),
  }, compute);
}

export function routingMetricsPrometheus(): string {
  const queueStats = queue.snapshot();
  const samples = [...routingMetrics.upstreamSamples].sort((a, b) => a - b);
  const quantiles = samples.length ? [0.5, 0.95, 0.99].map((quantile) =>
    `marshgo_routing_upstream_latency_ms{quantile="${quantile.toFixed(2)}"} ${samples[Math.min(samples.length - 1, Math.ceil(samples.length * quantile) - 1)]}`,
  ) : [];
  return [
    `marshgo_routing_requests_total ${routingMetrics.requests}`,
    `marshgo_routing_upstream_requests_total ${routingMetrics.upstreamRequests}`,
    `marshgo_routing_upstream_duration_ms_sum ${routingMetrics.upstreamDurationMs}`,
    `marshgo_routing_queue_rejected_total ${routingMetrics.queueRejected}`,
    `marshgo_routing_cache_bypasses_no_graph_version_total ${routingMetrics.noGraphVersionBypasses}`,
    `marshgo_routing_queue_active ${queueStats.active}`,
    `marshgo_routing_queue_pending ${queueStats.pending}`,
    ...quantiles,
  ].join('\n') + '\n';
}

/** Exported for deterministic queue and cache contract tests; production callers use requestOsrmRoute. */
export const __routingInternals = { queue, roadRouteSchema };
