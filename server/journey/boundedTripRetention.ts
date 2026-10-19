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
