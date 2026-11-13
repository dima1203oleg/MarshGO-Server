import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { WHOLE_ROUTE_ALIGHTING, WHOLE_ROUTE_BOARDING } from '../server/bookings/seatInventory';

const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
const start = source.indexOf("app.post('/api/v1/proposals/:id/accept'");
const end = source.indexOf("\napp.get('/api/v1/proposals/:id/revisions'", start);
assert.ok(start >= 0 && end > start);
const errorStart = source.indexOf('class ApiError extends Error');
const errorEnd = source.indexOf('\nasync function usersBlockEachOther', errorStart);
const code = ts.transpile(source.slice(errorStart, errorEnd) + '\n' + source.slice(start, end), { target: ts.ScriptTarget.ES2022 });

type Handler = (req: unknown, res: unknown) => Promise<void>;

function fixture(options: { revision?: number; actor?: string; blocked?: boolean; latestRole?: string } = {}) {
  const statements: string[] = [];
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const outbox: unknown[][] = [];
  let released = false;
  let handler: Handler | undefined;
  let status = 200;
  let body: { agreedTotalMinor?: number; data?: { total_price_minor: number } } | undefined;
  const departure = new Date(Date.now() + 86400000);
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.startsWith('SELECT navigation_candidate_id')) return { rows: [{ navigation_candidate_id: null }] };
    if (sql.includes('FOR UPDATE OF d')) return { rows: [{ id: 'demand', passenger_id: 'passenger', passenger_count: 2,
      status: 'open', earliest_departure: new Date(departure.getTime() - 1000), latest_departure: new Date(departure.getTime() + 1000) }] };
    if (sql.includes('FROM proposals WHERE id=$1 AND demand_id=$2 FOR UPDATE')) return { rows: [{
      id: 'proposal', driver_id: 'driver', vehicle_id: 'vehicle', price_minor: 45000, departure_at: departure,
      status: 'pending', expires_at: departure, navigation_candidate_id: null,
      ...(sql.includes('revision_number') ? { revision_number: options.revision ?? 3 } : {}),
    }] };
    if (sql.includes('FROM proposal_revisions')) return { rows: [{ actor_role: options.latestRole ?? 'driver' }] };
    if (sql.includes('FROM vehicles')) return { rows: [{ id: 'vehicle' }] };
    if (/^\s*(INSERT|UPDATE)/.test(sql)) {
      writes.push({ sql, values });
      if (sql.includes('INSERT INTO offers')) return { rows: [{ id: 'offer' }] };
      if (sql.includes('INSERT INTO bookings(')) return { rows: [{ id: 'booking', total_price_minor: values[4] }] };
      if (sql.includes('UPDATE offers SET available_seats')) return { rows: [{ available_seats: 0 }] };
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release() { released = true; } };
  runInNewContext(code, {
    app: { post(_path: string, _auth: unknown, registered: Handler) { handler = registered; } },
    requireAuth: () => {}, asyncHandler: (registered: Handler) => registered,
    WHOLE_ROUTE_BOARDING, WHOLE_ROUTE_ALIGHTING,
    recordOccupancy: async () => {}, refreshAvailableSeats: async () => 0,
    pool: { query, connect: async () => client },
    usersBlockEachOther: async () => options.blocked ?? false,
    calculatePlatformFee: () => ({ feeClass: 'community', platformFeeMinor: 0, ruleVersion: 'community-0pct-v1' }),
    insertRealtimeOutbox: async (...args: unknown[]) => { outbox.push(args); },
  });
  assert.ok(handler);
  return {
    statements, writes, outbox,
    get released() { return released; }, get status() { return status; }, get body() { return body; },
    invoke: (input: unknown) => handler!({ params: { id: 'proposal' }, userId: options.actor ?? 'passenger', body: input }, {
      status(value: number) { status = value; return this; },
      json(value: typeof body) { body = value; },
    }),
  };
}

function rejected(status: number, code?: string) {
  return (error: unknown) => {
    const value = error as { status?: number; code?: string };
    assert.equal(value.status, status);
    if (code) assert.equal(value.code, code);
    return true;
  };
}

test('stale or future displayed revisions roll back before booking, inventory, chat or events', async () => {
  for (const expectedRevision of [1, 2, 4]) {
    const state = fixture();
    await assert.rejects(state.invoke({ expectedRevision, priceMinor: 50000 }), rejected(409, 'proposal_revision_changed'));
    assert.equal(state.writes.length, 0);
    assert.equal(state.outbox.length, 0);
    assert.equal(state.statements.at(-1), 'ROLLBACK');
    assert.ok(state.released);
    assert.ok(state.statements.some(sql => sql.includes('revision_number') && sql.includes('FOR UPDATE')));
  }
});

test('missing and malformed revisions fail before acquiring a database client', async () => {
  for (const expectedRevision of [undefined, null, '3', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const state = fixture();
    await assert.rejects(state.invoke({ expectedRevision }), rejected(400));
    assert.equal(state.statements.length, 0);
    assert.equal(state.released, false);
  }
});

test('current revision commits the authoritative agreed total, not passenger-supplied price', async () => {
  const state = fixture();
  await state.invoke({ expectedRevision: 3, priceMinor: 1 });
  assert.equal(state.status, 201);
  assert.equal(state.body?.agreedTotalMinor, 45000);
  assert.equal(state.body?.data?.total_price_minor, 45000);
  assert.equal(state.writes.filter(write => write.sql.includes('INSERT INTO bookings(')).length, 1);
  assert.equal(state.writes.filter(write => write.sql.includes('INSERT INTO conversations(')).length, 1);
  assert.equal(state.outbox.length, 2);
  assert.equal(state.statements.at(-1), 'COMMIT');
  assert.ok(state.released);
});

test('revision guard preserves participant ownership, blocking and driver agreement checks', async () => {
  for (const [options, status] of [
    [{ actor: 'stranger' }, 404], [{ blocked: true }, 404], [{ latestRole: 'passenger' }, 409],
  ] as const) {
    const state = fixture(options);
    await assert.rejects(state.invoke({ expectedRevision: 3 }), rejected(status));
    assert.equal(state.writes.length, 0);
    assert.equal(state.outbox.length, 0);
    assert.equal(state.statements.at(-1), 'ROLLBACK');
    assert.ok(state.released);
  }
});
