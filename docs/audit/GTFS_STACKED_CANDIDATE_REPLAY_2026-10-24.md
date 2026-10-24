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
- The current branch's hosted CI and database integration are pending; prior PR #34 CI applies to its exact SHA, not this cherry-picked head.

## Decision and remaining work

The stacked code preserves separate BALANCED and FASTEST/CHEAPEST choices on the frozen query and is deterministic, but dense-feed search remains incomplete because graph and search truncation are explicit. Do not describe this as complete routing or production acceptance. Continue investigating bounded graph retention and query-directed expansion; compare all three strategy winners, chain recall, runtime and memory against frozen multi-OD inputs before changing the router. No live provider, staging, production or physical-device test was part of this replay.
