# MARSHGO Multimodal Progress

## Fresh GTFS VehiclePosition journey display

**Status:** IMPLEMENTED, subject to provider timestamp coverage.

- Journey legs now persist the GTFS `routeId`, `tripId`, and service date used by the scheduled itinerary. The mobility catalog stores a distinct VehiclePositions URL for the Lviv static provider.
- Authenticated `GET /api/v1/journeys/:id/live` checks Journey ownership and returns a map position only when the vehicle has an entity timestamp no older than 90 seconds and matches the exact provider, route, trip, and service date within the scheduled service window. It reports scheduled/unverified status instead of fabricating LIVE state.
- The Site route map polls only near scheduled transit and renders a separate public-transport GPS marker; it does not reuse the user's own navigation puck.
- Current live probe of the catalogued Lviv VehiclePositions feed returned 626 positions, of which 593 had fresh per-vehicle timestamps and 587 had both trip and route identity. The GTFS-Realtime decoder represents its uint64 timestamps as protobuf `Long`; the parser now converts that representation instead of silently discarding it. This feed omits `startDate`, so matching additionally requires the persisted trip to be inside its scheduled service window.
- Verification: Server typecheck/lint passed; 142 tests passed and one opt-in integration test skipped. Site typecheck/lint/build passed; 55 tests passed. Database-backed migration/API integration was not run in this environment.

## Phase A — Journey domain foundation

**Status:** PARTIAL.

**DONE**
- Added additive migration `020_journeys.sql` for `journeys`, ordered `journey_legs`, and one-to-one `journey_preferences`, with PostGIS geography indexes, foreign keys to existing offers/bookings/demands/navigation candidates, enum-like state checks, money/score bounds and ETA uncertainty/freshness fields.
- Added shared journey modes, strategies, candidate types and preference types under `server/journey/types.ts`.
- Added server-only strategy weights/scoring, Pareto filtering, cross-strategy result de-duplication, and bounded alternative ranks (up to 12 per available user-facing strategy).
- Added transfer feasibility that includes predicted arrival, cumulative ETA uncertainty, walking time, boarding grace and minimum transfer buffer, with a dynamic connection window and LOW/MEDIUM/HIGH/CRITICAL risk.
- Added provider option/quote/availability/booking contracts. They do not return or imply live provider inventory by themselves.
- Added authenticated `POST /api/v1/journeys/search`, owner-scoped `GET /api/v1/journeys/me`, and `GET /api/v1/journeys/:id`. Search normalizes the full timezone-aware request, queries real current Community offers and eligible open GTFS schedules, filters supported preferences, and persists the bounded, de-duplicated Pareto alternatives with per-strategy ranks.
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
- At this foundation phase, search returned direct Community legs only and no walking/multileg path. Later dated continuations below extend the planner; an unbooked Journey remains a plan snapshot, not a reservation.
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

## Phase D continuation — Journey leg lifecycle events

**Status:** PARTIAL.

**DONE**
- Linked Journey legs now follow the server booking lifecycle: the driver starting a boarded booking moves its leg and Journey to `ACTIVE` and stores the actual start timestamp.
- Completion still requires both passenger and driver confirmation. Once the booking becomes completed, its Journey leg stores actual arrival and becomes `COMPLETED`; the parent Journey moves to the next `TRANSFER` leg or `COMPLETED` when no leg remains.
- Journey lifecycle changes are persisted in the same PostgreSQL transaction as booking transitions and published through the existing outbox/WebSocket and persistent inbox projector. Payloads contain IDs/state only, never location or route details.
- Added a real API integration scenario covering search → Journey-bound booking → signed ticket/boarding → start → two-party completion, and DB assertions for Journey/leg states and actual timestamps.

**CHANGED FILES**
- `server/index.ts`, `server/notifications.ts`, `tests/api-bookings.integration.test.ts`, `tests/notifications.test.ts`, `docs/API.md`, `docs/MULTIMODAL_PROGRESS.md`

**TESTS**
- Root typecheck and unit tests passed: 37 passed, one opt-in DB integration skipped.
- Isolated PostGIS/Redis integration passed: Journey schema 1/1; booking/search/Journey lifecycle 10/10; navigation 1/1; cross-instance realtime 1/1; restart 1/1; rate limit 1/1.

**LIMITATIONS / BLOCKED_EXTERNAL**
- At this lifecycle phase, Journey search persisted only a direct Community offer leg. The later composition continuation below adds bounded GTFS + Community plans; transfer alerts and predictive multi-leg replanning are still not active.
- No physical device or background GPS test was performed for these server lifecycle transitions.

