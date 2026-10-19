export interface BoundedTripGroup<T> {
  key: string;
  priority: number;
  segments: T[];
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
