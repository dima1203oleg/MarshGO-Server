# MARSHGO Multimodal Routing 4.0 — acceptance checkpoint

**Status:** `PARTIAL` — bounded implementation and static-feed replay evidence; no release or live-realtime claim.  
**Baseline:** MarshGO-Server `c7d434d5c32e44970357cc9103fb6f8f1abca4ed` (`main`, 2026-11-10).
**Implementation commit:** `ebe8c0cb0b00fc8c478c7e33338f3cd6026e04de`, branch `codex/multimodal-routing-4-20261110`, PR [#135](https://github.com/dima1203oleg/MarshGO-Server/pull/135) (draft). The report-only update is not included in that implementation commit.
**Release:** `NOT_RELEASED`; `production_ready=false`.

## Baseline execution path

The existing production path is `POST /api/v1/journeys/search` in `server/index.ts`, through the existing cached GTFS search worker and `server/journey/gtfsTimetable.ts`. It already searches selected enabled corridor providers, composes scheduled and provider-backed candidates, applies routed walking paths, and ranks one candidate pool under `BALANCED`, `FASTEST`, and `CHEAPEST`. Unknown fares remain incomparable to known fares, and `CHEAPEST` excludes unknown prices.

The search is deliberately bounded. Stop selection, graph materialization, search steps, candidate pools, objective retention, and response pages have caps and truncation signals. Therefore results are not proof of exhaustive discovery when any corresponding truncation flag is set.

## Change in this candidate

`maxTransfers=0` previously used the ordinary endpoint reach. A nearest-stop fallback could admit one stop up to 2 km only when the normal radius found no stop at all. If stops existed at both ends but had no direct scheduled connection, the search did not widen to find a usable direct service farther away.

This candidate adds a staged direct-only reach policy:

1. Run the current endpoint radii first.
2. Only when `maxTransfers=0` and a foot router is configured, try the configured 1.5 km, 2.5 km, and 4 km endpoint tiers in order when the normal search has no direct schedule or when its candidates all fail real walking validation.
3. Keep the configured feed in the existing worker cache; this is another bounded timetable query, not a feed re-import.
4. Apply the user's total-walking limit during candidate composition as a safe straight-line lower-bound filter, then recheck the measured street path in the API.
5. Require confirmed pedestrian geometry for a direct-only result that uses reach beyond its standard radius. If foot routing is unavailable, the direct-only path cannot use the legacy long nearest-stop fallback.
6. Preserve truncation flags across attempted tiers.

The 1.5/2.5/4 km values are proposal tiers from the specification, not calibrated user-safety or Lviv optimum claims. They are bounded to direct-only searches and an explicit walking limit always wins.

## Three strategies

| Strategy | Existing behavior in source | Candidate acceptance |
|---|---|---|
| `FASTEST` | Orders the shared retained candidate pool by full door-to-door duration, with deterministic tie-breakers. | `NOT_TESTED` on this candidate. |
| `CHEAPEST` | Orders known comparable fares first; routes with unknown fare do not become zero-cost winners. | `NOT_TESTED` on this candidate. |
| `BALANCED` | Uses the shared multi-objective scorer over time, fare, transfers, walking, and risk. | `NOT_TESTED` on this candidate. |

No separate search is introduced for the three tabs. The router still reports bounded-search incompleteness rather than claiming mathematical global optimality when caps were hit.

## Lviv source and mode evidence

A frozen static schedule archive was downloaded from the publisher URL on 2026-11-10 and replayed against the implementation source now recorded in commit `ebe8c0cb0b00fc8c478c7e33338f3cd6026e04de`. Archive SHA-256: `45b8c8613b0ae40ae22f703c5e29011413a6baeabeaea6d0dc5b676a18f6bc64` (3,568,789 bytes; `Last-Modified: 2026-11-02 08:06:59 GMT`). The replay preceded the later opt-in replay-harness environment-control edit, which is not yet typechecked. This is static-schedule evidence, not live/realtime availability, fare evidence, or exact-commit acceptance of the harness.

Replay: Малий Голоско `[24.008217,49.864885]` → Сихів `[24.0175835,49.8013165]`, 2026-11-11 06:00–06:30 UTC, `maximumTransfers=2`, six-hour horizon, result limit 100, Node `24.21.0`. It returned 100 itineraries, 40 unique trip chains and 26 unique route chains. The retained `BALANCED` and `FASTEST` candidates were different; `CHEAPEST` had no candidate with a known UAH fare (this does not mean no fare exists). Search was truncated: `candidateGraphTruncated=true`, `resultLimitReached=true`, with candidate graph, candidate sampling and response-page truncation flags set. One run took 2,349.87 ms and reached 543,309,824 bytes RSS; this is a diagnostic sample, not a latency or memory target claim. The replay did not validate street geometry, exact transfer feasibility after pedestrian routing, no-transfer adaptive reach, realtime, or all three strategy optima.

The same archive's `routes.txt` contains 72 records: 55 `route_type=3` records without an explicit bus/minibus name marker, 9 named trolleybus routes, and 8 tram routes; no `route_type=1501` or explicitly named marshrutka appears in this snapshot. The road-route records cannot reliably distinguish scheduled buses from marshrutkas. This does not prove that marshrutkas do not operate in Lviv.

| Global category | Lviv acceptance on candidate SHA |
|---|---|
| Carpool | `NOT_TESTED` — no current corridor offer/inventory replay. |
| Minibus / marshrutka | `PARTIAL` — no explicit category marker in this archive; shared `route_type=3` data cannot establish a separate minibus service. Live route acceptance is `NOT_TESTED`. |
| Bus | `PARTIAL` — static road-transit schedule rows exist and the frozen OD replay found road-transit candidates; route classification is ambiguous and live service is `NOT_TESTED`. |
| Taxi | `NOT_TESTED` — no current provider quote/availability replay. |
| Tram | `PARTIAL` — 8 static schedule route rows in the pinned archive; an OD replay ran, but no route-type-specific winner or live service was verified. |
| Trolleybus | `PARTIAL` — 9 named static schedule route rows in the pinned archive; an OD replay ran, but no route-type-specific winner or live service was verified. |
| Metro | `NOT_APPLICABLE` in Lviv; retain the global category for other cities. |
| Train | `NOT_TESTED` — no schedule/availability replay. |
| Bicycle | `NOT_TESTED` — code support or static points alone do not prove rental availability. |
| Scooter | `NOT_TESTED` — no fresh corridor inventory replay. |
| Carsharing | `NOT_TESTED` — no current vehicle/provider availability replay. |
| Transfer | `NOT_TESTED` — no current operator quote/availability replay. |

## Test checkpoint

| Check | Result |
|---|---|
| `git diff --check` | `PASS` in the isolated candidate worktree. |
| Targeted adaptive-walking tests, first environment attempt | `BLOCKED` before test discovery because the isolated worktree had no `tsx`. |
| Corrected routing regression set | `PASS` on the implementation working tree before the later replay-harness environment-control edit — 77 tests, 0 failed, 0 skipped across adaptive direct-only walking, GTFS walking reach, routed-walk feasibility, strategy scoring, routing adapter and GTFS realtime suites. |
| TypeScript project check | `PASS` on the implementation working tree before the later replay-harness environment-control edit — `tsc --noEmit`. An initial run caught a truncation-object typing error; it was replaced with an explicit field-by-field merge and the rerun passed. The harness edit still needs a typecheck. |
| Scoped ESLint | `BLOCKED` — the available dependency tree lacks `eslint-plugin-unused-imports`; dependencies were not installed or changed. |
| Full Server suite | `NOT_TESTED` — this checkpoint ran only the focused routing regression set. |
| Frozen Lviv GTFS replay | `PASS` as a bounded static-feed diagnostic only; details and truncation flags above. It is not exact-commit or live acceptance. |
| Live provider checks / pedestrian geometry | `NOT_TESTED`. |
| PostGIS/Redis integration, staging, performance, backup/restore, rollback | `NOT_TESTED`. |

The focused fixture models nearby stops with no direct connection and a farther direct service. It is a correctness fixture, not live-feed evidence. Earlier failed attempts were corrected and are not counted as passes.

Resource gate around the final focused checks: `/` had 26 GiB free; `memory_pressure` reported 36–42% free at sampled checkpoints; encrypted swap use was approximately 7.4–7.6 GiB. One frozen archive replay was run serially. No full suite, browser, Docker build, live-feed import, or service restart was run.

## Remaining evidence boundary

The API-level retry after all normal-radius candidates fail real foot-route validation is implemented and bounded. Focused policy tests prove the tier controller retries after a non-feasible scheduled set and stops at the first usable tier, but endpoint worker/feed reuse and geometry wiring still lack an API-level integration test. The static feed replay exercised the timetable engine, not this API retry path. There is no live Lviv or production evidence.

## Remaining acceptance gates

1. Add an endpoint-level regression for the API retry after all standard-radius candidates fail real foot-route validation; prove feed reuse, connected geometry, and hard total-walk limits.
2. Compare no-transfer behavior against the pinned Lviv GTFS snapshot above, including nearby-but-unusable stops, missed departures, long egress, truncation, and a feasible normal-radius direct route; capture a separate replay with `maxTransfers=0` after the resource gate allows.
3. Recheck one common candidate set for all three strategy winners and their fare/walking constraints.
4. Resolve scoped ESLint from an existing approved dependency source or leave lint blocked; do not install or modify lockfiles just to turn the check green.
5. Complete exact-head CI on PR #135 and record its final status. Do not merge or deploy until all remaining acceptance gates pass.

No production deployment, database write, API restart, provider request, or live journey search was performed for this checkpoint.