**NEXT**
- Add a monitor that evaluates real provider/vehicle ETA observations against subsequent Journey leg windows. Activate it only for legs with verified schedule and uncertainty data; provider feeds remain the gating external dependency.

## Phase E continuation — route-aware Community Rescue candidates

**Status:** PARTIAL.

**DONE**
- The passenger-scoped rescue search still returns time-compatible, capacity-checked published rides that connect near the cancelled route's endpoints.
- It now also finds road-routed Community offers whose pickup lies within 20 km of the cancelled offer's stored road geometry, advances in the correct direction along that geometry, and ends within 20 km of the original destination.
- Candidate DTOs distinguish endpoint matches from corridor matches and report the pickup's distance from the cancelled route. Offers without real stored route geometry cannot qualify through the corridor branch.
- Added a PostGIS API integration scenario for a candidate beginning well after the original origin but following the cancelled route, while retaining checks for endpoint matches, distant candidates, insufficient seats and participant authorization.

**TESTS**
- `npm run typecheck`: PASS.
- `npm run lint:all`: PASS.
- `npm test`: 46 passed, 1 opt-in DB integration test skipped.
- `npm run test:integration`: PASS — Journey schema 2/2; booking/Rescue 11/11; navigation 1/1; Redis multi-instance realtime 1/1; API restart durability 1/1; shared rate limits 1/1.

**LIMITATIONS**
- This returns suggestions only. It does not book replacements, search transit/taxi partners, or monitor an active multi-leg Journey.
- Road geometry must exist and be trustworthy; deployments without a configured routing provider must not fabricate geometry.

## 2026-10-12 — Door-to-door GTFS duration and live Lviv verification

**DONE**
- GTFS results now measure the complete elapsed time from the requested departure through arrival, including initial wait, scheduled transfers and walking access/egress. The API exposes `requestedDepartureAt` and `waitingSeconds`, including the wait before a direct Community offer departs.
- Added a regression test showing that FASTEST ranks by the earliest realistic arrival when a later service has shorter in-vehicle time.
- Verified the active Lviv GTFS URL directly and registered only that source in a new loopback-only test database. The source was healthy at verification time: 1,071 stops, 72 routes, 15,835 trips, including 62 bus, 8 tram and 2 city-train routes.

**TESTS**
- Unit: 120 passed, 1 opt-in integration test skipped. Typecheck and lint passed.
- Full `npm run test:integration` against an empty provider registry: PASS — Journey schema 2/2; booking/search 19/19; navigation 2/2; Redis multi-instance realtime 1/1; process-restart durability 1/1; shared rate limit 1/1. The API reported unavailable bus/tram providers and returned zero transit alternatives rather than inventing schedules.
- The same full integration suite against the healthy Lviv GTFS registry: PASS with the same case counts. The live Lviv API test returned 3 bus itineraries, 3 tram itineraries and 3 bus/tram mixed alternatives for its fixed corridor. All 12 categories were checked; only modes backed by this Lviv schedule and the test Community ride returned trips.

**LIMITATIONS**
- The integration assertion now follows provider health: it requires real Lviv routes when the healthy provider is configured and otherwise requires zero trips plus an explicit blocked-provider reason. GitHub CI does not depend on an external timetable feed.
- This verifies one live city feed, not nationwide coverage or real-time location. Separate active marshrutka, taxi, transfer, carsharing and micromobility supplies are not established by this run.
- Street-routed pedestrian access, verified public-transport fares/seats, rescue/rebooking during transit disruption, and measured load p95 are still outstanding. Do not treat the full 12-mode production acceptance criteria as complete.

## 2026-10-12 — Published Community ride composed with GTFS transit

**Status:** PARTIAL; bounded candidate implementation, not regional or production acceptance.

