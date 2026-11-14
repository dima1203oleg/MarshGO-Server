import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import pg from 'pg';

// Characterization test for the MarshPass QR attestation (POPUTKY-SEC-QR-1).
// It pins down what the API does TODAY so the owner can decide on a fix with evidence,
// and it deliberately records which of my earlier claims were too strong.
// Local-only: throwaway accounts, loopback DB/API, strict cleanup. Fixtures, not live traffic.

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);

if (enabled) {
  const database = new URL(databaseUrl!);
  const api = new URL(apiUrl!);
  if (![database.hostname, api.hostname].every((host) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host))) {
    throw new Error('QR attestation test is strictly restricted to a local loopback API and database');
  }
  if (!/^\/marshgo_e2e(?:_[a-z0-9_]+)?$/.test(database.pathname)) {
    throw new Error('QR attestation test requires an explicitly configured disposable marshgo_e2e database');
  }
}

const decodeClaims = (value: string) => {
  const [payload] = value.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    bookingId: string; expiresAt: number; nonce: string; version: number;
  };
};

const apiReachable = enabled && await fetch(`${apiUrl}/healthz`, { signal: AbortSignal.timeout(2_000) })
  .then((response) => response.ok)
  .catch(() => false);

describe('POPUTKY-SEC-QR-1 — MarshPass ticket attestation, behaviour as shipped', {
  skip: !enabled ? 'requires explicit API_TEST_URL and API_TEST_DATABASE_URL' : apiReachable ? false : `no API at ${apiUrl} (run through npm run test:integration)`,
}, () => {
  it('gates booking boarding by the ticket, but never consumes its nonce', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const runId = crypto.randomUUID().slice(0, 8);
    const driverEmail = `qr.driver.${runId}@marshgo.ua`;
    const passEmail = `qr.passenger.${runId}@marshgo.ua`;
    const password = 'SecurePassword2026!';
    const createdUserIds: string[] = [];
    const createdVehicleIds: string[] = [];
    const createdOfferIds: string[] = [];
    const createdBookingIds: string[] = [];

    const register = async (role: 'driver' | 'passenger', email: string, name: string) => {
      const res = await fetch(`${apiUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName: name, role }),
      });
      assert.equal(res.status, 201, `${role} registration must succeed`);
      const data = (await res.json()).data;
      createdUserIds.push(data.user.id);
      return { token: data.accessToken as string, id: data.user.id as string };
    };

    try {
      const driver = await register('driver', driverEmail, `Водій ${runId}`);
      const passenger = await register('passenger', passEmail, `Пасажир ${runId}`);
      const asDriver = { 'Content-Type': 'application/json', Authorization: `Bearer ${driver.token}` };
      const asPassenger = { 'Content-Type': 'application/json', Authorization: `Bearer ${passenger.token}` };

      const suffix = ['AA', 'AB', 'AC', 'AE', 'AH', 'AI', 'AK', 'AM', 'AO', 'AP', 'AT', 'AX'][Math.floor(Math.random() * 12)];
      const vehicleRes = await fetch(`${apiUrl}/api/v1/vehicles`, {
        method: 'POST', headers: asDriver,
        body: JSON.stringify({ make: 'Skoda', model: 'Octavia', modelYear: 2021, seats: 4, plate: `BC${1000 + Math.floor(Math.random() * 9000)}${suffix}` }),
      });
      assert.equal(vehicleRes.status, 201);
      const vehicle = (await vehicleRes.json()).data;
      createdVehicleIds.push(vehicle.id);

      // trust_level 1 is required before publishing; upload a real 1x1 JPEG through the photo endpoint.
      const jpeg = Buffer.from(' /9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
        + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAA'
        + 'AAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
      const photoRes = await fetch(`${apiUrl}/api/v1/vehicles/${vehicle.id}/photos/file`, {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${driver.token}` }, body: jpeg,
      });
      assert.equal(photoRes.status, 201, 'vehicle photo upload must promote trust level');

      const departureAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const offerRes = await fetch(`${apiUrl}/api/v1/offers`, {
        method: 'POST', headers: asDriver,
        body: JSON.stringify({
          vehicleId: vehicle.id,
          originName: 'Київ, Метро Житомирська', destinationName: 'Житомир, Автовокзал',
          origin: [30.3649, 50.456], destination: [28.67, 50.2547],
          departureAt, pricePerSeatMinor: 25000, seats: 2,
        }),
      });
      assert.equal(offerRes.status, 201);
      const offer = (await offerRes.json()).data;
      createdOfferIds.push(offer.id);

      const bookingRes = await fetch(`${apiUrl}/api/v1/bookings`, {
        method: 'POST', headers: { ...asPassenger, 'idempotency-key': `qr-${crypto.randomUUID()}` },
        body: JSON.stringify({ offerId: offer.id, seats: 1 }),
      });
      assert.equal(bookingRes.status, 201);
      const booking = (await bookingRes.json()).data;
      createdBookingIds.push(booking.id);

      // 1) Boarding without a ticket is refused — so the ticket really does gate the booking lifecycle.
      const noTicketRes = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/boarding`, { method: 'POST', headers: asDriver, body: '{}' });
      assert.equal(noTicketRes.status, 400, 'boarding must require a ticket');
      assert.equal((await noTicketRes.json()).error.code, 'ticket_invalid');
      const stillConfirmed = await pool.query('SELECT status FROM bookings WHERE id=$1', [booking.id]);
      assert.equal(stillConfirmed.rows[0].status, 'confirmed', 'refused boarding must not advance the booking');

      // 2) Ticket claims: bound to the booking, single nonce, valid until departure + 24 h.
      const ticketRes = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/ticket`, { headers: asPassenger });
      assert.equal(ticketRes.status, 200);
      const ticket = (await ticketRes.json()).data;
      const claims = decodeClaims(ticket.token);
      assert.equal(claims.bookingId, booking.id, 'ticket must be bound to its booking');
      const hoursValid = (claims.expiresAt - Date.parse(departureAt) / 1000) / 3600;
      assert.ok(Math.abs(hoursValid - 24) < 0.01, `ticket must expire at departure+24h, got ${hoursValid}h`);

      // 3) The same token is accepted a second time, and a fresh ticket minted afterwards carries a
      //    different nonce while the used one still validates: nothing marks a nonce as spent.
      const first = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/boarding`, {
        method: 'POST', headers: asDriver, body: JSON.stringify({ ticket: ticket.token }),
      });
      assert.equal(first.status, 200);
      assert.equal((await first.json()).replayed, false);

      const second = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/boarding`, {
        method: 'POST', headers: asDriver, body: JSON.stringify({ ticket: ticket.token }),
      });
      assert.equal(second.status, 200, 'DEFECT: an already-used ticket token still validates');
      assert.equal((await second.json()).replayed, true);

      const rotated = (await (await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/ticket`, { headers: asPassenger })).json()).data;
      assert.notEqual(decodeClaims(rotated.token).nonce, claims.nonce, 'each ticket mints a new nonce');
      const third = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/boarding`, {
        method: 'POST', headers: asDriver, body: JSON.stringify({ ticket: ticket.token }),
      });
      assert.equal(third.status, 200, 'DEFECT: minting a new ticket does not invalidate the captured old one');

      // 4) Schema-level proof that no nonce ledger exists anywhere in the database.
      const nonceColumns = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema='public' AND (column_name ILIKE '%nonce%' OR column_name ILIKE '%ticket%')`,
      );
      assert.deepEqual(nonceColumns.rows, [],
        `DEFECT: expected no place to record a consumed ticket/nonce, found ${JSON.stringify(nonceColumns.rows)}`);

      // 5) Forgery is still refused — the defect is replay, not signature verification.
      const forged = `${ticket.token.split('.')[0]}.${crypto.randomBytes(32).toString('base64url')}`;
      const forgedRes = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/boarding`, {
        method: 'POST', headers: asDriver, body: JSON.stringify({ ticket: forged }),
      });
      assert.equal(forgedRes.status, 400, 'a re-signed payload must not validate');
      const foreignClaims = Buffer.from(JSON.stringify({ bookingId: crypto.randomUUID(), expiresAt: claims.expiresAt, nonce: claims.nonce, version: 1 }))
        .toString('base64url');
      const foreignRes = await fetch(`${apiUrl}/api/v1/bookings/${crypto.randomUUID()}/boarding`, {
        method: 'POST', headers: asDriver, body: JSON.stringify({ ticket: `${foreignClaims}.${'x'.repeat(43)}` }),
      });
      assert.equal(foreignRes.status, 400, 'an unsigned ticket for another booking must not validate');

      // 6) How much damage can a replayed token actually do? Two measured bounds.
      const boardEvents = await pool.query(
        "SELECT count(*)::int AS n FROM booking_events WHERE booking_id=$1 AND to_status='boarding'", [booking.id],
      );
      assert.equal(boardEvents.rows[0].n, 1, 'the three accepted boardings wrote exactly one event — replay does not duplicate the audit trail');

      await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/start`, { method: 'POST', headers: asDriver, body: '{}' });
      const afterStart = await pool.query('SELECT status FROM bookings WHERE id=$1', [booking.id]);
      assert.equal(afterStart.rows[0].status, 'in_progress');
      const replayAfterStart = await fetch(`${apiUrl}/api/v1/bookings/${booking.id}/boarding`, {
        method: 'POST', headers: asDriver, body: JSON.stringify({ ticket: ticket.token }),
      });
      assert.equal(replayAfterStart.status, 409,
        'the still-valid token cannot drag a live trip backwards — the lifecycle stays server-authoritative');
    } finally {
      // Reverse dependency order. A booking auto-opens a conversation, so the chat rows must go first,
      // and teardown errors must not be swallowed — leftover fixtures would be invisible otherwise.
      const teardown: [string, string, unknown[]][] = [];
      if (createdBookingIds.length) {
        teardown.push(['messages', 'DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE booking_id = ANY($1))', [createdBookingIds]]);
        teardown.push(['conversation_members', 'DELETE FROM conversation_members WHERE conversation_id IN (SELECT id FROM conversations WHERE booking_id = ANY($1))', [createdBookingIds]]);
        teardown.push(['conversations', 'DELETE FROM conversations WHERE booking_id = ANY($1)', [createdBookingIds]]);
        teardown.push(['completion confirmations', 'DELETE FROM booking_completion_confirmations WHERE booking_id = ANY($1)', [createdBookingIds]]);
        teardown.push(['booking events', 'DELETE FROM booking_events WHERE booking_id = ANY($1)', [createdBookingIds]]);
        teardown.push(['bookings', 'DELETE FROM bookings WHERE id = ANY($1)', [createdBookingIds]]);
      }
      if (createdOfferIds.length) teardown.push(['offers', 'DELETE FROM offers WHERE id = ANY($1)', [createdOfferIds]]);
      if (createdVehicleIds.length) teardown.push(['vehicle photos', 'DELETE FROM vehicle_photos WHERE vehicle_id = ANY($1)', [createdVehicleIds]]);
      if (createdVehicleIds.length) teardown.push(['vehicles', 'DELETE FROM vehicles WHERE id = ANY($1)', [createdVehicleIds]]);
      if (createdUserIds.length) {
        teardown.push(['driver profiles', 'DELETE FROM driver_profiles WHERE user_id = ANY($1)', [createdUserIds]]);
        teardown.push(['audit events', 'DELETE FROM audit_events WHERE actor_id = ANY($1)', [createdUserIds]]);
        teardown.push(['sessions', 'DELETE FROM sessions WHERE user_id = ANY($1)', [createdUserIds]]);
        teardown.push(['users', 'DELETE FROM users WHERE id = ANY($1)', [createdUserIds]]);
      }
      const failures: string[] = [];
      for (const [label, sql, params] of teardown) {
        try { await pool.query(sql, params); }
        catch (error) { failures.push(`${label}: ${(error as Error).message}`); }
      }
      const residue = await pool.query(
        `SELECT (SELECT count(*) FROM users WHERE id = ANY($1))::int AS users,
                (SELECT count(*) FROM bookings WHERE id = ANY($2))::int AS bookings,
                (SELECT count(*) FROM offers WHERE id = ANY($3))::int AS offers`,
        [createdUserIds, createdBookingIds, createdOfferIds],
      );
      await pool.end();
      assert.deepEqual(failures, [], `fixture teardown failed: ${failures.join(' | ')}`);
      assert.deepEqual(residue.rows[0], { users: 0, bookings: 0, offers: 0 }, 'test must leave no rows behind');
    }
  });
});
