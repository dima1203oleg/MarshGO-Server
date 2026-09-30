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
- Reconcile a JourneyLeg with booking and offer cancellation lifecycle, and let users select/book a Community leg without duplicating booking/fee logic.
- Add a real walking route provider contract before creating WALK legs.
- Then implement future Community transfer matching using uncertainty windows and the already-existing opt-in Navigation matching domain.
