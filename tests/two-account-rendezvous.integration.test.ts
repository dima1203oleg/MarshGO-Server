import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import pg from 'pg';

const apiUrl = process.env.API_TEST_URL || 'http://127.0.0.1:3002';
const databaseUrl = process.env.API_TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo';

const database = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('Rendezvous integration test is strictly restricted to a local loopback database');
}
if (!database.pathname.includes('marshgo') && !database.pathname.includes('test')) {
  throw new Error('Rendezvous integration test requires a database name containing "marshgo" or "test"');
}

describe('P1 — Two-Account Carpool & Rendezvous Verification', () => {
  it('verifies the full carpool, concurrent booking, dual-consent, and arrival lifecycle with strict cleanup', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const runId = crypto.randomUUID().slice(0, 8);
    const driverEmail = `driver.${runId}@marshgo.ua`;
    const pass1Email = `passenger1.${runId}@marshgo.ua`;
    const pass2Email = `passenger2.${runId}@marshgo.ua`;
    const outsiderEmail = `outsider.${runId}@marshgo.ua`;
    const password = 'SecurePassword2026!';

    const createdUserIds: string[] = [];
    const createdVehicleIds: string[] = [];
    const createdOfferIds: string[] = [];
    const createdBookingIds: string[] = [];
    const createdRendezvousIds: string[] = [];

    try {
      // 1. Register Accounts
      // Driver
      const regDriverRes = await fetch(`${apiUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: driverEmail, password, displayName: `Водій ${runId}`, role: 'driver' }),
      });
      assert.equal(regDriverRes.status, 201, 'Driver registration must succeed');
      const driverData = (await regDriverRes.json()).data;
      const driverToken = driverData.accessToken;
      const driverId = driverData.user.id;
      createdUserIds.push(driverId);

      // Passenger 1
      const regPass1Res = await fetch(`${apiUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pass1Email, password, displayName: `Пасажир 1 ${runId}`, role: 'passenger' }),
      });
      assert.equal(regPass1Res.status, 201, 'Passenger 1 registration must succeed');
      const pass1Data = (await regPass1Res.json()).data;
      const pass1Token = pass1Data.accessToken;
      const pass1Id = pass1Data.user.id;
      createdUserIds.push(pass1Id);

      // Passenger 2 (for concurrency testing)
      const regPass2Res = await fetch(`${apiUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pass2Email, password, displayName: `Пасажир 2 ${runId}`, role: 'passenger' }),
      });
      assert.equal(regPass2Res.status, 201, 'Passenger 2 registration must succeed');
      const pass2Data = (await regPass2Res.json()).data;
      const pass2Token = pass2Data.accessToken;
      const pass2Id = pass2Data.user.id;
      createdUserIds.push(pass2Id);

      // Outsider (to prove access control)
      const regOutRes = await fetch(`${apiUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: outsiderEmail, password, displayName: `Сторонній ${runId}`, role: 'passenger' }),
      });
      assert.equal(regOutRes.status, 201);
      const outData = (await regOutRes.json()).data;
      const outToken = outData.accessToken;
      const outId = outData.user.id;
      createdUserIds.push(outId);

      // 2. Step 8 Check: Unverified vehicle publishing is honestly BLOCKED
      const suffix = ['AA','AB','AC','AE','AH','AI','AK','AM','AO','AP','AT','AX'][Math.floor(Math.random() * 12)];
      const plate = `BC${Math.floor(1000 + Math.random() * 9000)}${suffix}`;
      const vehRes = await fetch(`${apiUrl}/api/v1/vehicles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
        body: JSON.stringify({ make: 'Skoda', model: 'Octavia', modelYear: 2021, seats: 4, plate }),
      });
      if (vehRes.status !== 201) {
        console.error('Vehicle creation error:', await vehRes.text());
      }
      assert.equal(vehRes.status, 201);
      const vehicle = (await vehRes.json()).data;
      createdVehicleIds.push(vehicle.id);
      assert.equal(vehicle.trust_level, 0, 'New vehicle must have trust_level=0 before verification');

      // Attempt publishing with unverified vehicle -> Must be rejected (honestly BLOCKED)
      const unverifiedPublishRes = await fetch(`${apiUrl}/api/v1/offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
        body: JSON.stringify({
          vehicleId: vehicle.id,
          originName: 'Київ, Метро Житомирська',
          destinationName: 'Житомир, Автовокзал',
          origin: [30.3649, 50.4560],
          destination: [28.6700, 50.2547],
          departureAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          pricePerSeatMinor: 25000,
          seats: 1,
        }),
      });
      assert.ok([404, 409].includes(unverifiedPublishRes.status), 'Publishing unverified vehicle must be honestly blocked with 404 or 409');

      // Upload vehicle photo via real binary API endpoint to auto-promote vehicle to trust_level=1
      const jpegBytes = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
        0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
        0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
        0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
        0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
        0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
        0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
        0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
        0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
        0x00, 0xbf, 0x80, 0xff, 0xd9
      ]);
      const photoUploadRes = await fetch(`${apiUrl}/api/v1/vehicles/${vehicle.id}/photos/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'Authorization': `Bearer ${driverToken}` },
        body: jpegBytes,
      });
      assert.equal(photoUploadRes.status, 201, 'Vehicle photo upload must succeed via direct API endpoint');
      const photoData = (await photoUploadRes.json()).data;
      assert.equal(photoData.trust_level, 1, 'Vehicle must be automatically promoted to trust_level=1 by photo upload API');

      // 3. Driver creates carpool offer with 1 available seat
      const departureAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min from now
      const offerRes = await fetch(`${apiUrl}/api/v1/offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
        body: JSON.stringify({
          vehicleId: vehicle.id,
          originName: 'Київ, Метро Житомирська',
          destinationName: 'Житомир, Автовокзал',
          origin: [30.3649, 50.4560],
          destination: [28.6700, 50.2547],
          departureAt,
          pricePerSeatMinor: 25000,
          seats: 1, // Exactly 1 seat to test race condition
        }),
      });
      assert.equal(offerRes.status, 201, 'Offer creation must succeed with verified vehicle');
      const offer = (await offerRes.json()).data;
      createdOfferIds.push(offer.id);
      assert.equal(offer.available_seats, 1);

      // 4. Passenger discovers offer
      const searchUrl = `${apiUrl}/api/v1/offers?origin=${encodeURIComponent('Київ')}&destination=${encodeURIComponent('Житомир')}&originLon=30.3649&originLat=50.4560&destinationLon=28.6700&destinationLat=50.2547&seats=1`;
      const searchRes = await fetch(searchUrl, { headers: { 'Authorization': `Bearer ${pass1Token}` } });
      assert.equal(searchRes.status, 200);
      const searchResults = (await searchRes.json()).data;
      const found = searchResults.find((o: { id: string }) => o.id === offer.id);
      assert.ok(found, 'Offer must be discoverable by passenger search');

      // 5. Concurrency & Atomic Seat Reservation: Two passengers try to book the last 1 seat simultaneously
      const idem1 = `book1-${crypto.randomUUID()}`;
      const idem2 = `book2-${crypto.randomUUID()}`;
      const [res1, res2] = await Promise.all([
        fetch(`${apiUrl}/api/v1/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pass1Token}`, 'idempotency-key': idem1 },
          body: JSON.stringify({ offerId: offer.id, seats: 1 }),
        }),
        fetch(`${apiUrl}/api/v1/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pass2Token}`, 'idempotency-key': idem2 },
          body: JSON.stringify({ offerId: offer.id, seats: 1 }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      assert.deepEqual(statuses, [201, 409], 'Exactly one booking must succeed (201) and the second must be rejected with 409 (capacity exceeded)');

      const winningRes = res1.status === 201 ? res1 : res2;
      const winningToken = res1.status === 201 ? pass1Token : pass2Token;
      const booking = (await winningRes.json()).data;
      createdBookingIds.push(booking.id);
      assert.equal(booking.status, 'confirmed');

      // 6. Idempotency Check: Re-sending the winning booking request returns the same booking
      const winningIdem = res1.status === 201 ? idem1 : idem2;
      const replayRes = await fetch(`${apiUrl}/api/v1/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${winningToken}`, 'idempotency-key': winningIdem },
        body: JSON.stringify({ offerId: offer.id, seats: 1 }),
      });
      assert.ok([200, 201].includes(replayRes.status), 'Replay of same idempotency key must succeed');
      const replayData = (await replayRes.json()).data;
      assert.equal(replayData.id, booking.id, 'Idempotent replay must return the exact same booking ID');

      // 7. MarshPass Domain Verification
      assert.equal(booking.status, 'confirmed');
      assert.equal(booking.seat_count, 1);
      assert.equal(booking.total_price_minor, 25000);

      // Verify list bookings shows current_user_is_driver === false for passenger
      const passBookingsRes = await fetch(`${apiUrl}/api/v1/bookings`, {
        headers: { 'Authorization': `Bearer ${winningToken}` },
      });
      assert.equal(passBookingsRes.status, 200);
      const passBookings = (await passBookingsRes.json()).data;
      const foundPassBooking = passBookings.find((b: { id: string }) => b.id === booking.id);
      assert.ok(foundPassBooking, 'Booking must be in passenger bookings list');
      assert.equal(foundPassBooking.current_user_is_driver, false, 'Passenger booking must have current_user_is_driver = false');
      assert.equal(foundPassBooking.status, 'confirmed', 'MarshPass requires status to be confirmed');

      // Public GET /api/v1/offers/:id filters available_seats > 0, so 0 seats left returns 404 for public booking
      const publicOfferCheck = await fetch(`${apiUrl}/api/v1/offers/${offer.id}`);
      assert.equal(publicOfferCheck.status, 404, 'Fully booked offer (0 seats) must not be offered for public booking');

      // Driver inspecting own offers sees available_seats = 0
      const driverOffersRes = await fetch(`${apiUrl}/api/v1/offers/mine`, {
        headers: { 'Authorization': `Bearer ${driverToken}` },
      });
      assert.equal(driverOffersRes.status, 200);
      const driverOffers = (await driverOffersRes.json()).data;
      const myOffer = driverOffers.find((o: { id: string }) => o.id === offer.id);
      assert.ok(myOffer, 'Driver must see own offer');
      assert.equal(myOffer.available_seats, 0, 'Driver view must show 0 available seats left');

      // 8. Rendezvous GPS Mutual Consent & Access Control
      // A. Outsider is forbidden from accessing rendezvous
      const outsiderRzRes = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/rendezvous`, {
        headers: { 'Authorization': `Bearer ${outToken}` },
      });
      assert.equal(outsiderRzRes.status, 404, 'Outsider must receive 404/not found for unparticipated booking rendezvous');

      // B. Passenger fetches rendezvous session
      const rzRes = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/rendezvous`, {
        headers: { 'Authorization': `Bearer ${winningToken}` },
      });
      assert.equal(rzRes.status, 200);
      const rzSession = (await rzRes.json()).data;
      createdRendezvousIds.push(rzSession.id);
      assert.equal(rzSession.state, 'SCHEDULED');

      // C. Activate rendezvous
      const activateRes = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/rendezvous/activate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${driverToken}` },
      });
      assert.equal(activateRes.status, 200);

      // D. Pre-consent GPS location transmission is rejected (HTTP 403 Forbidden)
      const preConsentLocRes = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${winningToken}` },
        body: JSON.stringify({
          latitude: 50.4561,
          longitude: 30.3650,
          accuracyMeters: 10,
          capturedAt: new Date().toISOString(),
        }),
      });
      assert.equal(preConsentLocRes.status, 403, 'Location transmission before mutual consent must return 403 Forbidden');

      // E. Single participant consent (Passenger only)
      const passConsentRes = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${winningToken}` },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(passConsentRes.status, 200);
      const passConsentData = (await passConsentRes.json()).data;
      assert.equal(passConsentData.currentParticipantConsent, true);
      assert.equal(passConsentData.locationSharingEnabled, false, 'Location sharing must remain false with only one consent');

      // Driver still cannot transmit before own consent
      const driverPreConsentLoc = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
        body: JSON.stringify({ latitude: 50.4562, longitude: 30.3651, accuracyMeters: 8, capturedAt: new Date().toISOString() }),
      });
      assert.equal(driverPreConsentLoc.status, 403, 'Driver cannot transmit before own consent');

      // F. Driver grants consent -> Dual Consent Active!
      const driverConsentRes = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(driverConsentRes.status, 200);
      const driverConsentData = (await driverConsentRes.json()).data;
      assert.equal(driverConsentData.locationSharingEnabled, true, 'Location sharing must be enabled when BOTH consent');

      // G. Driver transmits GPS location -> Succeeds!
      const driverLocRes = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
        body: JSON.stringify({
          latitude: 50.4562,
          longitude: 30.3651,
          accuracyMeters: 8,
          capturedAt: new Date().toISOString(),
        }),
      });
      assert.equal(driverLocRes.status, 200, 'Driver location transmission must succeed under active mutual consent');

      // Passenger sees driver location
      const passViewRes = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/rendezvous`, {
        headers: { 'Authorization': `Bearer ${winningToken}` },
      });
      const passView = (await passViewRes.json()).data;
      assert.equal(passView.locationSharingEnabled, true);
      assert.ok(passView.locations.driver, 'Passenger must receive driver location');
      assert.deepEqual(passView.locations.driver.coordinates, [30.3651, 50.4562]);

      // H. Consent revocation: Passenger revokes consent -> location sharing immediately disabled
      const revokeRes = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${winningToken}` },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(revokeRes.status, 200);
      const revokeData = (await revokeRes.json()).data;
      assert.equal(revokeData.locationSharingEnabled, false, 'Revoking consent must immediately disable location sharing');

      // Location transmission is now blocked again
      const blockedLocRes = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
        body: JSON.stringify({ latitude: 50.4563, longitude: 30.3652, accuracyMeters: 8, capturedAt: new Date().toISOString() }),
      });
      assert.equal(blockedLocRes.status, 409, 'Transmission must be rejected when sharing is inactive');

      // Re-grant consent for arrival flow
      await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${winningToken}` },
        body: JSON.stringify({ enabled: true }),
      });

      // 9. Status Progression: Arrival, Boarding, and Completion
      // Driver marks arrived
      const driverArrRes = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
        body: JSON.stringify({ action: 'arrived' }),
      });
      assert.equal(driverArrRes.status, 200);
      assert.equal((await driverArrRes.json()).data.state, 'DRIVER_WAITING');

      // Passenger marks arrived -> state becomes BOTH_NEARBY
      const passArrRes = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${winningToken}` },
        body: JSON.stringify({ action: 'arrived' }),
      });
      assert.equal(passArrRes.status, 200);
      assert.equal((await passArrRes.json()).data.state, 'BOTH_NEARBY');

      // Boarding
      const boardingRes = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/boarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
      });
      assert.equal(boardingRes.status, 200);
      assert.equal((await boardingRes.json()).data.state, 'BOARDING');

      // End
      const endRes = await fetch(`${apiUrl}/api/v1/rendezvous/${rzSession.id}/end`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${winningToken}` },
      });
      assert.equal(endRes.status, 200);

      // 10. Cancellation & Capacity Restoration Verification
      // Create second offer for cancellation verification
      const offer2Res = await fetch(`${apiUrl}/api/v1/offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${driverToken}` },
        body: JSON.stringify({
          vehicleId: vehicle.id,
          originName: 'Київ, Метро Лівобережна',
          destinationName: 'Бровари, Центр',
          origin: [30.5980, 50.4518],
          destination: [30.7900, 50.5100],
          departureAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          pricePerSeatMinor: 10000,
          seats: 2,
        }),
      });
      assert.equal(offer2Res.status, 201);
      const offer2 = (await offer2Res.json()).data;
      createdOfferIds.push(offer2.id);

      // Book 1 seat
      const book2Res = await fetch(`${apiUrl}/api/v1/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pass1Token}`, 'idempotency-key': `book2-${crypto.randomUUID()}` },
        body: JSON.stringify({ offerId: offer2.id, seats: 1 }),
      });
      assert.equal(book2Res.status, 201);
      const booking2 = (await book2Res.json()).data;
      createdBookingIds.push(booking2.id);

      // Verify available seats is 1
      const checkOffer2Res = await fetch(`${apiUrl}/api/v1/offers/${offer2.id}`);
      assert.equal((await checkOffer2Res.json()).data.available_seats, 1);

      // Cancel booking
      const cancelRes = await fetch(`${apiUrl}/api/v1/bookings/${booking2.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pass1Token}` },
        body: JSON.stringify({ reason: 'Changed mind' }),
      });
      assert.equal(cancelRes.status, 200);

      // Verify seats restored to 2
      const checkOffer2Restored = await fetch(`${apiUrl}/api/v1/offers/${offer2.id}`);
      assert.equal((await checkOffer2Restored.json()).data.available_seats, 2, 'Available seats must be restored to 2 after cancellation');
    } finally {
      // Guaranteed teardown in reverse dependency order
      if (createdBookingIds.length) {
        await pool.query('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE booking_id = ANY($1))', [createdBookingIds]);
        await pool.query('DELETE FROM conversations WHERE booking_id = ANY($1)', [createdBookingIds]);
      }
      if (createdRendezvousIds.length) {
        await pool.query('DELETE FROM rendezvous_events WHERE rendezvous_id = ANY($1)', [createdRendezvousIds]);
        await pool.query('DELETE FROM rendezvous_sessions WHERE id = ANY($1)', [createdRendezvousIds]);
      }
      if (createdBookingIds.length) {
        await pool.query('DELETE FROM bookings WHERE id = ANY($1)', [createdBookingIds]);
      }
      if (createdOfferIds.length) {
        await pool.query('DELETE FROM offers WHERE id = ANY($1)', [createdOfferIds]);
      }
      if (createdVehicleIds.length) {
        await pool.query('DELETE FROM vehicle_photos WHERE vehicle_id = ANY($1)', [createdVehicleIds]);
        await pool.query('DELETE FROM vehicles WHERE id = ANY($1)', [createdVehicleIds]);
      }
      if (createdUserIds.length) {
        await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1)', [createdUserIds]);
        await pool.query('DELETE FROM sessions WHERE user_id = ANY($1)', [createdUserIds]);
        await pool.query('DELETE FROM audit_events WHERE actor_id = ANY($1)', [createdUserIds]);
        await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
      }
      await pool.end();
    }
  });
});
