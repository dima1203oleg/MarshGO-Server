import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Pool } from 'pg';
import ts from 'typescript';
import { calculatePlatformFee } from '../server/fees';
import {
  WHOLE_ROUTE_ALIGHTING, WHOLE_ROUTE_BOARDING, recordOccupancy, refreshAvailableSeats,
} from '../server/bookings/seatInventory';

const databaseUrl = process.env.PROPOSAL_ACCEPTANCE_TEST_DATABASE_URL;
if (databaseUrl) {
  const database = new URL(databaseUrl);
  const loopback = database.hostname === '127.0.0.1';
  const localFixture = loopback && (
    database.pathname === '/marshgo_e2e_carpool5' || /^\/marshgo_e2e_codex_[a-z0-9_]+$/.test(database.pathname)
  );
  const ciFixture = process.env.CI === 'true' && loopback && database.pathname === '/marshgo_e2e';
  if (!localFixture && !ciFixture) {
    throw new Error('Only the isolated loopback carpool fixture database or its CI shadow-table database is allowed');
  }
}

test('real PostgreSQL shadow transaction rejects stale terms without writes and accepts the current revision', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const client = await pool.connect();
  const driver = randomUUID();
  const passenger = randomUUID();
  const demand = randomUUID();
  const proposal = randomUUID();
  const vehicle = randomUUID();
  try {
    await client.query('BEGIN');
    for (const table of ['passenger_demands', 'proposals', 'proposal_revisions', 'vehicles', 'offers', 'bookings', 'seat_occupancy_intervals',
      'booking_events', 'conversations', 'conversation_members', 'audit_events', 'realtime_outbox', 'user_blocks']) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
    }
    await client.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count,trust_level)
      VALUES($1,$2,'Test','Shadow fixture',2024,4,1)`, [vehicle, driver]);
    await client.query(`INSERT INTO passenger_demands(id,passenger_id,origin_name,destination_name,origin,destination,
      earliest_departure,latest_departure,passenger_count)
      VALUES($1,$2,'A03 shadow origin','A03 shadow destination',
        ST_SetSRID(ST_MakePoint(24,49),4326)::geography,ST_SetSRID(ST_MakePoint(25,50),4326)::geography,
        now()+interval '1 day',now()+interval '2 days',2)`, [demand, passenger]);
    await client.query(`INSERT INTO proposals(id,demand_id,driver_id,vehicle_id,price_minor,departure_at,revision_number,expires_at)
      VALUES($1,$2,$3,$4,45000,now()+interval '1 day 1 hour',3,now()+interval '2 days')`, [proposal, demand, driver, vehicle]);
    await client.query(`INSERT INTO proposal_revisions(proposal_id,revision_number,actor_id,actor_role,price_minor,departure_at)
      VALUES($1,3,$2,'driver',45000,now()+interval '1 day 1 hour')`, [proposal, driver]);
    const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    const extract = (start: string, end: string) => {
      const first = source.indexOf(start);
      const last = source.indexOf(end, first);
      assert.ok(first >= 0 && last > first);
      return source.slice(first, last);
    };
    let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    const executor = {
      async query(sql: string, values?: unknown[]) {
        if (sql === 'BEGIN') return client.query('SAVEPOINT acceptance');
        if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT acceptance');
        if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT acceptance');
        return client.query(sql, values);
      },
      release() {},
    };
    const code = ts.transpile([
      extract('class ApiError extends Error', '\nasync function usersBlockEachOther('),
      extract('async function usersBlockEachOther(', '\nconst asyncHandler ='),
      extract('async function insertRealtimeOutbox(', '\nasync function broadcastRealtime('),
      extract("app.post('/api/v1/proposals/:id/accept'", "\napp.get('/api/v1/proposals/:id/revisions'"),
    ].join('\n'), { target: ts.ScriptTarget.ES2022 });
    runInNewContext(code, {
      app: { post(_path: string, _auth: unknown, registered: typeof handler) { handler = registered; } },
      requireAuth: () => {}, asyncHandler: (registered: typeof handler) => registered,
      WHOLE_ROUTE_BOARDING, WHOLE_ROUTE_ALIGHTING, recordOccupancy, refreshAvailableSeats,
      pool: { query: executor.query, connect: async () => executor }, calculatePlatformFee,
      supportedOutboxEvents: new Set(['booking.confirmed', 'proposal.accepted', 'proposal.closed']),
    });
    assert.ok(handler);
    const snapshot = async () => (await client.query(`SELECT
      (SELECT count(*)::int FROM offers) AS offers,(SELECT count(*)::int FROM bookings) AS bookings,
      (SELECT count(*)::int FROM conversations) AS conversations,(SELECT count(*)::int FROM realtime_outbox) AS events,
      (SELECT count(*)::int FROM seat_occupancy_intervals) AS intervals,
      (SELECT status FROM proposals WHERE id=$1) AS proposal_status,
      (SELECT status FROM passenger_demands WHERE id=$2) AS demand_status`, [proposal, demand])).rows[0];
    const before = await snapshot();
    assert.deepEqual(before, { offers: 0, bookings: 0, conversations: 0, events: 0, intervals: 0, proposal_status: 'pending', demand_status: 'open' });
    let status = 0;
    let response: { agreedTotalMinor?: number } | undefined;
    const invoke = (body: unknown) => handler!({ params: { id: proposal }, userId: passenger, body }, {
      status(value: number) { status = value; return this; },
      json(value: typeof response) { response = value; },
    });
    for (const expectedRevision of [1, 2, 4]) {
      await assert.rejects(invoke({ expectedRevision }), (error: unknown) => {
        assert.equal((error as { status: number }).status, 409);
        assert.equal((error as { code: string }).code, 'proposal_revision_changed');
        return true;
      });
      assert.deepEqual(await snapshot(), before);
    }
    await invoke({ expectedRevision: 3 });
    assert.equal(status, 201);
    assert.equal(response?.agreedTotalMinor, 45000);
    assert.deepEqual(await snapshot(), { offers: 1, bookings: 1, conversations: 1, events: 2, intervals: 1, proposal_status: 'accepted', demand_status: 'matched' });
    const booking = (await client.query('SELECT total_price_minor,seat_count FROM bookings')).rows[0];
    assert.deepEqual(booking, { total_price_minor: 45000, seat_count: 2 });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
