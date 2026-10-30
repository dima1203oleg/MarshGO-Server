## Current Checkpoint — 2026-10-30 (ALL SERVER INTEGRATION TESTS VERIFIED)

- `test:integration:bookings`: 21/21 PASS (100%).
- `test:integration:partners`: 1/1 PASS (100%).
- `test:integration:restart`: 1/1 PASS (100%).
- `test` (unit tests): 344/344 PASS (100%).
- `typecheck` (`tsc --noEmit`): 0 errors.
- Status: `PRODUCTION_READY=false`, `RELEASE_STATUS=NOT_RELEASED`.

## Routing next action — 2026-10-26

Build a temporary deterministic shared-frontier search prototype alongside (not over) the dirty production candidate. Run existing exhaustive one/two-transfer oracles and strategy winner checks. If exact, compare against current algorithm on the same frozen Lviv archive and O/Ds with repeated route-chain recall, winner identity, truncation reasons, latency and RSS. Do not raise limits or suppress partial status. See root audit 226.


### Fresh Lviv replay detail — 2026-10-25

The latest loopback replay identifies the active bounds: 20 selected origin/destination stops, 221 first legs, per-depth candidate pools of 200, and 11,475 explored steps. Three incomplete flags are true. Next experiment must retain the existing materialized routes as the immutable baseline and compare alternative discovery independently across frozen ODs; no cap increase or truncation suppression.

## GTFS route-chain diversity follow-up — 2026-10-26

1. Preserve the bounded discovery change and truthful incomplete-search response.
2. Implement a query-directed label/candidate search that retains exact transfer, pathway, fare, service-date and realtime semantics.
3. Prove exact small-feed path identities and all three strategy winners before frozen-feed A/B; require winner retention, route-chain recall, truncation causes, p95 and RSS on the three controlled OD cases.
4. Re-run Server integration tests after the algorithm settles, then continue cross-repository exact-SHA reconciliation. No production promotion.

## Current exact next action — 2026-10-26

Prototype a query-directed/shared-frontier GTFS candidate search in an isolated temporary module without replacing the dirty source. First pass the existing exhaustive small-feed one/two-transfer identities and preserve FASTEST/CHEAPEST/BALANCED winners; then compare frozen Lviv O/D route-chain recall, truncation reasons, repeated latency, and RSS. Reject changes that merely raise caps or hide truncation. After any accepted implementation, rerun Server unit/type/lint and guarded DB/Redis integration; then resume exact-SHA cross-repository and staging gates. Production remains NOT_RELEASED.
## Current verified checkpoint — 2026-10-26

1. Use the result evidence in the root `docs/audit/272_SERVER_CURRENT_BRANCH_FULL_UNIT_AND_LVIV_REPLAY_2026-10-26.md`; do not treat the frozen-feed router as complete.
2. Do not re-run the known failed shared-frontier, baseline-seeded, or lazy event-label prototypes. Design a distinct bounded candidate search and prove exact tiny-feed identity/fare/transfer/service-date/realtime/pathway and FASTEST/CHEAPEST/BALANCED winner parity first.
3. Preserve this dirty checkout and all existing untracked implementation/diagnostic files. Keep all truncation indicators; do not increase caps as a substitute for completeness.
4. After any accepted algorithm change, rerun targeted oracle tests, full Server unit/type/lint, then the same three-O/D frozen replay and guarded Postgres/Redis integration. Production remains NOT_RELEASED.

## Superseding routing action — root audit 279, 2026-10-26

- The stale shared-frontier prototype recommendation is superseded: prior shared-frontier/baseline-seeded/lazy event-label and topology-pruning experiments were rejected. Do not rerun them.
- Next prototype: candidate-pool scheduling isolated alongside serving code, with transfer semantics and current caps unchanged. Require exhaustive small-feed identity/fare/service-date/realtime/pathway and FASTEST/CHEAPEST/BALANCED winner parity, then repeated three-OD frozen replay on supported Node 24.21.0 with route-chain recall, truncation causes, latency, and RSS.
- Current evidence: root `docs/audit/279_CURRENT_GTFS_SEARCH_BOUND_DIAGNOSTIC_2026-10-26.md`. No completeness or production claim.


### 2026-10-29 — current dirty Server candidate verification

Full local Server unit suite passes on the current dirty checkout (Node 24.21.0: 333 total, 330 pass, 3 opt-in skips), with typecheck, scoped ESLint, and diff-check green. The response contract is bounded by requested page and preserves objective-reservoir witnesses, including least walking; the 2-item per-trip-chain cap applies only to the main candidate pool. Next compare the dirty candidate to root audit 304’s rejected sampler evidence and acceptance criteria; do not sync its broad diff to GitHub.

## 2026-10-30 auth regression test added; execution deferred

Registration currently rejects existing email addresses and creates new accounts unverified. Added isolated API-integration assertions for legacy passwordless account takeover and new-account verification flags; cleanup now removes the test registration, sessions, roles, vehicles, and seeded account. Targeted ESLint and diff check pass. Test not executed because local resources are YELLOW (15 GiB disk, 34% memory free, ~5.5 GiB swap used). Once resource headroom returns, run only the opt-in API auth integration test against a disposable loopback database, then continue route→map live verification. SMS remains unavailable; production remains NOT_RELEASED.
