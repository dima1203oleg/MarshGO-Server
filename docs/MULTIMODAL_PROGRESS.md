# MARSHGO Multimodal Progress

## Phase A — Journey domain foundation

**Status:** PARTIAL.

**DONE**
- Added additive migration `020_journeys.sql` for `journeys`, ordered `journey_legs`, and one-to-one `journey_preferences`, with PostGIS geography indexes, foreign keys to existing offers/bookings/demands/navigation candidates, enum-like state checks, money/score bounds and ETA uncertainty/freshness fields.
- Added shared journey modes, strategies, candidate types and preference types under `server/journey/types.ts`.
- Added server-only strategy weights/scoring for FASTEST, CHEAPEST, BALANCED, PREMIUM, RELIABLE and CUSTOM, plus representative-route similarity suppression.
- Added transfer feasibility that includes predicted arrival, cumulative ETA uncertainty, walking time, boarding grace and minimum transfer buffer, with a dynamic connection window and LOW/MEDIUM/HIGH/CRITICAL risk.
- Added provider option/quote/availability/booking contracts. They do not return or imply live provider inventory by themselves.
- Added authenticated `POST /api/v1/journeys/search`, owner-scoped `GET /api/v1/journeys/me`, and `GET /api/v1/journeys/:id`. Search normalizes the full timezone-aware request, queries only real current Community offers with stored road routes, filters seat/date/geographic/price/rating preferences, scores representative strategy winners, and persists one planned Journey/Leg per selected result.
- Added public `GET /api/v1/offers/:id` so a result can load the current, privacy-filtered offer detail before the existing atomic booking flow.
- Journey API marks itself partial and explicitly lists unavailable external modes. It labels the unbooked offer fare as `ESTIMATED`, returns no confirmed fare, uses a database query timestamp for inventory freshness, and leaves route ETA uncertainty/reliability/comfort null when those values are not measured.

