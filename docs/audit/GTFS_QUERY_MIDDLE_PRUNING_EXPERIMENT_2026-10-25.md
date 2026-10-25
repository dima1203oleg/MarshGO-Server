# GTFS query-middle pruning experiment — 2026-10-25

## Decision

Rejected. No production routing code is retained from this experiment. The change pruned a non-endpoint segment in searches capped at two transfers unless it appeared to connect both query-reachable frontiers. Although the focused small-feed oracle tests passed after updating assertions to the new graph-completeness semantics, the frozen production-shaped replay regressed and remained truncated.

## Reproducible setup

- Parent/candidate baseline: `d5a1067e637ffcab3a2ea3f4f30e41c7fdbb5e24` (`codex/gtfs-sorted-frontier-scan-20261025`).
- Feed: `/private/tmp/marshgo-lviv-gtfs-current-20261025.zip`, SHA-256 `bb4ac0ce9127b4967ad889379f523b04b84a0bb033814aa8c844526b42078164`.
- Query date/window: 2026-10-23 05:00–05:30 UTC; max two transfers; access/egress/transfer walks 900/1000/400 m; 180-second transfer buffer; four-hour max wait; 100 results.
- Runtime: Node `v25.4.0` (repository requests Node `24.21.0`; timing is diagnostic, not a release benchmark).
- One serialized run per OD on baseline and candidate; no concurrent benchmark/test load.

## Results

| OD | Baseline → candidate time | Trip chains | Route chains | Candidate result hash | Outcome |
|---|---:|---:|---:|---|---|
| Малий Голоско → Сихів | 2,336 → 3,161 ms (+35%) | 65 → 62 | 44 → 42 | `37ac4f59573ff72c6ca1d35471ee15371dd400b36f59faa6ad79c03c2d7ba2b9` | FASTEST winner worsened by 42 min; all still truncated |
| Наукова → Сихів | 1,826 → 2,252 ms (+23%) | 48 → 50 | 27 → 29 | `556074bad60c423581e6384ce789289b01516113035b9784d155271a22a1ee6c` | Three winner IDs preserved; all still truncated |
| Ринок → Дубляни | 2,813 → 3,915 ms (+39%) | 60 → 60 | 35 → 30 | `3629f5fe0fbcb7f224daeb5f8881218c9d488466f8a9a6efa02f0aa61d0025ce` | Winner IDs preserved; route diversity fell; all still truncated |

Candidate ordered-result hashes were stable within each single run by construction only; repeat stability was not measured. Baseline hashes differ between this one-run replay and older reports, so those older reports are not substituted for this exact-parent comparison.

## Checks and cleanup

- Baseline `tests/gtfs-timetable.test.ts`: 76/76 passed.
- Candidate exhaustive/oracle/pathway/query-retention subset: 13/13 passed after updating fixture assertions to reflect that some injected-budget graphs no longer truncated.
- An earlier full candidate run showed 74 passed and two failures caused by stale truncation assertions; the corrected focused subset passed, but a corrected full suite was not rerun because the replay demonstrated a clear performance/result regression.
- Candidate implementation and test modifications were reverted. This document records the rejected hypothesis only.

## Next action

Do not retry per-segment `hasPriorEvent`/`hasNextEvent` filtering in the construction loop. It adds expensive frontier scans and changes bounded-search sampling without resolving the graph cap. Next investigate a batched/indexed reachability representation that answers temporal connection queries without a per-candidate scan, then prove exact equality against the exhaustive small-feed oracle and compare paired repeated frozen-feed runs before keeping code.
