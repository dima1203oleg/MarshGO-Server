import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Pool } from 'pg';

// Carpool 5.0 CP5-A02 / gate G14 — real-PostgreSQL shadow proof.
// Executes the ACTUAL embedded SQL from server/index.ts (offers INSERT, bookings
// INSERT and the price-edit UPDATE ... CASE) on temp tables cloned from the live
// schema, inside an outer transaction that is fully rolled back. No production
// row is written. TOTAL_ALL must keep the quoted group price; PER_SEAT multiplies.
const databaseUrl = process.env.FARE_BASIS_TEST_DATABASE_URL;
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
const extractTemplate = (marker: string) => {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `SQL marker not found: ${marker}`);
  const open = source.lastIndexOf('`', at);
  const close = source.indexOf('`', at);
  assert.ok(open >= 0 && close > open, `unterminated template for ${marker}`);
  return source.slice(open + 1, close);
};
const extractQuoted = (marker: string) => {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `SQL marker not found: ${marker}`);
  const open = source.lastIndexOf('"', at);
  const close = source.indexOf('"', at);
  assert.ok(open >= 0 && close > open, `unterminated string for ${marker}`);
  return source.slice(open + 1, close);
};

const offersInsert = extractTemplate('INSERT INTO offers(driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats,fare_basis)');
const bookingsInsert = extractTemplate('INSERT INTO bookings(offer_id, passenger_id, seat_count, unit_price_minor, total_price_minor, currency, fee_class, platform_fee_minor, fee_rule_version, idempotency_key, boarding_ordinal, alighting_ordinal, fare_basis)');
const priceEditUpdate = extractQuoted("UPDATE bookings SET unit_price_minor=$2,total_price_minor=$2*(CASE WHEN fare_basis='TOTAL_ALL' THEN 1 ELSE seat_count END) WHERE id=$1");

test('real PostgreSQL: fare_basis survives publication and the group total is never doubled', { skip: !databaseUrl }, async () => {
  // Both price-edit sites (driver drop + passenger accept) must use the CASE form.
  const caseStatement = "total_price_minor=$2*(CASE WHEN fare_basis='TOTAL_ALL' THEN 1 ELSE seat_count END)";
  assert.equal(source.split(caseStatement).length - 1, 2, 'both price-edit UPDATEs must branch on fare_basis');
  assert.ok(!source.includes('$2*seat_count'), 'no blind seat_count multiplication may remain');

  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const client = await pool.connect();
  const driver = randomUUID();
  const vehicle = randomUUID();
  const passenger = randomUUID();
  const departure = new Date(Date.now() + 86_400_000).toISOString();
  try {
    await client.query('BEGIN');
    for (const table of ['offers', 'bookings']) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
    }

    const publish = async (fareBasis: 'PER_SEAT' | 'TOTAL_ALL') => {
      const { rows } = await client.query(offersInsert, [
        driver, vehicle, 'Лівий берег', 'Правий берег', 30.6, 50.4, 30.5, 50.45, null,
        departure, null, null, null, 'development_unrouted', 45000, 2, fareBasis,
      ]);
      assert.equal(rows[0].fare_basis, fareBasis, 'offers INSERT must persist and return fare_basis');
      return rows[0].id as string;
    };
    const totalAllOffer = await publish('TOTAL_ALL');
    const perSeatOffer = await publish('PER_SEAT');

    // Mirror the handler's total computation (server/index.ts POST /bookings).
    const book = async (offerId: string, fareBasis: 'PER_SEAT' | 'TOTAL_ALL', seats: number) => {
      const unit = 45000;
      const total = fareBasis === 'TOTAL_ALL' ? unit : unit * seats;
      const { rows } = await client.query(bookingsInsert, [
        offerId, passenger, seats, unit, total, 'UAH', 'community', 0, 'community-0pct-v1',
        randomUUID(), 1, 32767, fareBasis,
      ]);
      return { id: rows[0].id as string, total: Number(rows[0].total_price_minor) };
    };
    const groupBooking = await book(totalAllOffer, 'TOTAL_ALL', 2);
    const perSeatBooking = await book(perSeatOffer, 'PER_SEAT', 2);
    assert.equal(groupBooking.total, 45000, 'TOTAL_ALL 450 UAH stays 450 UAH for two passengers');
    assert.equal(perSeatBooking.total, 90000, 'PER_SEAT 450 UAH × 2 = 900 UAH');

    // Apply the real price-edit UPDATE (drop 450 → 400) to both bookings.
    await client.query(priceEditUpdate, [groupBooking.id, 40000]);
    await client.query(priceEditUpdate, [perSeatBooking.id, 40000]);
    const after = await client.query('SELECT id, fare_basis, unit_price_minor, total_price_minor FROM bookings ORDER BY fare_basis');
    const byBasis = Object.fromEntries(after.rows.map((row) => [row.fare_basis, row]));
    assert.equal(Number(byBasis.TOTAL_ALL.unit_price_minor), 40000);
    assert.equal(Number(byBasis.TOTAL_ALL.total_price_minor), 40000, 'TOTAL_ALL drop must not double the group price');
    assert.equal(Number(byBasis.PER_SEAT.unit_price_minor), 40000);
    assert.equal(Number(byBasis.PER_SEAT.total_price_minor), 80000, 'PER_SEAT drop multiplies by seat_count');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});