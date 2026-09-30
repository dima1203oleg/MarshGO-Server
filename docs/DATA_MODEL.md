# MARSHGO data model status

The PostgreSQL schema is managed by ordered SQL migrations in `server/migrations/`. Local state was created with PostGIS; production data must not be seeded from `src/data/seedData.ts`.

## Implemented tables

| Domain | Tables | Current invariants |
| --- | --- | --- |
| Identity | `users`, `user_roles`, `sessions`, `otp_challenges`, `driver_profiles`, `verification_records`, `account_deletion_requests` | Unique E.164 phone; roles are normalized; access and refresh credentials are hashed; OTP challenge expiry and attempt state are stored. |
| Garage | `vehicles`, `vehicle_photos` | Owner FK; seat bounds; one active non-archived car per owner; archive preserves historic references. Photo metadata exists, upload/storage does not. |
| Marketplace | `offers`, `bookings`, `booking_events`, `booking_completion_confirmations`, `reviews` | Offer points and optional road LineString use SRID 4326; prices are integer minor units; capacity is checked; booking idempotency is unique per passenger; state transitions and two-party completion confirmations are persisted; reviews require completed bookings. |
| Demand | `passenger_demands`, `proposals`, `proposal_revisions` | Time window and passenger bounds; total/per-seat budget basis, notes, JSON requirements; immutable price/time and driver-agreement revisions; one accepted proposal per demand. |
| Navigation | `navigation_sessions`, `navigation_match_candidates`, `navigation_waypoints` | Owner-only current GPS and road route; opt-in candidates; candidate-bound proposal provenance; agreed pickup/dropoff persisted in order with booking and route version. One matched passenger per route session. |
| Messaging | `conversations`, `conversation_members`, `messages` | Conversation membership binds access to booking participants; message bodies have length constraints. |
| Realtime delivery | `realtime_outbox` | Chat, booking and proposal event plus recipient snapshot commit in the corresponding domain transaction; unique dedupe key; leased `SKIP LOCKED` delivery, exponential retry and published state; published payloads are pruned after seven days. |
| Safety | `moderation_cases` | Private booking-linked report, derived counterpart, reviewer, bounded resolution action/note, terminal state and queue indexes; partial uniqueness prevents duplicate open reports for one booking. |
| Operations | `audit_events` | Critical backend actions are recorded with actor, entity, action, and timestamp. |

## Migration history

* `001_initial.sql` — PostGIS, users, vehicles, offers, bookings, demand, proposals, chat, OTP/session baseline, and audit events.
* `002_reverse_marketplace.sql` — proposal vehicle/time fields, revisions, accepted-proposal uniqueness.
* `003_identity_auth.sql` — normalized roles, account state, refresh sessions, verification and deletion records.
* `004_vehicle_garage.sql` — active/archived car state and owner indexes.
* `005_offer_routes.sql` — route-derived arrival, distance, duration, and source.
* `006_vehicle_photo_primary.sql` — at most one primary image per vehicle.
* `007_booking_lifecycle_reviews.sql` — boarding/in-progress states, immutable booking transitions, two-party completion, and completed-booking reviews.
* `008_demand_details.sql` — passenger budget basis, notes, and JSON requirement flags.
* `014_realtime_outbox.sql` — transactional realtime event outbox with recipient IDs, deduplication, worker lease/retry state, and retention index.
* `015_moderation_cases.sql` — private booking-scoped reports, reviewer assignment, decision constraints, and queue indexes.

## Not yet modeled or incomplete

Migrations `010_navigation_sessions.sql`, `011_navigation_retention.sql`, and `012_navigation_matching.sql` add owner-scoped foreground navigation sessions with road geometry, destination point/label, route distance/duration/version, opt-in flag (false by default), verified vehicle/capacity snapshot, and the latest GPS point/accuracy/time. GiST indexes support route and current-location queries, and a partial unique index permits one active/paused session per driver. `navigation_match_candidates` persists a single current candidate per session/demand with route version, measured road detour, pickup ETA, state and short expiry. The latest precise point is intentionally not an event history: it is deleted along with destination label/coordinates and route geometry at session end or after five minutes without a GPS update.

Migrations `016_navigation_candidate_proposals.sql` and `017_navigation_candidate_proposal_restrict.sql` add an optional FK from `proposals` to a navigation candidate and a partial unique index so a candidate cannot generate multiple proposals. The restrictive FK preserves provenance: deleting the candidate/session cannot silently turn a navigation proposal into a normal proposal. Navigation-bound proposals are valid only while the candidate remains passenger-confirmed, unexpired, route-version current, and tied to the paused, opted-in driver's fresh-location session and verified active vehicle.

Migration `018_navigation_waypoints.sql` stores agreed pickup/dropoff coordinates, ordinal, booking and source candidate. Passenger proposal acceptance recomputes passenger and driver road geometry, creates the booking and waypoints, updates navigation route/distance/duration/version, and disables matching in that session in one database transaction. `navigation.route-updated` tells the driver UI to refetch its authorized navigation session. This first implementation does not support a second matched passenger on the same route.

The `user_blocks` table stores private directional pairs with a composite primary key and cascading user deletion; application policy treats a pair as mutually unavailable for negotiations, chat, and route matching. `moderation_cases` supports report intake and staff review, but does not replace a staffed safety-response policy or incident escalation. The outbox now covers chat, booking, proposal, navigation-consent and navigation-route-update events; Web Push, persistent user notification inbox, and missed-event replay do not yet exist. No persistent geocoder place registry, generalized multi-passenger stop ordering, vehicle photo object lifecycle/cleanup job, historical location-event retention, push subscriptions, partner inventory, financial ledger, or migration rollback rehearsal exists yet. These are tracked as incomplete in `docs/PRODUCTION_AUDIT.md` and must not be inferred from UI components.
