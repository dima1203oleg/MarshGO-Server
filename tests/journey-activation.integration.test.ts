import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('Journey activation integration tests are restricted to a loopback database');
}

describe('passenger journey activation contract (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const passenger = crypto.randomUUID();
  const stranger = crypto.randomUUID();
  const driver = crypto.randomUUID();
  const vehicle = crypto.randomUUID();
  const offer = crypto.randomUUID();
  const booking = crypto.randomUUID();
  const journey = crypto.randomUUID();
  const otherJourney = crypto.randomUUID();
  const walkLeg = crypto.randomUUID();
  const transitLeg = crypto.randomUUID();
  const bookedLeg = crypto.randomUUID();
  const otherLeg = crypto.randomUUID();

  const headers = (userId: string) => ({ 'content-type': 'application/json', 'x-dev-user-id': userId });

  async function call(method: string, path: string, userId: string, body?: unknown) {
    const response = await fetch(`${apiUrl}${path}`, {
      method, headers: headers(userId), body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) as Record<string, any> | null };
  }

  async function journeyRow(id: string) {
    const { rows } = await pool.query<{ state: string; current_leg_id: string | null; started_at: Date | null; completed_at: Date | null }>(
      'SELECT state,current_leg_id,started_at,completed_at FROM journeys WHERE id=$1', [id],
    );
    return rows[0];
  }

  async function insertJourney(id: string, userId: string, state = 'PLANNED') {
    await pool.query(
      `INSERT INTO journeys(id,user_id,origin,origin_name,destination,destination_name,requested_departure_at,strategy,state,passenger_count)
       VALUES($1,$2,ST_SetSRID(ST_MakePoint(24.03,49.19),4326)::geography,'Личаківська',
              ST_SetSRID(ST_MakePoint(24.06,49.16),4326)::geography,'Арсенал',
              now()+interval '2 hours','BALANCED',$3,1)`, [id, userId, state],
    );
  }

  async function insertLeg(id: string, journeyId: string, ordinal: number, mode: string, bookingId: string | null = null) {
    await pool.query(
      `INSERT INTO journey_legs(id,journey_id,ordinal,mode,origin,origin_name,destination,destination_name,state,booking_id)
       VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint(24.03,49.19),4326)::geography,'Личаківська',
              ST_SetSRID(ST_MakePoint(24.06,49.16),4326)::geography,'Арсенал','SUGGESTED',$5)`,
      [id, journeyId, ordinal, mode, bookingId],
    );
  }

  before(async () => {
    await pool.query(
      `INSERT INTO users(id,display_name,roles) VALUES($1,'Activation passenger',ARRAY['passenger']),
        ($2,'Activation stranger',ARRAY['passenger']),($3,'Activation driver',ARRAY['driver'])`,
      [passenger, stranger, driver],
    );
    await pool.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count,verification_status,is_active)
      VALUES($1,$2,'Test','Activated car',2024,4,'verified',true)`, [vehicle, driver]);
    await pool.query(
      `INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,departure_at,
         price_per_seat_minor,total_seats,available_seats,status)
       VALUES($1,$2,$3,'Личаківська','Арсенал',ST_SetSRID(ST_MakePoint(24.03,49.19),4326)::geography,
         ST_SetSRID(ST_MakePoint(24.06,49.16),4326)::geography,now()+interval '3 hours',4000,4,3,'published')`,
      [offer, driver, vehicle],
    );
    await pool.query(
      `INSERT INTO bookings(id,offer_id,passenger_id,seat_count,unit_price_minor,total_price_minor,status,idempotency_key)
       VALUES($1,$2,$3,1,4000,4000,'confirmed',$4)`, [booking, offer, passenger, `activation-${booking}`],
    );
    await insertJourney(journey, passenger);
    await insertJourney(otherJourney, passenger);
    await insertLeg(walkLeg, journey, 0, 'WALK');
    await insertLeg(transitLeg, journey, 1, 'BUS');
    await insertLeg(bookedLeg, journey, 2, 'COMMUNITY', booking);
    await insertLeg(otherLeg, otherJourney, 0, 'WALK');
  });

  after(async () => {
    await pool.query('DELETE FROM realtime_outbox WHERE dedupe_key LIKE ANY($1::text[])', [[`%:${journey}%`, `%:${otherJourney}%`]]);
    await pool.query('DELETE FROM audit_events WHERE entity_id=ANY($1::uuid[])', [[journey, otherJourney]]);
    await pool.query('DELETE FROM journey_legs WHERE journey_id=ANY($1::uuid[])', [[journey, otherJourney]]);
    await pool.query('DELETE FROM journeys WHERE id=ANY($1::uuid[])', [[journey, otherJourney]]);
    await pool.query('DELETE FROM bookings WHERE id=$1', [booking]);
    await pool.query('DELETE FROM offers WHERE id=$1', [offer]);
    await pool.query('DELETE FROM vehicles WHERE id=$1', [vehicle]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[passenger, stranger, driver]]);
    await pool.end();
  });

  it('activates a planned journey and records the navigation anchor leg', async () => {
    const response = await call('POST', `/api/v1/journeys/${journey}/activate`, passenger, { legId: transitLeg });
    assert.equal(response.status, 200);
    assert.equal(response.json?.data?.state, 'ACTIVE');
    assert.equal(response.json?.data?.currentLegId, transitLeg);
    const stored = await journeyRow(journey);
    assert.equal(stored.state, 'ACTIVE');
    assert.equal(stored.current_leg_id, transitLeg);
    assert.ok(stored.started_at instanceof Date);
    const audit = await pool.query('SELECT action FROM audit_events WHERE entity_id=$1 AND action=$2', [journey, 'journey.activated']);
    assert.equal(audit.rowCount, 1);
  });

  it('replays a repeated activation without moving started_at again', async () => {
    const before = await journeyRow(journey);
    const response = await call('POST', `/api/v1/journeys/${journey}/activate`, passenger);
    assert.equal(response.status, 200);
    assert.equal(response.json?.replayed, true);
    const after = await journeyRow(journey);
    assert.equal(after.started_at?.getTime(), before.started_at?.getTime());
    assert.equal(after.current_leg_id, before.current_leg_id);
  });

  it('hides another passenger\'s journey as 404 and never writes it', async () => {
    const response = await call('POST', `/api/v1/journeys/${journey}/activate`, stranger);
    assert.equal(response.status, 404);
    assert.equal((await journeyRow(otherJourney)).state, 'PLANNED');
    const before = await journeyRow(journey);
    assert.equal(before.state, 'ACTIVE');
  });

  it('rejects a leg that belongs to a different journey', async () => {
    const response = await call('POST', `/api/v1/journeys/${otherJourney}/activate`, passenger, { legId: transitLeg });
    assert.equal(response.status, 400);
    assert.equal(response.json?.error?.code, 'invalid_journey_leg');
    assert.equal((await journeyRow(otherJourney)).state, 'PLANNED');
  });

  it('refuses to cancel a journey whose carpool leg still has a live booking, and leaves the booking untouched', async () => {
    const response = await call('POST', `/api/v1/journeys/${journey}/end`, passenger, { outcome: 'CANCELLED' });
    assert.equal(response.status, 409);
    assert.equal(response.json?.error?.code, 'booking_lifecycle_active');
    assert.equal((await journeyRow(journey)).state, 'ACTIVE');
    const bookingRow = await pool.query('SELECT status FROM bookings WHERE id=$1', [booking]);
    assert.equal(bookingRow.rows[0].status, 'confirmed');
  });

  it('requires an explicit outcome and then completes the journey without touching the booking', async () => {
    const invalid = await call('POST', `/api/v1/journeys/${journey}/end`, passenger, {});
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json?.error?.code, 'invalid_journey_outcome');

    const ended = await call('POST', `/api/v1/journeys/${journey}/end`, passenger, { outcome: 'COMPLETED' });
    assert.equal(ended.status, 200);
    assert.equal(ended.json?.data?.state, 'COMPLETED');
    const stored = await journeyRow(journey);
    assert.equal(stored.state, 'COMPLETED');
    assert.ok(stored.completed_at instanceof Date);
    assert.equal(stored.current_leg_id, transitLeg);

    const bookingRow = await pool.query('SELECT status FROM bookings WHERE id=$1', [booking]);
    assert.equal(bookingRow.rows[0].status, 'confirmed');
    const legRow = await pool.query('SELECT state FROM journey_legs WHERE id=$1', [bookedLeg]);
    assert.equal(legRow.rows[0].state, 'SUGGESTED');
  });

  it('replays the completion and refuses to re-activate a finished journey', async () => {
    const replay = await call('POST', `/api/v1/journeys/${journey}/end`, passenger, { outcome: 'COMPLETED' });
    assert.equal(replay.status, 200);
    assert.equal(replay.json?.replayed, true);
    const reactivate = await call('POST', `/api/v1/journeys/${journey}/activate`, passenger);
    assert.equal(reactivate.status, 409);
    assert.equal(reactivate.json?.error?.code, 'journey_already_finished');
  });

  it('publishes journey.updated realtime events for both transitions to the owner only', async () => {
    const { rows } = await pool.query<{ event_type: string; recipient_ids: string[]; payload: Record<string, unknown> }>(
      `SELECT event_type,recipient_ids,payload FROM realtime_outbox
        WHERE dedupe_key LIKE $1 ORDER BY created_at`, [`%:${journey}%`],
    );
    const states = rows.filter((row) => row.payload.journey_id === journey).map((row) => `${row.event_type}:${row.payload.state}`);
    assert.deepEqual(states, ['journey.updated:ACTIVE', 'journey.updated:COMPLETED']);
    for (const row of rows) assert.deepEqual(row.recipient_ids, [passenger]);
  });
});
