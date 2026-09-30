# MARSHGO Production Progress

## Phase 0 — Local audit and baseline

**Status:** Complete for the inspected baseline; the requested root task file was absent in this checkout, so the full technical specification pasted in the user message is the active source of requirements.

**Completed:** Verified initial `main` at `1e7d0ee` with a clean starting tree. Created branch `codex/marshgo-production` and committed the initial API/UI foundation as `34c8899`. Inspected the PWA and found its core state was browser-local demo storage. Fixed the Vite/esbuild dependency mismatch, made page views lazy-loaded, revised the home/results interface toward the supplied mobile references, and added client-side safeguards for demo workflows. Production Vite builds now fail closed with a launch-status screen instead of showing seeded offers and profiles as live data.

**Modified files:** `package.json`, `bun.lock`, `src/App.tsx`, `src/components/AppHeader.tsx`, `src/services/storage.ts`, `src/views/HomeView.tsx`, `src/views/SearchView.tsx`, `vite.config.ts`, `tests/storage.test.ts`, `.env.example`, `docs/PRODUCTION_AUDIT.md`.

**Database changes:** None in this phase.

**API endpoints:** None in this phase.

**Tests:** Bun frozen-lockfile install, typecheck, build, and the four browser-storage unit tests pass.

**Remaining issues:** Frontend workflows still use demo storage. The launch-status screen remains until the authenticated API client is integrated.

**External blockers:** None for this phase.

**Next implementation step:** Build the persistent API foundation for the two-phone booking path.

## Phase 2 — Auth, profiles, roles, and garage

**Status:** Partial; phone enrollment, database sessions, profile updates, role grants, and owner-bound vehicle CRUD/active selection are implemented and tested. Real photo storage and verification review remain incomplete.

**Completed:** Added migration `003_identity_auth.sql` for normalized user roles, account status, session refresh-token families, driver profiles, verification records, vehicle-photo metadata, and deletion requests. Added OTP request/verify endpoints with hashed challenges, five-minute expiry, 60-second resend cooldown, per-phone/IP hourly limits, failed-attempt limit, opaque access tokens, HttpOnly refresh cookie, refresh rotation/reuse revocation, logout, logout-all, profile read/update, role enabling, data export, and deletion request. Added a development-only no-network OTP adapter and a Twilio provider adapter that remains disabled until configured. Corrected auth error payloads, removed the duplicate profile route, preserved omitted profile fields, and made deletion requests non-destructive pending review. Role authorization now uses normalized `user_roles`. Added migration `004_vehicle_garage.sql` and owner-bound vehicle editing, atomic active-vehicle switching, and archive protection for future published trips. New vehicles default to the first active vehicle for that owner. Added AWS SDK S3-compatible signed photo upload/download/delete, 10 MiB and image-type policy, file-signature validation, and primary photo selection; operations return a controlled 503 while bucket configuration is absent.

**Modified files:** `server/index.ts`, `server/sms.ts`, `server/objectStorage.ts`, `server/migrations/003_identity_auth.sql`, `server/migrations/004_vehicle_garage.sql`, `server/migrations/006_vehicle_photo_primary.sql`, `tests/api-bookings.integration.test.ts`, `tests/object-storage.test.ts`, `.env.example`, `package.json`, `bun.lock`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/SECURITY.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `003_identity_auth.sql`, `004_vehicle_garage.sql`, and `006_vehicle_photo_primary.sql` applied successfully to the local PostGIS database.

**API endpoints:** `POST /api/v1/auth/otp/request`, `POST /api/v1/auth/otp/verify`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `POST /api/v1/auth/logout-all`, `GET|PATCH /api/v1/users/me`, `POST /api/v1/users/me/roles`, `GET /api/v1/users/me/export`, `POST /api/v1/users/me/deletion-requests`, `GET|POST /api/v1/vehicles`, `PATCH /api/v1/vehicles/:id`, `POST /api/v1/vehicles/:id/activate`, `DELETE /api/v1/vehicles/:id`, and vehicle photo upload/list/primary/delete endpoints.

**Tests:** Node 24.21.0: `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` passed. Local integration command `API_TEST_URL=http://127.0.0.1:3002 API_TEST_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo npx --yes --package=node@24.21.0 -- node node_modules/tsx/dist/cli.mjs --test tests/*.test.ts` passed all 11 tests, including OTP registration, profile persistence, refresh rotation, self-enabling driver role, vehicle creation, fail-closed missing S3, ownership/edit/active selection, last-seat contention, cancellation, negotiation, chat, OSRM contract, and signed upload-policy contract. The run caught and fixed malformed SQL in role grant before the 11/11 pass.

**Remaining issues:** Vehicle API supports listing and creation only. No vehicle edit/delete, object storage upload, photo processing, verification submission/reviewer workflow, or frontend auth/profile integration. The real SMS provider is not configured. One combined check run initially raced `tsc` against `vite build` clearing `dist`; sequential typecheck passes. No production deployment.

**External blockers:** Twilio account credentials and approved sender identity for real SMS; private S3-compatible bucket, credentials/role, and browser CORS configuration; trusted staff account provisioning and verification policy. Signed policy and media-validation adapter are unit-tested using local fake credentials; no real bucket was contacted.

**Next implementation step:** Finish vehicle ownership-bound CRUD and photo-storage provider contract, then connect the frontend session/profile/vehicle flows.

## Phase 5 — Production UI integration (first marketplace vertical slice)

**Status:** Partial; production bundle uses real OTP/session, offer search, booking, and booking history APIs. The existing full demo UI remains development-only.

**Completed:** Added a typed browser API client with HttpOnly refresh-cookie credentials and one retry after access-token expiry. Added mobile-first production sign-in, verified phone flow, server-backed exact-city/date/seat search, booking with a fresh Idempotency-Key, and persisted booking list. `App` now chooses the API-backed marketplace for production builds and keeps the local demo UI out of production execution. Added Vite local API proxy routes. Search API now filters by Europe/Kyiv calendar date and requested seats.

**Modified files:** `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `src/App.tsx`, `server/index.ts`, `vite.config.ts`, `tsconfig.json`, `package.json`, `tests/api-bookings.integration.test.ts`, `docs/API.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None in this slice.

**API endpoints:** Uses `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/refresh`, `POST /auth/logout`, `GET /offers?origin=&destination=&date=&seats=`, `GET /bookings`, and `POST /bookings`.

**Tests:** `npm run typecheck`, scoped `npm run lint`, `npm run build`, and local PostGIS integration suite passed. The API integration suite includes date/seat search filters and booking transaction tests. No browser automation or physical-device run was performed.

**Remaining issues:** Production PWA still lacks authenticated driver offer creation/vehicle management, reverse-demand UI, trip lifecycle, chat, GPS navigation, and passive matching. Existing demo UI remains only in the development build. Search is exact city-name matching. The 15-minute access token renewal path is implemented but not tested through a browser session.

**External blockers:** Production SMS credentials/sender, staging API host and HTTPS same-site deployment, S3 photo storage credentials, routing provider service.

**Next implementation step:** Add a real driver publishing/garage flow to the production UI, then integrate demand negotiation and booking chat against existing APIs.

## Phase 6 — Routing foundation

**Status:** Partial; OSRM-compatible road-route adapter and server persistence contract are implemented. A real routing service is not configured.

**Completed:** Added `server/routing.ts` with bounded-timeout OSRM-compatible route fetch, geometry/range validation, and explicit provider failures. Added `POST /api/v1/routing/route`. Added migration `005_offer_routes.sql` for arrival time, road distance, duration, and source. Production offer creation now requires a successful configured road route and stores geometry/ETA; it returns 503 when routing is unavailable. Development-only unrouted fixtures are labeled `development_unrouted`. Production search presents the server route-derived ETA only when available.

**Modified files:** `server/routing.ts`, `server/index.ts`, `server/migrations/005_offer_routes.sql`, `.env.example`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/routing.test.ts`, `tests/api-bookings.integration.test.ts`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/SECURITY.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `005_offer_routes.sql` applied to the local PostGIS database.

**API endpoints:** `POST /api/v1/routing/route`, updated `POST /api/v1/offers`, and `GET /api/v1/offers` now returns saved route metadata.

**Tests:** Node 24.21.0 LTS: typecheck, scoped lint, production build, unit suite, and opt-in local PostGIS integration suite passed. The combined routing+API suite passed 10/10 tests, including a local HTTP OSRM contract fixture and the honest 503 behavior when no routing provider is configured. No public routing provider was called.

**Remaining issues:** `ROUTING_ENGINE_URL` is unset; production offer creation is correctly blocked until an owned routing service/provider is configured. No geocoder/address suggestion, multi-stop routing, rerouting, or real GPS stream exists. Tests validate the provider contract, not a live road network.

**External blockers:** Provisioned OSRM/Valhalla hosting or contracted routing API and service limits.

**Next implementation step:** Implement route/date/seat aware offer creation and search in the production driver UI, then connect reverse demands to route corridors and mutual matching.

## Phase 1 — Backend, PostgreSQL/PostGIS foundation

**Status:** Partial; local API/database infrastructure and persistent domain slices exist. OpenAPI, production orchestration, and shared Redis-backed services remain missing.

**Completed:** Added Docker Compose for local PostgreSQL/PostGIS and Redis with named persistent volumes; applied initial schema migration locally. Added Express API health/readiness, database-backed offer lookup, profile/vehicle reads, driver-only vehicle creation, verified-vehicle-only offer publication, server session-hash checking, explicit development-only identity bypass, request-size cap, allowlisted CORS, security headers, per-process API rate limit, and centralized errors. Added transactionally locked bookings with server-priced totals, idempotency keys, conversation creation, audit event, ownership-checked cancellation, and once-only seat restoration. Production UI now blocks demo inventory. Added ESLint for touched/backend files and a GitHub Actions workflow for lint, typecheck, tests, and build.

**Modified files:** `package.json`, `bun.lock`, `.env.example`, `docker-compose.yml`, `.github/workflows/ci.yml`, `eslint.config.js`, `server/index.ts`, `server/migrate.ts`, `server/migrations/001_initial.sql`, `server/migrations/002_reverse_marketplace.sql`, `src/App.tsx`, `src/components/AppHeader.tsx`, `src/services/storage.ts`, `src/views/SearchView.tsx`, `tests/api-bookings.integration.test.ts`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DEPLOYMENT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_AUDIT.md`.

**Database changes:** Added `001_initial.sql`: users, vehicles, offers with PostGIS points and route geometry, bookings, passenger demands, proposals, conversations/members, messages, OTP challenges, sessions, audit events, indexes and constraints. Added `002_reverse_marketplace.sql` with proposal vehicle/time/revision columns, revision history and one-accepted-proposal-per-demand guard. Both migrations were applied to the local Docker database.

**API endpoints:** `GET /healthz`, `GET /readyz`, `GET /api/v1/offers`, `GET /api/v1/users/me`, `GET|POST /api/v1/vehicles`, `POST /api/v1/offers`, `POST|GET /api/v1/demands`, `POST /api/v1/demands/:id/proposals`, `POST /api/v1/proposals/:id/counter`, `POST /api/v1/proposals/:id/accept`, `GET /api/v1/proposals/:id/revisions`, `GET /api/v1/bookings`, `POST /api/v1/bookings`, `POST /api/v1/bookings/:id/cancel`, `GET /api/v1/bookings/:id/conversation`, `GET|POST /api/v1/conversations/:id/messages`.

**Tests:** Lint/typecheck/build pass. Automated local PostGIS API integration tests verify OTP/session, anonymous denial, two simultaneous users competing for the last seat (one 201, one 409), same-key replay, repeated cancellation and seat restoration, vehicle ownership/role/verification, date/seat search, demand negotiation/revision history, accepted-proposal booking conversion, participant message send/history, and third-party privacy denial. All 8 tests pass. `docker compose config` and migrations pass. No API-driven two-device UI test yet. Repository-wide lint found legacy UI warnings/errors; current lint scope is new/backend and touched files only.

**Remaining issues:** Most legacy PWA screens are not API-wired. Vehicle verification review, demand cancellation, realtime message delivery, geographic corridor search, shared Redis rate limiting, generated OpenAPI, production orchestration, backup/restore, and production-grade observability are not implemented. Booking lifecycle exists as an API but is not integrated into the production UI. Redis is currently provisioned but unused. Current offer search uses exact city names.

**External blockers:** SMS provider/account and sender identity; staging/production host and database; secrets manager; routing/geocoding source decision. No public deploy or production database action performed.

**Next implementation step:** Complete user/session enrollment after the SMS provider is selected, then connect the frontend account/profile and vehicle screens to these endpoints.

## Booking transaction backend (spec Phase 3)

**Status:** Backend transaction slice implemented; cross-device application flow remains blocked on authentication and frontend integration.

**Completed:** Database-backed offer lookup, offer publishing for an owned verified vehicle, seat-locked booking, replay-safe idempotency, fixed server pricing, cancellation and single seat restoration. Tested with two independent local user identities racing for the last seat.

**Remaining issues:** Search is exact city text only; frontend still uses browser-local offers and booking state; lifecycle actions and QR presentation are not integrated in the production UI. This is not the user acceptance test on two physical phones.

**Next implementation step:** Create secure user enrollment/session issuance, wire the PWA to session-protected offer/booking endpoints, and run the cross-device scenario in staging.

## Reverse marketplace backend (spec Phase 4)

**Status:** Backend API flow implemented and locally transaction-tested; frontend and messaging integration remain incomplete.

**Completed:** Passenger demand submission, driver proposal using a verified vehicle, alternating counter-offers with server-stored revision history, expiry checks, passenger-only acceptance, atomic booking creation, seat consumption, competing proposal rejection, and conversation participant creation.

**Remaining issues:** PWA screens still use local data. Persisted message routes exist, but there is no realtime transport or live notification. No geographic relevance ranking, driver matching, or route deviation calculation.

**Next implementation step:** Wire demand and driver negotiation views to API and test the flow through the authenticated PWA.

## Chat persistence backend (spec Phase 7)

**Status:** Persistent chat API slice implemented; realtime and push remain incomplete.

**Completed:** Conversations are created with booking acceptance. Booking participants can resolve their conversation, send bounded messages, and read persisted history. Both routes verify membership; a third-party access test returns 404.

**Remaining issues:** The PWA chat still uses local demo state. No WebSocket, push provider, unread counts, notification subscriptions, or rescue alternatives.

**Next implementation step:** Connect the PWA Messages view to these endpoints, then add realtime delivery using shared Redis-backed coordination.

## Phase 3 continuation — booking lifecycle and reviews

**Status:** Partial; transactional API lifecycle is implemented and locally integration-tested. The passenger/driver UI and physical-device acceptance run remain outstanding.

**Completed:** Added booking transition history and participant completion confirmations. The driver can validate a short-lived, PII-free HMAC ticket at boarding, start a boarded trip, and each participant can confirm completion; the booking becomes completed only after both confirmations. Participants can each submit one rating (1–5) after completion. Offer search now derives driver rating and review count from persisted reviews. Added validation for invalid ticket, wrong actor, early review, duplicate review, lifecycle ordering, and rating aggregate.

**Modified files:** `server/index.ts`, `server/migrations/007_booking_lifecycle_reviews.sql`, `tests/api-bookings.integration.test.ts`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/SECURITY.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `007_booking_lifecycle_reviews.sql` adds booking lifecycle statuses, immutable transition records, one completion confirmation per participant, and one review per booking participant. Applied to the local PostGIS database.

**API endpoints:** `GET /api/v1/bookings/:id/events`, `GET /api/v1/bookings/:id/ticket`, `POST /api/v1/bookings/:id/boarding`, `POST /api/v1/bookings/:id/start`, `POST /api/v1/bookings/:id/complete`, and `POST /api/v1/bookings/:id/reviews`; offer search returns DB-derived rating aggregates.

**Tests:** Local PostGIS integration suite `API_TEST_URL=... API_TEST_DATABASE_URL=... npx --yes --package=node@24.21.0 -- node node_modules/tsx/dist/cli.mjs --test tests/*.test.ts` passed 11/11, including ticket signature rejection, unauthorized boarding/start, two-party completion, one-time reviews, and event history. `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed under Node 24.21.0. No real QR scanner, browser flow, or physical-device test was run.

**Remaining issues:** The API issues a signed ticket token but no UI renders/scans it. Driver/passenger trip-state controls and reviews are not wired into production UI. The route transition schema does not yet include a no-show policy or operational notifications. This slice does not establish production readiness.

**External blockers:** None for this local API slice. Deployment, real SMS, routing provider, photo bucket, and staging credentials remain external blockers for the full release.

**Next implementation step:** Replace the production UI’s browser-only state with authenticated server flows for driver garage/offer publishing and passenger demand negotiation, then surface booking lifecycle and persisted chat.

## Native iOS target and simulator smoke check

**Status:** Partial; a Capacitor iOS app builds, installs, launches, and displays the production welcome screen in the iPhone 18 Pro / iOS 27 CoreSimulator. Interactive sign-in/booking is not verified.

**Completed:** Added Capacitor 8.5.2 core/CLI/iOS dependencies and an Xcode project for bundle ID `ua.marshgo.app`, native MARSHGO app icon, portrait orientation, and iOS 15 minimum target. Capacitor build uses relative bundled assets and points at a local API for simulator builds only. Added a safe startup/loading fallback and an iOS simulator build/install/launch/screenshot script. CORS preflight accepts `capacitor://localhost` with credentials.

**Modified files:** `package.json`, `bun.lock`, `capacitor.config.ts`, `vite.config.ts`, `index.html`, `src/main.tsx`, `ios/App/App.xcodeproj/project.pbxproj`, `ios/App/App/Info.plist`, `ios/App/App/Assets.xcassets/AppIcon.appiconset/*`, `scripts/build-ios-simulator.sh`, `docs/IOS.md`, `README.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Tests:** Frozen Bun lockfile install, `npm run typecheck`, and `npm run lint` passed. Local PostGIS integration/unit suite passed 11/11 after starting the isolated API with development-only test identity bypass. `npm run ios:simulator` completed the Vite production build, Xcode simulator build, install, and launch on iPhone 18 Pro (iOS 27); the screenshot showed the production welcome screen. From inside the booted simulator, `curl http://localhost:3002/healthz` returned 200; an OPTIONS preflight for `Origin: capacitor://localhost` returned 204 with credentialed CORS headers. The regular production PWA build and `git diff --check` passed. No real SMS was sent.

**Remaining issues:** The graphical `Simulator.app` is absent in this environment, so we could not tap/enter text or run a UI automation flow. The native client uses the current browser auth transport; refresh-cookie persistence needs physical-device validation. Driver offer publishing, verified vehicle photos, demand negotiation, navigation, passive matching, push, booking lifecycle controls, and payments are not wired in the production UI. Booking chat and basic vehicle CRUD have since been connected in the reference-design slice below. iOS signing, archive, privacy declarations, and App Store submission are not done.

**External blockers:** Graphical simulator/interactive device test runner for tap-level UI acceptance, physical iPhone for device permissions/session checks, production HTTPS API origin, real SMS credentials, routing service, and private photo bucket.

**Next implementation step:** Automate the iOS OTP→server-search→booking journey on a full simulator UI runner, then continue production UI integration for driver vehicle/offer publishing and reverse demand.

## iOS reference design pass — mobile marketplace shell

**Phase:** 5 continuation / iOS presentation and partial API integration.

**Status:** PARTIAL. The sign-in screen and authenticated shell were redesigned toward the supplied iPhone references. This is not a complete implementation of the reference screens or a production release.

**Completed:** Added mobile-first home and exact-route results screens, Community offer details with server booking, booking history, booking-participant chat using persisted REST messages, profile/vehicle list, driver-role enablement, vehicle creation and active-vehicle selection. Added a five-item bottom navigation plus create action. Booking DTO now indicates whether the caller is the driver, so passenger/driver labels and chat counterpart resolve from server identity rather than display-name guesses. Nonconnected bus/taxi categories and unfinished demand/navigation/offer-publishing flows are explicitly shown as unavailable.

