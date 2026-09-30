# Security and privacy status

## Implemented controls

* Production requires a configured `SESSION_SECRET`; development identity bypass is accepted only when `NODE_ENV=development` and `AUTH_DEV_BYPASS=true`.
* OTP challenges are HMAC-hashed, expire after five minutes, allow at most five verification attempts, enforce resend cooldown and per-phone/per-IP request limits, and use a development provider that makes no outbound request.
* Access/refresh credentials are opaque random values; only SHA-256 hashes are persisted. Refresh rotation revokes the token family if a previously consumed token is reused.
* Refresh credentials use HttpOnly, SameSite=Strict cookies and Secure in production. Access credentials remain in browser memory.
* Vehicle, booking, proposal, and conversation mutations check authenticated ownership/role. Phone, plate, and verification evidence are not returned in public offer search.
* Vehicle photos use short-lived presigned upload policies constrained to 10 MiB and JPEG/PNG/WebP; API finalization checks object metadata plus detected file signature. Read URLs are signed and time-limited.
* Verification evidence accepts only JPEG/PNG/PDF up to 8 MiB, remains outside public DTOs, and is reachable only through a staff-guarded, short-lived URL. Admin/moderator decisions require separate persisted roles, a document-open request, transactional state updates, and audit events. Driver self-review is denied; vehicle verification requires both vehicle-registration and driver-licence approval.
* Booking participants can file private, rate-limited safety reports without choosing the reported user ID. Staff queue and case decisions are role-guarded, conflict-checked, reviewer-assigned, and audited. Account suspension is administrator-only, revokes sessions, and closes active realtime sockets.
* Boarding tickets contain no PII and use HMAC signatures; the server checks ticket expiry, booking ID, driver ownership, and current booking state before marking boarding.
* API requests have a JSON body limit, an allowlisted CORS policy, baseline security headers, request IDs, and per-process rate limits.
* Errors return structured codes/messages/request IDs; server logs do not include request bodies or OTP values.

## Open security work

* Replace per-process rate limiting with shared Redis coordination; configure trusted proxy hops behind deployment ingress before relying on source IP throttles.
* Add a security review and automated dependency/static/security checks; CI currently runs lint, typecheck, unit tests, and build.
* Configure production SMS credentials, secret management, HTTPS, same-site API routing, and account recovery policy.
* Configure private object storage and bucket CORS, add retention controls and anti-malware scanning before accepting real vehicle documents/photos.
* The verification flow is implemented but blocked operationally until the S3-compatible bucket is confirmed private, server-side encryption and access logging are enforced, bucket CORS is configured for the app, and a retention/deletion procedure is approved. No document malware scanning is installed.
* User blocks are stored by immutable user ID. Application reads and writes check either direction before returning or mutating proposal/chat/navigation-match data; blocking does not alter an existing booking or its cancellation obligations. The production UI lets booking participants block from chat and manage their private list in Profile. Report intake and staff decisions are implemented, but staffing, response coverage and escalation procedures remain open.
* Add account deletion processing, data retention and export policy review, initial staff-role provisioning/audit review, and incident response. First admin/moderator grant is a controlled owner/DBA operation; users cannot self-enable staff roles.
* Foreground navigation stores only the latest precise GPS sample and route for the authenticated driver; samples are age/accuracy/order/teleport checked and cleared when the owner ends the session or after five minutes without a fresh sample. There is no historical location track or public location endpoint. Demand matching is opt-in, requires a verified active vehicle, and only returns corridor-level demand data to the driver. Opt-out expires outstanding candidate interests. The passenger's driver identity is withheld until the passenger confirms interest; that confirmation does not create a booking. Booking chat WebSockets use single-use session-bound tickets, an allowlisted origin, participant-only fanout, frame/connection limits, heartbeats, and logout closure; message content remains durably authorized via REST. Cross-instance event fanout, navigation alerts, push privacy, background iOS GPS, and route rerouting remain unimplemented.

## Initial staff provisioning

Only a database owner may bootstrap the first administrator. Confirm the target account using an out-of-band owner verification process and its verified phone before running a transaction that inserts `user_roles(user_id, role)` and adds the same role to `users.roles`. Record a `staff_role.granted` audit event with `actor_id = NULL` and a minimal reason such as `owner_bootstrap`; never accept a user-supplied role through the public API. The profile reads `users.roles` to show the staff panel, while protected endpoints independently check `user_roles`.

No production security certification or legal compliance review is claimed.
