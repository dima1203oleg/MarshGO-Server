# GTFS batched temporal index replay — 2026-10-25

## Decision

Do not retain the grouped temporal-index optimization. It preserved the exact bounded results but did not demonstrate a material runtime improvement and did not reduce candidate-graph truncation. Its code was reverted. This report records both the experiment and the next structural direction.

## Setup

- Baseline and candidate source: baseline branch `codex/gtfs-sorted-frontier-scan-20261025` at `d5a1067e637ffcab3a2ea3f4f30e41c7fdbb5e24`; candidate was a local, uncommitted modification of the same source.
- Feed: `/private/tmp/marshgo-lviv-gtfs-current-20261025.zip`, SHA-256 `bb4ac0ce9127b4967ad889379f523b04b84a0bb033814aa8c844526b42078164`; 72 routes, 1,071 stops, 15,716 trips, no `transfers.txt` rows and no pathways.
- Search: 2026-10-23 05:00–05:30 UTC; max two transfers; walk limits 900/1,000/400 m; 180-second transfer buffer; four-hour wait; 100 results.
- Runtime: Node `v25.4.0`, while `package.json` requests Node `24.21.0`.
- Five serialized runs per OD, same replay harness and input for baseline and candidate. Frozen feed is local; no live provider calls.

## Paired replay

| OD | Baseline median → candidate median | Ordered hashes identical | Trip/route chains | FASTEST/CHEAPEST/BALANCED IDs | Truncation |
|---|---:|---|---:|---|---|
| Малий Голоско → Сихів | 2,150.83 → 2,103.61 ms (−2.2%) | Yes, `8c6a34794c534462cf24873d5c17fd1c8fe2d15c07a558a6d65e68e0ac4ce2ac` | 65 / 44 | Identical | Both graph and search remain truncated |
| Наукова → Сихів | 1,648.45 → 1,635.29 ms (−0.8%) | Yes, `edcd034a64305613165ed6a8cef3fe12090bceada3c558237d85145b1d08d18f` | 48 / 27 | Identical | Both graph and search remain truncated |
| Ринок → Дубляни | 2,834.72 → 2,785.15 ms (−1.7%) | Yes, `4d3ef0dae71ec8f06960ab8688b54e6cd4758ed6b68a931edd34240b8f7dac9a` | 60 / 35 | Identical | Both graph and search remain truncated |

These small deltas are within observed run spread and are not evidence of a stable speedup. A single debug-stage pair for Малий Голоско showed candidate construction at 1,202 ms versus baseline 1,128 ms, and total search at 2,303 ms versus 2,179 ms. This is diagnostic only; no memory conclusion is drawn from the noisy heap/RSS snapshots.

## Event-label traversal feasibility check

The existing test-only lazy event traversal was run on the same frozen feed with a 100,000-label cap:

- 5,395 ms; 100,000 labels expanded; `eventSearchTruncated=true`.
- 5,221 boarding expansions materialized 84,478 projected segments.
- 1,904 destination paths / 88 trip chains were observed before truncation.
- Peak report: about 529 MB RSS. The label cap prevented completeness; this is not a release candidate.

This traversal is not adopted as-is. Its output is incomplete and its memory/latency do not establish an advantage over the current bounded graph.

## Verification and cleanup

- Current baseline GTFS suite: 76/76 passed.
- Candidate focused query-retention, pathway, transfer-rule and exhaustive-oracle subset: 15/15 passed.
- Candidate full GTFS suite: 76/76 passed.
- Frozen replay preserved the baseline ordered hashes and all three strategy-winner IDs on all three ODs, but every OD remained `candidateGraphTruncated=true` and `searchTruncated=true`.
- Candidate source was reverted; the isolated worktree has no uncommitted code changes.

## Next engineering direction

The experiment rules out per-candidate frontier scans and shows that grouping those scans does not solve graph truncation. The next prototype should avoid materializing a full `GtfsDirectJourney` edge for every eligible stop pair: represent each scheduled trip instance once with its ordered eligible stop events, expand boarding/alighting lazily from query-reachable transfer states, and preserve the exact `transferDecision`, fare, realtime cancellation, service-date, and three-strategy semantics. Prove complete small-feed parity first, then run the same paired three-OD replay and memory measurements. Keep the current bounded implementation authoritative until that prototype proves both query coverage and bounded resource use.