**Modified files:** `src/views/ProductionMarketplace.tsx`, `src/services/productionApi.ts`, `server/index.ts`, `docs/IOS.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**API endpoints used:** Existing `/api/v1/auth/otp/*`, `/users/me`, `/users/me/roles`, `/vehicles`, `/offers`, `/bookings`, `/bookings/:id/conversation`, and `/conversations/:id/messages`. `GET /bookings` now includes `current_user_is_driver` for participant-specific UI.

**Tests:** `npm run typecheck`, `npm run lint`, `npm test` (11/11 with local PostGIS/API and development-only identity bypass; bypass disabled immediately after test), `npm run build`, and `git diff --check` passed. `npm run ios:simulator` built, installed, and launched `ua.marshgo.app` on iPhone 18 Pro / iOS 27; screenshot: `/tmp/marshgo-ios-design-simulator.png`. Simulator exercised app startup and welcome-screen rendering only; no interactive OTP/booking test was possible because this host lacks graphical `Simulator.app`/tap automation.

**DEMO/TRUTH status:** offer search, booking, bookings list, account, vehicle records, and booking chat use the API. Search is exact city-name matching. No seeded data or fake route/results were added. Test OTP is development-only. Bus/taxi, passenger demand, offer publishing, photo upload in this screen, GPS navigation, passive matching, WebSocket/push, and notifications are not live in this UI.

**Open issues:** No geocoder/place picker; no demand form, driver offer publisher, vehicle photos, booking lifecycle actions, proposal negotiation, or navigation screens connected to production API. No physical-device session test or tap-level simulator flow. UI is a visual direction match, not pixel-identical to the supplied composite image.

**External dependencies:** SMS provider credentials and sender; production HTTPS API; geocoder/routing deployment; private photo storage; interactive simulator runner or physical iPhone.

**Next implementation step:** Add place suggestion/geocoding and route selection, then build driver offer creation and passenger demand negotiation screens on the existing server contracts; add tap-driven simulator E2E on an interactive runner.

## Phase 4 / 5 — Demand negotiation UI and geocoded place input

**Phase:** 4 Reverse Market; 5 Production UI replacement continuation.

**Status:** PARTIAL. Passenger demand and negotiation are now represented in the production UI and persist through the API. Actual address suggestions need a configured provider, and verified driver vehicles need a real review flow before drivers can propose.

**Completed:** Added a Nominatim-compatible geocoder adapter and authenticated `/places/suggest` API with query validation, Ukraine restriction, HTTPS enforcement in production, five-second timeout, independent rate limit, and fail-closed behavior. Passenger form requires selecting actual provider results before publishing coordinates; it persists departure interval, passenger count, total/per-seat budget, requirements and notes. Added passenger demand list/proposal inbox/cancel, driver open-request list, driver proposal form, persisted counter revisions/history, explicit driver agreement after passenger counter, and separate passenger confirmation that creates the booking. Demand list is deliberately labeled as unranked; no route matching is claimed. Added migration `008_demand_details.sql`.

**Modified files:** `server/geocoding.ts`, `server/index.ts`, `server/migrations/008_demand_details.sql`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/geocoding.test.ts`, `tests/api-bookings.integration.test.ts`, `.env.example`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `008_demand_details.sql` adds constrained `budget_type`, `notes`, and object-valued JSONB `requirements` columns to `passenger_demands`; migration was applied to the local PostGIS database.

**Endpoints:** `GET /api/v1/places/suggest`; extended `POST /api/v1/demands`; added `GET /api/v1/demands/mine`, `POST /api/v1/demands/:id/cancel`, `GET /api/v1/demands/:id/proposals`, and `POST /api/v1/proposals/:id/agree`; proposal acceptance now rejects a passenger's unconfirmed counter-offer.

**Tests:** `npm run typecheck`, `npm run lint`, and `npm run build` passed. Unit suite passed 10/10. Local API/PostGIS integration suite passed 14/14 with development OTP and test identity bypass enabled only for that run; it covers budget/requirements persistence, driver request visibility, cancellation replay, proposal revision history, driver agreement, premature passenger confirmation rejection, and final booking creation. Place adapter tests cover coordinate validation, UA-scoped query contract, and unconfigured fail-closed response. Migration 008 applied. `npm run ios:simulator` rebuilt, installed, and launched the updated production bundle on iPhone 18 Pro / iOS 27; simulator health check returned `{"status":"ok"}`. Screenshot is `/tmp/marshgo-demand-ui-ios.png`. Interactive controls remain untested because only headless `simctl` is available.

**DEMO/TRUTH status:** Request, proposal, negotiation, cancellation, and booking state are server-backed. Place entry refuses to publish without a provider-selected coordinate. Geocoder has no production endpoint configured; UI therefore cannot complete address selection in current workspace. Driver proposals require a verified vehicle; user-facing verification review is not implemented. Open driver requests are not route-filtered. No GPS matching, WebSocket, or partner service is represented as live.

**Open issues:** No configured geocoder, no vehicle approval/admin UI, no route-aware demand sorting, incomplete privacy refinement for exact demand locations after agreement, and no interactive UI test. App-level request/accept UI awaits a working verified vehicle in a development environment or manual moderation path.

**External blockers:** Owner-selected contracted/self-hosted Nominatim-compatible endpoint; routing provider for road-distance matching; operational driver verification reviewer and policy; tap-driven simulator runner/physical device.

**Next implementation step:** Add a protected vehicle verification decision workflow for authorized admins and connect real route-based driver-demand eligibility; then implement driver offer publishing UI against the existing route/offer contracts.

## iOS reference alignment — welcome and navigation

**Phase:** 5 continuation / native iOS visual integration.

**Status:** PARTIAL. The native iPhone welcome surface now follows the supplied scenic welcome direction; internal screens retain the same light card-and-blue-action system. This is a visual pass, not pixel-by-pixel completion of every supplied screen.

**Completed:** Added a locally bundled, compressed Carpathian road hero image; centered MARSHGO map-pin branding; title and authentication actions; native edge-to-edge status bar with light icons on authentication screens and dark icons after sign-in; and a five-control bottom bar (Home, Search, Create, Trips, Profile). Chat remains reachable from the booking action so the primary navigation matches the reference.

**Modified files:** `public/images/welcome-road.jpg`, `src/views/ProductionMarketplace.tsx`, `src/index.css`, `capacitor.config.ts`, `package.json`, `bun.lock`, `ios/App/CapApp-SPM/Package.swift`, `docs/IOS.md`, `docs/PRODUCTION_PROGRESS.md`.

**Tests:** `npx tsc --noEmit`, `npx eslint src/views/ProductionMarketplace.tsx capacitor.config.ts`, `npm run build`, `npx cap sync ios`, and `npm run ios:simulator` passed. iPhone 18 Pro / iOS 27 screenshot `/tmp/marshgo-ios-welcome-final.png` confirms photo bleed under the status bar, white status glyphs and working welcome actions rendered without overflow. This headless host still cannot tap through authentication or verify signed-in screens.

**Remaining issues:** SMS delivery is not configured; internal screen interactions still require a tap-capable simulator or physical iPhone. The larger 10-screen reference collection has not all been individually matched or verified.

**External blockers:** Tap-driven simulator/physical device and real SMS provider credentials for end-to-end sign-in.

**Next implementation step:** Run the complete authenticated iOS flow in an interactive simulator, then align and verify the signed-in home/search/detail/trips/profile views against the supplied device references.

## Phase 2 continuation — protected driver verification

**Phase:** 2 Auth/Garage; production UI and security continuation.

**Status:** PARTIAL. Driver documents can be uploaded and reviewed through protected APIs/UI when private object storage is configured. No real documents or external storage were used in local verification.

**Completed:** Added an 8 MiB JPEG/PNG/PDF evidence policy with signed upload URLs, object metadata/signature validation, owner-only submissions, duplicate-pending prevention, private owner status history, and a staff-only review queue. Admin/moderator roles are required on all queue/evidence/decision endpoints. Staff views omit phone numbers and object keys; evidence URLs are short-lived, self-review is blocked, and document access/decisions are audit logged. A vehicle stays pending until both latest registration and licence decisions are approved; rejecting either closes its paired request so the driver can resubmit. The production profile offers document submission; a staff-gated review page presents evidence and requires a reason to reject.

**Modified files:** `server/objectStorage.ts`, `server/index.ts`, `server/migrations/009_verification_review.sql`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/object-storage.test.ts`, `tests/api-bookings.integration.test.ts`, `docs/API.md`, `docs/SECURITY.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `009_verification_review.sql` adds the evidence-access audit timestamp, a review-queue index, and a partial unique guard against duplicate pending records per user/type/vehicle. Migration applied to local PostGIS.

**Endpoints:** `GET /api/v1/users/me/verification`; `POST /api/v1/vehicles/:id/verification/evidence/upload-url`; `POST /api/v1/vehicles/:id/verification`; `GET /api/v1/admin/verification`; `GET /api/v1/admin/verification/:id/evidence`; `POST /api/v1/admin/verification/:id/decision`.

**Tests:** Local API/PostGIS integration and unit suite passed 16/16 with development OTP and identity bypass enabled only on the loopback test API. Verification tests cover anonymous/staff denial, no evidence/phone leakage, storage-not-configured response, required evidence-open access, both approvals before publication, one-time decisions, paired rejection, and driver identity level. Object-storage tests check allowlisted types and 8 MiB policy. `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed. `npm run ios:simulator` built with Xcode, installed and launched `ua.marshgo.app` on iPhone 18 Pro / iOS 27; screenshot `/tmp/marshgo-ios-current.png` confirms the reference-aligned scenic welcome screen renders in the native shell. This headless environment provides only `simctl`, so tap-driven auth/booking and the signed-in reference screens remain unverified.

**DEMO/TRUTH status:** No verification uses fake documents or auto-approval. The local form returns 503 for uploads until S3-compatible storage is configured. API code does not expose evidence to offers/search; the staff screen is role-gated and API RBAC is authoritative.

**Remaining issues:** Private S3 bucket, server-side encryption/access logs, app-origin bucket CORS, malware scanning and retention/delete processing are unconfigured. First `admin`/`moderator` role must be granted by an authorized owner/DBA; the UI cannot bootstrap staff. Commercial/legal verification rules still need review. No native tap-driven end-user review was exercised. iOS simulator showed the welcome screen; unauthenticated API refresh correctly received 401, and no credentials were entered, so the driver review flow was not exercised on-device.

**External blockers:** Owner/DBA staff role provisioning; private object storage setup and policy; document retention and malware-scanning decision; authorized moderators.

**Next implementation step:** Review the new vehicle document flow on iOS when the interactive simulator is available; implement real vehicle photo UI; then build driver offer publishing against the existing routing and offer API, keeping production publication blocked without a verified vehicle and configured route engine.

## Phase 3 / 5 — Driver offer publishing from iOS

**Phase:** 3 Offers/Booking; 5 Production UI replacement continuation.

**Status:** PARTIAL. A driver can now create a server-backed Community offer in the iOS/PWA production UI and view their own published offers. Live publication in this workspace remains blocked by the missing geocoder and routing provider configuration.

**Completed:** Added an iOS-friendly offer form with provider-selected origin/destination coordinates, future departure, price per seat, vehicle seat limit, and a verified owner vehicle requirement. Added authenticated `GET /api/v1/offers/mine`, which returns only the caller's offers and status. The trips screen now separates driver-owned offers from bookings. The create action offers passenger demand, driver trip publishing, and driver demand browsing. API errors remain visible and no route/ETA is invented.

**Modified files:** `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/api-bookings.integration.test.ts`, `docs/API.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints:** Added `GET /api/v1/offers/mine`; UI uses existing `GET /api/v1/places/suggest` and `POST /api/v1/offers`.

**Tests:** `npm test` passed 16/16 with the local loopback API/PostGIS test configuration. The offer integration case verifies publication only with a verified owner vehicle and now verifies own-offer visibility plus denial to a passenger role. `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed. `npm run ios:simulator` rebuilt, installed and launched the app on iPhone 18 Pro / iOS 27; screenshot `/tmp/marshgo-ios-offer-ui.png` shows the reference-aligned welcome screen inside the native shell. Tap-driven offer submission could not be exercised because the host only exposes headless `simctl`.

**DEMO/TRUTH status:** Offer creation and own-offer history use the production API; place coordinates require actual geocoder results; route geometry, distance, arrival and duration come from the configured OSRM-compatible service in production. No external bus/taxi inventory is shown as live.

**Remaining issues:** Geocoder and routing URLs are unset in this workspace. Photo UI and server-side publication gating are implemented in the continuation below, but no real upload can be performed until the private bucket is configured. No owner-side offer cancellation/edit screen, route stops, or tap-driven two-account iOS test is included.

**External blockers:** Contracted/self-hosted geocoding and routing services; private S3-compatible vehicle-photo bucket; interactive iOS simulator/physical devices and real SMS credentials for end-to-end acceptance.

**Next implementation step:** Add vehicle photo upload/primary photo UI and enforce the real-photo publication policy server-side; then run authenticated two-device offer/search/booking acceptance against staging.

## Phase 2 / 3 / 5 — Private vehicle photo flow and publication gate

**Phase:** 2 Auth/Garage; 3 Offers; 5 Production UI replacement.

**Status:** PARTIAL. The signed S3-compatible vehicle-photo endpoints are now connected to the production profile UI, and the backend requires a verified vehicle with at least one validated photo before publishing.

**Completed:** Added upload-to-private-bucket flow for JPEG/PNG/WebP (10 MiB max), owner-only photo gallery with short-lived read URLs, primary-photo selection and deletion. The offer form only allows a verified vehicle with a recorded real photo; the server independently enforces this invariant. Search and own-offer results include a short-lived primary-photo URL when available, without exposing storage keys; result cards render the real photo. The API integration test verifies publication is denied without a photo and succeeds only after a photo record exists, and checks that raw object keys are absent from search results.

**Modified files:** `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/api-bookings.integration.test.ts`, `docs/API.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints:** Existing `/vehicles/:id/photos*` upload/list/primary/delete endpoints are now used by the iOS/PWA profile; `POST /offers` enforces photo presence.

**Tests:** `npm test` passed 16/16 including photo-required offer creation; `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed after the signed-photo response change. `npm run ios:simulator` then rebuilt, installed and launched the app on iPhone 18 Pro / iOS 27; screenshot `/tmp/marshgo-ios-search-photos.png` confirms native launch and welcome rendering. Tap-driven profile upload was not run because only headless `simctl` is available. Test photo metadata is an isolated DB fixture because no S3 bucket is configured and no real image was uploaded.

**DEMO/TRUTH status:** No placeholder vehicle images are used. Uploads fail with an explicit storage-not-configured error until S3 settings and bucket CORS are supplied. Server publication checks the vehicle has a photo whose object passed the existing server-side content-signature verification before metadata was stored.

**Remaining issues:** S3 bucket, credentials/workload identity, encryption, access logs, CORS, malware controls and retention are still external operational requirements. Public search can display a verified primary photo only when its bucket is configured; no real image has been uploaded in this environment.

**External blockers:** Private S3-compatible photo/document storage and production geocoder/routing provider.

**Next implementation step:** Run integration/build/iOS simulator checks for this slice; then continue the core acceptance path and remaining route-aware search/navigation work.

## Phase 3 / 5 — PostGIS route endpoint search

**Phase:** 3 Offers/Search; 5 Production UI replacement.

**Status:** PARTIAL. Production UI search now requires actual provider-selected origin and destination points; the API supports geospatial endpoint proximity. Full route overlap/segment feasibility is still outstanding.

**Completed:** Added PostGIS search by origin and destination `ST_DWithin` within 20 km, with date and seat filters. The mobile home/search inputs now call the place provider and send selected WGS84 coordinates; typing alone is not treated as a canonical place. All four coordinate query parameters are required together and validated. The API keeps exact-name matching only for compatibility with legacy clients. Integration tests verify a near coordinate match succeeds despite different city labels, a remote origin is excluded, and partial coordinate input returns 400.

**Modified files:** `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/api-bookings.integration.test.ts`, `docs/API.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None; query uses the existing GiST-indexed PostGIS offer points.

**Endpoints:** Extended `GET /api/v1/offers` with `originLon`, `originLat`, `destinationLon`, and `destinationLat`.

**Tests:** `npm test` passed 16/16 with local PostGIS/API; geo tests cover successful proximity, remote exclusion and incomplete coordinate validation. `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed. `npm run ios:simulator` rebuilt, installed, and launched the app on iPhone 18 Pro / iOS 27; screenshot `/tmp/marshgo-ios-geosearch.png` confirms the reference-aligned welcome screen in the native shell. Search interaction itself is not tap-tested on this headless host.

**DEMO/TRUTH status:** Current production search uses coordinates selected from the configured geocoder and live DB inventory. No straight-line route, fabricated ETA or demo provider data is returned. Exact-name compatibility remains available to non-UI callers.

**Remaining issues:** Endpoint radius is only a coarse match. Route polyline overlap, intermediate pickup/dropoff feasibility, time window, full total-cost sorting, pagination/cursors and real geocoder configuration remain outstanding. A user cannot complete point selection until a geocoder is configured.

**External blockers:** Contracted/self-hosted HTTPS geocoder and routing provider for production use.

**Next implementation step:** Add route-corridor candidate evaluation using stored road geometry and measured detours; connect real provider configuration before claiming production search availability.

## Phase 3 / 5 — Passenger booking cancellation in iOS

**Phase:** 3 Offers/Booking; 5 Production UI replacement.

**Status:** PARTIAL. A passenger can cancel a confirmed booking from the iOS trips screen through the existing server state transition.

**Completed:** Added an explicit cancellation confirmation and status feedback. The UI refreshes canonical server bookings after cancellation; it does not locally invent an inventory update. The endpoint only permits the booking passenger and returns seats once transactionally; drivers do not receive a passenger cancellation action.

**Modified files:** `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints:** Existing `POST /api/v1/bookings/:id/cancel`.

**Tests:** `npm test` passed 16/16 including idempotent cancellation and exactly-once seat restoration; typecheck, lint and production build passed. `npm run ios:simulator` rebuilt, installed and launched on iPhone 18 Pro / iOS 27; screenshot `/tmp/marshgo-ios-booking-cancel.png` confirms successful native launch. The cancellation action itself is not tap-tested because this host only provides headless `simctl`.

**DEMO/TRUTH status:** Cancellation and booking state remain server-authoritative.

**Remaining issues:** Cancellation UI is not tap-tested on-device; refund behavior is intentionally not represented because no payment service exists. Driver boarding/start and two-party trip completion are API-backed but are not yet integrated into the iOS UI.

**External blockers:** Tap-capable simulator/physical iPhone for interaction checks; payment provider contract for any future refunds.

**Next implementation step:** Rebuild and launch in the iOS simulator, then implement driver trip lifecycle controls with clear participant-specific actions.

## Phase 6 — Opt-in route matching and mutual interest

**Phase:** 6 Navigation/Matching; part of Phase 5 Production UI replacement.

**Status:** PARTIAL. An opt-in passenger-candidate flow now evaluates actual passenger demand against the remaining foreground navigation route, checks candidate detours with ordered road-routing waypoints, and requires both driver's stationary interest and passenger confirmation. It intentionally does not create a price proposal or booking.

**Completed:** Added migration `012_navigation_matching.sql` with a verified-vehicle snapshot on each navigation session and durable, expiring `navigation_match_candidates`. Opt-in defaults off and requires an active verified vehicle. Matching queries actual open demands, filters direction, remaining route corridor, departure window, and seat capacity, then calls the configured OSRM-compatible routing provider for baseline, pickup ETA, and pickup/dropoff route distances/durations. Missing routing fails closed. Candidates are scoped to their driver and passenger; driver identity stays hidden until passenger confirmation. Driver interest requires the session be explicitly paused and the latest GPS fix be fresh. Passenger confirmation is idempotent and leaves both demand and booking inventory unchanged. The iOS UI can enable/disable matching, pause before driver response, restore candidate state, list and confirm driver interest, and resume navigation. After mutual confirmation, the paused driver can open the existing demand screen and send an explicit price proposal; it never silently creates a booking.

**Modified files:** `server/index.ts`, `server/routing.ts`, `server/migrations/012_navigation_matching.sql`, `src/services/productionApi.ts`, `src/views/ProductionNavigation.tsx`, `src/views/ProductionMarketplace.tsx`, `tests/fixtures/osrm-stub.mjs`, `tests/navigation.integration.test.ts`, `tests/routing.test.ts`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/SECURITY.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_PROGRESS.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCTION_CHECKLIST.md`.

**Database changes:** Added `vehicle_id` and `vehicle_seat_count` to `navigation_sessions`; added `navigation_match_candidates` with unique session/demand pair, route version, detour values, pickup ETA, state, expiry, and GiST route-geography index.

**Endpoints:** `PATCH /api/v1/navigation/sessions/:id/matching`; `POST /api/v1/navigation/sessions/:id/pause`; `POST /api/v1/navigation/sessions/:id/resume`; `GET /api/v1/navigation/sessions/:id/matches`; `POST /api/v1/navigation/sessions/:id/matches/refresh`; `POST /api/v1/navigation/sessions/:id/matches/:candidateId/interest`; `GET /api/v1/demands/mine/navigation-matches`; `POST /api/v1/navigation/matches/:candidateId/passenger-confirm`.

**Tests:** `DATABASE_URL=... npm run db:migrate` applied `012_navigation_matching.sql`. `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed. `API_TEST_URL=... npm test` passed 17/17 with local PostGIS/API; the opt-in navigation integration is skipped in that aggregate run. `API_TEST_NAVIGATION=true npx tsx --test tests/navigation.integration.test.ts` passed 1/1 against local PostGIS/API and a local test-only OSRM contract fixture. It checked forward-only road candidate inclusion, reverse and over-capacity exclusion, verified vehicle gate, opt-in, measured detour response, pause-required interest, role denial, withheld driver identity, idempotent passenger confirmation, no booking creation, navigation resume/end, GPS validation, and exact-location purge. `API_TEST_URL=... npx tsx --test tests/api-bookings.integration.test.ts` separately passed 5/5 with no routing provider configured. An initial attempt to run the entire API integration suite while the navigation routing fixture was active failed three routing-dependent assertions because those existing booking tests expect an unconfigured provider; the suites were rerun separately with their intended provider environment. `SIMULATOR_UDID=95D35F57-0F2F-467B-95C1-109C223D18F0 npm run ios:simulator` passed the Vite/Capacitor sync, Xcode build, install, launch, and screenshot flow on iPhone 18 Pro / iOS 27. Screenshot `/tmp/marshgo-ios-simulator.png` shows the reference-aligned MARSHGO welcome screen in the native shell. Tap-through matching and location permission cannot be tested without interactive Simulator controls; actual GPS requires a physical-device run.

**DEMO/TRUTH status:** Candidate records are generated only from persisted user demands and a configured road-routing provider. The local OSRM fixture is test-only; there is no configured production router/geocoder or live GPS device run. Candidate matching has no WebSocket/push, no price proposal linkage, and no route waypoint insertion. No booking is implied by either side's interest.

**Open issues:** Route candidate detour evaluation has API integration coverage only; no on-device GPS run was possible in this headless simulator host. Demand matching does not yet evaluate driver preference flags or existing passenger stop occupancy. The demand proposal is not linked to the candidate row, no in-app realtime/chat notification is sent, and the route is not automatically recalculated or updated with accepted stops. Router/geocoder/map tiles are unconfigured.

**External dependencies:** Approved production OSRM-compatible route provider, geocoder, map tile service, tap-capable iOS Simulator or physical iPhone with GPS, staging environment and independent user/device acceptance.

**Next implementation step:** Link mutually confirmed navigation interest into the existing quote/proposal flow without implying a booking, then add realtime notification delivery and on-device GPS acceptance when providers/devices are available.

## Phase 5 / 9 — Mobile browser E2E for booking and chat

**Phase:** 5 Production UI replacement; 9 test/quality pipeline.

**Status:** PARTIAL. The first local two-account UI acceptance path is now browser-tested against the real API and isolated PostGIS. Staging/physical iPhone acceptance and the remaining E2E matrix are not complete.

**Completed:** Added an iPhone-sized Chromium Playwright test that signs in two independent users through development-only OTP, resolves origin/destination through an isolated local geocoder fixture, searches a persisted route, books two seats, verifies the database-frozen total and remaining inventory, sends a persisted message, then verifies both booking inventory and chat from a second browser context. Added a dedicated loopback-only `marshgo_e2e` creation helper, unique E2E service ports (3300–3304), Playwright browser config, and GitHub Actions PostGIS + browser E2E steps. Fixed the development OTP response to include its code in the standard `{ data }` envelope consumed by the frontend; the test OTP is returned only by the no-network development adapter. Refined the production iPhone home layout to place route search directly below the greeting and reduce transport category cards to reference scale. The initial browser run exposed an unrelated site bound to port 3000; E2E now uses dedicated ports and refuses server reuse.

**Modified files:** `e2e/marketplace.spec.ts`, `tests/fixtures/geocoder-stub.mjs`, `tests/fixtures/e2e-web-server.mjs`, `playwright.config.ts`, `scripts/ensure-e2e-database.ts`, `server/index.ts`, `src/views/ProductionMarketplace.tsx`, `package.json`, `bun.lock`, `.github/workflows/ci.yml`, `.gitignore`, `README.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** No production schema change. Created a separate local `marshgo_e2e` database and applied existing migrations `001`–`012`; it contains only test fixture data. The test cleans up the exact UUID-scoped fixture rows after execution.

**Endpoints:** Existing `POST /api/v1/auth/otp/request`, `POST /api/v1/auth/otp/verify`, `POST /api/v1/auth/refresh`, `GET /api/v1/places/suggest`, `GET /api/v1/offers`, `POST /api/v1/bookings`, `GET /api/v1/bookings`, booking conversation/history, and `POST /api/v1/conversations/:id/messages` verified through the user interface.

**Tests:** `npx bun@1.3.5 install --frozen-lockfile` passed. `npm run typecheck`, `npm run lint`, and `npm test` passed (12/12 unit tests; integration tests require explicit API test env). `npm run build` passed. `E2E_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e npm run test:e2e` passed 1/1 on an iPhone-sized Playwright viewport after the visual adjustment: independently authenticated passenger and driver see the same confirmed two-seat booking, two remaining seats, and persisted chat. The test also confirms the HttpOnly refresh cookie survives a page reload and the passenger sees the booking and chat restored from the API. A same-origin test reverse proxy forwards requests to the separate API process, matching the intended deployment shape; direct cross-origin preview did not preserve the test cookie, so it is not used for this cookie-auth test. `/tmp/marshgo-e2e-home-refined.png` captures the refreshed home screen. The first test attempt failed because port 3000 served an unrelated local site; no product code was inferred as passing from that failed run. `npm run ios:simulator` rebuilt, installed, and launched the latest UI on iPhone 18 Pro / iOS 27; `/tmp/marshgo-ios-design-latest.png` confirms the reference-aligned welcome screen in the native shell. No UI taps were automated in Simulator.

**DEMO/TRUTH status:** This is a genuine API/PostGIS-backed local test using fixtures and a local geocoder. OTP code disclosure and geocoder fixture are restricted to test/development configuration; neither represents production SMS/address coverage. Booking and chat state was read back from independent user sessions and PostgreSQL. No real message push or WebSocket delivery is included.

**Remaining issues:** The critical browser scenario is local-only and does not exercise production SMS, uploads, driver publishing UI, reverse-demand negotiation, GPS permission, or passive matching. iPhone Simulator confirms latest build and launch but only the welcome screen has been visually captured; interaction flow remains unverified in the simulator. Full E2E/security/load/restore suites are still incomplete.

**External blockers:** Real SMS sender/account; contracted routing/geocoder/map tiles; private photo/document object storage; HTTPS staging/API host, secrets and monitoring; two physical-device or interactive-simulator acceptance.

**Next implementation step:** Run the same state checks after a full logout/restart, add tested E2E coverage for demand counter-proposals and authorization denial, then validate the new sign-up path in the running iOS simulator once tap automation is available.

### Verification update — Reverse Marketplace UI + iOS simulator

**Phase:** 4 Reverse Marketplace and 5 Production UI replacement; iOS wrapper verification.

**Status:** PARTIAL. The local two-account browser test now verifies booking, persisted chat, and the full demand price negotiation. iOS builds and launches in Simulator, but only startup rendering has been visually verified; tap-driven simulator acceptance is still unavailable.

**Implemented:** Extended the iPhone-sized E2E path so a passenger publishes a Stryi → Lviv demand for two people with a 300 UAH total budget; a driver offers 350 UAH; the passenger counters 320 UAH; the driver explicitly agrees; the passenger confirms; the test verifies exactly one resulting booking for two seats at 32,000 minor units and the driver sees the matching booking. The passenger then enables driver capability and the test confirms the same User ID retains both roles; a cross-account vehicle edit returns 404 without changing the driver's vehicle. Fixed driver proposal action selection in the E2E flow, the production proposal turn indicator (driver must agree after a passenger counter-offer), and a post-confirmation UI refresh that incorrectly fetched a driver-only demand list from the passenger account. Both account contexts persist the same booking/chat state from API-backed storage.

**Changed files:** `src/views/ProductionMarketplace.tsx`, `e2e/marketplace.spec.ts`, `playwright.config.ts`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None. E2E used the isolated local PostGIS `marshgo_e2e` database and removed its account, booking, demand, proposal, and vehicle fixtures at test teardown.

**Endpoints:** Existing `POST /api/v1/demands`, `GET /api/v1/demands/mine`, `GET /api/v1/demands`, `POST /api/v1/demands/:id/proposals`, `POST /api/v1/proposals/:id/counter`, `POST /api/v1/proposals/:id/agree`, `POST /api/v1/proposals/:id/accept`, `GET /api/v1/bookings` and persisted conversation messages exercised through UI.

**Tests:** `npm run typecheck` passed; `npm run lint` passed; `npm test` passed 12/12; `npm run build` passed; `E2E_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e npm run test:e2e` passed 1/1 including role retention, cross-account write denial, counter-offer and final booking verification. `SIMULATOR_UDID=95D35F57-0F2F-467B-95C1-109C223D18F0 SIMULATOR_API_BASE_URL=http://localhost:3002 SIMULATOR_SCREENSHOT_PATH=/tmp/marshgo-ios-iphone-reference.png npm run ios:simulator` built the Capacitor iOS app, installed/launched `ua.marshgo.app` on iPhone 18 Pro / iOS 27, and captured `/tmp/marshgo-ios-iphone-reference.png`. Visual inspection confirms the branded onboarding screen and native status/navigation shell render. Simulator taps and the authenticated workflows have not been exercised on-device.

**DEMO/TRUTH status:** Negotiation, agreement, booking, and chat are server/PostGIS-backed in this isolated development E2E environment. OTP and geocoding are test adapters; no production SMS, external routing/map provider, photo-storage, push, or live partner is active. Simulator API pointed at the isolated local E2E database with development OTP; this is not a staging or production release.

**Open issues:** Remaining Gate A E2E matrix (especially independent-device restart, authorization denial, concurrent last-seat booking, and GPS candidate mutual confirmation), interactive iOS flow, physical-device location behavior, routing/geocoding/map contracts, production SMS, object storage, HTTPS staging, push, backup/restore, and operational monitoring.

**External dependencies:** Real SMS provider credentials, an owned/contracted routing and geocoding provider, map tiles and attribution, private object storage, a staging host/secret manager, push credentials, and a physical iOS device or interactive simulator controls for full tap/GPS testing.

**Next implementation step:** Expand deterministic API/E2E coverage for role/ownership denial and concurrent booking; then add an interactive simulator/XCUITest path for sign-in and the actual home/search screens.

## Phase 9 — Run API/PostGIS integration suites in CI

**Phase:** 9 Hardening / continuous verification.

**Status:** PARTIAL. CI now exercises existing booking/lifecycle and foreground navigation API integration tests in addition to the browser flow. This does not replace production-provider tests or staging acceptance.

**Completed:** Added `npm run test:integration` with scoped subcommands. The runner refuses any database other than loopback `marshgo_e2e`, starts a development-only API process with `x-dev-user-id` test identity, runs transactional booking tests without routing, stops that API, starts a local OSRM contract fixture, and runs navigation/matching tests against a second API process. GitHub Actions invokes this runner after migrations against its isolated PostGIS service. README documents the safe local invocation and makes clear this is fixture-backed verification.

**Modified files:** `scripts/run-integration-tests.sh`, `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None; the runner intentionally does not apply migrations. CI applies migrations to the isolated PostGIS service before the test step.

**API endpoints:** Existing booking/lifecycle and navigation session/matching routes are exercised by the two integration suites.

**Tests:** `API_TEST_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e npm run test:integration` passed booking suite 5/5 and navigation suite 1/1. This includes OTP/profile/session rotation, one-winner last-seat concurrency, vehicle/role ownership, verification workflow, demand negotiation/booking conversion, real-route candidate filters, opt-in, mutual confirmation, GPS validation, and location purge. After wiring CI, `npm run typecheck`, `npm run lint`, `bash -n scripts/run-integration-tests.sh`, `npm test` (12/12), `npm run build`, `npm run test:e2e` (1/1), and `git diff --check` all passed locally.

**DEMO/TRUTH status:** All integration users and route responses are test-only; the OSRM fixture estimates routes only for deterministic assertions and is never presented to the app as a production provider. The runner pins DB targeting to loopback and the dedicated test database.

**Remaining issues:** No CI result from GitHub Actions has been observed for this change yet; physical device, real providers, production host, load/performance, backup restore, and interactive iOS workflows are still outstanding.

**External blockers:** None for local CI wiring. Production service credentials and deployment/restore resources remain separately blocked as listed above.

**Next implementation step:** Validate the complete local command set including browser E2E after adding the runner, then continue the critical acceptance matrix with multi-device booking/cancellation and safe mutual-match behavior.

## Phase 7 — Participant-authorized realtime chat

**Phase:** 7 Real-time chat (message delivery slice).

**Status:** PARTIAL. Local two-account realtime send and reconnect/history replay are browser-tested. Production multi-instance fan-out and push remain incomplete.

**Completed:** Added an authenticated one-use 30-second realtime ticket bound to a persisted access session. WebSocket upgrade checks allowlisted browser origin, consumes the ticket, revalidates active session, limits frames/connections, sends ping/pong heartbeats, and closes connections on logout. Persisted booking messages are broadcast only to participants after the database insert. The production client automatically reconnects using a newly-issued ticket, fetches persisted conversation history on reconnect, deduplicates socket/REST messages, and shows online/offline chat status. E2E reverse proxy now forwards WebSocket upgrades; the two-account mobile-sized test proves an online passenger message appears for an already-connected driver without refresh and is still present when the driver reloads/reopens chat.

**Modified files:** `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/fixtures/e2e-web-server.mjs`, `e2e/marketplace.spec.ts`, `package.json`, `bun.lock`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None; the single-use tickets are short-lived in-memory credentials bound to existing database sessions. Messages remain durable in PostgreSQL.

**API endpoints/events:** Added `POST /api/v1/realtime/ticket`; added authenticated WebSocket `GET /api/v1/realtime?ticket=…`; `POST /api/v1/conversations/:id/messages` emits `conversation.message.created` to booking conversation members after persistence.

**Tests:** `npx --yes bun@1.3.5 install --frozen-lockfile` passed. Under pinned Node.js 24.21.0, `npm run typecheck`, `npm run lint`, `npm test` (12/12), and `npm run build` passed. `API_TEST_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e npm run test:integration` passed booking/lifecycle (5/5) and navigation (1/1). `E2E_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e npm run test:e2e` passed (1/1), including immediate cross-account WebSocket delivery and persisted replay after reload. `SIMULATOR_UDID=95D35F57-0F2F-467B-95C1-109C223D18F0 SIMULATOR_API_BASE_URL=http://localhost:3002 SIMULATOR_SCREENSHOT_PATH=/tmp/marshgo-ios-realtime-build.png npx --yes --package=node@24.21.0 -- npm run ios:simulator` passed Capacitor sync, Xcode build, install, and launch on iPhone 18 Pro / iOS 27; screenshot confirms the branded onboarding screen renders. Simulator taps/auth/chat/GPS could not be exercised with the available headless simulator controls.

**DEMO/TRUTH status:** Real server sessions and PostgreSQL-backed conversations are used. Ticket issuance cannot use the development identity bypass without a database session. No fixture-only event is exposed by this implementation. Fan-out currently reaches clients connected to the same API process only; a multi-instance production deployment must not scale this server horizontally until shared pub/sub is added.

**Remaining issues:** Web Push, unread/read receipts, demand-bound pre-booking conversations, Redis pub/sub/scale-out, cross-process reconnection/load testing, and independent production staging remain incomplete.

**External dependencies:** No provider credentials for this slice. Redis provisioning is already local but its pub/sub integration is outstanding engineering work.

**Next implementation step:** Add shared Redis WebSocket fan-out before any multi-instance deployment; block controls are recorded in the account-safety continuation below.

## Phase 7 — User-ID block enforcement

**Phase:** 7 Real-time and account-safety continuation.

**Status:** PARTIAL. Server and production UI block/unblock flows are implemented and integration/E2E-tested. Report/moderation intake and active-booking policy remain.

**Completed:** Added `user_blocks` with user-ID keys, cascade deletion, and a reverse lookup index. Authenticated list/block/unblock endpoints are audit logged. Production chat offers a participant block action for a confirmed booking; Profile lists blocks and can unblock. Either direction in a blocked pair prevents demand proposals and negotiation, suppresses passive route candidates, and denies booking-chat history and message sends. Blocks leave an already-confirmed booking intact; standard booking cancellation remains a separate explicit action.

**Modified files:** `server/migrations/013_user_blocks.sql`, `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/api-bookings.integration.test.ts`, `tests/navigation.integration.test.ts`, `e2e/marketplace.spec.ts`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/SECURITY.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `user_blocks(blocker_id, blocked_id, created_at)`, composite primary key, self-block check, cascading foreign keys, and reverse lookup index.

**Endpoints:** `GET /api/v1/users/me/blocks`; `POST /api/v1/users/:id/block`; `DELETE /api/v1/users/:id/block`; `POST /api/v1/bookings/:id/block-other` resolves the participant server-side to avoid disclosing another account ID to the client.

**Tests:** Applied migration `013_user_blocks.sql` to local `marshgo` and isolated `marshgo_e2e` PostGIS databases. `npm run test:integration` passed booking/chat 5/5 and navigation 1/1; assertions verify block/unblock, proposal denial, chat history/send denial, and matching suppression while blocked. `npm test` passed 12/12; production build passed; two-account `npm run test:e2e` passed 1/1, covering UI block, profile listing, blocked message rejection/no insert, unblock, and restored message persistence. `npm run typecheck`, `npm run lint`, and `git diff --check` passed. `npm run ios:simulator` passed with the local development API running: Capacitor sync, Xcode build, install and launch on iPhone 18 Pro / iOS 27; screenshot at `/tmp/marshgo-ios-block-ui.png` shows the branded onboarding. Touch-driven native login and in-app screens remain untested.

**DEMO/TRUTH status:** Block data and enforcement are server/PostgreSQL-backed. No demo blacklist data is used by the production endpoints or PWA. Existing bookings are not cancelled by a block.

**Remaining issues:** Add abuse report/moderation intake and resolution; define the customer-support policy for blocking an existing booking pair.

**External dependencies:** None for the server slice. Staff moderation still requires initial authorized staff provisioning and the unfinished admin workflow.

**Next implementation step:** Add report/moderation workflow, then implement shared Redis WebSocket fan-out and continue owner provisioning for external geocoder/routing services.

## Phase 6 — Foreground GPS navigation session

**Phase:** 6 Navigation/Matching (foreground navigation slice).

**Status:** PARTIAL. Real GPS session and route persistence are implemented and API-tested. Passenger matching, navigation instructions, rerouting, map-provider configuration, background GPS, and physical-device GPS permission testing remain incomplete.

**Completed:** Added migrations `010_navigation_sessions.sql` and `011_navigation_retention.sql` with one-active-session-per-driver and spatial indexes. Added owner/driver-authorized start, restore, inspect, location-update, and idempotent end API. Starting requires a real GPS origin and successful OSRM-compatible road route; no estimate is invented if routing is absent. The API validates WGS84, sample accuracy ≤100 m, freshness (≤60 s), future skew (≤15 s), ordering, and implausible movement. It returns an on-route check against the road line. End removes precise position, destination label/point, and road geometry; a five-minute no-fix cleanup runs at startup and every 15 seconds. Added a mobile navigation screen in the production shell with destination geocoder selection, native-browser foreground location watch, visible stale/off-route state, real route geometry, map-tile-provider configuration, and explicit disclosure that passenger matching/voice/background navigation are unavailable. iOS now requests foreground location permission with a purpose string.

**Modified files:** `server/migrations/010_navigation_sessions.sql`, `server/migrations/011_navigation_retention.sql`, `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `src/views/ProductionNavigation.tsx`, `ios/App/App/Info.plist`, `.env.example`, `package.json`, `tests/fixtures/osrm-stub.mjs`, `tests/navigation.integration.test.ts`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/SECURITY.md`, `docs/IOS.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `navigation_sessions` with `geography(Point,4326)` destination/current location, `geometry(LineString,4326)` road route, route distance/duration/version, state and opt-in flag. Partial unique active-session-per-driver index plus GiST route/current-location indexes. Destination label is nullable for retention purge.

**Endpoints:** `POST /api/v1/navigation/sessions`; `GET /api/v1/navigation/sessions/active`; `GET /api/v1/navigation/sessions/:id`; `POST /api/v1/navigation/sessions/:id/location`; `POST /api/v1/navigation/sessions/:id/end`.

**Tests:** Applied both migrations on the existing local PostGIS container. Navigation API integration passed 1/1 against local PostGIS/API with a test-only OSRM-compatible fixture. Tested role/owner denial, duplicate active session conflict, route polyline/distance, fresh GPS accepted/on-route, stale GPS 400, teleport 422, idempotent end, and deletion of route/destination/precise point. `npm test`: 11 passed, 2 opt-in integration suites skipped without env. `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed after fixture cleanup. `npm run ios:simulator` built/installed/launched `ua.marshgo.app` on iPhone 18 Pro / iOS 27; screenshot `/tmp/marshgo-ios-simulator.png` confirms the production welcome screen renders in the native shell. Tap-through OTP/navigation and GPS permission testing are unavailable because only headless `simctl` is present. The test route fixture does not represent a real roads service.

**DEMO/TRUTH status:** Production navigation no longer uses demo coordinates or simulated movement. API stores one latest GPS point only, available to the owning driver. If `ROUTING_ENGINE_URL` is missing the start request fails closed. No opt-in passenger matching is exposed as active. Without `VITE_MAP_TILE_URL`, the app draws the real route geometry and identifies the missing street-map tile layer.

**Open issues:** No actual dynamic route recalculation, maneuver/voice guidance, geospatial passenger candidate query, detour routing, mutual passenger consent, WebSocket location fanout, offline recovery UX, or background tracking. A tap-driven iOS GPS session was not possible on the headless simulator host.

**External dependencies:** Configure an owned/contracted OSRM-compatible router; approved contracted/self-hosted map tile service plus attribution; real geocoder for selecting destination; physical-device/iOS permission review. Passive matching needs its own route-detour engine and two-sided consent workflow.

**Next implementation step:** Run lint and the complete build/test suite after fixture cleanup; sync, install, and launch the updated iOS app in the available simulator. Then implement and test passenger candidate corridor/detour matching without exposing it as active until both sides confirm.

## Phase 7 continuation — Redis-backed realtime across API instances

**Phase:** 7 Real-time; shared infrastructure slice.

**Status:** PARTIAL. Realtime tickets and message delivery now work across two local API instances backed by Redis. This is not yet a durable event queue, push notification service, staging deployment, or production release.

**Completed:** Added Redis client integration. Production server startup now requires `REDIS_URL`; Redis configured in any environment is connected before the HTTP server starts. Single-use 30-second realtime tickets are stored with Redis expiry and consumed atomically using `GETDEL`, allowing issue/consume across replicas without replay. Persisted conversation messages publish participant-scoped events to a Redis Pub/Sub channel; each API process delivers only to local sockets for those user IDs. Logout/logout-all also publish session revocation so sockets connected to other API processes close. The single-process in-memory ticket/fan-out path is retained only when `REDIS_URL` is absent in non-production development. Added isolated two-instance integration coverage with two authenticated users: ticket issued on API A, socket opened on API B, replay rejected after consumption, durable message posted through API A, event received on API B, and logout on API A closes the API B socket. CI now provisions Redis and shares a stable test session secret across API processes.

**Modified files:** `server/index.ts`, `src/views/ProductionMarketplace.tsx`, `tests/realtime-cluster.integration.test.ts`, `e2e/marketplace.spec.ts`, `scripts/run-integration-tests.sh`, `playwright.config.ts`, `.github/workflows/ci.yml`, `package.json`, `bun.lock`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DEPLOYMENT.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints/events:** Existing `POST /api/v1/realtime/ticket`; WebSocket `/api/v1/realtime?ticket=...`; existing `POST /api/v1/conversations/:id/messages` emits `conversation.message.created` over Redis Pub/Sub after persistence.

**Tests:** With local PostGIS and Redis running, `DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e npm run db:migrate` passed. After the dependency override and logout propagation change, `npm run typecheck`, `npm run lint`, `npm test` (12/12), and `npm run build` passed. `npx --yes bun@1.3.5 audit` reports no vulnerabilities; `bun install --frozen-lockfile` and `git diff --check` passed. `API_TEST_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:integration` passed booking/lifecycle 5/5, navigation/matching 1/1, and two-process realtime 1/1, including cross-process logout socket closure. `E2E_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:e2e` passed 1/1 after fixing a navigation race where async block completion could override a user's later screen change. `npm run ios:simulator` with Node 24.21.0 passed Capacitor sync, Xcode build, install, and launch on iPhone 18 Pro / iOS 27; the welcome screen screenshot is `/tmp/marshgo-ios-final-redis.png`. This is a render/startup check only; touch-driven iOS auth, booking, chat and GPS remain untested on this headless host.

**DEMO/TRUTH status:** Conversation records and messages remain PostgreSQL-backed. Redis Pub/Sub is transient fan-out only; clients recover from database history. No production SMS, push delivery, partner service, or public deployment is active.

**Open issues:** The transactional outbox currently covers chat messages only; booking/proposal event publication and logout revocation still need durable delivery coverage. Redis-backed rate limiting, Redis/outbox health metrics and alerting, failover behavior under production topology, durable push delivery, and staging load tests remain incomplete.

**External dependencies:** Production Redis endpoint/credentials and managed operational monitoring must be provisioned by the owner. No new provider credentials were required for local verification.

**Next implementation step:** Build moderation report intake/decision workflow; extend durable outbox coverage to booking/proposal events, then continue provider and staging work.

## Phase 7 continuation — transactional chat event outbox

**Phase:** 7 Realtime; durable event slice.

**Status:** PARTIAL. Chat messages and their realtime event are committed atomically and delivered with retry. Push and other domain-event outbox coverage remain incomplete.

**Completed:** Added migration `014_realtime_outbox.sql`. Message creation now inserts the message and a deduplicated participant-scoped event in one PostgreSQL transaction. A background API worker leases rows using `FOR UPDATE SKIP LOCKED`, publishes through Redis Pub/Sub, records publish state, and schedules exponential retry if Redis is unavailable. Published payload records are pruned after seven days. Events remain durable if an API process exits between transaction commit and Redis publication. Updated the account-block E2E to wait for the asynchronous block result and fixed a race so a completed block action only navigates away if the user still remains in chat.

**Modified files:** `server/migrations/014_realtime_outbox.sql`, `server/index.ts`, `tests/realtime-cluster.integration.test.ts`, `src/views/ProductionMarketplace.tsx`, `e2e/marketplace.spec.ts`, `docs/DATA_MODEL.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `realtime_outbox` with UUID event ID, event type, unique dedupe key, recipient snapshot, JSON payload, attempt count, lease expiry, next availability, publish timestamp, last error, and pending-event index.

**Endpoints/events:** Existing `POST /api/v1/conversations/:id/messages` now writes a transactional outbox event; no public endpoint added. Redis channel carries the existing `conversation.message.created` event.

**Tests:** Applied migration `014_realtime_outbox.sql` on local `marshgo` and isolated `marshgo_e2e` PostGIS databases. `npm run typecheck`, `npm run lint`, and `npm test` (12/12) passed. `API_TEST_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:integration` passed 5 booking/lifecycle, 1 navigation/matching, and 1 two-process realtime test; the realtime test verifies the outbox row is published, cross-instance one-use tickets, event delivery and logout closure. `npm run build` and the two-account `npm run test:e2e` (1/1) passed. The iOS build/simulator launch for this worktree passed shortly before the outbox-only server changes; no UI files changed in the outbox slice.

**DEMO/TRUTH status:** Realtime chat remains authenticated and database-backed. Redis Pub/Sub is still a delivery channel, not storage. No push provider or public deployment is active.

**Open issues:** Extend outbox events to booking/proposal and notifications; make logout revocation delivery durable; monitor queue depth/oldest pending age and Redis failures; exercise retry with an injected outage; no staging or production worker supervision is configured.

**External dependencies:** Production Redis endpoint and managed metrics/alerting remain owner-provisioned. No new external credentials required for local verification.

**Next implementation step:** Implement abuse-report intake and staff moderation actions; extend the outbox to booking/proposal events and make logout revocation durable.

## Phase 7 continuation — private reports and staff moderation

**Phase:** 7 Realtime and safety operations.

**Status:** PARTIAL. Booking participants can submit a private report and staff can review it through a guarded server queue. Staffing procedures, moderation notifications and staging review are still absent.

**Completed:** Added a PostgreSQL moderation case model. A report must reference a booking the caller participated in; the API derives the other participant and accepts no client-supplied target ID. Added per-reporter daily rate limiting, duplicate open-report protection, bounded category/details fields, audit events, and a profile-inaccessible staff queue. Moderators/admins can claim a case and record an audited terminal decision; only the assigned reviewer or an administrator can continue an in-review case. Only an administrator can suspend a non-staff account; the API revokes its sessions and closes active realtime sockets. Added private report submission from booking chat and a staff moderation view alongside verification review.

**Modified files:** `server/migrations/015_moderation_cases.sql`, `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/api-bookings.integration.test.ts`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/SECURITY.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `moderation_cases` with reporter/reported-user/booking references, category/details constraints, reviewer and resolution metadata, state invariants, duplicate open booking-report index, and staff queue/user indexes.

**Endpoints:** `POST /api/v1/reports`; `GET /api/v1/admin/moderation`; `POST /api/v1/admin/moderation/:id/decision`.

**Tests:** Applied `015_moderation_cases.sql` on local loopback `marshgo_e2e` and `marshgo`. `npm run typecheck`, `npm run lint`, `npm test` (12/12), `npm run build`, and `git diff --check` passed. `API_TEST_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:integration` passed bookings/moderation 6/6, navigation 1/1, realtime 1/1. The moderation test covers participant-only intake, duplicate conflict, outsider denial, staff queue authorization, assignment and resolution persistence. First integration run caught an incorrect booking route join; it was fixed and the complete rerun passed. `E2E_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:e2e` passed the two-account UI scenario (1/1). `SIMULATOR_UDID=95D35F57-0F2F-467B-95C1-109C223D18F0 npm run ios:simulator` passed Vite production build, Capacitor sync, Xcode build, install and launch on iPhone 18 Pro / iOS 27. Screenshot `/tmp/marshgo-ios-simulator.png` shows the bundled MARSHGO welcome screen with safe-area layout, scenic road image and native status bar; interactive sign-in and post-auth gestures remain untested on this headless host.

**DEMO/TRUTH status:** Report details and review actions are persisted and server-authorized. UI appears only in the production/API-backed screen; development demo data does not seed moderation cases. This is not a staffed or externally monitored safety service.

**Open issues:** Add durable notification/outbox for new reports and decisions; enforce staff coverage/escalation procedures; perform staging abuse/suspension review; interactive iOS sign-in/booking remains untested.

**External dependencies:** Owner must provision and verify the initial staff roles and establish safety-response procedures. No external service credentials required for the local report flow.

**Next implementation step:** Extend transactional outbox coverage to booking/proposal events, then continue remaining Gate A infrastructure and physical-device acceptance blockers.

## Phase 5 continuation — iOS home date localization

**Phase:** 5 UI replacement and mobile presentation.

**Status:** PARTIAL. Home/search UI follows the supplied light mobile reference; this visual pass fixed the device-locale-dependent date display. iOS authenticated interactions remain unverified.

**Completed:** Kept the native date picker but separated its invisible interactive input from the visible date label, formatting the displayed date in Ukrainian (`uk-UA`, Europe/Kyiv). This removes `09/30/2026` on English-locale browsers and shows the localized form such as `30 вересня 2026 р.` without changing the date API value or E2E form interaction.

**Modified files:** `src/views/ProductionMarketplace.tsx`, `docs/IOS.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints:** None.

**Tests:** `npm run typecheck`, `npm run lint`, `npm run build` passed. `E2E_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 E2E_SCREENSHOT_PATH=/tmp/marshgo-home-ukraine-date.png npm run test:e2e` passed 1/1. Visual inspection confirmed the localized date on the mobile viewport. Final `SIMULATOR_UDID=95D35F57-0F2F-467B-95C1-109C223D18F0 SIMULATOR_SCREENSHOT_PATH=/tmp/marshgo-ios-reference-update.png npm run ios:simulator` passed Vite build, Capacitor sync, Xcode build, install, launch and screenshot on iPhone 18 Pro / iOS 27.

**DEMO/TRUTH status:** This changes only display formatting; date selection remains native, and bookings still use the server API. The screenshot is a signed-in browser E2E viewport, not a post-login native simulator screenshot.

**Open issues:** No automated tap entry into the native simulator, so OTP and authenticated iOS interaction remain untested. The complete two-device, physical GPS, and production release gates remain blocked.

**External dependencies:** None for the date display. Native interactive verification requires simulator UI automation or a physical device run.

**Next implementation step:** Continue production blocker work; authenticated native screen interaction remains to be exercised with an available simulator UI automation or physical-device run.

## Phase 7 continuation — transactional booking and negotiation events

**Phase:** 7 Realtime; domain-event delivery.

**Status:** PARTIAL. Booking and proposal domain writes now enqueue participant-scoped realtime records transactionally, with Redis delivery across API instances. Push, missed-event replay, durable logout revocation and outbox monitoring remain open.

**Completed:** Added a shared typed outbox insertion helper and dispatcher allowlist. Offer booking and cancellation persist `booking.confirmed` / `booking.cancelled`; boarding, trip start and completion persist `booking.changed`. Proposal creation, each counter revision, driver agreement, passenger acceptance and competitor closure persist proposal events in the same transaction as their state change. Passenger demand cancellation now uses a row-locked transaction, closes pending proposals, and outboxes a reasoned `proposal.closed` event to both negotiation parties. Production clients establish an authenticated event channel and reload booking/offer or demand/proposal data after relevant events; chat continues to deduplicate messages and recover history through REST.

**Modified files:** `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/api-bookings.integration.test.ts`, `tests/realtime-cluster.integration.test.ts`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** No new migration; reuses the existing durable `realtime_outbox` schema from `014_realtime_outbox.sql`.

**Endpoints/events:** Existing booking, lifecycle, demand cancellation and proposal endpoints now enqueue `booking.confirmed`, `booking.cancelled`, `booking.changed`, `proposal.created`, `proposal.countered`, `proposal.updated`, `proposal.accepted`, and `proposal.closed` events. REST remains canonical; clients treat events as resync triggers.

**Tests:** `API_TEST_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:integration` passed booking/moderation 6/6, navigation 1/1, and realtime 1/1. Realtime integration verifies booking confirmation outbox persistence, remote socket delivery for cancellation, event publication acknowledgement, message fanout, single-use tickets, and remote logout closure. API integration verifies negotiation lifecycle event set/participants and proposal closure when demand is cancelled. `npm run typecheck`, `npm run lint`, `npm test` (12/12), `npm run build`, and `git diff --check` passed. `E2E_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:e2e` passed (1/1).

**DEMO/TRUTH status:** Events are emitted from committed PostgreSQL outbox rows; clients refresh canonical REST records. Redis Pub/Sub is not a durable notification inbox, and this does not enable Web Push.

**Open issues:** Outbox uses at-least-once delivery; consumers are idempotent refreshes, but events have no cursor/replay API. Add Redis/outbox queue age/depth/failed delivery metrics, fault-injected retry test, durable logout revocation, push/in-app notification storage, expiry worker, and staging verification.

**External dependencies:** Production Redis, monitoring/alerting, staging and push provider still require owner infrastructure/credentials; no new key was needed for this local slice.

**Next implementation step:** Continue operational hardening: prove outbox retry after Redis outage, add health/queue metrics and durable session revocation, then re-evaluate remaining Gate A launch dependencies.

## Phase 5 / 6 continuation — Pro Max responsive route and native startup verification

**Phase:** 5 UI replacement; 6 foreground navigation; 9 release validation.

**Status:** PARTIAL. The app renders its launch and home screens on both requested Pro Max simulator profiles, and the mobile foreground route flow passes against isolated provider fixtures. The real road router, geocoder, map tiles, and interactive native GPS flow are not configured or verified, so this is not production route validation.

**Completed:** Added iPhone 15 Pro Max and iPhone 16 Pro Max Playwright viewport coverage for authenticated home layout, horizontal overflow, foreground route start, Leaflet route geometry, GPS status, honest missing-basemap state, route end, and server-side location deletion. Fixed local OTP test isolation by using separate accounts and made the cross-device trip E2E bring the other simulated phone to foreground before asserting refreshed state or incoming chat. Added a 3-second bookings refresh while the trips view is visible as a recovery path if realtime delivery is suspended. Allowed `capacitor://localhost` in the default API CORS list and documented it in `.env.example`; the native WebView had been blocked from completing its initial API request. Captured and visually inspected the production welcome screen on both iOS 27 simulator profiles.

**Modified files:** `server/index.ts`, `.env.example`, `src/views/ProductionMarketplace.tsx`, `e2e/marketplace.spec.ts`, `playwright.config.ts`, `tests/api-bookings.integration.test.ts`, `tests/realtime-cluster.integration.test.ts`, `tests/fixtures/e2e-web-server.mjs`, `tests/fixtures/geocoder-stub.mjs`, `tests/fixtures/osrm-stub.mjs`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints:** No new endpoint. Existing `/api/v1/navigation/sessions`, `/api/v1/navigation/sessions/:id/location`, `/api/v1/navigation/sessions/:id/end`, `/api/v1/routing/route`, and bookings/realtime APIs are exercised.

**Tests:** `npm run test:e2e` passed 2/2: the independent-account booking, reverse-demand negotiation, persistence, trip lifecycle and realtime chat flow; and Pro Max route-render coverage for both viewport profiles. The targeted Pro Max route test also passed after capturing screenshots. `npm run typecheck`, `npm run lint`, and `npm test` passed (12/12). `npm run test:integration` passed booking/moderation 6/6, foreground navigation 1/1, and Redis cross-instance realtime 1/1. One earlier realtime integration run exposed a test race: socket delivery precedes marking the outbox row published; the test now waits for the publication acknowledgement and the full rerun passed. `npm run ios:simulator` built, installed, and launched MARSHGO on iPhone 15 Pro Max / iOS 27. The same built app was installed/launched on iPhone 16 Pro Max / iOS 27. Visually inspected screenshots: `/tmp/marshgo-iphone-15-pro-max-loaded.png`, `/tmp/marshgo-iphone-16-pro-max-retry.png`, and browser route captures `/tmp/marshgo-iphone-15-pro-max-route.png`, `/tmp/marshgo-iphone-16-pro-max-route.png`.

**DEMO/TRUTH status:** Simulator screenshots show the native iOS welcome screen. Browser route tests use local geocoder/OSRM contract fixtures; their route path and 72.6 km / 1h41 values are fixture output and do not prove a live road route. The navigation UI correctly warns that no basemap tile provider is configured. The server returns 503 for routing if no provider is configured. GPS used by the viewport test is Playwright-mocked; a native real-device or simulator GPS session was not run.

**Open issues:** Configure and validate contracted/operated geocoding, road-routing, and map-tile providers; add navigation detour refresh and rerouting against actual routes; exercise native OTP, account flows, location permission and foreground GPS via UI automation or physical devices; implement push fallback for backgrounded clients. PWA/iOS background tracking remains outside this foreground test.

**External dependencies:** Production geocoder/routing SLA and map tile source/attribution; production SMS provider and verified sender; physical-device acceptance for GPS and two-account trip lifecycle.

**Next implementation step:** Add and contract-test provider configuration/diagnostics, then rerun route creation and foreground location on a provider-backed staging environment before the Gate A two-device sign-off.

## Phase 7 continuation — realtime operations and retry visibility

**Phase:** 7 Realtime; operations and retry visibility.

**Status:** PARTIAL. Staff can inspect safe queue metrics and readiness reports Redis dependency state. The integration suite now proves the durable outbox records a failed dispatch and retries successfully after backoff; an actual Redis outage/recovery drill and external alerting are still outstanding.

**Completed:** Added staff-only `GET /api/v1/admin/ops/realtime` with pending and retrying row counts, maximum attempts, oldest pending/lease ages, last successful publish timestamp, and Redis state. Raw `last_error`, recipients, and event payloads are omitted. `/readyz` now returns `503` with database/realtime dependency detail when configured Redis is disconnected. Extended the two-process integration test with a deliberately unsupported local outbox event: the worker records the failure and backoff, the isolated test repairs the event contract, and the worker publishes it to the authorized remote socket on retry. Fixed an E2E packaging regression where the simulator build's embedded `http://localhost:3002` API origin was being served to a browser on a different origin: `test:e2e` now rebuilds a clean PWA bundle, and the E2E web server refuses simulator-configured JS bundles. Revalidated the order iOS simulator build → browser E2E. Updated current API and audit records where prior prose still described booking/proposal outbox delivery as absent.

**Modified files:** `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `e2e/marketplace.spec.ts`, `tests/api-bookings.integration.test.ts`, `tests/realtime-cluster.integration.test.ts`, `tests/fixtures/e2e-web-server.mjs`, `scripts/build-pwa.mjs`, `package.json`, `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None; uses existing `realtime_outbox` migration `014_realtime_outbox.sql`.

**Endpoints:** `GET /api/v1/admin/ops/realtime`; `/readyz` now includes Redis readiness.

**Tests:** Under pinned Node `v24.21.0`: `npm run typecheck`, `npm run lint`, `npm test` (12/12), `npm run build`, `git diff --check`, local integration (bookings/moderation 6/6, navigation 1/1, Redis cross-instance realtime and retry 1/1), and `E2E_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:e2e` (two independent accounts, 1/1) passed. E2E requires the explicit isolated database environment; without it the test stops before discovery. `npm run ios:simulator` completed Vite/Capacitor/Xcode build, install and launch on iPhone 18 Pro, iOS 27 under the host Node `v26.7.0`; screenshot `/tmp/marshgo-ios-lifecycle-final.png` shows the branded native welcome screen. This verifies compile/install/start/render only; no taps or authenticated native journey were tested. A later attempt to nest the simulator script inside the temporary Node 24 `npx` environment failed at nested `npx cap sync` resolution, before Xcode; it does not change the successful host-Node simulator result.

**DEMO/TRUTH status:** Metrics and readiness are server-backed; outbox retry is exercised with a controlled invalid event in a loopback test database. This does not verify Redis network partition recovery, alert delivery or managed production operations. iOS remains the Capacitor native shell around the reference-aligned API client; the simulator screenshot covers welcome only. The graphical `Simulator.app` UI is unavailable in this host, so test credentials could not be entered through native controls.

**Open issues:** Production remains blocked by missing SMS sender credentials, HTTPS staging host, managed PostGIS/Redis, geocoder/routing service, private object storage, security/backup/rollback/alerting runbooks, and physical two-device acceptance. Need Redis outage/recovery drill, durable logout revocation, Web Push/in-app inbox, and tap-driven iOS tests. The supplied composite reference contains partner/bus availability and full maps that are not enabled without real sources; the UI must not invent those results.

**External dependencies:** SMS provider/sender; HTTPS staging/production infrastructure and monitoring; geocoding/routing hosting; private S3-compatible bucket; physical iPhones/two real accounts for release-gate verification.

**Next implementation step:** Add privacy-safe QR rendering/scanning and completed-trip review UI; connect mutually confirmed navigation candidates to an explicit price/proposal and booking flow with real route/stop updates. Then provision staging services and run the two-device acceptance path. Do not mark Production release ready.

## Phase 3 / 5 continuation — trip lifecycle in the mobile client

**Phase:** 3 Offers/Booking; 5 Production UI replacement.

**Status:** PARTIAL. The production mobile trip list now drives the server booking lifecycle end to end for boarded trips. QR camera handoff, review UI, and real-device interaction remain open.

**Completed:** Added participant ticket retrieval and a private display of the signed, PII-free token; driver token entry confirms boarding through the server; driver can start the trip; either participant can confirm completion; the server persists each completion confirmation and only marks the booking complete after both participants confirm. Booking list DTOs expose server-derived confirmation count and caller confirmation state. First-party completion confirmation now emits an outbox invalidation so the other device refreshes its trip card. Status labels and button visibility follow canonical API state.

**Modified files:** `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `e2e/marketplace.spec.ts`, `docs/API.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None; reuses existing booking completion confirmation and realtime outbox tables.

**Endpoints:** `GET /api/v1/bookings` now includes completion count/current-user confirmation; existing `GET /api/v1/bookings/:id/ticket`, `POST /api/v1/bookings/:id/boarding`, `/start`, and `/complete` are wired to the app.

**Tests:** Under Node `v24.21.0`, `npm run typecheck`, `npm run lint`, and the built-PWA two-account E2E passed. E2E verifies the signed token is accepted only by the driver, boarding/start are server-backed, each participant's completion confirmation synchronizes, and PostgreSQL ends at `completed` with exactly two confirmations. The test bundle now safely rebuilds the web target after iOS builds.

**DEMO/TRUTH status:** Booking lifecycle state is server-backed and tested across independent browser contexts. The token is manually handed between the two screens; this is not a QR barcode/scanner implementation or native camera flow.

**Open issues:** No QR code renderer or camera scanning; no rating form after completion; the trip detail remains a compact mobile card rather than every screen in the supplied storyboard. Simulator has only been visually checked at welcome/startup because the graphical simulator UI is unavailable.

**External dependencies:** Interactive iOS simulator runner/physical devices for native camera, OTP and session tests. No new third-party credential is needed for this local flow.

**Next implementation step:** Add privacy-safe QR rendering/scanning on the native client and rating UI backed by completed-trip reviews; continue Gate A navigation candidate-to-booking integration separately.

## Phase 9 continuation — split GitHub packages and device smoke checks

**Phase:** 9 Hardening; repository packaging and simulator verification.

**Status:** PARTIAL. Prepared independently installable Server, Site, and iOS repositories from the existing codebase. All three have been pushed to GitHub; the original umbrella repository remains intact. Standalone builds/tests pass for the API, PWA, and iOS simulator target. Production remains blocked by configured provider and staging requirements above.

**Completed:** Created focused `MarshGO-Server`, `MarshGO-Site`, and `MarshGO-iOS` public repositories with isolated manifests, lockfiles, CI workflows, and ownership documentation. iOS consumes the Site repository at build time rather than maintaining a duplicate React UI. Re-ran the API and cross-instance realtime integration suite, E2E two-account marketplace and route viewport tests, and native simulator build/install/launch on iPhone 15 Pro Max and iPhone 16 Pro Max. First iPhone 15 screenshot was captured before WebKit finished first-run initialization; relaunch after WebKit startup rendered correctly. Raised the simulator screenshot wait to 35 seconds for cold-start reliability.

**Modified files:** `docs/REPOSITORIES.md`, `docs/PRODUCTION_PROGRESS.md`, `README.md`, `scripts/build-ios-simulator.sh`, plus the standalone manifests, lockfiles, CI and README files in each of the three GitHub repositories.

**Database changes:** None.

**Endpoints:** None.

**Tests:** Root: `npm run typecheck`, `npm run lint`, `npm test` (12 passed), `npm run build`, `npm run test:integration` (bookings 6/6, navigation 1/1, Redis realtime 1/1), and `E2E_DATABASE_URL=postgres://.../marshgo_e2e npm run test:e2e` (2/2) passed. Standalone server: clean `npm ci`, typecheck, unit suite (8 passed; database-gated cases excluded), integration suite (same 6/1/1 passing). Standalone site: clean `npm ci`, scoped ESLint, typecheck, Vite production build passed. Standalone iOS: clean npm dependencies, Vite site build, `cap sync`, Capacitor doctor and generic iOS Simulator Xcode build passed. Native app launched on iPhone 15 Pro Max and iPhone 16 Pro Max simulators; screenshots `/tmp/marshgo-iphone-15-pro-max-retry.png` and `/tmp/marshgo-iphone-16-pro-max-verified.png` show the same MARSHGO welcome screen. Browser E2E verifies route screen behavior at both Pro Max viewports against a local OSRM fixture, not a contracted production map/routing provider.

**DEMO/TRUTH status:** The core tested API scenarios are PostgreSQL-backed and exercised with isolated test accounts. The native screenshots verify install, launch and first-screen rendering only. No real SMS, live external routing/geocoding, map tile provider, two physical devices, or real-user release scenario was exercised.

**Open issues:** Gate A still needs production SMS sender, HTTPS staging, managed PostGIS/Redis, contracted/self-hosted route/geocoder and map tiles with attribution, private S3 bucket, backup/restore, monitoring/rollback and two real device acceptance. Foreground PWA navigation is not background navigation.

**External dependencies:** SMS provider/sender approval, API/site domains, routing/geocoding/tile hosting, private object-storage configuration, managed database/cache and operational monitoring.

**Next implementation step:** Provision staging with the listed providers, run the two-account acceptance scenario against that real environment, verify map tile attribution/rendering, and keep public production deployment gated until the final checklist is evidenced.

## Phase 3 continuation — 20-way atomic last-seat contention

**Phase:** 3 Offers/Booking; transaction acceptance E07.

**Status:** PARTIAL. The local transaction criterion for simultaneous last-seat requests now matches the 20-request specification. Staging/two-physical-device acceptance remains pending.

**Completed:** Expanded the isolated PostGIS booking integration fixture to 20 distinct passenger accounts. All 20 requests race for one available seat; the test proves one `201`, nineteen `409`, zero remaining seats, one confirmed booking, idempotent replay of the winner, rejection when the same idempotency key is reused with different seat parameters, and exactly one cancellation transition/inventory restoration after a repeated cancellation.

**Modified files:** `tests/api-bookings.integration.test.ts`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None; uses the existing isolated `marshgo_e2e` database and booking schema.

**Endpoints:** Existing `POST /api/v1/bookings` and `POST /api/v1/bookings/:id/cancel`.

**Tests:** `npm run typecheck`, `npm run lint`, and `npm run test:integration` passed. Booking/moderation: 6/6; navigation: 1/1; Redis realtime: 1/1. The contention case sent 20 concurrent API requests from different test users and verified exactly one winner. An initial fixture setup had an untyped SQL parameter and was corrected; the first rerun then exposed a stale display-name assertion, which was corrected. The final full integration rerun passed.

**DEMO/TRUTH status:** This is local PostgreSQL/PostGIS API integration with isolated fixture identities. It verifies the database locking path, not staging load characteristics, managed-database behavior, or a public service.

**Open issues:** Staging and physical two-device acceptance remain absent. Add true load-profile testing before relying on production SLOs; keep provider and release blockers visible.

**External dependencies:** No credentials required for this test. Staging database/host and physical user accounts remain owner-provisioned.

**Next implementation step:** Continue the P0 release-critical path by addressing remaining testable server invariants (offer expiry/status and idempotency persistence across process restart), then return to provider-backed route and staging acceptance when infrastructure is available.

## Phase 3 continuation — expired offer booking guard

**Phase:** 3 Offers/Booking; direct API expiry invariant.

**Status:** PARTIAL. A new booking now fails closed when the published offer's departure has passed. An existing idempotent replay still returns its prior booking, preserving retry semantics.

**Completed:** The transactional booking query locks and reads `departure_at`; before inventory changes or booking creation, the server returns HTTP 409 `offer_expired` for a new request against an elapsed departure. Added an isolated API/PostGIS test that attempts this direct request and proves both seat inventory and booking count remain unchanged.

**Modified files:** `server/index.ts`, `tests/api-bookings.integration.test.ts`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints:** `POST /api/v1/bookings` now returns `409 offer_expired` when a new booking targets an offer whose departure time is not in the future.

**Tests:** `npm run typecheck`, `npm run lint`, `API_TEST_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e npm run test:integration`, `npm test`, and `npm run build` passed. Booking suite: 7/7; navigation: 1/1; cross-instance Redis realtime: 1/1; unit: 12/12. Integration fixtures use only the isolated loopback test database.

**DEMO/TRUTH status:** Expiry is enforced by the real API/PostgreSQL path and regression-tested locally. This does not establish staging uptime or independent-device acceptance.

**Open issues:** Run the new integration case in the standalone server repository CI, then continue idempotency/process-restart and provider-backed route/staging checks.

**External dependencies:** None for the invariant; staging and managed production infrastructure remain owner-provisioned blockers.

**Next implementation step:** Sync the API and test change into `MarshGO-Server`, verify its clean install/CI, and continue remaining release-critical invariants without marking the release ready.

## Phase 3 / 9 continuation — booking durability across API restart

**Phase:** 3 Offers/Booking; 9 reliability and verification.

**Status:** PARTIAL. The local integration suite now proves a persisted booking and its idempotency record survive an actual API process restart. Managed staging restart, backup restoration and multi-host acceptance remain outstanding.

**Completed:** Added an isolated test that creates real PostgreSQL fixtures, starts the API as a child process, books one seat, sends SIGTERM and waits for process exit, starts a fresh API process against the same database, retries the identical idempotency key, and asserts the same booking ID/status, one booking total, and exactly three of four seats remaining. Reusing the key for different seat parameters still returns 409. The integration runner now runs this test after stopping its other API instances.

**Modified files:** `tests/booking-restart.integration.test.ts`, `scripts/run-integration-tests.sh`, `package.json`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None; test data is UUID-scoped in the loopback-only `marshgo_e2e` database and cleaned after the test.

**Endpoints:** Existing `POST /api/v1/bookings`; no API contract change.

**Tests:** `npm run typecheck`, `npm run lint`, and the full `npm run test:integration` passed. Booking API: 7/7; navigation: 1/1; Redis multi-instance: 1/1; restart durability: 1/1. The process restart is observed by the test harness; this is stronger than a page reload but does not verify managed staging availability or backup recovery.

**DEMO/TRUTH status:** The booking and idempotency records are PostgreSQL-backed and verified across two separate server processes. Test identities and local Redis/PostGIS are isolated; no production data or provider credentials are involved.

**Open issues:** Add explicit API-level restart coverage to the standalone server package and CI, then continue staging, restore drill, external route/map configuration, SMS, and physical-device release acceptance.

**External dependencies:** None for local verification. Managed staging/database, backups and restore credentials still require owner-provisioned infrastructure.

**Next implementation step:** Mirror the new restart test and runner command to `MarshGO-Server`, verify standalone CI, then inspect remaining P0 routes for any state transitions that can bypass expiry/capacity checks.

## Phase 3 continuation — participant-authorized booking cancellation

**Phase:** 3 Offers/Booking; cancellation authorization and inventory invariant.

**Status:** PARTIAL. Either booking participant can cancel a confirmed booking; unrelated accounts remain denied. Platform cancellation terms and automated Rescue recovery remain unfinished.

**Completed:** Changed `POST /api/v1/bookings/:id/cancel` to find and lock a booking only when the caller is its passenger or the offer's driver. The production trip UI now offers cancellation to both participants. Added an API integration case that proves a third account receives 404, the driver can cancel, a second request is reported as a replay, and exactly one cancellation event restores the seat once.

**Modified files:** `server/index.ts`, `src/views/ProductionMarketplace.tsx`, `tests/api-bookings.integration.test.ts`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints:** `POST /api/v1/bookings/:id/cancel` now authorizes either participant; response contract is unchanged.

**Tests:** `npm run typecheck`, `npm run lint`, and the full `npm run test:integration` passed. Booking API: 8/8; navigation: 1/1; Redis multi-instance: 1/1; process restart durability: 1/1. The cancellation test verifies an unrelated user cannot cancel and checks database event count and inventory after the driver cancels twice.

**DEMO/TRUTH status:** The permission check and inventory state change are enforced and tested in the authenticated PostgreSQL API. The PWA exposes the action to both participants. No cancellation fee/refund or Rescue alternatives are implied by this change.

**Open issues:** Mirror these API/UI/test changes to the standalone server/site repositories and run their CI; define cancellation timing rules and implement real Rescue search only against verified inventory.

**External dependencies:** No credentials required for participant authorization. Refund handling depends on an actual payment provider/contract, which is not configured.

**Next implementation step:** Publish and verify the mirrored server and site changes, then keep advancing Gate A test cases while preserving the outstanding staging/provider blockers.

## Phase 7 continuation — cancellation Rescue lookup and rebooking

**Phase:** 7 Real-time/Rescue; 5 UI integration.

**Status:** PARTIAL. A passenger can now retrieve currently published MARSHGO Community alternatives after cancelling a confirmed booking and continue to the existing atomic booking flow. This is not the full provider-backed or route-detour-aware Rescue system.

**Completed:** Added an authenticated `GET /api/v1/bookings/:id/rescue` endpoint restricted to the cancelled booking's passenger. It filters real published Community offers by available seats, future departure time window, endpoint proximity (20 km), self-dealing and user blocks, and reports the source/check time and distance. The production PWA displays these results on the cancelled trip and selecting one opens its normal booking detail. Fixed a UI bug where a successful booking could be followed by a failing empty-search refresh and appear unsuccessful. Extended PostGIS integration and browser E2E through cancellation, Rescue display, selection, and a second persisted booking.

**Modified files:** `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/api-bookings.integration.test.ts`, `e2e/marketplace.spec.ts`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints:** `GET /api/v1/bookings/:id/rescue` (new; passenger scoped); existing `POST /api/v1/bookings/:id/cancel`, `GET /api/v1/offers/:id`, and `POST /api/v1/bookings` continue to provide the underlying state changes.

**Tests:** Root `npm run typecheck`, `npm run lint`, `npm test` (12/12), `npm run build`, full `npm run test:integration` (booking 9/9, navigation 1/1, Redis multi-instance realtime 1/1, API restart 1/1), and `E2E_DATABASE_URL=postgres://...@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:e2e` (2/2) passed. The Playwright route view rendered at iPhone 15 Pro Max and 16 Pro Max viewports against the isolated OSRM fixture. The standalone server clone also passed typecheck, unit tests (8/8), and the complete integration suite with the same 9/1/1/1 results; the standalone site passed lint, typecheck, and production build. The Capacitor app built, installed and launched on both named iOS simulators; screenshots `/tmp/marshgo-ios-rescue-iphone15-later.png` and `/tmp/marshgo-ios-rescue-iphone16-later.png` show the welcome screen correctly rendered. This simulator check does not automate taps, OTP or booking inside native WebKit, and the route geometry still comes from a local test fixture rather than a contracted production routing/map service.

**DEMO/TRUTH status:** Rescue cards contain data read from PostgreSQL and use the ordinary authenticated booking API; no partner, taxi, bus or fabricated inventory is presented. The 20 km endpoint radius and time window are a limited prefilter, not proof of a feasible road detour, and results may change between display and booking (the booking transaction revalidates capacity/state).

**Open issues:** Add routing-engine detour feasibility, provider freshness/quote contracts, time-zone-aware cancellation policy/refunds, external partner alternatives, and notification delivery. Complete full-suite reruns and synchronize all changed source/tests/docs to the three standalone repositories before CI verification.

**External dependencies:** No credentials for this local MARSHGO inventory workflow. Contracted partner feeds, managed routing/geocoding, staging infrastructure, SMS and payment providers remain owner-provisioned blockers.

**Next implementation step:** Continue mobile WKWebView interaction tests and route-provider/map validation, then close remaining Gate A staging and external-service blockers. The current GitHub changes and CI runs are already published/verified below.

## GitHub and native build verification — 2026-09-30

Changes were pushed to the existing production work branch and the three focused repositories. GitHub Actions passed for umbrella CI at `f88d6db`, Server CI at `e358ad2`, Site CI at `80631b0`, and the iOS Simulator Build at `ff71161`. The iOS workflow compiled the latest default-branch site bundle and Xcode Simulator target. Umbrella PR #1 remains open as a draft; no production/staging deployment was performed.

The local Capacitor bundle was also installed and launched on iPhone 15 Pro Max and iPhone 16 Pro Max simulators. Both render the reference-aligned welcome screen; this does not verify tapping through sign-in, OTP, booking, maps on a live provider, locked-screen GPS, signing, or App Store distribution. Mobile viewport browser E2E covers route UI at both dimensions using a local routing fixture. Production-grade route tiles/routing, SMS credentials, managed hosting, external commercial providers, and two-account staging acceptance remain blockers.

## Phase 9 continuation — shared Redis API rate limits

**Phase:** 9 Security/reliability; P0 API hardening.

**Status:** PARTIAL. General API and place-search limits now coordinate across server instances when Redis is configured. Trusted-proxy configuration, Redis outage alert/recovery drills and managed production topology remain open.

**Completed:** Added `RedisRateLimitStore` using atomic Redis `INCR` plus window expiry and hashed client keys. The general `/api` limiter and stricter place-search limiter use distinct Redis prefixes; production startup already requires Redis. Local development without Redis retains the in-process development store. Added a test that alternates five unauthenticated requests across two independent API processes under a three-request window and verifies the shared sequence is 404, 404, 404, 429, 429.

**Modified files:** `server/redisRateLimitStore.ts`, `server/index.ts`, `tests/redis-rate-limit-store.test.ts`, `tests/redis-rate-limit.integration.test.ts`, `scripts/run-integration-tests.sh`, `playwright.config.ts`, `package.json`, `docs/SECURITY.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints:** No endpoint contract changes; the existing `/api` limiter now shares counters via Redis.

**Tests:** `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` passed (13 passed, one opt-in API test skipped; a unit test confirms rate limiting rejects when Redis is unavailable). `API_TEST_DATABASE_URL=postgres://...@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:integration` passed booking 9/9, navigation 1/1, Redis realtime 1/1, process restart 1/1, and Redis rate-limit 1/1. The new cross-process test uses real local Redis and isolated loopback APIs. Full browser E2E passed 2/2 after assigning each E2E API process a unique Redis rate-limit namespace.

**DEMO/TRUTH status:** Production API instances share Redis counters; development configurations without Redis are explicitly process-local. This does not establish ingress IP correctness until trusted proxy hops are configured, nor resilience during Redis outages.

**Open issues:** Exercise Redis outage recovery/alerting, configure trusted proxies, run dependency/security checks, sync and publish to standalone Server, and verify CI. Production infra and owner credentials are unchanged blockers.

**External dependencies:** None to verify local cross-instance Redis behavior. Trusted ingress settings and production Redis failover/monitoring require the deployment operator.

**Next implementation step:** Mirror the store, test and integration-runner change to `MarshGO-Server`, run standalone CI, then continue hardening Redis failure handling and routing/matching integration.

## GitHub verification — Redis rate-limit release

**Published:** The shared Redis limiter is pushed to the umbrella `MarshGO` repo on `codex/marshgo-production` (`c836b798`) and to `MarshGO-Server` `main` (`6024bd6d`). The existing standalone `MarshGO-Site` (`80631b0`) and `MarshGO-iOS` (`ff71161`) remain published and their latest workflows are successful.

**CI evidence:** [Umbrella push CI](https://github.com/dima1203oleg/MarshGO/actions/runs/36683056699), [umbrella PR CI](https://github.com/dima1203oleg/MarshGO/actions/runs/36683060533), and [Server CI](https://github.com/dima1203oleg/MarshGO-Server/actions/runs/36683055097) all completed successfully. Latest Site CI `36680728871` and iOS Simulator CI `36680859063` are successful. The iOS workflow compiles against the site bundle; simulator screenshot validation was previously done for iPhone 15 Pro Max and iPhone 16 Pro Max but did not automate login/booking interactions.

**Release status:** Source and CI are published across the three focused repositories (plus the umbrella repository). This is not a production deployment. The draft PR remains open; external service and interactive two-account/mobile acceptance blockers listed above remain unresolved.

## Phase 6 continuation — map tile failure reporting

**Phase:** 6 Navigation; 9 hardening.

**Status:** PARTIAL. The foreground navigation screen now detects tile-provider load failures and reports missing, loading, degraded, or failed street-map layers while retaining the actual route geometry. No provider has been configured, so this change improves failure visibility; it does not supply production map tiles.

**Completed:** Added a small tile-health state reducer and wired Leaflet `tileload` / `tileerror` events into the production navigation UI. A missing provider still has an explicit no-street-layer notice. A configured but unavailable provider now reports the failure instead of leaving a blank/partial map without explanation; a later successful tile load clears the failure/degraded notice.

**Modified files:** `src/views/ProductionNavigation.tsx`, `src/services/mapTileStatus.ts`, `tests/map-tile-status.test.ts`, `e2e/marketplace.spec.ts`, `docs/PRODUCTION_PROGRESS.md`, `docs/PRODUCTION_AUDIT.md`.

**Database changes:** None.

**Endpoints:** None.

**Tests:** `npm run typecheck` passed; `npm run lint` passed; `npm test` passed (15 passed, 1 opt-in API test skipped). `E2E_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:e2e` passed 2/2, including route geometry and mobile viewport checks for both iPhone 15 Pro Max and iPhone 16 Pro Max. Two interim E2E runs exposed that the test's later direct booking call reused a revoked bearer token after the UI had rotated its refresh session. Updated the test to track successful `/auth/refresh` responses and use the latest access token; the full suite then passed 2/2. One earlier reload assertion briefly saw the welcome screen, so session restoration still needs monitoring. The native Capacitor app was rebuilt from Site commit `de7652b`, installed and launched on iPhone 15 Pro Max and iPhone 16 Pro Max simulators, and screenshots after the first-render delay show the reference-aligned welcome view (`/tmp/marshgo-iphone15-maptiles-latest.png`, `/tmp/marshgo-iphone16-maptiles-latest.png`). This simulator run used `http://localhost:3002` but no API was running, so it verifies native rendering only. GitHub Actions passed umbrella push [`36685164024`](https://github.com/dima1203oleg/MarshGO/actions/runs/36685164024) and PR [`36685171108`](https://github.com/dima1203oleg/MarshGO/actions/runs/36685171108), standalone Site [`36684697817`](https://github.com/dima1203oleg/MarshGO-Site/actions/runs/36684697817), and iOS Simulator Build [`36685185436`](https://github.com/dima1203oleg/MarshGO-iOS/actions/runs/36685185436). No live tile/routing provider or real-device GPS was available.

**DEMO/TRUTH status:** Only map-provider health visibility changed. Route geometry in the browser acceptance test is supplied by the local OSRM fixture. Native device GPS, production tiles, voice guidance, and automatic rerouting remain unverified/unavailable.

**Open issues:** Configure an approved map tile provider with required attribution and production routing/geocoding endpoints; add an E2E tile-error simulation against a configured provider; monitor session restoration across repeated reloads; implement reroute/turn guidance and physical-device GPS validation.

**External dependencies:** Contracted/self-hosted tile, routing, and geocoding services; iOS test device or interactive simulator for actual location permission/GPS.

**Next implementation step:** Publish the navigation screen health handling and refreshed-token E2E fix to the standalone Site repository, rebuild the standalone iOS app against that site revision, then add a configured tile-provider error simulation before proceeding with navigation rerouting and end-to-end confirmation.

## Phase 6 continuation — per-tile map health and retry

**Phase:** 6 Navigation; 9 mobile/reliability verification.

**Status:** PARTIAL. Map health now reflects each currently loaded Leaflet tile: a successful tile cannot hide another visible tile's failure. Drivers can explicitly retry a degraded/failed map layer. Actual commercial map tiles still require an approved configured provider.

**Completed:** Added keyed loaded/failed tile tracking and tile-unload cleanup. Added an isolated SVG tile HTTP fixture for E2E only; it can return all-success, mixed success/503, and recovery modes. Extended the two Pro Max viewport scenario to prove real test tiles load, a partial outage produces the degraded message, retry after provider recovery clears it, and route geometry remains rendered on both screen sizes. The first E2E retry attempt exposed that zooming did not guarantee failed visible tiles were re-requested; adding the explicit retry control fixed the user path and made recovery deterministic.

**Modified files:** `src/services/mapTileStatus.ts`, `src/views/ProductionNavigation.tsx`, `tests/map-tile-status.test.ts`, `tests/fixtures/map-tile-server.mjs`, `scripts/build-pwa.mjs`, `playwright.config.ts`, `e2e/marketplace.spec.ts`, `package.json`.

**Database changes:** None.

**Endpoints:** None; the local fixture's `/__test/mode` and `/__test/stats` endpoints are test-only and not part of the app API.

**Tests:** Added `npm run check:production` as the missing repeatable static release check. `npm run check:production` passed typecheck, lint, unit tests (16 passed, one opt-in API test skipped) and production build. Confirmed by searching `dist` that the local E2E tile URL is absent from the production bundle. `E2E_DATABASE_URL=postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:e2e` passed 2/2. It covers independent account booking/negotiation/chat, plus iPhone 15 Pro Max and iPhone 16 Pro Max viewport navigation with tile success → partial failure → retry recovery. The initial E2E recovery assertion failed; the new retry button was added and the full rerun passed. Fresh `npm run build:simulator` compiled with Xcode, installed/launched on iPhone 15 Pro Max and was installed/launched on iPhone 16 Pro Max. After allowing startup, both simulator screenshots show the branded welcome view with safe-area content. No API was running, so simulator screenshots verify first-screen rendering only.

**DEMO/TRUTH status:** Browser E2E uses a deterministic local-only tile fixture; no test tile endpoint is included in standard `npm run build` or the production iOS bundle. This verifies UI failure/retry behavior, not a production basemap. Simulator/viewport routes use isolated local routing/geocoding fixtures and are not proof of live provider service or background GPS.

**Open issues:** Configure contracted/self-hosted routing, geocoding and tile services with attribution; validate provider terms/availability. Implement turn guidance and route rerouting; validate live GPS on physical devices. No live maps provider or device GPS is available in this environment.

**External dependencies:** Approved production map-tile, routing and geocoding provider configuration; physical-device location validation.

**Next implementation step:** Continue with contracted routing/map service setup and live navigation verification; these external dependencies block claims of a fully live basemap or end-to-end real-device navigation.

**GitHub verification:** Published umbrella commit `6219f2b` to `codex/marshgo-production`; its push CI [`36686996373`](https://github.com/dima1203oleg/MarshGO/actions/runs/36686996373) and PR CI [`36687003256`](https://github.com/dima1203oleg/MarshGO/actions/runs/36687003256) passed, including migration, integration tests and browser E2E. Published Site commit `3f000cd`; Site CI [`36686580078`](https://github.com/dima1203oleg/MarshGO-Site/actions/runs/36686580078) passed. Published iOS documentation commit `323f914`; iOS Simulator Build [`36686847575`](https://github.com/dima1203oleg/MarshGO-iOS/actions/runs/36686847575) passed against current Site main. The PR remains draft/open; no public deploy occurred.

## Phase 6 continuation — passenger alert for driver interest

**Phase:** 6 Navigation/matching; 7 realtime delivery.

**Status:** PARTIAL. When a driver expresses interest in a suggested passenger request, the server now records the state/audit event and queues a passenger-only realtime notification atomically. The passenger PWA refreshes its own authorized match list. The subsequent price negotiation and mutual confirmation still require separate actions; driver interest does not create a booking.

**Completed:** Changed the existing interest endpoint to use one PostgreSQL transaction for the candidate transition, audit log, and deduplicated realtime outbox row. The event payload has candidate/demand IDs and status only; no driver identity or precise location is sent. Added a client event type and passenger-side UI resync. Extended the two-API integration flow to connect the passenger's WebSocket to API instance B, submit interest through API instance A, verify cross-instance delivery after outbox publication, and confirm the passenger's authenticated REST list reflects the canonical status. Adjusted the test to wait for durable publication before asserting socket delivery, eliminating a race between observing the database and the separate Pub/Sub subscriber.

**Modified files:** `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `tests/realtime-cluster.integration.test.ts`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None; uses existing `navigation_match_candidates`, `audit_events`, and `realtime_outbox` tables.

**Endpoints:** Existing `POST /api/v1/navigation/sessions/:id/matches/:candidateId/interest`; adds a transactional outbox event, no REST schema changes.

**Tests:** `npm run check:production` passed typecheck, lint, unit tests (16 passed, 1 opt-in DB test skipped), and Vite production build. Full local PostgreSQL/PostGIS/Redis integration passed: booking/negotiation 9/9 (including 20-way last-seat contention), navigation 1/1, cross-instance WebSocket/outbox 1/1 (including driver-interest delivery and expected retry/backoff path), process restart durability 1/1, and shared Redis rate limit 1/1. `E2E_DATABASE_URL=postgres://...@127.0.0.1:5434/marshgo_e2e REDIS_URL=redis://127.0.0.1:6380 npm run test:e2e` passed 2/2: independent-user booking/negotiation/chat and road-map failure/retry at both iPhone Pro Max viewport sizes. The cross-instance test initially timed out while racing the outbox publisher and socket assertion; requiring the durable outbox row to be published before waiting for the socket event resolved the flaky observation, and the full suite then passed. E2E uses isolated local route/tile fixtures; this is not live provider verification.

**DEMO/TRUTH status:** Driver-interest status and passenger alert are persisted and delivered between two local API processes via Redis, then reconciled from authenticated REST. No production Redis, map provider, push service, mutual booking, or full detour route recalculation is configured.

**Open issues:** Add proposal/price negotiation after passenger alert; complete mutual agreement and route waypoint insertion; configure production route/geocoder/map providers, Web Push/inbox, staging, and operational alerting. iOS simulator still proves branded first-screen rendering only; authenticated native gestures, OTP and GPS remain unverified on physical devices.

**External dependencies:** Production Redis/HTTPS staging; contracted or self-hosted routing/geocoding/tiles; SMS credentials; private vehicle-photo bucket; physical-device GPS and device acceptance.

**Next implementation step:** Publish this slice to umbrella and standalone Server/Site repositories, rebuild the Capacitor bundle from the published Site revision, run simulator launch/build workflows for both requested device profiles, and check the resulting GitHub CI before moving to the next matching handshake.

**Publication and device verification:** Published umbrella commit `a21a2b7` on `codex/marshgo-production`, Server commit `a0f7bde` on `MarshGO-Server/main`, and Site commit `03f3027` on `MarshGO-Site/main`. Rebuilt the native Capacitor app using the published Site revision `03f3027`, then installed and launched it on iPhone 15 Pro Max and iPhone 16 Pro Max simulators. Final first-screen captures: `/tmp/marshgo-site03f3027-iphone15.png` and `/tmp/marshgo-site03f3027-iphone16.png`. A first iPhone 16 capture was blank during early WebKit startup; after relaunch and a 10-second wait, both simulators rendered the complete welcome view. No backend/API was running, so this validates native packaging and the first screen only. The local build used Node 25.4.0 while the repository specifies 24.21.0 (engine warning); CI uses its pinned Node version.

**GitHub CI:** Umbrella branch workflow [`36689801958`](https://github.com/dima1203oleg/MarshGO/actions/runs/36689801958) and PR workflow [`36689811065`](https://github.com/dima1203oleg/MarshGO/actions/runs/36689811065), Server [`36689802615`](https://github.com/dima1203oleg/MarshGO-Server/actions/runs/36689802615), Site [`36689801269`](https://github.com/dima1203oleg/MarshGO-Site/actions/runs/36689801269), and iOS Simulator Build [`36690296800`](https://github.com/dima1203oleg/MarshGO-iOS/actions/runs/36690296800) completed successfully. iOS documentation commit `905852e` records the current site bundle and simulator proof. PR #1 remains draft/open; no production hosting, App Store release, or live services were deployed.

**Next implementation step:** Continue the navigation-match handshake into passenger-visible price negotiation and mutual booking, preserving consent and route-detour constraints. Production routing/geocoding/tiles, real SMS, private object storage, staging, Web Push, backups/monitoring, and physical-device GPS remain external or operational gates.

## Phase 6 continuation — candidate-bound price proposal

**Phase:** 6 Navigation/matching; 4 Reverse Market.

**Status:** PARTIAL. The navigation match now opens a price proposal linked to the passenger-confirmed candidate. The server checks the current candidate/session consent, GPS freshness, route version and verified vehicle when creating the proposal, then rechecks them at passenger acceptance. It does not yet update navigation waypoints or recalculate the driver's route after booking.

**Completed:** Added an optional `navigationCandidateId` to proposal creation and persisted it with a unique candidate constraint. The driver action is available from the passenger-confirmed candidate card while navigation is paused; the modal is prefilled from the passenger's demand and labels that the proposal is not a booking. The API rejects proposals before passenger confirmation, after expiry or opt-out, from a wrong driver/vehicle, with insufficient seats, or against a changed route. Passenger acceptance repeats consent/session/vehicle/route checks in the transaction. Added local integration assertions for premature, successful, duplicate, and revoked-consent cases.

**Modified files:** `server/index.ts`, `server/migrations/016_navigation_candidate_proposals.sql`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `src/views/ProductionNavigation.tsx`, `tests/navigation.integration.test.ts`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** Migrations `016_navigation_candidate_proposals.sql` and `017_navigation_candidate_proposal_restrict.sql`; add nullable `proposals.navigation_candidate_id` FK, a partial unique index, and a restrictive delete rule to preserve navigation provenance.

**Endpoints:** `POST /api/v1/demands/:id/proposals` accepts optional `navigationCandidateId`; `POST /api/v1/proposals/:id/accept` revalidates candidate consent and route freshness for linked proposals.

**Tests:** `npm run typecheck`, `npm run lint`, `npm test` (16 passed, 1 database test skipped), and `npm run build` passed. Migration applied to isolated local `marshgo_e2e`. Full `npm run test:integration` passed: booking/negotiation 9/9, navigation candidate-bound proposal flow 1/1, cross-instance realtime 1/1, restart durability 1/1, shared Redis rate limit 1/1. The navigation test verifies no proposal before passenger confirmation, one linked proposal after, duplicate rejection, and acceptance rejection after driver opt-out. The initial integration attempt exposed test cleanup still deleting demand rows before proposals; cleanup now removes the new FK rows first and the full suite passes.

**DEMO/TRUTH status:** Candidate and price proposal are persisted in PostgreSQL and proposal creation is exposed in the PWA. The existing general proposal-accept endpoint still creates a booking, but this increment does not insert the navigation pickup/dropoff into the driver's itinerary or reroute the active session; do not describe navigation pickup as complete. External routing provider contract fixtures are local only.

**Open issues:** Persist pickup/dropoff waypoints for the accepted booking, reroute from the driver's current GPS through those stops to their original destination, return the new route to the navigation UI and update ETA. Add browser E2E for two-account navigation negotiation and verify physical-device GPS behavior.

**External dependencies:** Production routing/geocoding/tiles, real SMS, production Redis/storage/staging, and physical-device GPS permissions remain outstanding.

**Next implementation step:** Complete transactional waypoint insertion and road-route recalculation on navigation-bound proposal acceptance; refuse to claim the driver navigation pickup is operational until both are verified.

**Publication and device verification:** Published umbrella commit `7b5c398` on `codex/marshgo-production`, Server implementation commit `7ba197a` plus API-path correction `18b697a` on `MarshGO-Server/main`, Site commit `2cdc4a2` on `MarshGO-Site/main`, and iOS documentation commit `eedcd4f` on `MarshGO-iOS/main`. The standalone Server initially failed CI because its API implementation had been copied to the repository root rather than `server/index.ts`; the root umbrella was unaffected. Corrected the path, reran Server typecheck, unit tests, and the complete PostgreSQL/PostGIS/Redis integration suite locally, then pushed the fix. Final GitHub runs passed: umbrella push [`36694161846`](https://github.com/dima1203oleg/MarshGO/actions/runs/36694161846) and PR [`36694158725`](https://github.com/dima1203oleg/MarshGO/actions/runs/36694158725), Server [`36695035549`](https://github.com/dima1203oleg/MarshGO-Server/actions/runs/36695035549), Site [`36694337040`](https://github.com/dima1203oleg/MarshGO-Site/actions/runs/36694337040), and iOS Simulator Build [`36694845655`](https://github.com/dima1203oleg/MarshGO-iOS/actions/runs/36694845655). Rebuilt and launched the site revision `2cdc4a2` on both iPhone 15 Pro Max and iPhone 16 Pro Max simulators; captures `/tmp/marshgo-site2cdc4a2-iphone15.png` and `/tmp/marshgo-site2cdc4a2-iphone16.png` show the full welcome screen. No local API was running during the simulator capture, so this is packaging/launch/first-screen evidence only, not signed-in or GPS acceptance.

## Phase 6 continuation — transactional navigation booking and reroute

**Phase:** 6 Navigation/matching; 4 Reverse Market.

**Status:** PARTIAL. Passenger acceptance of a candidate-bound price now commits one booking and extends the driver's stored road route through pickup and dropoff. Matching is turned off for the rest of that navigation session; multi-passenger route stop ordering is deliberately not enabled.

**Completed:** The passenger proposal-accept endpoint obtains a road route for the rider and a full remaining route for the driver before taking database locks, then locks and revalidates the demand, proposal, candidate, session, route version, fresh location, driver consent and verified vehicle. In one PostgreSQL transaction it creates the booking, rider route geometry, conversation, pickup/dropoff waypoint rows, updates the driver's route geometry/distance/duration/version, disables matching and expires competing navigation candidates, and stores a driver-only route-update outbox event. Routing or state change failure rolls back the booking. The driver UI receives the event, refetches the owner-authorized active route, redraws the road polyline and displays a confirmation message. The API rejects a second passenger opt-in until this navigation session ends. The integration test verifies exact waypoint order/coordinates, full route geometry through both stops, route version increment, single booking and matching lockout.

**Modified files:** `server/index.ts`, `server/migrations/018_navigation_waypoints.sql`, `src/services/productionApi.ts`, `src/views/ProductionNavigation.tsx`, `tests/navigation.integration.test.ts`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** Migration `018_navigation_waypoints.sql` adds ordered, booking/candidate-bound pickup/dropoff geography.

**Endpoints:** `POST /api/v1/proposals/:id/accept` now creates the route update for navigation-bound proposals; `PATCH /api/v1/navigation/sessions/:id/matching` rejects another opt-in while agreed waypoints exist. New `navigation.route-updated` outbox event targets the driver only.

**Tests:** `npm run check:production` passed (typecheck, lint, 16 unit tests, 1 database-only skip, production build). `npm run test:e2e` passed 2/2 (two-user marketplace and iPhone 15/16 Pro Max viewport/map route geometry). `npm run test:integration` passed on the latest full retry: booking/negotiation 9/9 (including concurrent last-seat lock), navigation proposal/booking/reroute 1/1, Redis multi-instance realtime 1/1, process restart 1/1, and shared rate limit 1/1. Two earlier full-suite retries hit an existing short Redis-outbox publication timeout in the realtime test; the subsequent full rerun passed. The navigation test's first run exposed test cleanup order after waypoints added a restrictive candidate reference; cleanup was corrected and the final navigation test passed.

**DEMO/TRUTH status:** Booking and route changes persist on the actual local API/PostGIS database, and the OSRM fixture contract supplied an ordered road geometry during test. No live/self-hosted production routing provider is configured. Simulator evidence from this slice only covers app launch/welcome screen; no gesture, OTP, route-update event or physical GPS path was exercised on the simulators.

**Open issues:** Generalized multi-passenger itinerary/matching, live route deviation rerouting/turn instructions, real map tiles/geocoding/routing service, two-account browser navigation E2E, and native simulator authentication/GPS route acceptance remain open. Do not present native background location as available.

**External dependencies:** Production routing/geocoding/map tile provider, production SMS/storage/hosting, and a physical iPhone GPS permission/device pass remain outstanding.

**Next implementation step:** Publish this incremental API+Site change to the umbrella and split repositories, verify GitHub/iOS build checks, then add a safe browser E2E for two independent accounts through navigation candidate confirmation, price proposal, acceptance and persisted reroute.

## Phase 6 continuation — passenger confirmation returns to driver

**Phase:** 6 Navigation/matching; 7 realtime delivery.

**Status:** PARTIAL. The mutual-interest handshake now notifies both participants across API instances. Passenger confirmation is durable and visible to the driver without creating a booking; the driver can then pause safely and explicitly open the passenger demand to send a proposal.

**Completed:** Passenger confirmation now writes candidate state, audit event, and `navigation.match.passenger-confirmed` outbox event to the same transaction, addressed only to the driver. The foreground driver navigation screen reloads its authorized candidate list and shows that the passenger confirmed, while retaining the explicit price-proposal action and safe-stop requirement. The cross-instance integration connects separate driver/passenger sockets to API instance B, writes interest and confirmation through API instance A, validates both minimal participant-scoped events, and checks authorized REST state from both accounts. The test asserts mutual interest does not silently create a booking.

**Modified files:** `server/index.ts`, `src/services/productionApi.ts`, `src/views/ProductionNavigation.tsx`, `tests/realtime-cluster.integration.test.ts`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None; existing candidate, audit and outbox tables.

**Endpoints:** Existing `POST /api/v1/navigation/matches/:candidateId/passenger-confirm`; now atomically writes a passenger-only-to-driver realtime event.

**Tests:** `npm run typecheck` and `npm run lint` passed. Full PostgreSQL/PostGIS/Redis integration passed booking/negotiation 9/9, navigation 1/1, two-way cross-instance realtime 1/1, restart 1/1, and shared rate limits 1/1. The new assertion confirms the driver sees `passenger_confirmed` after another user's explicit confirmation while no navigation booking is created. Browser E2E does not yet exercise this specific navigation acceptance/negotiation path. Existing Pro Max viewport E2E and native welcome screen tests remain the only visual device evidence; they use no production routing or map provider.

**DEMO/TRUTH status:** Both consent states persist in PostgreSQL and are relayed through Redis across two API processes. Price proposal creation remains a separate UI action; final route insertion, driver ETA recomputation and atomic capacity reservation from a navigation match are not implemented.

**Open issues:** Tie the navigation candidate to a specific proposal revision with detour, price and seats; require passenger acceptance before booking; then revalidate capacity and route constraints transactionally. Add a browser E2E across two account contexts and validate on-device GPS.

**External dependencies:** Real SMS/provider keys, approved routing/geocoding/map tile service, production Redis/staging, and physical iPhone GPS permissions remain outstanding for the full navigation journey.

**Next implementation step:** Design and implement candidate-bound price proposal creation with explicit participant acceptance, expiry and seat-capacity checks; do not create a confirmed booking from either party's unilateral click.

**Publication and device verification:** Published umbrella commit `a66af6e` on `codex/marshgo-production`, Server commit `7ed815f` on `MarshGO-Server/main`, and Site commit `7a5540b` on `MarshGO-Site/main`. Built from Site `7a5540b`, then launched the native package on iPhone 15 Pro Max and iPhone 16 Pro Max. Final welcome captures `/tmp/marshgo-site7a5540b-iphone15-retry.png` and `/tmp/marshgo-site7a5540b-iphone16-final.png` show the full brand/splash screen after relaunch/render wait. This does not test native authentication, actual GPS permission, route rendering, or server requests; the API was not running in this check. iOS docs commit `b5f2c1a` records the evidence.

**GitHub CI:** Umbrella push [`36691659138`](https://github.com/dima1203oleg/MarshGO/actions/runs/36691659138) and PR [`36691667665`](https://github.com/dima1203oleg/MarshGO/actions/runs/36691667665), Server [`36691659639`](https://github.com/dima1203oleg/MarshGO-Server/actions/runs/36691659639), Site [`36691658518`](https://github.com/dima1203oleg/MarshGO-Site/actions/runs/36691658518), and iOS Simulator Build [`36692066467`](https://github.com/dima1203oleg/MarshGO-iOS/actions/runs/36692066467) all passed. The pull request remains draft/open; no production site, backend, or App Store release was deployed.

## Phase 4 continuation — competing proposal acceptance race

**Phase:** 4 Reverse Market; exclusive demand resolution.

**Status:** PARTIAL. Two different proposals can no longer be mistaken as independently confirmable when a passenger double-confirms or requests race. Existing demand-row locking serializes acceptance; a regression test now proves the transaction outcome.

**Completed:** Extended the real API/PostGIS negotiation test to create two driver proposals for one passenger demand and submit both passenger acceptance requests concurrently. It asserts one HTTP 201 and one HTTP 409, then queries PostgreSQL to prove the demand is matched, exactly one proposal is accepted, the other is rejected, and only one booking/offer was created. Existing counteroffer agreement and accepted-price tests remain in the same integration flow.

**Modified files:** `tests/api-bookings.integration.test.ts`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None.

**Endpoints:** Existing `POST /api/v1/proposals/:id/accept`.

**Tests:** `npm run typecheck`, `npm run lint`, and `API_TEST_DATABASE_URL=... npm run test:integration` passed. Booking/negotiation: 8/8; navigation: 1/1; Redis multi-instance: 1/1; restart persistence: 1/1. The first typecheck flagged an inferred fetch response as implicit `any`; adding the explicit DOM `Response` type resolved it before the passing rerun.

**DEMO/TRUTH status:** This is a two-request race against the actual local API and PostgreSQL transaction/row locks, using isolated test identities. It is not a production traffic load test.

**Open issues:** Route relevance and detour/time feasibility are not yet enforced for reverse-market proposals; staging and external-provider validation also remain open.

**External dependencies:** None for the transaction invariant. Real routing/geocoding and staging infrastructure remain separately blocked.

**Next implementation step:** Mirror and validate this acceptance-race test in the server repository, then implement/test route relevance with an explicit road-routing provider contract without substituting straight-line distance for route truth.

## Phase 6 continuation — passenger-confirmed route insertion, validation and publication

**Phase:** 6 Navigation/matching; 4 Reverse Market.

**Status:** PARTIAL. A passenger can accept a navigation candidate's price proposal; the API transaction creates exactly one booking, persists pickup/dropoff route waypoints, recalculates the driver's remaining road route, disables further matches for that session, and notifies the driver's UI to refresh. This is the first single-passenger route insertion; full multi-passenger scheduling remains out of scope.

**Completed:** Revalidated the core API transaction and persisted reroute against PostgreSQL/PostGIS and an ordered OSRM-compatible test provider; copied the matching implementation into the Server and Site repositories; rebuilt/installed/launched the Capacitor app on both requested Pro Max simulators and visually checked the welcome screen at each device resolution.

**Modified files:** `server/index.ts`, `server/migrations/018_navigation_waypoints.sql`, `src/services/productionApi.ts`, `src/views/ProductionNavigation.tsx`, `tests/navigation.integration.test.ts`, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `018_navigation_waypoints.sql` adds ordered geography pickup/dropoff records bound to booking and navigation candidate.

**Endpoints/events:** `POST /api/v1/proposals/:id/accept` atomically creates booking + waypoints + driver-route update; `PATCH /api/v1/navigation/sessions/:id/matching` refuses a second opt-in for a route that already has an agreed passenger. Driver-only outbox event: `navigation.route-updated`.

**Tests:** Main workspace `npm run check:production` passed (typecheck, lint, 16 unit tests, one database-only skip, production build); `npm run test:integration` passed booking/negotiation 9/9, navigation 1/1, multi-instance realtime 1/1, restart 1/1, rate limit 1/1; Playwright E2E passed 2/2 (two-user marketplace and Pro Max viewport/route-geometry checks). Standalone Server `npm run typecheck`, `npm run test` (9 pass, 1 opt-in integration skip) and complete `npm run test:integration` passed. Server CI run [`36697101588`](https://github.com/dima1203oleg/MarshGO-Server/actions/runs/36697101588) and Site CI run [`36697110670`](https://github.com/dima1203oleg/MarshGO-Site/actions/runs/36697110670) passed. Standalone Server has no lint script; its typecheck and test jobs are the available checks. iOS simulator Xcode builds/install/launch passed on iPhone 15 Pro Max and iPhone 16 Pro Max. Captures: `/tmp/marshgo-navroute-iphone15.png`, `/tmp/marshgo-navroute-iphone16-final.png`; the 16 Pro Max required relaunch/wait after an early blank WKWebView capture. iOS Simulator Build CI run [`36697452523`](https://github.com/dima1203oleg/MarshGO-iOS/actions/runs/36697452523) passed. Umbrella push run [`36697551662`](https://github.com/dima1203oleg/MarshGO/actions/runs/36697551662) and PR run [`36697558917`](https://github.com/dima1203oleg/MarshGO/actions/runs/36697558917) both passed lint, typecheck, unit/integration suites, build and Playwright E2E.

**DEMO/TRUTH status:** Server booking, waypoints and new route geometry are durable; unit and integration tests use an isolated local routing fixture. The iOS simulator verifies first-screen render only; it was built with `http://localhost:3306` and no API process, so native OTP, live map tiles, GPS and authenticated route-update interaction were not tested. Node 25.4.0 was used locally and emitted an engine warning against the repo's Node 24.21.0 pin; GitHub CI uses the pin.

**Open issues:** A contracted/self-hosted geocoder, routing engine and map tiles are unconfigured. Generalized multi-passenger insertion, live deviation rerouting/turn instructions, real device GPS/permission verification and native two-account end-to-end navigation remain open. External SMS, photo storage, staging/production hosting and partner APIs also remain blockers. The PWA does not provide guaranteed background GPS.

**External dependencies:** Routing/geocoding/map-tile provider credentials or hosted service, SMS sender credentials, private object storage, staging/production environment, and physical-device GPS checks.

**Publication:** Server `bbea24b` pushed to `MarshGO-Server/main`; Site `50816d7` pushed to `MarshGO-Site/main`; iOS verification documentation `647ffbb` pushed to `MarshGO-iOS/main` (iOS CI pending). The umbrella changes are on `codex/marshgo-production`; do not merge PR or deploy production.

**Next implementation step:** Add a Playwright two-account acceptance journey from route candidate confirmation through proposal and booking/reroute, then implement multi-passenger route stop ordering only after the provider-backed route test is reliable.

## Phase 6 continuation — browser acceptance and realtime outbox repair

**Phase:** 6 Navigation/matching; 7 realtime; 9 mobile and E2E verification.

**Status:** PARTIAL. The core browser flow now passes on the production PWA build with two isolated accounts; an outbox row decoder defect that prevented fresh navigation events from publishing is fixed and verified across two API instances.

**Completed:** Added Playwright coverage for a driver starting foreground road navigation, explicitly opting into route matching, and a second account publishing a geographically compatible demand. The driver expresses interest while safely stopped; the passenger confirms; the driver sends a candidate-bound price; the passenger accepts; PostgreSQL contains one confirmed booking and ordered pickup/dropoff waypoints; after browser reload the driver's real route geometry changes and matching stays disabled. Captured viewport and map geometry checks for iPhone 15 Pro Max and iPhone 16 Pro Max presets. The E2E booking assertion now waits for the actual POST response and checks returned booking identity, inventory and persisted rows. Increased the isolated E2E-only global API request budget to avoid false throttling from map/GPS polling without changing runtime defaults. Diagnosed and fixed the realtime outbox worker's `uuid[]` recipient handling/query decoder and made event-type vs recipient validation errors explicit.

**Modified files:** `server/index.ts`, `e2e/marketplace.spec.ts`, `playwright.config.ts`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** None. Existing outbox recipient arrays are returned to Node as `text[]` for reliable delivery.

**Endpoints/events:** Existing driver-interest/passenger-confirm, navigation proposal creation and proposal acceptance endpoints; persisted `navigation.match.driver-interested`, `navigation.match.passenger-confirmed`, and `navigation.route-updated` events now pass through the outbox worker.

**Tests:** `npm run check:production` passed (typecheck, ESLint, 16 unit tests passed, one DB-only test skipped, production PWA build). `npm run test:integration` passed bookings/negotiation 9/9, navigation 1/1, cross-instance WebSocket/outbox 1/1, restart persistence 1/1, shared Redis rate limit 1/1. Full production-build Playwright E2E passed 3/3: two-account marketplace/rescue/chat, two-account navigation→mutual confirmation→price→booking→reroute, and foreground route/map viewport checks on iPhone 15 Pro Max and 16 Pro Max. Test routing, map tiles and geocoding use local deterministic provider fixtures; simulator screenshots still do not establish physical-device GPS or contracted map/routing service operation.

**DEMO/TRUTH status:** These browser flows use the production PWA bundle and local authenticated API/PostGIS, not `localStorage` seeded fixtures. Device presets run in Chromium emulation. Native UI previously launched on both Xcode simulators, but native auth/GPS and physical iOS navigation remain unverified.

**Open issues:** Production SMS, contracted/self-hosted routing, geocoding and map tiles, private S3 storage, staging/production hosting, background iOS GPS, full payment and partner contracts, multi-passenger stop scheduling and load/restore evidence remain open. Do not describe the product as production-ready.

**External dependencies:** SMS provider credentials, routing/geocoder/tile hosting, object storage, production Redis/database/monitoring/backup, partner agreements, Apple signing/release credentials, and real-device GPS testing.

**GitHub CI:** Umbrella push run [`36701646951`](https://github.com/dima1203oleg/MarshGO/actions/runs/36701646951), draft PR run [`36701652704`](https://github.com/dima1203oleg/MarshGO/actions/runs/36701652704), and Server run [`36701692148`](https://github.com/dima1203oleg/MarshGO-Server/actions/runs/36701692148) all passed, including CI migrations/integration and the umbrella Playwright suite.

**Next implementation step:** Continue Gate A hardening for provider-backed maps/routing, physical-device location permissions, external SMS/storage and staging/backup; keep the split Server and Site repositories aligned when their respective code changes.

## Phase 7 continuation — Community fee snapshots and isolated acceptance DBs

**Phase:** 7 Monetization/security; 9 test isolation.

**Status:** PARTIAL. Every current first-party direct or negotiated booking now records a server-calculated immutable 0% Community fee snapshot. Commercial pricing and payment remain disabled pending an approved agreement/provider.

**Completed:** Added a fail-closed `FeeEngine` for integer minor units. It accepts only the configured `community` fee class, sets `platform_fee_minor=0`, preserves the full gross amount as the driver amount and records `community-0pct-v1`; it never reads a client-provided fee. Additive migration `019_booking_fee_snapshot.sql` adds the columns/check and a PostgreSQL trigger preventing later snapshot edits. Direct booking and demand-proposal acceptance calculate the rule inside their transaction and return it through booking DTOs; API integration and browser E2E assert the values. Independently named loopback DBs prefixed `marshgo_e2e_` allow clean-schema tests without contending with the user's running API.

**Modified files:** `server/fees.ts`, `server/index.ts`, `server/migrations/019_booking_fee_snapshot.sql`, `src/services/productionApi.ts`, `scripts/ensure-e2e-database.ts`, `scripts/run-integration-tests.sh`, `tests/fees.test.ts`, `tests/api-bookings.integration.test.ts`, `e2e/marketplace.spec.ts`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/PRODUCTION_AUDIT.md`, `docs/PRODUCTION_CHECKLIST.md`, `docs/PRODUCTION_PROGRESS.md`.

**Database changes:** `019_booking_fee_snapshot.sql` adds immutable `fee_class`, `platform_fee_minor`, and `fee_rule_version` columns with a check constraint to `bookings`.

**Endpoints:** Existing direct `POST /api/v1/bookings` and negotiated `POST /api/v1/proposals/:id/accept` now calculate and return the authoritative fee snapshot.

**Tests:** `npm run check:production` passed (typecheck, lint, 18 tests passed, one opt-in DB-only test skipped, PWA build). On a newly created `marshgo_e2e_fee2` loopback DB, all migrations `001`–`019` applied; integration suites passed bookings/negotiation 9/9 (including rejection of a direct SQL fee snapshot mutation), navigation 1/1, cross-instance realtime/outbox 1/1, restart persistence 1/1, rate limit 1/1. `npm run test:e2e` passed 3/3, including fee snapshots for direct and navigation-linked bookings and the two Pro Max viewport checks. The older shared `marshgo_e2e` DB had an already-running API process; test isolation avoided contention without stopping it.

**DEMO/TRUTH status:** First-party Community bookings are server-priced and carry a 0% snapshot; no online money transfer occurs. No commercial/partner percentage is configured, no fee ledger/settlement or payment provider exists. The new clean local DB is for tests only, not staging.

**Open issues:** Contract-backed commercial fees, online payments/webhooks/refunds, production SMS/routing/geocoding/tile/photo-storage services, physical-device GPS, staging/backup/monitoring and multi-passenger matching remain incomplete.

**External dependencies:** Commercial fee agreements, payment provider contract/credentials, real SMS sender, approved routing/geocoder/map tile service, private storage, and staging/production host access.

**GitHub:** Root commits `7d874df` and `9693c68` are pushed to the development branch; Server commits `51aa4b6` and `39c3c35` are pushed to Server `main`; Site commit `3e3e703` is pushed to Site `main`. Final code CI passed in Root [`36704443948`](https://github.com/dima1203oleg/MarshGO/actions/runs/36704443948) and Server [`36704465311`](https://github.com/dima1203oleg/MarshGO-Server/actions/runs/36704465311); Site CI [`36703831012`](https://github.com/dima1203oleg/MarshGO-Site/actions/runs/36703831012) passed for its DTO change. The primary PR remains a draft; no public deploy has occurred.

**Next implementation step:** Continue Gate A security/reliability work. Live infrastructure and physical-device dependencies remain blockers; no production release claim is made.

## Phase 9 continuation — Production startup guard

**Phase:** 9 Hardening.

**Status:** PARTIAL. Added a fail-closed startup validator so the API cannot enter production with development OTP/auth bypass, a weak or absent session secret, implicit/local HTTP web origins, wildcard CORS, or missing real SMS provider credentials.

**Changed files:** `server/config.ts`, `server/index.ts`, `tests/config.test.ts`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md`. Also made SIGTERM/SIGINT wait for the active outbox dispatch before closing the PostgreSQL pool, fixing a normal-shutdown race surfaced by integration logs.

**Tests:** `npm run check:production` passed (22 tests passed, one opt-in DB test skipped; typecheck/lint/PWA build clean). `npm run test:integration` passed all booking 9/9, navigation 1/1, multi-instance realtime 1/1, restart 1/1, and rate-limit 1/1 suites after the shutdown change, with no pool-after-end shutdown error. Server repo typecheck/unit (15 passed, one DB-only skipped) and full integration suites passed. No SMS was sent; config test credentials are in-memory placeholders only.

**External blockers:** A production web origin, Twilio account credentials, a secret manager, shared Redis, database, routing/geocoding/map tile and object-storage providers must be supplied before a production API can start.

**GitHub:** Root commit `2df5ab8` and Server commit `f967576` are pushed. Root CI [`36705163160`](https://github.com/dima1203oleg/MarshGO/actions/runs/36705163160) and Server CI [`36705191016`](https://github.com/dima1203oleg/MarshGO-Server/actions/runs/36705191016) passed including integration suites.

**Next step:** Continue P0 operational hardening. Production still requires the real secrets/providers listed above; local CI config used placeholders only and did not contact Twilio.

## Multimodal expansion — Journey Phase A/B foundation

**Status:** PARTIAL. Started the additive Journey layer in MarshGO-Server and synchronized the same implementation into this umbrella workspace. Existing Offer, Booking, Demand, Proposal and Navigation domains remain intact.

**Implemented:** Added persisted Journey, ordered JourneyLeg and preference models; server-side FASTEST/CHEAPEST/BALANCED/PREMIUM/RELIABLE/CUSTOM scoring; uncertainty-aware transfer feasibility; provider contracts; authenticated Community-only Journey search/history/detail endpoints; and a privacy-filtered public offer-detail endpoint. Added a production site form/results panel for real geocoded Journey searches, priority selection, honest blocked-provider disclosure, and handoff to the existing booking screen. Search persists a plan snapshot and labels unbooked prices ESTIMATED. Server report: `docs/MULTIMODAL_PROGRESS.md`.

**Changed files:** `server/migrations/020_journeys.sql`, `server/journey/*`, `server/providers/types.ts`, `server/index.ts`, Journey tests and integration wiring, `docs/API.md`, `docs/DATA_MODEL.md`, `docs/MULTIMODAL_PROGRESS.md`, and the umbrella test script in `package.json`.

**Tests:** Server typecheck and unit suite passed (24 passed, one opt-in DB test skipped); isolated PostGIS migration/schema test passed; full API booking/search/detail, navigation, realtime, restart and rate-limit integration suites passed; Site typecheck/lint/build passed; umbrella `npm run check:production` passed; Playwright E2E passed 4/4, including Journey search/persistence/offer-detail handoff, two-user booking/chat, mutual navigation-match flow, and iPhone 15 Pro Max / 16 Pro Max viewport rendering.

**Limitations:** Planner currently returns direct Community legs only; plans do not yet track bookings or replan. There is no walking/transit/taxi/rail inventory, Journey history/active-trip UI, persisted inbox/push, future transfer matching, monitor/replanning, or multi-passenger stop optimizer. External provider integration remains blocked on contracts/credentials. No staging or production deployment occurred.

**Next step:** Connect selecting/bookable Journey legs to existing booking transactions, then implement future Community matching with ETA uncertainty and continue provider-independent Journey monitoring/replanning.

## Multimodal expansion — Journey booking lifecycle binding

**Status:** PARTIAL. Journey-planned Community legs can now pass through the existing transactional booking service. This does not yet add multi-leg journeys or replanning alternatives.

**Implemented:** `POST /api/v1/bookings` optionally accepts paired Journey and leg IDs, verifies Journey ownership and selected single-leg state inside the existing seat-lock transaction, freezes the server-calculated price on the leg, associates the booking and moves the Journey to `READY`. Idempotency replays validate the original Journey association. Cancellation remains idempotent, returns seats once, transitions a linked leg to `CANCELLED` and its Journey to `REPLANNING`, and emits owner-scoped `journey.updated`. The site sends the link from the chosen result through its normal booking flow.

**Changed files:** `server/index.ts`, `tests/api-bookings.integration.test.ts`, `src/services/productionApi.ts`, `src/views/JourneyResultsPanel.tsx`, `src/views/ProductionMarketplace.tsx`, `e2e/marketplace.spec.ts`, `docs/API.md`, `docs/MULTIMODAL_PROGRESS.md`.

**Database/API changes:** No migration required; the existing Journey foreign keys and Community booking fee snapshots are reused. Changed `POST /api/v1/bookings`, `POST /api/v1/bookings/:id/cancel`; added the supported realtime event `journey.updated`.

**Tests:** Server typecheck and unit tests passed (24 passed, one opt-in DB-only test skipped). Real PostGIS/Redis integration passed: Journey schema 1/1, core booking/search/negotiation 10/10, navigation 1/1, cross-instance realtime 1/1, restart 1/1, rate-limit 1/1. These include 20 concurrent last-seat attempts, Journey price locking, idempotency mismatch rejection, double cancellation and Journey event privacy. Site typecheck/lint/build passed. Umbrella `npm run check:production` passed (31 unit tests, one opt-in DB-only test skipped), integration suites passed, and Playwright E2E passed 4/4 including persisted Journey `READY` after booking.

**Demo/truth status:** Community search and booking use persisted database records. Bus, transit, taxi, rail, walking legs, future transfer matching, Journey monitor/replanning and push remain unavailable and are not presented as live options.

**External blockers:** Provider feeds/contracts, staging credentials/infrastructure, SMS and routing/geocoding service credentials remain outstanding.

**iOS simulator:** Rebuilt the current Site bundle in Capacitor, installed/launched on iPhone 15 Pro Max and iPhone 16 Pro Max simulators, and visually verified the Welcome screen. Cold WebKit launch needed about 20 seconds before first paint. Captures: `/tmp/marshgo-iphone15-production-latest.png`, `/tmp/marshgo-iphone16-production-latest.png`. This verifies packaging/startup/rendering only; login, live API booking and device GPS were not exercised in native UI on these simulators.

**GitHub:** Server commit `5e3147d` is on `MarshGO-Server/main`; Site commit `57f1309` is on `MarshGO-Site/main`; umbrella commit `86575a9` is on `MarshGO/codex/marshgo-production`. Server CI [`36713598722`](https://github.com/dima1203oleg/MarshGO-Server/actions/runs/36713598722), Site CI [`36713619301`](https://github.com/dima1203oleg/MarshGO-Site/actions/runs/36713619301) and umbrella workflows [`36713641749`](https://github.com/dima1203oleg/MarshGO/actions/runs/36713641749) / [`36713636817`](https://github.com/dima1203oleg/MarshGO/actions/runs/36713636817) all passed. Existing PR #1 remains a draft; no deployment occurred.

**Next step:** Continue future Community transfer matching using arrival uncertainty windows, then add predictive re-planning and provider-independent journey monitoring.

## Multimodal expansion — persisted Journey history in the app

**Status:** PARTIAL.

**Implemented:** The Site now fetches the signed-in user's saved Journey history from `GET /api/v1/journeys/me` at session restore and login. The Trips screen shows stored plan state, origin/destination, Kyiv-local departure time, passenger count, confirmation vs estimated fare, and persisted leg/booking state. Owner-only `journey.updated` events refresh that list. Logging out clears it from UI memory. When a linked booking is cancelled, the backend also clears the previous planned/confirmed total; the UI states that a new price will follow replanning instead of retaining a stale fare.

**Changed files:** `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `e2e/marketplace.spec.ts`.

**Tests:** Root typecheck/lint passed; `npm run check:production` passed (31 unit tests, one opt-in DB-only test skipped; production build passed); isolated PostgreSQL/PostGIS + Redis integration suites passed; Playwright E2E passed 4/4, including showing a persisted Journey as `Маршрут готовий`, cancelling its booking, and showing `REPLANNING` without the stale fare.

**Next step:** Continue the future Community transfer matcher only when there is a real predecessor leg schedule and uncertainty source. No current Bus/GTFS partner feed exists, so Bus-to-Community future-transfer inventory remains unavailable.

## Multimodal expansion — persistent notification inbox

**Phase:** G (partial).

**Completed:** Added persistent per-user inbox records projected idempotently from the transactional realtime outbox; authenticated pagination, unread counts, per-item and bulk read APIs; safe notification projection that excludes chat content and personal details; and a Site inbox sheet with unread badge and realtime refresh.

**Changed files:** `server/migrations/021_user_notifications.sql`, `server/notifications.ts`, `server/index.ts`, `tests/notifications.test.ts`, `tests/api-bookings.integration.test.ts`, `src/services/productionApi.ts`, `src/views/ProductionMarketplace.tsx`, `docs/API.md`, `docs/MULTIMODAL_PROGRESS.md`.

**Database/API changes:** Migration `021_user_notifications.sql`; `GET /api/v1/notifications`, `POST /api/v1/notifications/:id/read`, `POST /api/v1/notifications/read-all`.

**Tests:** Root unit suite passed (33 passed, one opt-in DB test skipped); root and standalone Site typecheck/lint/build passed. Real PostGIS/Redis integration remains to be rerun with migration 021 before considering this slice verified end-to-end.

**Demo/truth status:** Inbox items originate from server outbox events and persist in PostgreSQL; unread state is server-owned. No Web Push/APNs delivery is connected. Predictive Journey notifications are not yet available because live Journey monitoring/replanning is not implemented.

**External dependencies:** APNs credentials and physical-device push entitlement/testing for iOS push; staging domain and HTTPS endpoints for real cross-device release tests.

**Next implementation step:** Run the migration and API integration tests on an isolated PostGIS/Redis database, then implement a Journey monitor/event source before emitting future-transfer or predictive-rescue notifications.

## Multimodal expansion — multi-passenger navigation

**Phase:** E (partial).

**Completed:** Added migration `022_multi_passenger_navigation.sql`; real-road stop insertion optimizer with segment seat checks and pickup-before-dropoff ordering; transactional multi-rider navigation proposal acceptance with waypoint snapshot locking/rebuild; GPS stop-arrival state; driver can explicitly re-enable matching between passengers.

**Changed files:** `server/index.ts`, `server/routing.ts`, `server/navigation/stopOptimizer.ts`, `server/migrations/022_multi_passenger_navigation.sql`, `tests/navigation.integration.test.ts`, `tests/navigation-stop-optimizer.test.ts`, `tests/routing.test.ts`, `tests/fixtures/osrm-stub.mjs`, `scripts/run-integration-tests.sh`, `docs/API.md`, `docs/MULTIMODAL_PROGRESS.md`.

**Database/API changes:** Migration 022 adds waypoint `state`, allows up to 30 waypoint ordinals, and persists candidate insertion ordinals. Existing navigation matching and proposal acceptance APIs now handle more than one rider per active route; no new endpoint.

**Tests:** `npm run check:production` passed (36 unit tests; one opt-in DB test skipped; ESLint and production build passed). Fresh isolated PostGIS/Redis database `marshgo_e2e_multinav`: migrations 001–022; Journey schema 1/1, booking/search/negotiation 10/10, navigation with two passenger accounts 1/1, cross-instance realtime 1/1, restart durability 1/1, rate limits 1/1.

**Demo/truth status:** The exercised navigation API flow uses persisted accounts/demands/bookings and an isolated local OSRM-compatible fixture. It is not evidence of production routing SLA or physical-device GPS quality.

**External dependencies:** Contracted routing and geocoding services, SMS credentials, map tiles, S3, staging infrastructure, APNs/push credentials, GTFS/ticket/taxi provider agreements, and physical-device TestFlight acceptance remain outstanding.

**Next implementation step:** Journey live monitor and multi-leg predictive replanning; future community-leg matching remains unavailable until a real predecessor schedule and ETA uncertainty source exist.

## Multimodal expansion — persisted Journey lifecycle

**Phase:** D (partial).

**Completed:** Journey-bound bookings now propagate the signed boarding/start/completion flow to Journey and leg states. Start records actual departure and publishes `journey.started` and `journey.leg.started`. Completion after both parties confirm records actual arrival, completes the leg, and moves the Journey to the next waiting transfer leg or `COMPLETED`. Lifecycle notifications use the persistent inbox and contain no GPS details.

**Changed files:** `server/index.ts`, `server/notifications.ts`, `tests/api-bookings.integration.test.ts`, `tests/notifications.test.ts`, `docs/API.md`, `docs/MULTIMODAL_PROGRESS.md`.

**Database/API changes:** No migration or new endpoint. Existing booking lifecycle endpoints now update linked Journey records in the same transaction.

**Tests:** Root typecheck/unit passed (37 passed, one optional integration skip). Isolated PostGIS/Redis integration passed Journey schema 1/1, booking/Journey lifecycle 10/10, navigation 1/1, Redis realtime 1/1, restart 1/1, rate limit 1/1.

**Demo/truth status:** Lifecycle was verified against persisted PostgreSQL Journey/booking data and a signed local test ticket. It does not validate a live transit ETA feed or physical GPS.

**External dependencies:** Live transit/taxi/rail/GTFS and contracted routing services, staging infrastructure and physical-device/TestFlight acceptance remain outstanding.

**Next implementation step:** Build the Journey monitor around real and freshness-bounded leg ETA observations, then evaluate downstream transfer risk and safe re-planning. Until an external schedule source is connected, no future bus-to-Community candidate is exposed.

**Verification update:** Created fresh loopback database `marshgo_e2e_notifications` and applied migrations 001–021 successfully. Full `E2E_DATABASE_URL=postgres://…/marshgo_e2e_notifications REDIS_URL=redis://127.0.0.1:6380 npm run test:integration` passed: Journey schema 1/1, booking/search/negotiation/Journey inbox 10/10, navigation 1/1, Redis cross-instance realtime 1/1, restart durability 1/1, and rate limiting 1/1. Root unit tests/typecheck/lint/build and standalone Site typecheck/lint/build passed. Playwright E2E passed 4/4; the Journey test opens the inbox, checks saved booking/replanning events, and marks an item read. One test expectation was corrected from three to four notifications because the lifecycle emits booking confirmed/cancelled plus Journey READY/REPLANNING events; final rerun passed.

**CI correction:** The first GitHub run exposed equal `created_at` values for realtime events inserted within the same DB transaction, which made same-transaction inbox ordering unstable. Outbox creation now uses `clock_timestamp()` and the durable inbox stores that source timestamp, preserving READY → cancellation → REPLANNING event order. The CI check is rerun with this fix.

**Verification after CI ordering fix:** Full isolated PostGIS/Redis integration rerun passed: Journey schema 1/1, API booking/search/negotiation/inbox 10/10, navigation 1/1, cross-instance realtime 1/1, restart persistence 1/1, rate limits 1/1. Root and standalone Server typecheck/unit suites passed (33 root unit pass with one opt-in DB skip; 26 Server unit pass with one opt-in DB skip). New GitHub CI for the ordering correction is pending.
