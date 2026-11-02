/**
 * Share identical synchronous searches within one API request. The cache is
 * intentionally request-scoped so results never outlive their source snapshot.
 */
export function memoizeRequestSearch<TArgs extends unknown[], TResult>(
  keyFor: (...args: TArgs) => string,
  search: (...args: TArgs) => TResult,
  maxEntries = 128,
): (...args: TArgs) => TResult {
  const cache = new Map<string, TResult>();
  const capacity = Number.isSafeInteger(maxEntries) ? Math.max(1, maxEntries) : 128;

  return (...args: TArgs): TResult => {
    const key = keyFor(...args);
    if (cache.has(key)) return cache.get(key)!;

    const result = search(...args);
    cache.set(key, result);
    if (cache.size > capacity) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    return result;
  };
}
