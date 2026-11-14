import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { WHOLE_ROUTE_BOARDING, WHOLE_ROUTE_ALIGHTING, MAX_PARTIAL_ALIGHTING } from '../server/bookings/seatInventory';

const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
const extract = (start: string, end: string) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `cannot extract ${start}`);
  return source.slice(first, last);
};
const code = ts.transpile(
  extract('class ApiError extends Error', '\nasync function usersBlockEachOther') + '\n'
    + extract("app.post('/api/v1/bookings'", "\napp.post('/api/v1/bookings/:id/cancel'"),
  { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
);
const offerId = '22222222-2222-4222-8222-222222222222';
const replayKey = 'interval-replay-test-key';
type Handler = (req: unknown, res: unknown) => Promise<void>;

function replayFixture(boarding: number | null, alighting: number | null, hasJourney = false) {
  const stored: Record<string, unknown> = {
    id: 'booking', offer_id: offerId, seat_count: 1, total_price_minor: 15000, currency: 'UAH',
    fee_class: 'community', platform_fee_minor: 0, fee_rule_version: 'community-0pct-v1', status: 'confirmed',
    boarding_ordinal: boarding, alighting_ordinal: alighting,
  };
  const statements: string[] = [];
  const state = { status: 0, body: undefined as undefined | { replayed: boolean; data: Record<string, unknown> }, released: false };
  let handler: Handler | undefined;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (sql.includes('FROM offers WHERE id = $1 FOR UPDATE')) return { rows: [{ status: 'published' }] };
      if (sql.includes('FROM bookings WHERE passenger_id = $1 AND idempotency_key = $2')) {
        assert.deepEqual(Array.from(values), ['passenger', replayKey]);
        const columns = sql.match(/^SELECT (.+) FROM bookings WHERE /)?.[1].split(',').map((value) => value.trim());
        assert.ok(columns, 'expected a booking projection');
        return { rows: [Object.fromEntries(columns.map((column) => [column, stored[column]]))] };
      }
      if (sql === 'SELECT id FROM journey_legs WHERE booking_id=$1 AND journey_id=$2 AND id=$3') return { rows: [] };
      if (sql === 'SELECT id FROM journey_legs WHERE booking_id=$1') return { rows: hasJourney ? [{ id: 'leg' }] : [] };
      throw new Error(`Unexpected query during replay: ${sql}`);
    },
    release() { state.released = true; },
  };
  runInNewContext(code, {
    app: { post: (_path: string, _auth: unknown, registered: Handler) => { handler = registered; } },
    requireAuth: () => {}, asyncHandler: (registered: Handler) => registered,
    pool: { connect: async () => client },
    WHOLE_ROUTE_BOARDING, WHOLE_ROUTE_ALIGHTING, MAX_PARTIAL_ALIGHTING,
  });
  assert.ok(handler);
  return {
    state, statements,
    invoke: (body: Record<string, unknown> = {}) => handler!({
      userId: 'passenger', body: { offerId, seats: 1, ...body }, get: () => replayKey,
    }, {
      status(value: number) { state.status = value; return this; },
      json(value: NonNullable<typeof state.body>) { state.body = value; },
    }),
  };
}

const conflict = { status: 409, message: 'idempotency key already used for another request' };

for (const [label, boarding, alighting, body] of [
  ['partial', 2, 5, { boardingOrdinal: 2, alightingOrdinal: 5 }],
  ['omitted whole-route', 1, 32767, {}],
] as const) {
  test(`booking replay: identical ${label} interval returns the stored booking without writes`, async () => {
    const fixture = replayFixture(boarding, alighting);
    await fixture.invoke(body);
    assert.equal(fixture.state.status, 200);
    assert.equal(fixture.state.body?.replayed, true);
    assert.equal(fixture.state.body?.data.id, 'booking');
    assert.equal(fixture.state.body?.data.boarding_ordinal, boarding);
    assert.equal(fixture.state.body?.data.alighting_ordinal, alighting);
    assert.equal(fixture.statements.at(-1), 'COMMIT');
    assert.ok(fixture.statements.every((sql) => /^(SELECT|BEGIN|COMMIT)/.test(sql)));
    assert.equal(fixture.state.released, true);
  });
}

for (const [label, body] of [
  ['boarding only', { boardingOrdinal: 3, alightingOrdinal: 5 }],
  ['alighting only', { boardingOrdinal: 2, alightingOrdinal: 6 }],
  ['disjoint interval', { boardingOrdinal: 5, alightingOrdinal: 8 }],
  ['omitted whole-route interval', {}],
] as const) {
  test(`booking replay: changing ${label} returns 409 and rolls back`, async () => {
    const fixture = replayFixture(2, 5);
    await assert.rejects(fixture.invoke(body), conflict);
    assert.equal(fixture.statements.at(-1), 'ROLLBACK');
    assert.equal(fixture.statements.length, 4);
    assert.equal(fixture.state.body, undefined);
    assert.equal(fixture.state.released, true);
  });
}

test('booking replay: changing whole-route to partial returns 409', async () => {
  const fixture = replayFixture(1, 32767);
  await assert.rejects(fixture.invoke({ boardingOrdinal: 1, alightingOrdinal: 16 }), conflict);
  assert.equal(fixture.statements.at(-1), 'ROLLBACK');
  assert.equal(fixture.state.released, true);
});

test('booking replay: legacy NULL ordinals replay only as the whole route', async () => {
  const whole = replayFixture(null, null);
  await whole.invoke();
  assert.equal(whole.state.status, 200);
  assert.equal(whole.state.body?.replayed, true);
  assert.equal(whole.state.body?.data.id, 'booking');
  assert.equal(whole.state.body?.data.boarding_ordinal, null);
  assert.equal(whole.state.body?.data.alighting_ordinal, null);
  assert.equal(whole.statements.at(-1), 'COMMIT');
  const partial = replayFixture(null, null);
  await assert.rejects(partial.invoke({ boardingOrdinal: 1, alightingOrdinal: 16 }), conflict);
  assert.equal(partial.statements.at(-1), 'ROLLBACK');
});

test('booking replay: existing offer and seat identity guards remain enforced', async () => {
  for (const body of [{ offerId: '33333333-3333-4333-8333-333333333333' }, { seats: 2 }]) {
    const fixture = replayFixture(2, 5);
    await assert.rejects(fixture.invoke({ boardingOrdinal: 2, alightingOrdinal: 5, ...body }), conflict);
    assert.equal(fixture.statements.at(-1), 'ROLLBACK');
  }
});

test('booking replay: an unchanged interval cannot bypass the Journey association guard', async () => {
  const fixture = replayFixture(2, 5, true);
  await assert.rejects(fixture.invoke({ boardingOrdinal: 2, alightingOrdinal: 5 }), {
    status: 409, message: 'idempotency key already used with another Journey association',
  });
  assert.equal(fixture.statements.at(-1), 'ROLLBACK');
});

test('booking replay: malformed ordinals are rejected before opening a transaction', async () => {
  for (const body of [
    { boardingOrdinal: 2 }, { alightingOrdinal: 5 },
    { boardingOrdinal: 2, alightingOrdinal: 2 }, { boardingOrdinal: 2, alightingOrdinal: 32767 },
    { boardingOrdinal: 1.5, alightingOrdinal: 5 }, { boardingOrdinal: null, alightingOrdinal: null },
  ]) {
    const fixture = replayFixture(2, 5);
    await assert.rejects(fixture.invoke(body), { status: 400 });
    assert.deepEqual(fixture.statements, []);
  }
});
