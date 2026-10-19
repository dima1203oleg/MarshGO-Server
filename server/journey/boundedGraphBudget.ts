import { compareStableId } from './stableOrdering';

/**
 * Allocate a hard graph-segment budget proportionally to estimated route demand.
 * Every positive-demand route gets one slot when the budget permits; routes
 * cannot exceed the per-route ceiling, and unused ceiling capacity is
 * redistributed deterministically.
 */
export function allocateBoundedGraphBudgets(
  demandByRoute: ReadonlyMap<string, number>,
  totalBudget: number,
  maximumPerRoute: number,
): Map<string, number> {
  if (!Number.isSafeInteger(totalBudget) || totalBudget < 0
    || !Number.isSafeInteger(maximumPerRoute) || maximumPerRoute < 1) {
    throw new TypeError('graph budget bounds are invalid');
  }
  const candidates = [...demandByRoute]
    .filter(([routeId, demand]) => routeId.length > 0 && Number.isFinite(demand) && demand > 0)
    .sort(([a], [b]) => compareStableId(a, b));
  if (totalBudget === 0 || candidates.length === 0) return new Map();

  // If more routes qualify than the global budget can represent, retain the
  // highest-demand routes deterministically. Normal city feeds are far below
  // this bound; this guard keeps national catalog feeds finite as well.
  const active = candidates.length > totalBudget
    ? [...candidates].sort(([aId, a], [bId, b]) => b - a || compareStableId(aId, bId)).slice(0, totalBudget)
      .sort(([a], [b]) => compareStableId(a, b))
    : candidates;
  const budgets = new Map(active.map(([routeId]) => [routeId, 1]));
  let remaining = totalBudget - active.length;
  let allocatable = active.filter(([routeId]) => (budgets.get(routeId) ?? 0) < maximumPerRoute);

  while (remaining > 0 && allocatable.length > 0) {
    const weightTotal = allocatable.reduce((sum, [routeId]) => sum + (demandByRoute.get(routeId) ?? 0), 0);
    if (!(weightTotal > 0) || !Number.isFinite(weightTotal)) break;
    const capped = allocatable.filter(([routeId]) => {
      const current = budgets.get(routeId) ?? 0;
      return current + remaining * (demandByRoute.get(routeId) ?? 0) / weightTotal >= maximumPerRoute;
    });
    if (capped.length > 0) {
      const cappedIds = new Set(capped.map(([routeId]) => routeId));
      for (const [routeId] of capped) {
        const current = budgets.get(routeId) ?? 0;
        const added = maximumPerRoute - current;
        budgets.set(routeId, maximumPerRoute);
        remaining -= added;
      }
      allocatable = allocatable.filter(([routeId]) => !cappedIds.has(routeId));
      continue;
    }

    const shares = allocatable.map(([routeId]) => {
      const exact = remaining * (demandByRoute.get(routeId) ?? 0) / weightTotal;
      const whole = Math.floor(exact);
      return { routeId, whole, fraction: exact - whole };
    });
    let assigned = 0;
    for (const share of shares) {
      const current = budgets.get(share.routeId) ?? 0;
      const added = Math.min(share.whole, maximumPerRoute - current);
      budgets.set(share.routeId, current + added);
      assigned += added;
    }
    remaining -= assigned;
    const byRemainder = [...shares].sort((a, b) => b.fraction - a.fraction || compareStableId(a.routeId, b.routeId));
    for (const share of byRemainder) {
      if (remaining <= 0) break;
      const current = budgets.get(share.routeId) ?? 0;
      if (current >= maximumPerRoute) continue;
      budgets.set(share.routeId, current + 1);
      remaining--;
    }
    allocatable = allocatable.filter(([routeId]) => (budgets.get(routeId) ?? 0) < maximumPerRoute);
    if (assigned === 0 && remaining > 0 && allocatable.length === 0) break;
  }

  return budgets;
}
