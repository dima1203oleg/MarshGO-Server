## 2026-10-30 — Full Integration Suite & Unit Test Cleanliness (21/21 Bookings PASS, Partner Platform PASS, Restart Durability PASS, 344/344 Unit PASS, 0 TS Errors)

- **Bookings & Trip Editing Integration Suite (`npm run test:integration:bookings` — 21/21 PASS):**
  - All 14 booking transactions and 7 trip editing checks passed (100% success rate, duration 97.4s).
  - Fixed `leg.headsign` in GTFS feed parsing (`gtfsTimetable.ts`) and journey segment materialized metadata.
  - Enforced `requireAuth` on `POST /api/v1/journeys/search` (rejecting unauthenticated requests with HTTP 401).
- **Partner Platform Integration Suite (`npm run test:integration:partners` — 1/1 PASS):**
  - Tenant isolation and atomic partner application submission verified.
- **Process Restart Durability Integration Suite (`npm run test:integration:restart` — 1/1 PASS):**
  - Booking durability across API process restarts verified (2.08s).
- **Unit Test Suite (`npm run test` in `MarshGO-Server` — 344/344 PASS):**
  - 344 passed, 0 failed, 3 opt-in suites skipped (duration 33.4s).
- **TypeScript Typecheck (`tsc --noEmit`):**
  - Zero errors (code 0).
- **Production Status:** `PRODUCTION_READY=false`, `RELEASE_STATUS=NOT_RELEASED`.

## 2026-10-30 — Two-Account Carpool & Rendezvous Verification, GTFS Route Oracle (87/87 PASS)

- **Two-Account Carpool & Rendezvous Lifecycle Verification (P1 — ALL PASS):**
  - Created automated integration test suite: `tests/two-account-rendezvous.integration.test.ts`.
  - Flow executed against live local API daemon (`http://127.0.0.1:3002`) with zero mock bypasses:
    1. Driver registered via `POST /api/v1/auth/register` with role `driver` and verified scrypt password.
    2. Passenger registered via `POST /api/v1/auth/register` with role `passenger`.
    3. Vehicle registered (`POST /api/v1/vehicles`) and auto-promoted to `trust_level=1` via verified photo.
    4. Carpool offer published (`POST /api/v1/offers`) for 3 seats with route geometry.
    5. Passenger discovered offer via `GET /api/v1/offers` with coordinate bounding.
    6. Passenger booked 1 seat (`POST /api/v1/bookings`).
    7. Verified atomic seat inventory decrement (from 3 down to 2).
    8. Rendezvous session activated (`POST /api/v1/bookings/:id/rendezvous/activate`).
    9. Dual-consent location tracking strictly verified:
       - HTTP 403 Forbidden before consent.
       - `locationSharingEnabled: false` after single participant consent.
       - `locationSharingEnabled: true` immediately upon mutual participant consent.
       - Driver location transmitted into Redis; passenger receives live driver coordinates (`lon=30.3651, lat=50.4562, freshness=LIVE`).
    10. Passenger cancelled booking (`POST /api/v1/bookings/:id/cancel`): seat inventory atomically restored back to 3 seats.
  - Duration: 742ms.
- **GTFS Replay & Route Engine Oracle Verification (P2 — ALL PASS):**
  - Executed `tests/gtfs-timetable.test.ts` and `tests/route-engine-oracle.test.ts`.
  - **87/87 tests passed (0 failed, 28.1s)**.
  - Verified multi-criteria trade-offs, transfer window rules, service-date exceptions, pathway walk buffers, and stop-pair alternatives.
- **Production Status:** `PRODUCTION_READY=false`, `RELEASE_STATUS=NOT_RELEASED`.

## 2026-10-26 — revalidated dense Lviv route search

- Current dirty branch `feature/transport-layer-availability` @ `92a26a3f617f32d644a66c0af46cba096ccb0ce0`, Node 24.22.1: 239/239 unit pass, 1 opt-in skip; typecheck/lint pass.
- Three repeated exact frozen-feed O/D replays are deterministic but all partial. Endpoint selection, per-depth budget, 2,500-result candidate pool/sampling and segment-span truncation remain.
- Temporary all-access-stop experiment cleared endpoint truncation only, reduced returned route-chain counts on two requests, and left all searches partial. Rejected and temporary code removed. Details: root audit 226.
- Next: isolated deterministic shared-frontier search prototype; first validate exact one/two-transfer oracle and all three strategy winners, then paired frozen-feed recall/truncation/latency/RSS. Keep product source and limits unchanged until evidence supports a safe change.


### 2026-10-25 — fresh dense Lviv search counters

- Replayed the current enabled Lviv GTFS archive on loopback `marshgo_e2e` for 08:00 Europe/Kyiv, 30-minute departure window: 1,197 ms summary, 100 returned, 800 retained, 50 line patterns; 329/329 segments had valid geometry and stop-time order.
- Counters: 11,475 search steps, 221 first legs, 200 candidates at each 2–5 leg depth, zero direct; access-stop selection, per-depth search budget and candidate sampling all truncated. Hard global step/result caps were not hit. No comparable fares.
- Reconfirmed completeness remains open; do not increase fixed limits or mark search complete. Evidence and exact parameters: [audit 145](docs/audit/145_GTFS_MULTI_DAY_SERVICE_DATE_FIX_2026-10-25.md).

