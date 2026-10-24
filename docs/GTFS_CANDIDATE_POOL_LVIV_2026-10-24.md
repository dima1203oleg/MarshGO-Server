# GTFS Candidate Pool Experiment — Lviv — 2026-10-24

## Scope

This is a bounded search-quality change on the Server release-candidate branch, based on parent commit `c7252783f3c8b3b1140d621bcbdae175248008be`. It increases the per-leg-count itinerary candidate cap used before ranking. It does not claim complete timetable search or production readiness.

## Reproduction inputs

- Frozen public Lviv GTFS archive: `/tmp/marshgo-lviv-gtfs-20261024.zip`
- Archive SHA-256: `bb4ac0ce9127b4967ad889379f523b04b84a0bb033814aa8c844526b42078164`
- Feed inventory: 1,071 stops, 72 routes, 15,716 trips.
- Origin: `[24.008217, 49.864885]`; destination: `[24.0175835, 49.8013165]`.
- Requested service time: 2026-10-23 08:00–08:30, Europe/Kyiv (05:00–05:30 UTC); replay clock 04:55 UTC.
- Search horizon: 6 hours; up to two transfers; walk radii 900/1,000/400 m; transfer buffer 180 seconds; max wait 4 hours; response limit 100.
- Runtime: Node 24.21.0.

## Change

`MAX_CANDIDATES_PER_LEG_COUNT` changes from `min(limit * 2, 500)` to `min(limit * 5, 1,000)`. The pool remains bounded and per transit-leg count. The existing `searchTruncated`/sampling flags remain authoritative; reaching a sampling cap is still reported as incomplete search.

## Frozen replay comparison

Three runs per variant used the same feed archive and query.

| Measure | Before (2x cap) | Candidate (5x cap) |
|---|---:|---:|
| Candidate pool before response limit | 400 (200 two-leg + 200 three-leg) | 1,000 (500 two-leg + 500 three-leg) |
| Unique returned route chains | 31 | 49 |
| Unique returned trip chains | 44 | 65 |
| Returned legs distribution | 63 two-leg / 37 three-leg | 60 two-leg / 40 three-leg |
| Search truncated | yes | yes |
| Truncation causes | stop selection, search budget, candidate sampling | stop selection, search budget, candidate sampling |
| Strategy winners | same winner for FASTEST/CHEAPEST/BALANCED | same winner for FASTEST/CHEAPEST/BALANCED |
| Winner duration/fare | 3,243 s / 2,300 minor units | 3,243 s / 2,300 minor units |
| Median elapsed | 1,380 ms | 1,466 ms (+6.2%) |
| Median process RSS | 576 MB | 579 MB (no meaningful change) |

Ordered journey-ID replay hashes were deterministic across each variant: before `a0c966efae6498164578f4ce658dfcd3990673dba064cd8ce28653d79a977d9c`; candidate `63f89bcfbf8425acff797b0d4577fa121e72604c11d9dfcab679882fc91819df`.

## Verification

- GTFS timetable and journey-scoring tests: 52 passed, 0 failed.
- Full Server unit suite on this change: 225 passed, 0 failed, 1 opt-in test skipped.
- Typecheck: passed on this change.
- Lint: passed on this change.
- `git diff --check`: passed after the focused edit.

No staging, provider live endpoint, production, or physical device was tested by this experiment.

## Conclusion and next work

The larger bounded pool yields more route and trip-chain diversity at a small measured median latency increase in this replay, while preserving the same strategy winners. This is an improvement to candidate breadth only. The algorithm still reports incomplete search because stop-selection, search-budget, and candidate-sampling truncation remain. Next routing work must address those truncation sources independently, with frozen-feed benchmarks and explicit completeness signals; do not remove the signals or claim all feasible journeys were enumerated.
