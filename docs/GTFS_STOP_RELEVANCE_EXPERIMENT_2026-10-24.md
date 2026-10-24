# GTFS endpoint stop relevance experiment — 2026-10-24

## Decision

Keep this change isolated as an experiment pending product-level review. It improves candidate diversity in two frozen Lviv queries without changing the selected strategy winners or increasing the configured stop/candidate caps. It does not solve search completeness: all three queries still report both `searchTruncated` and `resultLimitReached`.

## Change under evaluation

`findGtfsItinerariesWithStats` now retains 15 of the 20 bounded endpoint stop slots by nearest radial distance, then fills up to five remaining slots by a directional score (`distance + 0.25 × distance-to-the-other-end`). Deterministic stop-ID tie breaks make selection stable. The final nearest-stop fill preserves the existing cap when fewer directional candidates exist. Search still reports truncation whenever eligible stops were excluded.

The candidate does not use route geometry for the directional score. It is a geometric heuristic and must not be represented as a complete or globally optimal search.

## Evidence

Frozen input archive: `/tmp/marshgo-lviv-gtfs-20261024.zip`  
SHA-256: `bb4ac0ce9127b4967ad889379f523b04b84a0bb033814aa8c844526b42078164`  
Runtime: Node `v24.21.0`  
Replay: `scripts/replay-lviv-gtfs.mts`  
Query window: `2026-10-23T05:00:00Z`–`05:30:00Z`; up to two transfers; 900m access, 1000m egress, 400m transfer walking; 180s transfer buffer; 100 result limit.

| Frozen OD | Baseline trip / route chains | Candidate trip / route chains | Candidate result SHA-256 | Baseline winner IDs preserved? | Candidate search complete? |
| --- | ---: | ---: | --- | --- | --- |
| Holosko → Sykhiv | 65 / 49 | 69 / 54 | `01ce5e7a31e9ef8ff530275d54bf07c44cab2a9c7ceac214cec0cb130795ecd7` | Yes, FASTEST/CHEAPEST/BALANCED | No |
| Naukova → Sykhiv | 57 / 43 | 52 / 42 | `7c0e528a79adf5c40ba5d36fce82655f7884a8a0fcd4f3909d8633661b1cc46e` | Yes, FASTEST/CHEAPEST/BALANCED | No |
| Rynok → Dubliany | 46 / 36 | 46 / 36 | `2c56e404e17f8163c53018da735c25e16bff99125540d3ffd4c86617650ed96d` | Yes, FASTEST/CHEAPEST/BALANCED | No |

Candidate hashes were identical across two candidate replays. Three paired process runs on each version gave the following per-query median elapsed times:

| Frozen OD | Baseline median | Candidate median | Difference |
| --- | ---: | ---: | ---: |
| Holosko → Sykhiv | 1466.53 ms | 1556.24 ms | +6.1% |
| Naukova → Sykhiv | 867.73 ms | 969.12 ms | +11.7% |
| Rynok → Dubliany | 1437.06 ms | 1353.12 ms | −5.8% |
| Sum of per-query medians | 3771.32 ms | 3878.48 ms | +2.8% |

These are three process pairs on one machine and a frozen data archive, not a representative load test. Heap/RSS varied between runs and showed no reliable conclusion. The archive contains 1,071 stops, 72 routes and 15,716 trips; it is a snapshot, not proof that the corresponding upstream feed is currently healthy or licensed for production use.

## Checks on this worktree

- Focused `gtfs-timetable` tests: 36 passed.
- Full Server test suite: 226 passed, 0 failed, 1 opt-in integration test skipped.
- TypeScript typecheck: passed.
- ESLint: passed.
- `git diff --check`: passed.

The new regression test creates an endpoint with 20 nearer non-progressing stops and five farther stops progressing toward the destination. It proves directional candidates can survive the bounded endpoint selection and that the result remains explicitly marked truncated.

## Open work

1. Investigate why baseline candidate discovery is dominated by dense corridor / stop-time expansion and identify a completeness-preserving search strategy with a defensible CPU/memory bound.
2. Add differential correctness checks against a small exhaustive oracle and replay more frozen OD/time windows before integrating this heuristic.
3. Benchmark with a larger, production-representative GTFS snapshot and controlled warm/cold runs.
4. Keep `searchTruncated=true` visible to callers until the search can prove it exhausted the relevant candidate space.
5. This experiment is not staging, provider-live, production, device, or release acceptance evidence.
