# GTFS query-temporal segment retention — 2026-10-24

## Change under evaluation

The per-route stop-pair sample now gives priority to a segment for which the query has both a schedule-feasible preceding event and following event, before using generic interchange route-count as the tie-breaker. Exact `transferDecision` remains authoritative during itinerary search. The replay harness accepts explicit `GTFS_REPLAY_ORIGIN` and `GTFS_REPLAY_DESTINATION` coordinate pairs; defaults are unchanged.

## Verification

- Regression fixture: access → middle → egress is preserved under a one-segment-per-route graph budget even when an irrelevant, out-of-window interchange has more connected routes.
- Full Server suite: 309 passed, 0 failed, 3 opt-in skips.
- TypeScript: PASS. ESLint: PASS.
- Frozen static Lviv feed SHA-256: `bb4ac0ce9127b4967ad889379f523b04b84a0bb033814aa8c844526b42078164`, Node `24.21.0`.

| OD | Baseline elapsed | Candidate elapsed | Baseline trip chains | Candidate trip chains | Baseline route chains | Candidate route chains | Strategy winners | Truncation |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Holosko → Sykhiv | 2,031 ms | 2,498 ms | 58 | 59 | 37 | 38 | Changed | Both truncated |
| North Lviv → Sykhiv | 1,794 ms | 1,775 ms | 67 | 67 | 44 | 42 | Same | Both truncated |

These are single sequential runs, not latency percentiles. Returned-result ID hashes changed on both ODs. The candidate changed the first OD's selected objective candidates, including fastest/cheapest, and reduced route-chain diversity by two in the second OD. It did not clear candidate graph or search truncation.

## Decision

This is a bounded retention improvement demonstrated by a deterministic fixture, but not an accepted dense-feed completeness fix. Keep it on the stacked candidate for further comparison; do not claim improved production routing or merge it as closing the dense-feed gate. Next test the full three-OD suite with repeated paired runs and an exhaustive small-feed oracle, and inspect why the per-route and global segment caps discard useful stop-pair candidates. Production remains `PRODUCTION_READY=false`, `RELEASE_STATUS=NOT_RELEASED`.