**CHANGED FILES**
- `server/migrations/020_journeys.sql`
- `server/journey/types.ts`
- `server/journey/scoring.ts`
- `server/journey/transferEngine.ts`
- `server/providers/types.ts`
- `server/journey/search.ts`
- `server/index.ts`
- `package.json`, `scripts/run-integration-tests.sh`
- `tests/journey-scoring.test.ts`
- `tests/journey-search.test.ts`
- `tests/journey-schema.integration.test.ts`
- `tests/api-bookings.integration.test.ts`
- `tests/transfer-engine.test.ts`
- `docs/API.md`, `docs/DATA_MODEL.md`, `docs/MULTIMODAL_PROGRESS.md`
- Site main: `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `src/views/JourneyResultsPanel.tsx`, `package.json` (Journey search form/results).

**MIGRATIONS**
- `020_journeys.sql` applied successfully to a newly created loopback database after migrations 001–019.

**API CHANGES**
- `POST /api/v1/journeys/search`, `GET /api/v1/journeys/me`, `GET /api/v1/journeys/:id`, `GET /api/v1/offers/:id`. Planned results remain separate from and never create an Offer booking.

**TESTS**
- `npm run typecheck`: passed.
- `npm test`: 24 passed, 1 opt-in database test skipped without DB URLs (25 total).
- `JOURNEY_TEST_DATABASE_URL=... npm run test:integration:journey`: 1/1 passed against PostGIS 4326 tables.
- `API_TEST_DATABASE_URL=... REDIS_URL=... npm run test:integration`: Journey schema 1/1; API booking/negotiation/search 10/10 (including offer detail privacy); navigation 1/1; cross-instance realtime 1/1; restart 1/1; rate-limit 1/1 passed.
- Site `npm run typecheck`, `npm run lint`, and `npm run build`: passed with the Journey search/results interface.
- Umbrella Playwright `npm run test:e2e`: 4/4 passed, including the Community Journey Planner UI, persistence, provider disclosure and public offer-detail handoff.
- Clean local migrations 001–020 passed on an isolated loopback database.
- One transfer-engine expected-risk assertion initially expected LOW with only 12 minutes of post-requirement slack; corrected the fixture to provide 22 minutes. Final suite passed.

**LIMITATIONS / BLOCKED_EXTERNAL**
- Search currently returns direct Community legs only and no walking/multileg path. An unbooked Journey is a plan snapshot, not a reservation.
- No bus, rail, taxi, GTFS, municipal transit or commercial provider is connected. Provider contracts alone are not service availability.
- No provider cache, Journey history/active-trip UI, booking-to-leg lifecycle binding, live journey monitor, predictive matching/replanning, persistent notifications or push yet.
- Existing native iOS remains a Capacitor/WKWebView client; Journey acceptance on physical devices is not covered.

**NEXT**
- Add a real walking route provider contract before creating WALK legs.
- Then implement future Community transfer matching using uncertainty windows and the already-existing opt-in Navigation matching domain.

## Phase B continuation — Journey booking lifecycle binding

**Status:** PARTIAL.

**DONE**
- The existing booking endpoint accepts optional paired Journey/leg IDs. In the same transaction as the existing seat lock, it checks Journey ownership, selected state, single-leg scope, offer identity and passenger count, then stores the booking link, changes the leg to `CONFIRMED` / `LOCKED`, freezes the actual fare and marks the Journey `READY`.
- Idempotency replay validates the original Journey association as well as offer and seat count. A conflicting association returns 409.
- Cancelling a linked booking updates its leg to `CANCELLED`, transitions the Journey to `REPLANNING`, clears confirmed and estimated Journey totals so a stale fare is not shown as valid, and emits an owner-only `journey.updated` event. Existing booking cancellation still returns inventory at most once.
- The Site carries Journey and leg IDs from a selected result into its existing booking flow and reports the server-confirmed Journey state. Trips loads the owner-scoped Journey history and refreshes it from `journey.updated`.

**CHANGED FILES**
- `server/index.ts`
- `tests/api-bookings.integration.test.ts`
- `docs/API.md`, `docs/MULTIMODAL_PROGRESS.md`
- Site: `src/services/productionApi.ts`, `src/views/JourneyResultsPanel.tsx`, `src/views/ProductionMarketplace.tsx`

**API CHANGES**
- `POST /api/v1/bookings`: optional `journeyId` + `journeyLegId` association.
- `POST /api/v1/bookings/:id/cancel`: linked Journey transition and owner-scoped `journey.updated`.
- Realtime event: `journey.updated`.

**TESTS**
- Added to the real PostGIS/Redis booking integration suite: linked booking, frozen Journey price, replay, double cancel, Journey transitions and participant-only event recipients.
- An initial run executed the Journey assertions but teardown failed because new Journey audit rows retained the fixture actor FK; test cleanup now explicitly removes these rows before deleting fixture users. The rerun passed all suites: schema 1/1; booking/search/negotiation 10/10; navigation 1/1; Redis realtime 1/1; restart 1/1; rate limit 1/1.
- `npm run typecheck` and `npm test`: passed (24 passed, one opt-in database test skipped). The Server package has no separate `build` script; CI typechecks it and exercises it against PostgreSQL/PostGIS and Redis.
- Site `npm run typecheck`, `npm run lint`, `npm run build`: passed. Umbrella `npm run check:production`: passed (31 unit tests, one opt-in DB test skipped). Umbrella integration passed Journey schema 1/1, booking/search/negotiation 10/10, navigation 1/1, Redis realtime 1/1, restart 1/1, rate limit 1/1. Playwright E2E passed 4/4; the Journey path checks persisted history, booking, cancellation and price clearing during replanning.
- Server GitHub CI [`36713598722`](https://github.com/dima1203oleg/MarshGO-Server/actions/runs/36713598722), Site CI [`36713619301`](https://github.com/dima1203oleg/MarshGO-Site/actions/runs/36713619301), and both umbrella workflows [`36713641749`](https://github.com/dima1203oleg/MarshGO/actions/runs/36713641749) / [`36713636817`](https://github.com/dima1203oleg/MarshGO/actions/runs/36713636817): passed.
- Rebuilt, installed and launched the latest Site bundle in Capacitor/WKWebView on iPhone 15 Pro Max and iPhone 16 Pro Max simulators. The Welcome screen rendered correctly after WebKit's first-load delay (about 20 seconds on a cold launch); captures: `/tmp/marshgo-iphone15-production-latest.png`, `/tmp/marshgo-iphone16-production-latest.png`.

**LIMITATIONS / BLOCKED_EXTERNAL**
- Cancellation sets `REPLANNING` but does not yet find replacement legs.
- Journey UI represents a single direct Community leg only; no partner modes, future transfer match or route monitor is active.

**NEXT**
- Continue future Community transfer matching using the existing opt-in Navigation matching domain and explicit uncertainty/time windows. Scheduled non-Community predecessor legs remain unavailable until a real provider feed exists.

## Phase G continuation — persistent in-app notification inbox

**Status:** PARTIAL.

**DONE**
- Added additive migration `021_user_notifications.sql` with user-owned rows, event/dedupe identity, safe JSON payload, read timestamp, expiry and inbox/unread indexes.
- Realtime outbox dispatch now idempotently persists an allowlisted notification projection before WebSocket fan-out. Chat text, sender names, phone numbers, route coordinates and arbitrary event payload fields are excluded.
- Added authenticated keyset-paginated `GET /api/v1/notifications`, `POST /api/v1/notifications/:id/read` and `POST /api/v1/notifications/read-all`. Cross-account reads return 404.
- Replaced the Site's “no new notifications” placeholder with a persistent inbox sheet, unread badge, read controls and pagination. It refreshes from realtime events and after login; logout clears inbox data from UI memory.

**LIMITATIONS / BLOCKED_EXTERNAL**
- Browser push and APNs registration/delivery are not implemented. Inbox writes are coupled to realtime outbox delivery; rows are durable after delivery, while push remains a separate future worker integration.
- No Journey-started, leg-started, transfer-risk, replan or provider-delay events exist yet, so those notification categories are absent.

**NEXT**
- Implement Journey state monitoring and a real event source for ETA/transfer risk before adding predictive replan notifications. External transit provider feeds remain unavailable until integration contracts and credentials are provided.

**Verification update:** On isolated loopback database `marshgo_e2e_notifications`, migrations 001–021 applied from a clean database. Full `npm run test:integration` passed: Journey schema 1/1, API booking/search/negotiation/Journey notification integration 10/10, navigation 1/1, Redis cross-instance realtime 1/1, restart durability 1/1, and shared rate limits 1/1. Root typecheck/lint/build and unit tests passed (33 pass, 1 opt-in DB-only skip); standalone Site typecheck/lint/build passed. Playwright E2E passed 4/4; the Journey test now opens the persisted inbox, verifies booking and replanning events, and marks an item read. The initial inbox assertion expected three rows but the flow correctly generated four (booking confirm/cancel and Journey READY/REPLANNING); the expected count was corrected and the full suite then passed.

**Ordering correction after CI:** Outbox events now use `clock_timestamp()` at insertion rather than transaction-start `now()`, and inbox rows preserve the source outbox timestamp. Events created within one transaction therefore retain causal ordering (for example Journey READY before later booking cancellation and REPLANNING). GitHub CI exposed this tie that did not occur in the first local run; the notification integration is rerun against the fix.

**Verification after ordering correction:** Full isolated PostGIS/Redis `npm run test:integration` passed again on migration 021: Journey schema 1/1, booking/search/negotiation/inbox 10/10, navigation 1/1, cross-instance realtime 1/1, restart 1/1, rate limits 1/1. Root and standalone server typecheck/unit tests passed. The previous GitHub failure is fixed in code; the commit-level workflow is pending.

## Phase E continuation — multi-passenger live navigation

**Status:** PARTIAL.

**DONE**
- Added additive migration `022_multi_passenger_navigation.sql`: up to 30 ordered navigation waypoints, scheduled/visited/skipped states, and candidate pickup/dropoff insertion ordinals.
- Added a server-side stop insertion optimizer that preserves each booking's pickup-before-dropoff order, checks occupied and segment-by-segment seat capacity, checks pickup time windows and detour limits, and prices the top eight geometric insertions with the configured road router.
- Navigation matching evaluates existing stops and occupied seats rather than rejecting every demand larger than the vehicle's full-trip capacity or blocking a session after its first matched passenger.
- Proposal acceptance requires passenger confirmation, locks/rechecks the navigation session and waypoint snapshot, then transactionally rebuilds waypoints and recomputes route geometry, distance and ETA. Matching pauses for explicit driver opt-in after each insertion.
- Foreground GPS marks only the next scheduled stop visited within an accuracy-adjusted arrival radius; stop history is retained when a later passenger is added.
- Extended the navigation integration scenario to use two independent passenger accounts on one driver route, complete both proposal/confirmation/booking flows and verify the four ordered pickup/dropoff records.
- The integration runner applies all SQL migrations before tests, so a fresh isolated database is a supported test path.

**CHANGED FILES**
- `server/migrations/022_multi_passenger_navigation.sql`, `server/navigation/stopOptimizer.ts`, `server/index.ts`, `server/routing.ts`
- `tests/navigation-stop-optimizer.test.ts`, `tests/navigation.integration.test.ts`, `tests/routing.test.ts`, `tests/fixtures/osrm-stub.mjs`, `scripts/run-integration-tests.sh`
- `docs/API.md`, `docs/MULTIMODAL_PROGRESS.md`

**TESTS**
- `npm run check:production`: passed; 36 unit tests passed, one opt-in integration test skipped; ESLint and production Vite build passed.
- Fresh isolated database `marshgo_e2e_multinav`: migrations 001–022 applied; Journey schema 1/1, booking/search/negotiation 10/10, multi-passenger navigation 1/1, Redis cross-instance realtime 1/1, restart durability 1/1 and shared rate limits 1/1 passed.
- This uses a local OSRM contract fixture, not a contracted production routing provider or physical-device GPS.

**LIMITATIONS / BLOCKED_EXTERNAL**
- Production route quality depends on a contracted/self-hosted routing service; the optimizer's top-eight road rechecks still need load testing at larger stop counts.
- This does not add JourneyLeg orchestration for future bus/transit legs, cumulative ETA uncertainty, predictive transfer rescue, provider outage handling or multi-leg replanning.
- Physical iOS location accuracy, stop arrival acknowledgement and background tracking remain unverified. PWA GPS remains foreground-only.

**NEXT**
- Add dynamic Journey/leg event monitoring and future Community transfer matching using real scheduled predecessor legs plus explicit ETA uncertainty. Until a live transit schedule feed exists, do not show a future bus-to-Community match as available.
