export interface BoundedTripGroup<T> {
  key: string;
  priority: number;
  segments: T[];
}

/** Keep the best K items with O(log K) insertion memory and deterministic ordering. */
export class BoundedBestK<T> {
  private readonly heap: T[] = [];

  constructor(private readonly limit: number, private readonly compare: (left: T, right: T) => number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('sample limit must be a positive safe integer');
  }

  consider(candidate: T): boolean {
    if (this.heap.length < this.limit) {
      this.heap.push(candidate);
      this.siftUp(this.heap.length - 1);
      return true;
    }
    if (this.compare(candidate, this.heap[0]) >= 0) return false;
    this.heap[0] = candidate;
    this.siftDown(0);
    return true;
  }

  get size(): number {
    return this.heap.length;
  }

  some(predicate: (candidate: T) => boolean): boolean {
    return this.heap.some(predicate);
  }

  toSortedArray(): T[] {
    return [...this.heap].sort(this.compare);
  }

  private siftUp(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.heap[parent], this.heap[index]) >= 0) break;
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      index = parent;
    }
  }

  private siftDown(index: number) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < this.heap.length && this.compare(this.heap[left], this.heap[worst]) > 0) worst = left;
      if (right < this.heap.length && this.compare(this.heap[right], this.heap[worst]) > 0) worst = right;
      if (worst === index) return;
      [this.heap[index], this.heap[worst]] = [this.heap[worst], this.heap[index]];
      index = worst;
    }
  }
}

function compareTripGroups<T>(a: Pick<BoundedTripGroup<T>, 'key' | 'priority'>,
  b: Pick<BoundedTripGroup<T>, 'key' | 'priority'>): number {
  const priorityDifference = a.priority - b.priority;
  if (priorityDifference !== 0) return priorityDifference;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

/** Retain deterministic whole-trip groups within a segment-count bound. */
export function retainBoundedTripGroup<T>(retained: BoundedTripGroup<T>[], candidate: BoundedTripGroup<T>,
  currentSegments: number, limit: number): { segments: number; retained: boolean } {
  if (candidate.segments.length > limit) return { segments: currentSegments, retained: false };

  let evictFrom = retained.length;
  let segmentsAfterEviction = currentSegments;
  while (segmentsAfterEviction + candidate.segments.length > limit) {
    const worst = retained[evictFrom - 1];
    if (!worst || compareTripGroups(candidate, worst) >= 0) {
      return { segments: currentSegments, retained: false };
    }
    segmentsAfterEviction -= worst.segments.length;
    evictFrom--;
  }

  if (evictFrom < retained.length) retained.splice(evictFrom);
  let low = 0;
  let high = retained.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareTripGroups(retained[middle], candidate) < 0) low = middle + 1;
    else high = middle;
  }
  retained.splice(low, 0, candidate);
  return { segments: segmentsAfterEviction + candidate.segments.length, retained: true };
}

/** Redistribute only otherwise-unused graph slots across routes with sampled overflow. */
export function redistributeBoundedCandidates<T>(
  retainedByRoute: ReadonlyMap<string, readonly T[]>,
  overflowByRoute: ReadonlyMap<string, readonly T[]>,
  totalLimit: number,
  perRouteLimit: number,
  candidateKey: (candidate: T) => string,
): { routes: Map<string, T[]>; added: number } {
  if (!Number.isSafeInteger(totalLimit) || totalLimit < 0
    || !Number.isSafeInteger(perRouteLimit) || perRouteLimit < 1) {
    throw new TypeError('redistribution bounds are invalid');
  }
  const routes = new Map([...retainedByRoute].map(([routeId, candidates]) => [routeId, [...candidates]]));
  const keysByRoute = new Map([...routes].map(([routeId, candidates]) =>
    [routeId, new Set(candidates.map(candidateKey))]));
  const retainedCount = [...routes.values()].reduce((sum, candidates) => sum + candidates.length, 0);
  let remaining = Math.max(0, totalLimit - retainedCount);
  let added = 0;
  const routeIds = [...overflowByRoute.keys()].sort();
  const candidatesByRoute = new Map(routeIds.map((routeId) => [routeId, overflowByRoute.get(routeId) ?? []]));
  const offsets = new Map(routeIds.map((routeId) => [routeId, 0]));

  // Round-robin makes the bounded slack useful across lines rather than letting
  // a single high-volume route consume it all. Input arrays must be ranked
  // deterministically by the caller.
  while (remaining > 0) {
    let progressed = false;
    for (const routeId of routeIds) {
      if (remaining <= 0) break;
      const route = routes.get(routeId) ?? [];
      if (route.length >= perRouteLimit) continue;
      const candidates = candidatesByRoute.get(routeId) ?? [];
      let offset = offsets.get(routeId) ?? 0;
      const keys = keysByRoute.get(routeId) ?? new Set<string>();
      while (offset < candidates.length && keys.has(candidateKey(candidates[offset]))) offset++;
      offsets.set(routeId, offset + 1);
      if (offset >= candidates.length) continue;
      const candidate = candidates[offset];
      route.push(candidate);
      routes.set(routeId, route);
      keys.add(candidateKey(candidate));
      keysByRoute.set(routeId, keys);
      remaining--;
      added++;
      progressed = true;
    }
    if (!progressed) break;
  }
  return { routes, added };
}
