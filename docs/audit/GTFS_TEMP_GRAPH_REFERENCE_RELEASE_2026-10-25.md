# GTFS temporary graph reference release

Date: 2026-10-25  
Branch: `codex/gtfs-batched-reachability-20261025`  
Base: `d5a1067e637ffcab3a2ea3f4f30e41c7fdbb5e24` (stacked on the current GTFS frontier work)

## Change

After the selected public journey graph and its `segments-built` diagnostic snapshot are complete, clear the route retention reservoirs and redistributed-route context maps. No subsequent graph-adjacency, transfer, or itinerary-search operation reads these maps. The selected `segments` array remains the source for the final graph, so route candidates and returned journeys are unchanged.

## Evidence

- `tsc --noEmit`: PASS.
- `tests/gtfs-timetable.test.ts`: 76/76 PASS.
- Frozen Lviv replay archive SHA-256: `bb4ac0ce9127b4967ad889379f523b04b84a0bb033814aa8c844526b42078164`.
- One candidate replay returned 100 journeys and retained the baseline ordered result hash `8c6a34794c534462cf24873d5c17fd1c8fe2d15c07a558a6d65e68e0ac4ce2ac`; balanced, fastest, and cheapest winner IDs matched the recorded baseline. The search and candidate graph remained truncated, as before.

## Limits

This is a reference-lifetime cleanup, not a demonstrated latency improvement. A paired five-run benchmark was attempted but invalidated by a concurrently running replay in another checkout and was stopped. The single replay showed lower RSS but higher heap than prior measurements, so no memory or performance gain is claimed. Re-run a paired benchmark on an otherwise idle host before describing this as a measured optimization.

The frozen replay uses Node v25.4.0 while the repository requires Node 24.21.0; repeat on the declared runtime before accepting performance results. Routing completeness is not improved: this fixture still reaches the existing graph/search truncation limits.