**DONE**
- Journey search now considers up to six published, road-routed Community offers found along the requested origin/destination corridor. A candidate can combine a GTFS transit prefix, the offer's exact driver-approved pickup-to-dropoff ride, and a GTFS transit suffix.
- Prefix/suffix paths are searched against connected timezone-compatible GTFS feeds. Their walking access/egress and station transfers must be supported by the configured walking router or an explicit GTFS pathway; missing pedestrian evidence rejects the combination. The published Community pickup/dropoff is never shifted or invented.
- Each returned candidate is checked for passenger capacity, the conservative 10-minute Community connection buffer, configured transfer/walking/duration limits, current published-offer state at search time, and fare completeness. Unknown or non-UAH components remain unknown; they are not zeroed, and an unknown fare prevents the global `CHEAPEST` label.
- Transit fare products are scaled to the requested passenger count before ranking, max-price filtering, persistence, and per-leg display. The ride leg retains its offer ID, route geometry, price-per-seat and inventory snapshot so the existing details/booking flow can open that exact leg.
- Composite Journey plans persist ordered WALK, GTFS and COMMUNITY legs, including source stops, timetable/prediction timestamps, route geometry, fare allocations and provider freshness. Booking the selected private-ride leg is allowed; the parent remains `PARTIALLY_RESERVED` because the public-transport legs are not booked through this server. The Site now explains that distinction in its Journey update message.
- Direct Community results are kept truthful: an offer more than five metres from either requested endpoint is not presented as a direct door-to-door ride. Such an offer can appear only inside a validated scheduled combination.

**CHANGED FILES**
- `server/index.ts`, `server/journey/communityComposition.ts`, `server/journey/gtfsFares.ts`
- `tests/community-composition.test.ts`, `tests/gtfs-fares.test.ts`
- Site: `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`

**TESTS**
- Server: TypeScript and ESLint pass; full unit suite 154 passed, 0 failed, 1 opt-in database test skipped. Added tests cover valid prefix/ride/suffix composition, missed pickup buffer, insufficient seats, exact endpoints, unknown fares and passenger-count fare scaling.
- Site: typecheck, ESLint, production build and all 59 tests pass.
- The API/PostGIS booking integration suite was not run for this delta because no dedicated test database is configured. Database persistence and composite booking still need a fresh isolated integration run before release.

**LIMITATIONS / BLOCKED_EXTERNAL**
- Composition is bounded (six Community offers, at most two transit paths per side, 24 total combinations) and depends on a healthy GTFS feed plus a configured walking router or explicit GTFS transfer paths. Search reports truncation/partial coverage when these bounds or dependencies apply.
- Only the driver's published route endpoints are eligible. Intermediate pickup/dropoff requires an explicit driver-approved stop and is intentionally unsupported.
- The server does not issue or sell the transit tickets in a composite Journey. The saved plan and Community reservation are separate from any third-party transit purchase.
- Taxi, commercial bus/rail purchasing, taxi/car-share/bike/scooter/transfer inventory, transit disruption Rescue, nationwide coverage, provider credentials, production load p95 and real-provider end-to-end acceptance remain open. Production stays NOT RELEASED.

## 2026-10-12 — Enforce canonical transit modes at Journey search

**Status:** COMPLETE for the route-search mode boundary; it does not add new provider coverage.

**DONE**
- Journey search now has an explicit allowlist for GTFS-backed canonical modes: bus, marshrutka, rail, tram, trolleybus and metro.
- GTFS ferry/funicular records can still be parsed for feed diagnostics, but neither default search nor a crafted mode preference can route them. The API also does not report those feed-only types as routable providers.
- This preserves train subtypes (intercity, suburban and city train) under the canonical train category and does not change the approved twelve-category client catalogue.

**TESTS**
- Added a regression test asserting ferry and funicular are excluded under default and explicit selections while an approved tram selection remains routable.
- Server TypeScript and ESLint pass; unit suite passes 155 tests with 0 failures and 1 opt-in database test skipped.

**LIMITATIONS**
- This is a guard against an unapproved transport category; it does not add a real metro feed, provider coverage or fare source.

## 2026-10-12 — Preserve actual in-seat transfer counts in composed journeys

**Status:** COMPLETE for candidate scoring and transfer-limit accounting.

**DONE**
- Community + GTFS composition now uses each transit itinerary's validated physical-transfer count, then adds the actual mode changes between transit and the private ride.
- In-seat GTFS continuation connections no longer count as passenger transfers merely because they are represented by multiple trip records.
- Rejects malformed transit summaries whose transfer count exceeds their number of ride-to-ride boundaries.

**TESTS**
- Regression covers an in-seat two-trip transit path, one real transfer in that path, and an impossible transfer count.
- Server TypeScript, ESLint and unit suite pass; one opt-in DB integration test is skipped when no isolated DB is configured.

**LIMITATIONS**
- This fixes transfer accounting; it does not resolve incomplete provider coverage or replace an end-to-end DB integration for composite Journey persistence/booking.
