# GTFS boarding preflight recheck — 2026-10-23

## Decision

Do not promote this search variation. It is a test-only correctness experiment, not a production router change.

## What changed in this isolated worktree

- Extracted a narrow `decideBoarding` view from the existing exact GTFS transfer authority. The existing journey-to-journey `decide` delegates to the same function, so transfer rules, pathways, distance, and buffers are not reimplemented.
- Updated the independent lazy-label test helper to check an exact boarding event before materializing downstream stop-pair legs.
- Added a focused regression assertion that a forbidden type-3 transfer is rejected before the onward boarding's legs are materialized.

The production search does not call the test helper or alter search caps/defaults.

## Evidence

- Exact existing Lviv replay evidence in `MarshGO-Server-gtfs-event-round-v2-20261023/docs/audit/GTFS_ROUND_BASED_SEARCH_V2_2026-10-23.md` reports that the analogous event preflight rejected only 2.6–2.7% of checked boarding events, reached its event budget in all three frozen ODs, retained 0/3 strategy winners for Малий Голоско → Сихів and Наукова → Сихів, and did not improve useful-chain recall. That production-scale evidence fails the promotion gate; repeating the same design on the same feed is not justified.
- In this isolated worktree, `tsx --test tests/gtfs-timetable.test.ts` passed 72/72 after the final focused assertion was added.
- The additional focused `tsx --test --test-name-pattern='graph-relative lazy search' tests/gtfs-timetable.test.ts` run passed 1/1.
- `npm run typecheck`, `npm run lint`, and `git diff --check` passed.
- The full Server suite, pinned Node 24.21, frozen-feed replay, staging and production were not run in this worktree. No production improvement is claimed.

## Next action

Keep the prototype isolated. Continue from the saved product/release checkpoint and prioritize remaining production blockers; do not change GTFS search caps or claim routing completeness based on these tests.
