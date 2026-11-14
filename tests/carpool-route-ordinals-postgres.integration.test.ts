import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Pool } from 'pg';
import { routeIntervalViolation } from '../server/bookings/seatInventory';

// Carpool 5.0 CP5-A01 / gates G10/G15 — real-PostgreSQL shadow proof.
// Executes the ACTUAL offer SELECT (with ST_NPoints(route)) sliced from server/index.ts
// on a temp offers table cloned from the live schema, then applies the REAL exported
// routeIntervalViolation to the returned point count. Outer transaction fully rolled
// back; no production row is written. Proves a partial interval is bounded by the route's
// segment space (N vertices ⇒ alighting <= N) and an unrouted offer admits only whole-route.
const databaseUrl = process.env.ROUTE_ORDINALS_TEST_DATABASE_URL;
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

const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
const extractSingleQuoted = (marker: string) => {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `SQL marker not found: ${marker}`);
  const open = source.lastIndexOf("'", at);
  const close = source.indexOf("'", at);
  assert.ok(open >= 0 && close > open, `unterminated string for ${marker}`);
  return source.slice(open + 1, close);
};

const offerSelect = extractSingleQuoted('ST_NPoints(route) AS route_points FROM offers WHERE id = $1 FOR UPDATE');

test('real PostgreSQL: partial ordinals are bounded by the route segment space', { skip: !databaseUrl }, async () => {
  // The handler must compute the point count and validate partial ordinals against it.
  assert.ok(source.includes('ST_NPoints(route) AS route_points'), 'offer SELECT must compute route point count');
  assert.ok(source.includes('routeIntervalViolation(currentOffer.route_points'), 'handler must bound partial ordinals by the route');
  assert.ok(source.includes('routeIntervalViolation,'), 'handler must import the route-interval validator');

  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const client = await pool.connect();
  const driver = randomUUID();
  const vehicle = randomUUID();
  const departure = new Date(Date.now() + 86_400_000).toISOString();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE offers (LIKE public.offers INCLUDING DEFAULTS) ON COMMIT DROP');

    const insertOffer = async (routeExpr: string) => {
      const { rows } = await client.query(
        `INSERT INTO offers(driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,price_per_seat_minor,total_seats,available_seats)
         VALUES ($1,$2,'O','D',ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,${routeExpr},$3,15000,2,2)
         RETURNING id`,
        [driver, vehicle, departure],
      );
      return rows[0].id as string;
    };
    const twoPoint = await insertOffer('ST_MakeLine(ST_SetSRID(ST_MakePoint(24.0,49.0),4326),ST_SetSRID(ST_MakePoint(25.0,50.0),4326))');
    const sixteenPoint = await insertOffer('(SELECT ST_MakeLine(ST_SetSRID(ST_MakePoint(24.0 + g/15.0, 49.0 + g/15.0),4326) ORDER BY g) FROM generate_series(0,15) AS g)');
    const unrouted = await insertOffer('NULL');

    const selectOffer = async (id: string) => {
      const { rows } = await client.query<{ route_points: number | null }>(offerSelect, [id]);
      return rows[0];
    };
    const two = await selectOffer(twoPoint);
    const sixteen = await selectOffer(sixteenPoint);
    const un = await selectOffer(unrouted);
    assert.equal(Number(two.route_points), 2, 'ST_NPoints of a two-vertex route is 2');
    assert.equal(Number(sixteen.route_points), 16, 'ST_NPoints of the sixteen-vertex route is 16');
    assert.equal(un.route_points, null, 'ST_NPoints of an unrouted offer is NULL');

    const points = (row: { route_points: number | null }) => (row.route_points === null ? null : Number(row.route_points));
    // Two-point route: only [1,2) is realizable; the original defect [2,5) is rejected.
    assert.equal(routeIntervalViolation(points(two), 2), null);
    assert.equal(routeIntervalViolation(points(two), 5)?.code, 'ordinal_out_of_route');
    // Sixteen-point route: alighting up to 16 valid, 17 and the abstract max rejected.
    assert.equal(routeIntervalViolation(points(sixteen), 16), null);
    assert.equal(routeIntervalViolation(points(sixteen), 12), null);
    assert.equal(routeIntervalViolation(points(sixteen), 17)?.code, 'ordinal_out_of_route');
    assert.equal(routeIntervalViolation(points(sixteen), 32766)?.code, 'ordinal_out_of_route');
    // Unrouted offer: any partial interval is rejected; whole-route is handled by the caller.
    assert.equal(routeIntervalViolation(points(un), 5)?.code, 'ordinals_require_route');
    assert.equal(routeIntervalViolation(points(un), 2)?.code, 'ordinals_require_route');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});