## GTFS route-chain diversity search — 2026-10-26

- Local dirty Server candidate now continues after a depth reaches its display-page candidate pool, under existing global 50k step, 128-per-first-leg, `limit * 25`, and 8-per-route-chain bounds. Actual rejected same-chain candidates keep `searchTruncated=true`.
- Focused GTFS exhaustive tests 42/42 PASS; full Server unit 234 PASS / 0 FAIL / 1 opt-in integration SKIP; typecheck and ESLint PASS on Node 24.21.0.
- Same-process frozen-feed comparison retained all three previous strategy winners for all three OD requests; unique route chains grew 31→65, 41→43, 24→46. Latency cost +19–36%; every dense query remains truncated. See root `docs/audit/206_GTFS_ROUTE_CHAIN_DIVERSITY_SEARCH_2026-10-26.md`.
- Still only a local uncommitted bounded improvement. Next action: query-directed completeness design; don't mask truncation or promote the current dirty tree.

## Worker shutdown and dense-search cap experiment — 2026-10-26

- Current checkout: branch `feature/transport-layer-availability`, HEAD `92a26a3f617f32d644a66c0af46cba096ccb0ce0`, dirty source; no immutable release tuple.
- Added GTFS worker close to graceful server shutdown and a closed-worker regression assertion. Worker tests 5/5, typecheck, focused ESLint, and guarded loopback Postgres/Redis integration 29/29 PASS after the change.
- Full Server unit suite on this current broader source before the final shutdown assertion: 240 PASS, 0 FAIL, 1 opt-in integration SKIP; typecheck and full ESLint PASS.
- Frozen Lviv diagnostic shows repeated search is partial: 42,603/35,203/50,000 explored steps; candidate pool reaches 2,500 for the first two O/Ds. Stop-selection, budget/pool, route-chain sampling, and segment-span losses remain; see root audit 232.
- Doubled search caps (100k steps, `limit * 50`) were tested then reverted: all searches still partial, and the third O/D hit 100k steps. Keep original bounds until a query-directed algorithm passes oracle/recall/latency/RSS checks.
- Production Node container smoke passed before the shutdown change; image digest `sha256:71e8e4630c0df816b58baa43f929d15b71ad35264da46d0fe7ec0c265613b83a` is therefore stale for current source and was not deployed.
- Next exact action: prototype query-directed/shared-frontier candidate search beside the current implementation; validate exact small-feed path identities and all three strategy winners before frozen-feed comparisons. No production deployment.
- 2026-10-26 revalidation: bundled Node 24.22.1 full unit 240 PASS / 0 FAIL / 1 opt-in DB integration SKIP; GTFS/oracle 62/62; typecheck/lint/diff-check PASS. Frozen Lviv 3 O/D × 3 repeat hashes and all three strategy winners are deterministic; all queries remain truncated. Evidence: root `docs/audit/272_SERVER_CURRENT_BRANCH_FULL_UNIT_AND_LVIV_REPLAY_2026-10-26.md`. Existing dirty and untracked files preserved.


### 2026-10-29 — objective-reservoir and trip-chain contract reconciled

- Current Server checkout remains the pre-existing dirty branch `feature/transport-layer-availability` at HEAD `30f9691`; I preserved its other changes. The local candidate returned up to 11 stop-pair variants for one scheduled trip chain because objective reservoirs are intentionally merged after the 2-item main-pool cap.
- A temporary final hard-cap experiment was rejected: it removed the explicit global least-walking witness required by `tests/gtfs-objective-reservoir-regression.test.ts`. The serving algorithm was restored; only the conflicting older timetable test was clarified to assert the actual response-page uniqueness/bound and truthful sampling status, rather than incorrectly requiring the internal 2-item cap to apply to objective-reservoir output.
- Verification on Node 24.21.0: full `npm test` 333 total / 330 pass / 0 fail / 3 opt-in skips; `npm run typecheck`, scoped ESLint, and `git diff --check` pass. This is local evidence for the current dirty candidate, not exact-SHA CI, feed replay, staging, or production acceptance.
- Next: inspect the candidate against the rejected sampler evidence in root audit 304 and current route-retention acceptance; do not push/merge the dirty tree. Production remains NOT_RELEASED.

### 2026-10-30 — registration takeover regression coverage added (not executed)

Current dirty Server source now rejects registration for any existing email and creates new accounts with `email_verified=false` / `is_verified=false`. Added opt-in API integration assertions in `tests/api-bookings.integration.test.ts` that seed an isolated passwordless account, assert registration returns 409 without changing its hash/verification/name, and assert new registrations remain unverified. Improved cleanup for the created registration user, sessions, roles and vehicles, plus the seeded legacy account. Targeted ESLint and `git diff --check` pass. The integration test was not run: `local-stack-status.sh` reports disk 15 GiB YELLOW and free memory 34% YELLOW, with swap 5.5 GiB used; defer integration/build work until resources recover. API health/readiness, Postgres and Redis currently PASS; real SMS remains BLOCKED. Keep production NOT_RELEASED.
