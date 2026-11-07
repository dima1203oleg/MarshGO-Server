import { readFileSync } from 'node:fs';

/**
 * The GTFS worker isolate parses whole feeds and builds the candidate graph, so it is the largest
 * single memory consumer in this process. Node sizes every isolate from the same container limit,
 * which means the API isolate and the worker isolate can each try to reach that limit — measured on
 * the acceptance container: `heap_size_limit` 1496 MiB in both, while `/sys/fs/cgroup/memory.max`
 * is 1800 MiB. The kernel therefore wins the race and kills the whole API (observed `exit 137`)
 * instead of either isolate raising a catchable out-of-memory error.
 */
const CGROUP_V2_LIMIT_FILE = '/sys/fs/cgroup/memory.max';
const CGROUP_V1_LIMIT_FILE = '/sys/fs/cgroup/memory.limit_in_bytes';
const CGROUP_V1_MEMORY_CONTROLLER_LIMIT_FILE = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

/** Lowest ceiling worth applying: below this the worker cannot hold one mid-size feed plus its graph. */
export const MIN_GTFS_WORKER_HEAP_MB = 384;
/** Never let a derived ceiling exceed what a single API container is realistically given. */
export const MAX_GTFS_WORKER_HEAP_MB = 3_072;
/** Share of the container limit the worker isolate may use; the rest stays for the API itself. */
const WORKER_SHARE_OF_CONTAINER = 0.6;

export interface GtfsWorkerHeapCeiling {
  maxOldGenerationSizeMb: number;
  source: 'env' | 'cgroup';
  containerLimitBytes?: number;
  /**
   * `false` when `NODE_OPTIONS` already pins `--max-old-space-size`. Measured on Node 24: that flag
   * applies to every isolate in the process and outranks the worker's `resourceLimits`, so the
   * ceiling below is what this process asked for, not what the worker actually gets.
   */
  authoritative: boolean;
  nodeOptionsMaxOldSpaceMb?: number;
}

/** `--max-old-space-size=<MiB>` as an operator set it in `NODE_OPTIONS`, if present at all. */
function readNodeOptionsPinned(environment: Record<string, string | undefined>): number | undefined {
  const match = /(?:^|\s)--max-old-space-size=(\d+)/.exec(environment.NODE_OPTIONS ?? '');
  if (!match) return undefined;
  const pinned = Number(match[1]);
  return Number.isSafeInteger(pinned) && pinned > 0 ? pinned : undefined;
}

function readContainerMemoryLimit(readFile: (path: string) => string): number | undefined {
  for (const path of [CGROUP_V2_LIMIT_FILE, CGROUP_V1_MEMORY_CONTROLLER_LIMIT_FILE, CGROUP_V1_LIMIT_FILE]) {
    let raw: string;
    try { raw = readFile(path).trim(); } catch { continue; }
    // cgroup v2 reports the string "max" when the memory controller imposes no limit.
    if (raw === '' || raw === 'max') continue;
    const bytes = Number(raw);
    if (!Number.isSafeInteger(bytes) || bytes < 1) continue;
    // v1 without a limit reports a near-`unsigned long max` sentinel, not a real ceiling.
    if (bytes > 1_000 * 1_024 * 1_024 * 1_024) continue;
    return bytes;
  }
  return undefined;
}

/**
 * Resolve the worker's `maxOldGenerationSizeMb`. Returns `undefined` — leaving Node's own default
 * untouched — when no container limit is visible and the operator set nothing, so development
 * machines and unlimited hosts keep behaving exactly as before.
 */
export function resolveGtfsWorkerHeapCeiling(
  environment: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): GtfsWorkerHeapCeiling | undefined {
  const pinned = readNodeOptionsPinned(environment);
  const authority = pinned === undefined ? { authoritative: true } : { authoritative: false, nodeOptionsMaxOldSpaceMb: pinned };
  const explicit = environment.MARSHGO_GTFS_WORKER_MAX_OLD_SPACE_MB?.trim();
  if (explicit) {
    const parsed = Number(explicit);
    if (!Number.isSafeInteger(parsed) || parsed < MIN_GTFS_WORKER_HEAP_MB) return undefined;
    return { maxOldGenerationSizeMb: Math.min(parsed, MAX_GTFS_WORKER_HEAP_MB), source: 'env', ...authority };
  }
  const containerLimitBytes = readContainerMemoryLimit(readFile);
  if (!containerLimitBytes) return undefined;
  const derived = Math.floor((containerLimitBytes / (1024 * 1024)) * WORKER_SHARE_OF_CONTAINER);
  if (derived < MIN_GTFS_WORKER_HEAP_MB) return undefined;
  return { maxOldGenerationSizeMb: Math.min(derived, MAX_GTFS_WORKER_HEAP_MB), source: 'cgroup', containerLimitBytes, ...authority };
}
