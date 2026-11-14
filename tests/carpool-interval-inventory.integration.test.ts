import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { globalMaxOccupancy, maxOccupancyOverInterval } from '../server/bookings/seatInventory';

// Carpool 5.0 P0.1 — route-interval seat inventory (spec XXXIX.3, T26/T28, G12–G17).
// Half-open [boardingOrdinal, alightingOrdinal): the same physical seat may be sold
// to sequential passengers whose intervals do not intersect, and must never be
// oversold on any shared edge. seat_occupancy_intervals is authoritative.
const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('API integration tests are restricted to a loopback database');
}

const ACTIVE = `(oi.state = 'CONFIRMED' OR (oi.state = 'HELD' AND oi.expires_at > now()))`;

describe('Carpool interval seat inventory (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const driver = crypto.randomUUID();
  const vehicle = crypto.randomUUID();
  const passengers = Array.from({ length: 100 }, () => crypto.randomUUID());
  const allUsers = [driver, ...passengers];
  const createdOffers: string[] = [];
  const createdBookings: string[] = [];

  const key = () => `interval-${crypto.randomUUID()}`;

  async function mkOffer(totalSeats: number, fareBasis: 'PER_SEAT' | 'TOTAL_ALL' = 'PER_SEAT'): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,
         departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats,fare_basis)
       VALUES ($1,$2,$3,'Interval Origin','Interval Destination',
         ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,
         ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
         (SELECT ST_MakeLine(ST_SetSRID(ST_MakePoint(24.0 + g/15.0, 49.0 + g/15.0),4326) ORDER BY g) FROM generate_series(0,15) AS g),
         now()+interval '10 days',now()+interval '10 days 1 hour',140000,3600,'osrm',15000,$4,$4,$5)`,
      [id, driver, vehicle, totalSeats, fareBasis],
    );
    createdOffers.push(id);
    return id;
  }

  // An unrouted offer (route IS NULL) admits only the whole-route sentinel; partial
  // ordinals have no segment space to bind to (G10/G15).
  async function mkUnroutedOffer(totalSeats: number): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,
         departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats,fare_basis)
       VALUES ($1,$2,$3,'Unrouted Origin','Unrouted Destination',
         ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,
         ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
         NULL,
         now()+interval '10 days',now()+interval '10 days 1 hour',140000,3600,'development_unrouted',15000,$4,$4,'PER_SEAT')`,
      [id, driver, vehicle, totalSeats],
    );
    createdOffers.push(id);
    return id;
  }

  function book(userId: string, offerId: string, opts: { seats?: number; boarding?: number; alighting?: number; key?: string } = {}) {
    const body: Record<string, unknown> = { offerId, seats: opts.seats ?? 1 };
    if (opts.boarding !== undefined) body.boardingOrdinal = opts.boarding;
    if (opts.alighting !== undefined) body.alightingOrdinal = opts.alighting;
    return fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-user-id': userId, 'idempotency-key': opts.key ?? key() },
      body: JSON.stringify(body),
    });
  }

  async function bookOk(userId: string, offerId: string, opts: { seats?: number; boarding?: number; alighting?: number; key?: string } = {}) {
    const response = await book(userId, offerId, opts);
    assert.equal(response.status, 201, `expected 201, got ${response.status}: ${await response.clone().text()}`);
    const body = await response.json() as { data: { id: string; boarding_ordinal: number; alighting_ordinal: number; fare_basis: string } };
    createdBookings.push(body.data.id);
    return body.data;
  }

  async function bookConflict(userId: string, offerId: string, opts: { seats?: number; boarding?: number; alighting?: number } = {}) {
    const response = await book(userId, offerId, opts);
    assert.equal(response.status, 409, `expected 409, got ${response.status}: ${await response.clone().text()}`);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'no_capacity');
  }

  async function bookBadRequest(userId: string, offerId: string, opts: { seats?: number; boarding?: number; alighting?: number }, code: string) {
    const response = await book(userId, offerId, opts);
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${await response.clone().text()}`);
    assert.equal((await response.json() as { error: { code: string } }).error.code, code);
  }

  const cancel = (userId: string, bookingId: string) => fetch(`${apiUrl}/api/v1/bookings/${bookingId}/cancel`, {
    method: 'POST', headers: { 'x-dev-user-id': userId },
  });

  async function offerState(offerId: string) {
    const { rows } = await pool.query<{ available_seats: number; total_seats: number; inventory_version: number }>(
      'SELECT available_seats,total_seats,inventory_version FROM offers WHERE id=$1', [offerId],
    );
    return rows[0];
  }

  async function activeIntervals(offerId: string) {
    const { rows } = await pool.query<{ booking_id: string; boarding_ordinal: number; alighting_ordinal: number; seat_count: number; state: string }>(
      `SELECT booking_id,boarding_ordinal,alighting_ordinal,seat_count,state FROM seat_occupancy_intervals oi
        WHERE offer_id=$1 AND ${ACTIVE} ORDER BY boarding_ordinal,alighting_ordinal`, [offerId],
    );
    return rows;
  }

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES ($1,'Interval test driver',ARRAY['driver'])`, [driver]);
    await pool.query(`INSERT INTO users(id,display_name,roles)
      SELECT user_id,'Interval test passenger',ARRAY['passenger'] FROM unnest($1::uuid[]) AS user_id`, [passengers]);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES ($1,'driver')`, [driver]);
    await pool.query(`INSERT INTO user_roles(user_id,role) SELECT user_id,'passenger' FROM unnest($1::uuid[]) AS user_id`, [passengers]);
    await pool.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count) VALUES ($1,$2,'Test','Interval',2024,4)`, [vehicle, driver]);
  });

  after(async () => {
    await pool.query(`DELETE FROM conversation_members WHERE conversation_id IN
      (SELECT id FROM conversations WHERE booking_id IN (SELECT id FROM bookings WHERE offer_id = ANY($1::uuid[])))`, [createdOffers]);
    await pool.query('DELETE FROM conversations WHERE booking_id IN (SELECT id FROM bookings WHERE offer_id = ANY($1::uuid[]))', [createdOffers]);
    await pool.query('DELETE FROM realtime_outbox WHERE recipient_ids && $1::uuid[]', [allUsers]);
    await pool.query('DELETE FROM audit_events WHERE actor_id = ANY($1::uuid[]) OR entity_id = ANY($2::uuid[])',
      [allUsers, [...createdOffers, ...createdBookings, vehicle]]);
    await pool.query('DELETE FROM bookings WHERE offer_id = ANY($1::uuid[])', [createdOffers]);
    await pool.query('DELETE FROM offers WHERE id = ANY($1::uuid[])', [createdOffers]);
    await pool.query('DELETE FROM vehicles WHERE id=$1', [vehicle]);
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [allUsers]);
    await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])', [allUsers]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [allUsers]);
    await pool.end();
  });

  it('T28: reuses one seat for sequential non-overlapping intervals [2,5) then [5,8)', async () => {
    const offer = await mkOffer(1);
    const first = await bookOk(passengers[0], offer, { boarding: 2, alighting: 5 });
    assert.equal(first.boarding_ordinal, 2);
    assert.equal(first.alighting_ordinal, 5);
    // The derived global cache reads 0 (total 1 - globalMax 1), yet the authoritative
    // interval check must still allow the disjoint second leg — no false global FULL.
    assert.equal((await offerState(offer)).available_seats, 0);
    const second = await bookOk(passengers[1], offer, { boarding: 5, alighting: 8 });
    assert.equal(second.boarding_ordinal, 5);
    const intervals = await activeIntervals(offer);
    assert.equal(intervals.length, 2);
    assert.deepEqual(intervals.map((row) => [row.boarding_ordinal, row.alighting_ordinal]), [[2, 5], [5, 8]]);
    const confirmed = await pool.query<{ count: string }>(
      `SELECT count(*) FROM bookings WHERE offer_id=$1 AND status='confirmed'`, [offer],
    );
    assert.equal(Number(confirmed.rows[0].count), 2);
  });

  it('T28: rejects intersecting intervals [2,6) then [5,8) on a one-seat offer', async () => {
    const offer = await mkOffer(1);
    await bookOk(passengers[0], offer, { boarding: 2, alighting: 6 });
    await bookConflict(passengers[1], offer, { boarding: 5, alighting: 8 });
    const intervals = await activeIntervals(offer);
    assert.equal(intervals.length, 1);
    assert.deepEqual([intervals[0].boarding_ordinal, intervals[0].alighting_ordinal], [2, 6]);
    const confirmed = await pool.query<{ count: string }>(
      `SELECT count(*) FROM bookings WHERE offer_id=$1 AND status='confirmed'`, [offer],
    );
    assert.equal(Number(confirmed.rows[0].count), 1);
  });

  it('T26: exactly one of 100 concurrent whole-route bookings wins a single seat', async () => {
    const offer = await mkOffer(1);
    const attempts = await Promise.all(passengers.map((userId) => book(userId, offer, { seats: 1 })));
    const created = attempts.filter((response) => response.status === 201);
    const conflicts = attempts.filter((response) => response.status === 409);
    assert.equal(created.length, 1, `expected exactly 1 winner, got ${created.length}`);
    assert.equal(conflicts.length, 99);
    for (const response of created) {
      createdBookings.push((await response.json() as { data: { id: string } }).data.id);
    }
    const intervals = await activeIntervals(offer);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].seat_count, 1);
    assert.equal((await offerState(offer)).available_seats, 0);
    // No edge may ever exceed capacity: brute-force every ordinal of the winning interval.
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ max_occ: number }>(
        `WITH segs AS (SELECT generate_series($2::int,$3::int) AS ord)
         SELECT COALESCE(MAX(seats),0)::int AS max_occ FROM (
           SELECT s.ord, COALESCE(SUM(oi.seat_count),0) AS seats
             FROM segs s LEFT JOIN seat_occupancy_intervals oi
               ON oi.offer_id=$1 AND oi.boarding_ordinal<=s.ord AND oi.alighting_ordinal>s.ord AND ${ACTIVE}
            GROUP BY s.ord) occ`,
        [offer, intervals[0].boarding_ordinal, intervals[0].alighting_ordinal - 1],
      );
      assert.equal(rows[0].max_occ, 1);
    } finally {
      client.release();
    }
  });

  it('requires the requested group seats on every shared edge, not just the endpoints', async () => {
    const offer = await mkOffer(2);
    await bookOk(passengers[0], offer, { seats: 2, boarding: 2, alighting: 6 });
    // Edge 5 already carries 2/2 seats, so even a single extra seat must be rejected.
    await bookConflict(passengers[1], offer, { seats: 1, boarding: 5, alighting: 8 });
    // A leg starting exactly at the first alighting ordinal shares no edge and is allowed.
    await bookOk(passengers[2], offer, { seats: 1, boarding: 6, alighting: 9 });
    const intervals = await activeIntervals(offer);
    assert.equal(intervals.length, 2);
  });

  it('T27: a group of two is atomically rejected when only one seat remains', async () => {
    const offer = await mkOffer(1);
    await bookConflict(passengers[0], offer, { seats: 2 });
    assert.equal((await activeIntervals(offer)).length, 0);
    const state = await offerState(offer);
    assert.equal(state.available_seats, 1);
    assert.equal(state.inventory_version, 0);
    const bookings = await pool.query<{ count: string }>('SELECT count(*) FROM bookings WHERE offer_id=$1', [offer]);
    assert.equal(Number(bookings.rows[0].count), 0);
    // The single seat is still bookable by a solo passenger after the atomic rejection.
    await bookOk(passengers[1], offer, { seats: 1 });
  });

  it('snapshots fare_basis from the offer onto each booking (PER_SEAT and TOTAL_ALL)', async () => {
    const perSeat = await mkOffer(3, 'PER_SEAT');
    const totalAll = await mkOffer(3, 'TOTAL_ALL');
    const a = await bookOk(passengers[0], perSeat, { seats: 2 });
    const b = await bookOk(passengers[1], totalAll, { seats: 2 });
    assert.equal(a.fare_basis, 'PER_SEAT');
    assert.equal(b.fare_basis, 'TOTAL_ALL');
    const stored = await pool.query<{ fare_basis: string }>(
      'SELECT fare_basis FROM bookings WHERE id = ANY($1::uuid[]) ORDER BY id', [[a.id, b.id]],
    );
    assert.equal(stored.rows.length, 2);
    assert.ok(stored.rows.every((row) => row.fare_basis === 'PER_SEAT' || row.fare_basis === 'TOTAL_ALL'));
  });

  it('idempotent replay returns the same booking without consuming a second interval', async () => {
    const offer = await mkOffer(1);
    const replayKey = key();
    const first = await bookOk(passengers[0], offer, { boarding: 2, alighting: 5, key: replayKey });
    const before = await offerState(offer);
    const replay = await book(passengers[0], offer, { boarding: 2, alighting: 5, key: replayKey });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json() as { replayed: boolean; data: { id: string; boarding_ordinal: number; alighting_ordinal: number } };
    assert.equal(replayBody.replayed, true);
    assert.equal(replayBody.data.id, first.id);
    assert.equal(replayBody.data.boarding_ordinal, 2);
    assert.equal(replayBody.data.alighting_ordinal, 5);
    assert.equal((await activeIntervals(offer)).length, 1);
    const after = await offerState(offer);
    assert.equal(after.available_seats, before.available_seats);
    assert.equal(after.inventory_version, before.inventory_version);
  });

  it('rejects reuse of a partial-booking key for a changed interval without changing inventory', async () => {
    const offer = await mkOffer(2);
    const replayKey = key();
    const first = await bookOk(passengers[0], offer, { boarding: 2, alighting: 5, key: replayKey });
    const before = await offerState(offer);
    const beforeIntervals = await activeIntervals(offer);
    const changes = [
      { boarding: 3, alighting: 5 },
      { boarding: 2, alighting: 6 },
      { boarding: 5, alighting: 8 },
      {},
    ];
    for (const interval of changes) {
      const response = await book(passengers[0], offer, { ...interval, key: replayKey });
      assert.equal(response.status, 409, `expected idempotency conflict for ${JSON.stringify(interval)}`);
      const body = await response.json() as { error: { message: string } };
      assert.equal(body.error.message, 'idempotency key already used for another request');
      assert.deepEqual(await offerState(offer), before);
      assert.deepEqual(await activeIntervals(offer), beforeIntervals);
    }
    const stored = await pool.query(
      'SELECT id,boarding_ordinal,alighting_ordinal FROM bookings WHERE offer_id=$1', [offer],
    );
    assert.deepEqual(stored.rows, [{ id: first.id, boarding_ordinal: 2, alighting_ordinal: 5 }]);
    const replay = await book(passengers[0], offer, { boarding: 2, alighting: 5, key: replayKey });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { data: { id: string } }).data.id, first.id);
  });

  it('replays omitted whole-route ordinals but rejects changing the key to a partial interval', async () => {
    const offer = await mkOffer(2);
    const replayKey = key();
    const first = await bookOk(passengers[0], offer, { key: replayKey });
    const before = await offerState(offer);
    const beforeIntervals = await activeIntervals(offer);
    const changed = await book(passengers[0], offer, { boarding: 1, alighting: 16, key: replayKey });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json() as { error: { message: string } }).error.message,
      'idempotency key already used for another request');
    const replay = await book(passengers[0], offer, { key: replayKey });
    assert.equal(replay.status, 200);
    const body = await replay.json() as { replayed: boolean; data: { id: string; boarding_ordinal: number; alighting_ordinal: number } };
    assert.equal(body.replayed, true);
    assert.equal(body.data.id, first.id);
    assert.equal(body.data.boarding_ordinal, 1);
    assert.equal(body.data.alighting_ordinal, 32767);
    assert.deepEqual(await offerState(offer), before);
    assert.deepEqual(await activeIntervals(offer), beforeIntervals);
    const stored = await pool.query('SELECT id FROM bookings WHERE offer_id=$1', [offer]);
    assert.deepEqual(stored.rows, [{ id: first.id }]);
  });

  it('replays legacy NULL booking ordinals only as the whole route without mutating the stored snapshot', async () => {
    const offer = await mkOffer(2);
    const replayKey = key();
    const first = await bookOk(passengers[0], offer, { key: replayKey });
    await pool.query('UPDATE bookings SET boarding_ordinal=NULL,alighting_ordinal=NULL WHERE id=$1', [first.id]);
    const before = await offerState(offer);
    const beforeIntervals = await activeIntervals(offer);
    const partial = await book(passengers[0], offer, { boarding: 1, alighting: 16, key: replayKey });
    assert.equal(partial.status, 409);
    assert.equal((await partial.json() as { error: { message: string } }).error.message,
      'idempotency key already used for another request');
    const replay = await book(passengers[0], offer, { key: replayKey });
    assert.equal(replay.status, 200);
    const body = await replay.json() as { replayed: boolean; data: { id: string } };
    assert.equal(body.replayed, true);
    assert.equal(body.data.id, first.id);
    assert.deepEqual(await offerState(offer), before);
    assert.deepEqual(await activeIntervals(offer), beforeIntervals);
    const stored = await pool.query('SELECT id,boarding_ordinal,alighting_ordinal FROM bookings WHERE offer_id=$1', [offer]);
    assert.deepEqual(stored.rows, [{ id: first.id, boarding_ordinal: null, alighting_ordinal: null }]);
  });

  it('cancelling releases the interval so the seat is reusable, idempotently', async () => {
    const offer = await mkOffer(1);
    const booking = await bookOk(passengers[0], offer, { boarding: 2, alighting: 6 });
    assert.equal((await offerState(offer)).available_seats, 0);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.equal((await cancel(passengers[0], booking.id)).status, 200);
    }
    const released = await pool.query<{ state: string }>(
      'SELECT state FROM seat_occupancy_intervals WHERE booking_id=$1', [booking.id],
    );
    assert.equal(released.rows[0].state, 'RELEASED');
    assert.equal((await activeIntervals(offer)).length, 0);
    assert.equal((await offerState(offer)).available_seats, 1);
    // The freed seat is bookable again, both as a partial leg and whole-route.
    await bookOk(passengers[1], offer, { boarding: 5, alighting: 8 });
  });

  it('a whole-route booking blocks every overlapping partial leg on a one-seat offer', async () => {
    const offer = await mkOffer(1);
    const whole = await bookOk(passengers[0], offer, { seats: 1 });
    assert.equal(whole.boarding_ordinal, 1);
    assert.equal(whole.alighting_ordinal, 32767);
    await bookConflict(passengers[1], offer, { boarding: 2, alighting: 5 });
    // A partial near the upper end of the route's segment space still overlaps whole-route.
    await bookConflict(passengers[2], offer, { boarding: 10, alighting: 15 });
  });

  it('A01: rejects partial ordinals beyond the route point count with 400 ordinal_out_of_route', async () => {
    const offer = await mkOffer(2); // 16-vertex route ⇒ valid partial alighting <= 16
    // The route has 16 points; alighting 17 exceeds the segment space and is physically unrealizable.
    await bookBadRequest(passengers[0], offer, { boarding: 2, alighting: 17 }, 'ordinal_out_of_route');
    await bookBadRequest(passengers[1], offer, { boarding: 5, alighting: 32766 }, 'ordinal_out_of_route');
    // The boundary itself is realizable: alighting == point count books the final segment.
    await bookOk(passengers[2], offer, { boarding: 14, alighting: 16 });
    assert.equal((await activeIntervals(offer)).length, 1);
    assert.equal((await offerState(offer)).available_seats, 1);
  });

  it('A01: an unrouted offer admits only the whole route, never a partial interval', async () => {
    const offer = await mkUnroutedOffer(2);
    await bookBadRequest(passengers[0], offer, { boarding: 2, alighting: 5 }, 'ordinals_require_route');
    // Whole-route sentinel still books normally on an unrouted offer.
    const whole = await bookOk(passengers[1], offer, { seats: 1 });
    assert.equal(whole.boarding_ordinal, 1);
    assert.equal(whole.alighting_ordinal, 32767);
    assert.equal((await offerState(offer)).available_seats, 1);
  });

  it('A01: a two-point route admits only [1,2) partial or the whole-route sentinel', async () => {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,
         departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats,fare_basis)
       VALUES ($1,$2,$3,'Two Point','Two Point',
         ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,
         ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
         ST_MakeLine(ST_SetSRID(ST_MakePoint(24.0,49.0),4326),ST_SetSRID(ST_MakePoint(25.0,50.0),4326)),
         now()+interval '10 days',now()+interval '10 days 1 hour',140000,3600,'osrm',15000,1,1,'PER_SEAT')`,
      [id, driver, vehicle],
    );
    createdOffers.push(id);
    // The original defect: [2,5) on a single-segment route must now be rejected, not sold.
    await bookBadRequest(passengers[0], id, { boarding: 2, alighting: 5 }, 'ordinal_out_of_route');
    await bookOk(passengers[1], id, { boarding: 1, alighting: 2 });
    // The single seat is now occupied; a disjoint-looking but out-of-route leg cannot reuse it.
    await bookBadRequest(passengers[2], id, { boarding: 5, alighting: 8 }, 'ordinal_out_of_route');
    assert.equal((await activeIntervals(id)).length, 1);
  });

  it('rejects malformed ordinals with 400 and leaves inventory untouched', async () => {
    const offer = await mkOffer(2);
    const cases: Array<{ boarding?: number; alighting?: number }> = [
      { boarding: 5, alighting: 2 },
      { boarding: 0, alighting: 5 },
      { boarding: 2, alighting: 32767 },
      { boarding: 2, alighting: 2 },
      { boarding: 1.5, alighting: 5 },
      { boarding: 3 },
    ];
    for (const scenario of cases) {
      const response = await book(passengers[0], offer, scenario);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(scenario)}, got ${response.status}`);
    }
    assert.equal((await activeIntervals(offer)).length, 0);
    assert.equal((await offerState(offer)).available_seats, 2);
  });

  it('critical-points occupancy equals a brute-force generate_series over every edge', async () => {
    const offer = await mkOffer(3);
    await bookOk(passengers[0], offer, { seats: 2, boarding: 2, alighting: 6 });
    await bookOk(passengers[1], offer, { seats: 1, boarding: 4, alighting: 9 });
    await bookOk(passengers[2], offer, { seats: 2, boarding: 9, alighting: 12 });
    const client = await pool.connect();
    try {
      const bruteGlobal = await client.query<{ max_occ: number }>(
        `WITH segs AS (SELECT generate_series(1,12) AS ord)
         SELECT COALESCE(MAX(seats),0)::int AS max_occ FROM (
           SELECT s.ord, COALESCE(SUM(oi.seat_count),0) AS seats
             FROM segs s LEFT JOIN seat_occupancy_intervals oi
               ON oi.offer_id=$1 AND oi.boarding_ordinal<=s.ord AND oi.alighting_ordinal>s.ord AND ${ACTIVE}
            GROUP BY s.ord) occ`, [offer],
      );
      assert.equal(await globalMaxOccupancy(client, offer), bruteGlobal.rows[0].max_occ);
      assert.equal(bruteGlobal.rows[0].max_occ, 3);
      for (const [boarding, alighting] of [[2, 6], [6, 9], [9, 12], [1, 12], [4, 9], [3, 10]] as Array<[number, number]>) {
        const brute = await client.query<{ max_occ: number }>(
          `WITH segs AS (SELECT generate_series($2::int,$3::int) AS ord)
           SELECT COALESCE(MAX(seats),0)::int AS max_occ FROM (
             SELECT s.ord, COALESCE(SUM(oi.seat_count),0) AS seats
               FROM segs s LEFT JOIN seat_occupancy_intervals oi
                 ON oi.offer_id=$1 AND oi.boarding_ordinal<=s.ord AND oi.alighting_ordinal>s.ord AND ${ACTIVE}
              GROUP BY s.ord) occ`, [offer, boarding, alighting - 1],
        );
        assert.equal(await maxOccupancyOverInterval(client, offer, boarding, alighting), brute.rows[0].max_occ,
          `interval [${boarding},${alighting}) mismatch`);
      }
    } finally {
      client.release();
    }
  });
});