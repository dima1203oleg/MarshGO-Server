import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('API integration tests are restricted to a loopback database');
}

// Regression for UUID-VALIDATION-1: five booking routes passed req.params.id
// straight into SQL, so a malformed :id crashed as 500 internal_error
// (Postgres uuid cast failure) instead of a client 400.
describe('booking :id parameter validation (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const phone = `+38097${process.pid}${crypto.randomInt(1000, 9999)}`;
  let accessToken = '';

  before(async () => {
    const requested = await fetch(`${apiUrl}/api/v1/auth/otp/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, displayName: 'UUID Guard Test User' }),
    });
    assert.equal(requested.status, 200);
    const requestBody = await requested.json() as { developmentCode?: string };
    assert.match(requestBody.developmentCode ?? '', /^\d{6}$/);
    const verified = await fetch(`${apiUrl}/api/v1/auth/otp/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, code: requestBody.developmentCode }),
    });
    assert.equal(verified.status, 200);
    const auth = await verified.json() as { data: { accessToken: string } };
    accessToken = auth.data.accessToken;
  });

  after(async () => {
    await pool.query('DELETE FROM otp_challenges WHERE phone_e164 = $1', [phone]);
    await pool.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE phone_e164 = $1)', [phone]);
    await pool.query('DELETE FROM audit_events WHERE actor_id IN (SELECT id FROM users WHERE phone_e164 = $1)', [phone]);
    await pool.query('DELETE FROM users WHERE phone_e164 = $1', [phone]);
    await pool.end();
  });

  const malformedIds: Array<{ id: string; label: string }> = [
    { id: 'null', label: '"null"' },
    { id: 'not-a-uuid', label: 'garbage string' },
    { id: '-'.repeat(36), label: '36 dashes (regex-satisfying non-uuid)' },
  ];

  for (const { id, label } of malformedIds) {
    it(`returns 400 invalid_booking_id for ${label} on all five booking :id routes`, async () => {
      const routes: Array<{ method: string; path: string }> = [
        { method: 'GET', path: `/api/v1/bookings/${id}/ticket` },
        { method: 'GET', path: `/api/v1/bookings/${id}/events` },
        { method: 'POST', path: `/api/v1/bookings/${id}/cancel` },
        { method: 'POST', path: `/api/v1/bookings/${id}/start` },
        { method: 'POST', path: `/api/v1/bookings/${id}/complete` },
      ];
      for (const route of routes) {
        const response = await fetch(`${apiUrl}${route.path}`, {
          method: route.method,
          headers: { authorization: `Bearer ${accessToken}` },
        });
        const body = await response.json() as { error?: { code?: string } };
        assert.equal(response.status, 400, `${route.method} ${route.path} must respond 400`);
        assert.equal(body.error?.code, 'invalid_booking_id', `${route.method} ${route.path} error code`);
      }
    });
  }

  it('keeps 404 booking unavailable for a well-formed unknown uuid (negative control)', async () => {
    const response = await fetch(`${apiUrl}/api/v1/bookings/${crypto.randomUUID()}/ticket`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(response.status, 404);
    const body = await response.json() as { error?: { message?: string } };
    assert.equal(body.error?.message, 'booking unavailable');
  });
});
