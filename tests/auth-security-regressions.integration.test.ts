import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import pg from 'pg';

const apiUrl = process.env.API_TEST_URL || 'http://127.0.0.1:3002';
const databaseUrl = process.env.API_TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo';

const database = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('Auth security regression tests are restricted to a local loopback database');
}
if (!database.pathname.includes('marshgo') && !database.pathname.includes('test')) {
  throw new Error('Auth security regression tests require a database name containing "marshgo" or "test"');
}

describe('P0 — Auth Security Regressions & Verification Integrity', () => {
  it('prevents account takeover of pre-existing/passwordless users by email and provides recovery instructions', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const runId = crypto.randomUUID().slice(0, 8);
    const victimEmail = `legacy.user.${runId}@marshgo.ua`;
    const victimId = crypto.randomUUID();

    try {
      // Seed pre-existing user without password (e.g. legacy/migrated)
      await pool.query(
        `INSERT INTO users (id, email, display_name, roles, password_hash, email_verified, is_verified, account_status)
         VALUES ($1, $2, 'Legacy User', ARRAY['passenger']::text[], NULL, false, false, 'active')`,
        [victimId, victimEmail],
      );

      // Attempt registration takeover with that same email
      const takeoverRes = await fetch(`${apiUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: victimEmail,
          password: 'MaliciousPassword2026!',
          displayName: 'Attacker Impersonator',
        }),
      });

      assert.equal(takeoverRes.status, 409, 'Registration must be rejected with 409 Conflict when email exists');
      const body = await takeoverRes.json();
      assert.equal(body.error.code, 'email_already_registered');
      assert.match(body.error.message, /відновленням пароля/i, 'Error message must guide user to secure password recovery');

      // Assert database record was not compromised or modified
      const userCheck = await pool.query<{ password_hash: string | null; display_name: string }>(
        'SELECT password_hash, display_name FROM users WHERE id = $1',
        [victimId],
      );
      assert.equal(userCheck.rows[0].password_hash, null, 'password_hash must remain null');
      assert.equal(userCheck.rows[0].display_name, 'Legacy User', 'display_name must not be overwritten');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [victimId]);
      await pool.end();
    }
  });

  it('ensures new registrations are never automatically marked email_verified or is_verified', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const runId = crypto.randomUUID().slice(0, 8);
    const newEmail = `unverified.${runId}@marshgo.ua`;
    let createdUserId: string | undefined;

    try {
      const regRes = await fetch(`${apiUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail,
          password: 'ValidPassword2026!',
          displayName: `Fresh User ${runId}`,
        }),
      });

      assert.equal(regRes.status, 201, 'Registration must succeed');
      const regData = (await regRes.json()).data;
      createdUserId = regData.user.id;

      // Query database directly
      const dbCheck = await pool.query<{ email_verified: boolean; is_verified: boolean }>(
        'SELECT email_verified, is_verified FROM users WHERE id = $1',
        [createdUserId],
      );
      assert.equal(dbCheck.rows[0].email_verified, false, 'New registrations must have email_verified = false');
      assert.equal(dbCheck.rows[0].is_verified, false, 'New registrations must have is_verified = false');
    } finally {
      if (createdUserId) {
        await pool.query('DELETE FROM sessions WHERE user_id = $1', [createdUserId]);
        await pool.query('DELETE FROM user_roles WHERE user_id = $1', [createdUserId]);
        await pool.query('DELETE FROM audit_events WHERE actor_id = $1', [createdUserId]);
        await pool.query('DELETE FROM users WHERE id = $1', [createdUserId]);
      }
      await pool.end();
    }
  });

  it('strictly disables OTP endpoints and returns HTTP 410 Gone with security policy notice', async () => {
    const otpReqRes = await fetch(`${apiUrl}/api/v1/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+380501234567' }),
    });
    assert.equal(otpReqRes.status, 410, 'POST /api/v1/auth/otp/request must return 410 Gone');
    const reqBody = await otpReqRes.json();
    assert.equal(reqBody.error.code, 'otp_deprecated');

    const otpVerRes = await fetch(`${apiUrl}/api/v1/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+380501234567', code: '123456' }),
    });
    assert.equal(otpVerRes.status, 410, 'POST /api/v1/auth/otp/verify must return 410 Gone');
    const verBody = await otpVerRes.json();
    assert.equal(verBody.error.code, 'otp_deprecated');
  });

  it('rejects unauthenticated requests to protected API endpoints with clear error responses', async () => {
    const protectedRoutes = [
      { method: 'GET', path: '/api/v1/users/me' },
      { method: 'GET', path: '/api/v1/offers/mine' },
      { method: 'POST', path: '/api/v1/vehicles' },
      { method: 'POST', path: '/api/v1/bookings' },
    ];

    for (const route of protectedRoutes) {
      const res = await fetch(`${apiUrl}${route.path}`, {
        method: route.method,
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(res.status, 401, `${route.method} ${route.path} without token must return 401`);
      const data = await res.json();
      assert.ok(data.error, `${route.path} must return error object`);
      assert.equal(data.error.code, 'unauthorized');

      // Invalid token
      const invalidRes = await fetch(`${apiUrl}${route.path}`, {
        method: route.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid-token-12345',
        },
      });
      assert.equal(invalidRes.status, 401, `${route.method} ${route.path} with bad token must return 401`);
    }
  });

  it('fails password reset closed when no email delivery provider exists without leaking account existence', async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const runId = crypto.randomUUID().slice(0, 8);
    const userEmail = `reset.test.${runId}@marshgo.ua`;
    let userId: string | undefined;

    try {
      // 1. Register user
      const regRes = await fetch(`${apiUrl}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: userEmail,
          password: 'InitialPassword2026!',
          displayName: `Reset User ${runId}`,
        }),
      });
      assert.equal(regRes.status, 201);
      userId = (await regRes.json()).data.user.id;

      // 2. No sender is configured: report the capability as unavailable before writing a token.
      const resetReqRes = await fetch(`${apiUrl}/api/v1/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userEmail }),
      });
      assert.equal(resetReqRes.status, 503);
      const reqError = (await resetReqRes.json()).error;
      assert.equal(reqError.code, 'password_reset_unavailable');
      assert.equal(reqError.message, 'Відновлення пароля тимчасово недоступне. Спробуйте пізніше.');

      // No reset token may be written when delivery is unavailable.
      const tokenRecords = await pool.query<{ id: string }>(
        'SELECT id FROM password_reset_tokens WHERE user_id = $1',
        [userId],
      );
      assert.equal(tokenRecords.rows.length, 0, 'unusable reset links must not be created');

      // Unknown and known accounts receive the same unavailable response.
      const unknownRes = await fetch(`${apiUrl}/api/v1/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `nonexistent.${runId}@marshgo.ua` }),
      });
      assert.equal(unknownRes.status, 503);
      const unknownError = (await unknownRes.json()).error;
      assert.equal(unknownError.code, reqError.code, 'must not reveal account existence');
      assert.equal(unknownError.message, reqError.message, 'must return identical copy to prevent email enumeration');
    } finally {
      if (userId) {
        await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM audit_events WHERE actor_id = $1', [userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      }
      await pool.end();
    }
  });
});
