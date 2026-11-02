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

describe('client-visible roles come from the enforced user_roles relation', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const email = `roles-single-source.${crypto.randomUUID().slice(0, 8)}@marshgo.test`;
  const password = 'RolesSingleSource2026!';
  let userId = '';
  let token = '';

  let refreshCookie = '';

  async function json(path: string, init?: RequestInit) {
    const res = await fetch(`${apiUrl}/api/v1${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any };
  }

  async function signIn() {
    const res = await json('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.body)}`);
    token = res.body.data.accessToken;
    refreshCookie = String(res.headers.get('set-cookie')?.match(/mg_refresh=[^;]+/)?.[0] ?? '');
    return res.body.data.user as { id: string; roles: string[] };
  }

  before(async () => {
    const created = await json('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName: 'Roles Single Source' }),
    });
    assert.ok([200, 201].includes(created.status), `register failed: ${JSON.stringify(created.body)}`);
    userId = created.body.data.user.id;
    token = created.body.data.accessToken;
    // Registration writes both the mirror array and the enforced rows; the mirror must agree.
    const measured = await signIn();
    assert.deepEqual(measured.roles, ['passenger']);
  });

  after(async () => {
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM audit_events WHERE actor_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  });

  async function mirrorOnly() {
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await pool.query(`UPDATE users SET roles = ARRAY['admin','driver','passenger']::text[] WHERE id = $1`, [userId]);
  }

  it('hides roles that the server would refuse to honour', async () => {
    await mirrorOnly();
    const user = await signIn();
    // Out-of-band array rows are not enforcement; showing them unlocks UI that then 403s.
    assert.deepEqual(user.roles, [], 'mirror-only roles must not be published');
    const me = await json('/users/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.data.roles, [], '/users/me must publish the same enforced set');
    const adminRoute = await json('/admin/mobility/providers');
    assert.equal(adminRoute.status, 403, 'table-enforced admin absence must match the empty role list');
    const driverRoute = await json(`/navigation/sessions/${crypto.randomUUID()}/matches`);
    assert.equal(driverRoute.status, 403, 'table-enforced driver absence must match the empty role list');
  });

  it('publishes exactly the roles the guards enforce once the table is written', async () => {
    await pool.query('INSERT INTO user_roles(user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, 'driver']);
    const user = await signIn();
    assert.deepEqual(user.roles, ['driver'], 'only the enforced role is visible');

    const driverRoute = await json(`/navigation/sessions/${crypto.randomUUID()}/matches`);
    assert.notEqual(driverRoute.status, 403, `visible driver role must pass the driver guard: ${JSON.stringify(driverRoute.body)}`);

    const adminRoute = await json('/admin/mobility/providers');
    assert.equal(adminRoute.status, 403, 'a non-admin role list must not reach admin data');

    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    const stale = await signIn();
    assert.deepEqual(stale.roles, [], 'revoked roles disappear from the client even while the mirror still lists them');
  });

  it('returns the enforced set through /auth/refresh', async () => {
    await pool.query('INSERT INTO user_roles(user_id, role) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING', [userId, 'driver', 'passenger']);
    assert.ok(refreshCookie, 'login must issue a refresh cookie for this check');
    const res = await fetch(`${apiUrl}/api/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: refreshCookie } });
    const body = await res.json() as any;
    assert.equal(res.status, 200, `refresh failed: ${JSON.stringify(body)}`);
    assert.deepEqual(body.data.user.roles, ['driver', 'passenger']);
  });
});
