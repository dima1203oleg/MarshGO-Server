# Rendezvous implementation progress

## Phase 1 — booking-bound backend foundation

**STATUS: PARTIAL**

### Implemented

- Migration: `023_rendezvous_sessions.sql`; one session is bound to a booking and can reference its Journey leg.
- Participant-only API: create/read session, activate location sharing, submit latest location, report status, confirm boarding handshake, and end rendezvous.
- Location consent starts no earlier than the server-configured lead time (default 15 minutes). Location sharing is off by default and is disabled in the same transaction as booking cancellation or completion.
- Current driver and passenger locations are held only in Redis for five minutes. Ephemeral location messages bypass durable outbox/inbox. PostgreSQL stores only pickup geography and explicit state-transition timestamps/metadata, never a participant coordinate history.
- GPS samples are validated for range, accuracy and age. Geofence proximity is a suggestion only; participants must explicitly confirm arrival. Poor GPS accuracy cannot infer arrival.
- Status events are transactionally persisted and delivered to both booking participants. Each request rechecks booking participation server-side.
- The Production Site booking card can load the rendezvous, activate consent during its permitted window, send one current GPS fix, report approaching/arrival, complete the rendezvous boarding handshake, and end sharing. Realtime state events refresh an already-open session.

### API endpoints

- `GET /api/v1/bookings/:bookingId/rendezvous`
- `POST /api/v1/bookings/:bookingId/rendezvous/activate`
- `POST /api/v1/rendezvous/:id/location`
- `POST /api/v1/rendezvous/:id/status`
- `POST /api/v1/rendezvous/:id/boarding`
- `POST /api/v1/rendezvous/:id/end`

### Tests run

- Unit: status transitions, geofence accuracy, activation time and server setting bounds.
- Integration: two distinct participant accounts, outsider denied, premature GPS denied, Redis-only location exchange, both-arrive transition, boarding, end and no coordinates in durable events.
- Full integration command: `API_TEST_DATABASE_URL=postgres://...@127.0.0.1:5434/marshgo_e2e_rendezvous REDIS_URL=redis://127.0.0.1:6380 npm run test:integration`.

### Known limitations / external dependencies

- Activation is participant-triggered; no scheduler/push worker activates the session automatically.
- The service does not yet request road-routing ETAs for driver or passenger, retain a prediction, or calculate `MeetingReadyAt`.
- The Site does not yet render a live map or automatically stream foreground fixes; location sending is a deliberate one-shot user action. No iOS background location behavior is claimed.
- No production SMS/APNs credentials, external route/geocode/tiles service, HTTPS staging, signing identity, or physical iPhone acceptance was available for this local implementation pass.

### iOS simulator rendering check

- Built, installed and launched the Capacitor app on iPhone 15 Pro Max and iPhone 16 Pro Max simulators. Both rendered the MARSHGO welcome screen at native simulator resolution without visible clipping. The simulator script now waits for WebKit to settle and captures a screenshot.
- This is launch-screen smoke evidence only; it does not test sign-in, an authenticated booking/rendezvous, camera, location permission behavior, background GPS, push, production signing or TestFlight. The physical-device acceptance requested by the product specification remains outstanding.

### NEXT

Build the Journey Monitor against actual schedule/location observations and existing transfer feasibility logic. Cascade Rendezvous timing changes into downstream legs and only trigger replan when a verified observation makes the current connection infeasible. Add user-facing booking screens after those API response states are stable.
