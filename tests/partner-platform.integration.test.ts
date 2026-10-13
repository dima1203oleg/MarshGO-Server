import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1','localhost','::1'].includes(database.hostname)) {
  throw new Error('Partner platform tests are restricted to a loopback database');
}

describe('partner platform API and tenant isolation (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ownerA = crypto.randomUUID();
  const ownerB = crypto.randomUUID();
  const admin = crypto.randomUUID();
  const organizationIds: string[] = [];
  const applicationIds: string[] = [];
  const auth = (userId: string) => ({ 'content-type': 'application/json', 'x-dev-user-id': userId });
  const application = (displayName: string) => ({
    displayName,
    legalName: `${displayName} LLC`,
    city: 'Київ',
    contactEmail: `${crypto.randomUUID()}@example.test`,
    serviceModes: ['bicycle','transfer'],
    dispatchMode: 'INTEGRATION_ONLY',
  });

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES
      ($1,'Partner owner A',ARRAY['passenger']),($2,'Partner owner B',ARRAY['passenger']),($3,'Partner admin',ARRAY['admin'])`, [ownerA, ownerB, admin]);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES ($1,'passenger'),($2,'passenger'),($3,'admin')`, [ownerA, ownerB, admin]);
  });

  after(async () => {
    if (organizationIds.length) {
      await pool.query('DELETE FROM audit_events WHERE entity_id=ANY($1::uuid[]) OR actor_id=ANY($2::uuid[])', [organizationIds, [ownerA, ownerB, admin]]);
      await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [organizationIds]);
    }
    if (applicationIds.length) await pool.query('DELETE FROM audit_events WHERE entity_id=ANY($1::uuid[])', [applicationIds]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB, admin]]);
    await pool.end();
  });

  it('submits onboarding atomically and keeps organization data tenant-scoped', async () => {
    const createdA = await fetch(`${apiUrl}/api/v1/partner/applications`, {
      method: 'POST', headers: auth(ownerA), body: JSON.stringify(application('Partner Isolation A')),
    });
    assert.equal(createdA.status, 201);
    const resultA = await createdA.json() as { data: { organization: { id: string; status: string }; application: { id: string; status: string }; serviceModes: string[] } };
    organizationIds.push(resultA.data.organization.id);
    applicationIds.push(resultA.data.application.id);
    assert.equal(resultA.data.organization.status, 'PENDING_REVIEW');
    assert.equal(resultA.data.application.status, 'SUBMITTED');
    assert.deepEqual(resultA.data.serviceModes, ['bicycle','transfer']);

    const createdB = await fetch(`${apiUrl}/api/v1/partner/applications`, {
      method: 'POST', headers: auth(ownerB), body: JSON.stringify(application('Partner Isolation B')),
    });
    assert.equal(createdB.status, 201);
    const resultB = await createdB.json() as { data: { organization: { id: string }; application: { id: string } } };
    organizationIds.push(resultB.data.organization.id);
    applicationIds.push(resultB.data.application.id);

    const own = await fetch(`${apiUrl}/api/v1/partner/organizations/${resultA.data.organization.id}`, { headers: auth(ownerA) });
    assert.equal(own.status, 200);
    const leaked = await fetch(`${apiUrl}/api/v1/partner/organizations/${resultA.data.organization.id}`, { headers: auth(ownerB) });
    assert.equal(leaked.status, 404);
    const listed = await fetch(`${apiUrl}/api/v1/partner/organizations`, { headers: auth(ownerB) });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { data: Array<{ id: string }> };
    assert.equal(listedBody.data.some((row) => row.id === resultA.data.organization.id), false);

    const noAdmin = await fetch(`${apiUrl}/api/v1/admin/partners`, { headers: auth(ownerA) });
    assert.equal(noAdmin.status, 403);
    const rejectWithoutReason = await fetch(`${apiUrl}/api/v1/admin/partners/${resultA.data.organization.id}/reject`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({}),
    });
    assert.equal(rejectWithoutReason.status, 400);
    assert.equal((await rejectWithoutReason.json() as { error: { code: string } }).error.code, 'review_reason_required');
    const approved = await fetch(`${apiUrl}/api/v1/admin/partners/${resultA.data.organization.id}/approve`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ note: 'Перевірку завершено' }),
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json() as { data: { status: string; applicationStatus: string } }).data.status, 'ACTIVE');
    const duplicateDecision = await fetch(`${apiUrl}/api/v1/admin/partners/${resultA.data.organization.id}/reject`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ note: 'Повторне рішення' }),
    });
    assert.equal(duplicateDecision.status, 409);

    const suspended = await fetch(`${apiUrl}/api/v1/admin/partners/${resultA.data.organization.id}/suspend`, {
      method: 'POST', headers: auth(admin), body: JSON.stringify({ note: 'Тестове призупинення' }),
    });
    assert.equal(suspended.status, 200);
    const permissions = await fetch(`${apiUrl}/api/v1/partner/organizations/${resultA.data.organization.id}/permissions`, { headers: auth(ownerA) });
    assert.equal(permissions.status, 200);
    assert.equal((await permissions.json() as { data: { canManageOrders: boolean } }).data.canManageOrders, false);
  });
});
