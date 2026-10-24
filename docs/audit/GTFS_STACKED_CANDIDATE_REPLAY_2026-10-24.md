# GTFS stacked candidate replay — 2026-10-24

## Candidate under test

- Integration branch: `codex/server-production-integration-20261024`.
- Base: PR #34 head `904a15a57ed7332b0620d048b4d724e7e681beb3`, stacked on the GTFS ranking/graph/transfer/freshness/oracle chain.
- Added commit: lockfile security update from release candidate commit `c7252783f3c8b3b1140d621bcbdae175248008be`, cherry-picked as `375825c`.
- This is an isolated unmerged candidate. It does not replace or rewrite PR #35.

## Frozen Lviv replay

- Archive SHA-256: `bb4ac0ce9127b4967ad889379f523b04b84a0bb033814aa8c844526b42078164`.
- Runtime: Node `24.21.0`.
- Query: Малий Голоско `[24.008217,49.864885]` → Сихів `[24.0175835,49.8013165]`; 2026-10-23 08:00–08:30 Europe/Kyiv; six-hour horizon; up to two transfers; walk limits 900/1000/400 m; 180-second buffer; four-hour wait cap; 100 results.
- Reproducer: `scripts/replay-lviv-gtfs.mts`; the public feed archive is intentionally external and must be supplied via `GTFS_REPLAY_ZIP`. Set `GTFS_REPLAY_EXPECTED_SHA256` to enforce the frozen archive identity.
- Three runs returned the same ordered result hash `698e0e7538b5f0b9c0645ffdffd75be039ef921a2ebb79feb928237b29b6dd6f`, 58 unique trip chains and 37 route chains. Each returned 100 journeys and `searchTruncated=true`, `candidateGraphTruncated=true`.
- FASTEST and CHEAPEST selected the same journey on this query; BALANCED selected a different journey. Identical FASTEST/CHEAPEST output is observed evidence for this query, not proof the strategies are generally equivalent.
- Elapsed times: 2,457.82 ms, 2,233.28 ms, 2,928.76 ms (median 2,457.82 ms). RSS varied from 242 MB to 291 MB; this small sample is not a load or percentile benchmark.

## Local verification on this branch

- Full unit suite: 308 passed, 0 failed, 3 opt-in integration tests skipped.
- TypeScript typecheck: PASS.
- ESLint: PASS.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: PASS before commit.
- Server CI completed successfully for PR #38 at head `e2774b110a024fad4511f7a9fa4f20fb520fb13f` (run `40068814598`): dependency audit, lint, typecheck, unit suite, clean database migrations, integration suite, production API image build, and local PostGIS/Redis image smoke all passed. This is a GitHub CI result for the candidate branch, not a deployed production test.

## Lazy event-search investigation on the same frozen query

The current bounded production graph and the opt-in test-only lazy event-label search were compared using the same GTFS archive and the production-selected 27 origin stops / 25 destination stops. The test oracle now calls the production `materializeTripInstanceLegs` projection for scheduled stop-pair eligibility, while retaining an independent transfer traversal. This avoids silently comparing different trip-instance/stop-pair rules. The diagnostic script is `scripts/replay-lviv-lazy-event-search.mts` and requires the external archive path plus its expected SHA.

| Expanded-label cap | Expanded labels | Materialized boarding expansions | Projected legs | Found paths | Unique trip chains | Unique route chains | Truncated | Event-search time | Peak reported RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: |
| 10,000 | 10,000 | 2,025 | 35,754 | 166 | 16 | 3 | yes | 5,402 ms | 568 MB |
| 20,000 | 20,000 | 2,025 | 35,754 | 344 | 34 | 3 | yes | 550 MB |
| 100,000 | 100,000 | 5,221 | 84,478 | 1,904 | 88 | 6 | yes | 5,912 ms | 421 MB |

All three runs returned `searchTruncated=true`; this traversal is not complete and is not suitable to replace production search as-is. The result counts grow as the expansion cap grows, and the 100k run still reports truncation. The event-search timing excludes the production search, and one-run RSS is noisy; neither is a load benchmark. The production result remained on the previously recorded deterministic hash for the prior replay. These results support a bounded, query-directed algorithm with dominance and explicit completeness accounting; simply raising the label cap does not establish exhaustive routing.

## Production-stage diagnostics

One debug replay of the same archive/query reported: 27 origin stops, 25 destination stops, 423 corridor stops, 814 interchange stops, 15,716 trips considered, 15,541 with eligible stops, 99,054 retained graph segments across 70 routes, and estimated graph demand of 415,997. The graph was truncated; 41 routes reported at their allocated limit and the global segment budget was almost exhausted (99,054 / 100,000). Reachability included 360 transfer states and 358 stops. Search then visited 101,827 work steps (below its 1,000,000 hard step cap), considered 1,625 candidate results, and had a maximum queued-work count of 4,400. The result was capped at 100, with both candidate sampling and segment graph truncation flagged.

This narrows the observed loss: the hard search-step limit was not reached. The retained graph and candidate-sampling stages are the current bottlenecks on this replay. This one OD does not establish the behavior for every city or request.

## Decision and remaining work

The stacked code preserves separate BALANCED and FASTEST/CHEAPEST choices on the frozen query and is deterministic, but dense-feed search remains incomplete because graph and search truncation are explicit. The test-only event traversal also remains incomplete at 100k labels. Do not describe this as complete routing or production acceptance. Continue investigating bounded graph retention and query-directed expansion; compare all three strategy winners, chain recall, runtime and memory against frozen multi-OD inputs before changing the router. No live provider, staging, production or physical-device test was part of this replay.
