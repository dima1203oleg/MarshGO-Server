import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('Journey activation integration tests are restricted to a loopback database');
}

describe('passenger journey activation lifecycle (opt-in integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ids = {
    passenger: randomUUID(), stranger: randomUUID(), driver: randomUUID(), vehicle: randomUUID(), offer: randomUUID(), booking: randomUUID(),
    activeJourney: randomUUID(), completionJourney: randomUUID(), cancellationJourney: randomUUID(), otherJourney: randomUUID(), reactivationJourney: randomUUID(),
    activeLeg: randomUUID(), bookedLeg: randomUUID(), completionLeg: randomUUID(), cancellationLeg: randomUUID(), otherLeg: randomUUID(), reactivationLeg: randomUUID(),
  };

  const headers = (userId: string) => ({ 'content-type': 'application/json', 'x-dev-user-id': userId });

  async function call(method: string, path: string, userId: string, body?: unknown) {
    const response = await fetch(`${apiUrl}${path}`, {
      method, headers: headers(userId), body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) as Record<string, any> | null };
  }

  async function insertJourney(id: string, state = 'PLANNED') {
    await pool.query(
      `INSERT INTO journeys(id,user_id,origin,origin_name,destination,destination_name,requested_departure_at,strategy,state,passenger_count)
       VALUES($1,$2,ST_SetSRID(ST_MakePoint(24.03,49.19),4326)::geography,'Личаківська',
         ST_SetSRID(ST_MakePoint(24.06,49.16),4326)::geography,'Арсенал',now()+interval '3 hours','BALANCED',$3,1)`,
      [id, ids.passenger, state],
    );
  }

  async function insertLeg(id: string, journeyId: string, ordinal: number, mode = 'BUS', bookingId: string | null = null) {
    await pool.query(
      `INSERT INTO journey_legs(id,journey_id,ordinal,mode,origin,origin_name,destination,destination_name,state,booking_id)
       VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint(24.03,49.19),4326)::geography,'Личаківська',
         ST_SetSRID(ST_MakePoint(24.06,49.16),4326)::geography,'Арсенал','SUGGESTED',$5)`,
      [id, journeyId, ordinal, mode, bookingId],
    );
  }

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES
      ($1,'Journey activation passenger',ARRAY['passenger']),($2,'Journey activation stranger',ARRAY['passenger']),
      ($3,'Journey activation driver',ARRAY['driver'])`, [ids.passenger, ids.stranger, ids.driver]);
    await pool.query(
      `INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count) VALUES($1,$2,'Test','Activation car',2024,4)`,
      [ids.vehicle, ids.driver],
    );
    await pool.query(
      `INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,departure_at,
         price_per_seat_minor,total_seats,available_seats)
       VALUES($1,$2,$3,'Личаківська','Арсенал',ST_SetSRID(ST_MakePoint(24.03,49.19),4326)::geography,
         ST_SetSRID(ST_MakePoint(24.06,49.16),4326)::geography,now()+interval '3 hours',4000,2,1)`,
      [ids.offer, ids.driver, ids.vehicle],
    );
    await pool.query(
      `INSERT INTO bookings(id,offer_id,passenger_id,seat_count,unit_price_minor,total_price_minor,status,idempotency_key)
       VALUES($1,$2,$3,1,4000,4000,'confirmed',$4)`, [ids.booking, ids.offer, ids.passenger, `journey-activation-${ids.booking}`],
    );
    await insertJourney(ids.activeJourney);
    await insertJourney(ids.completionJourney);
    await insertJourney(ids.cancellationJourney);
    await insertJourney(ids.otherJourney);
    await insertJourney(ids.reactivationJourney);
    await insertLeg(ids.activeLeg, ids.activeJourney, 0);
    await insertLeg(ids.bookedLeg, ids.activeJourney, 1, 'COMMUNITY', ids.booking);
    await insertLeg(ids.completionLeg, ids.completionJourney, 0);
    await insertLeg(ids.cancellationLeg, ids.cancellationJourney, 0);
    await insertLeg(ids.otherLeg, ids.otherJourney, 0);
    await insertLeg(ids.reactivationLeg, ids.reactivationJourney, 0);
  });

  after(async () => {
    await pool.query('DELETE FROM realtime_outbox WHERE payload->>\'journey_id\'=ANY($1::text[])', [
      [ids.activeJourney, ids.completionJourney, ids.cancellationJourney, ids.otherJourney, ids.reactivationJourney],
    ]);
    await pool.query('DELETE FROM audit_events WHERE entity_id=ANY($1::uuid[])', [
      [ids.activeJourney, ids.completionJourney, ids.cancellationJourney, ids.otherJourney, ids.reactivationJourney],
    ]);
    await pool.query('DELETE FROM journeys WHERE id=ANY($1::uuid[])', [
      [ids.activeJourney, ids.completionJourney, ids.cancellationJourney, ids.otherJourney],
    ]);
    await pool.query('DELETE FROM bookings WHERE id=$1', [ids.booking]);
    await pool.query('DELETE FROM offers WHERE id=$1', [ids.offer]);
    await pool.query('DELETE FROM vehicles WHERE id=$1', [ids.vehicle]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ids.passenger, ids.stranger, ids.driver]]);
    await pool.end();
  });

  it('enforces owner and leg scope before activation', async () => {
    const privateJourney = await call('POST', `/api/v1/journeys/${ids.activeJourney}/activate`, ids.stranger, { legId: ids.activeLeg });
    assert.equal(privateJourney.status, 404);
    const wrongLeg = await call('POST', `/api/v1/journeys/${ids.otherJourney}/activate`, ids.passenger, { legId: ids.activeLeg });
    assert.equal(wrongLeg.status, 400);
    assert.equal(wrongLeg.json?.error?.code, 'invalid_journey_leg');
    const privateEnd = await call('POST', `/api/v1/journeys/${ids.activeJourney}/end`, ids.stranger, { outcome: 'CANCELLED' });
    assert.equal(privateEnd.status, 404);
    const state = await pool.query<{ state: string }>('SELECT state FROM journeys WHERE id=$1', [ids.activeJourney]);
    assert.equal(state.rows[0]?.state, 'PLANNED');
  });

  it('activates once, anchors the selected leg and replays without changing timestamps or events', async () => {
    const activated = await call('POST', `/api/v1/journeys/${ids.activeJourney}/activate`, ids.passenger, { legId: ids.activeLeg });
    assert.equal(activated.status, 200);
    assert.equal(activated.json?.data?.state, 'ACTIVE');
    assert.equal(activated.json?.data?.currentLegId, ids.activeLeg);
    assert.ok(activated.json?.data?.startedAt);
    const startedAt = Date.parse(activated.json!.data.startedAt);

    const replay = await call('POST', `/api/v1/journeys/${ids.activeJourney}/activate`, ids.passenger);
    assert.equal(replay.status, 200);
    assert.equal(replay.json?.replayed, true);
    assert.equal(Date.parse(replay.json!.data.startedAt), startedAt);
    assert.equal(replay.json?.data?.currentLegId, ids.activeLeg);

    const read = await call('GET', `/api/v1/journeys/${ids.activeJourney}`, ids.passenger);
    assert.equal(read.status, 200);
    assert.equal(read.json?.data?.state, 'ACTIVE');
    assert.equal(read.json?.data?.current_leg_id, ids.activeLeg);
    assert.equal(Date.parse(read.json!.data.startedAt), startedAt);
    assert.equal(read.json?.data?.completedAt, null);

    const audit = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_events WHERE entity_id=$1 AND action='journey.activated'`, [ids.activeJourney],
    );
    assert.equal(audit.rows[0]?.count, 1);
    const event = await pool.query<{ recipient_ids: string[] }>(
      `SELECT recipient_ids FROM realtime_outbox
        WHERE event_type='journey.updated' AND payload->>'journey_id'=$1 ORDER BY created_at LIMIT 1`, [ids.activeJourney],
    );
    assert.equal(event.rows.length, 1);
    assert.deepEqual(event.rows[0]?.recipient_ids, [ids.passenger]);
  });

  it('rejects terminal navigation while any linked booking is confirmed, boarding, or in progress', async () => {
    for (const bookingStatus of ['confirmed', 'boarding', 'in_progress']) {
      await pool.query('UPDATE bookings SET status=$2 WHERE id=$1', [ids.booking, bookingStatus]);
      for (const outcome of ['COMPLETED', 'CANCELLED']) {
        const response = await call('POST', `/api/v1/journeys/${ids.activeJourney}/end`, ids.passenger, { outcome });
        assert.equal(response.status, 409, `${outcome} must be blocked while a linked booking is ${bookingStatus}`);
        assert.equal(response.json?.error?.code, 'booking_lifecycle_active');
      }
      const unchanged = await pool.query<{ journey_state: string; booking_status: string; leg_state: string }>(
        `SELECT j.state AS journey_state,b.status AS booking_status,l.state AS leg_state
           FROM journeys j JOIN journey_legs l ON l.journey_id=j.id JOIN bookings b ON b.id=l.booking_id
          WHERE j.id=$1 AND b.id=$2`, [ids.activeJourney, ids.booking],
      );
      assert.deepEqual(unchanged.rows[0], { journey_state: 'ACTIVE', booking_status: bookingStatus, leg_state: 'SUGGESTED' });
    }
    await pool.query("UPDATE bookings SET status='confirmed' WHERE id=$1", [ids.booking]);
  });

  it('emits a distinct audited event after cancellation returns an active journey to replanning', async () => {
    const first = await call('POST', `/api/v1/journeys/${ids.reactivationJourney}/activate`, ids.passenger, { legId: ids.reactivationLeg });
    assert.equal(first.status, 200);

    // Model the booking-cancellation transition without invoking the booking API.
    await pool.query("UPDATE journey_legs SET state='CANCELLED' WHERE id=$1", [ids.reactivationLeg]);
    await pool.query("UPDATE journeys SET state='REPLANNING' WHERE id=$1", [ids.reactivationJourney]);

    const second = await call('POST', `/api/v1/journeys/${ids.reactivationJourney}/activate`, ids.passenger);
    assert.equal(second.status, 200);
    assert.equal(second.json?.data?.state, 'ACTIVE');
    assert.equal(second.json?.data?.currentLegId, ids.reactivationLeg);

    const audit = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_events WHERE entity_id=$1 AND action='journey.activated'`, [ids.reactivationJourney],
    );
    assert.equal(audit.rows[0]?.count, 2, 'each actual transition into ACTIVE is audited; idempotent replay is not');
    const events = await pool.query<{ count: number; dedupe_keys: string[] }>(
      `SELECT count(*)::int AS count,array_agg(dedupe_key ORDER BY created_at) AS dedupe_keys FROM realtime_outbox
        WHERE event_type='journey.updated' AND payload->>'journey_id'=$1`, [ids.reactivationJourney],
    );
    assert.equal(events.rows[0]?.count, 2);
    assert.equal(new Set(events.rows[0]?.dedupe_keys).size, 2, 'each activation transition needs a unique outbox key');
  });

  it('completes an activated booking-free journey, replays idempotently and blocks reactivation', async () => {
    const activation = await call('POST', `/api/v1/journeys/${ids.completionJourney}/activate`, ids.passenger, { legId: ids.completionLeg });
    assert.equal(activation.status, 200);
    const ended = await call('POST', `/api/v1/journeys/${ids.completionJourney}/end`, ids.passenger, { outcome: 'COMPLETED' });
    assert.equal(ended.status, 200);
    assert.equal(ended.json?.data?.state, 'COMPLETED');
    assert.ok(ended.json?.data?.startedAt);
    assert.ok(ended.json?.data?.completedAt);

    const replay = await call('POST', `/api/v1/journeys/${ids.completionJourney}/end`, ids.passenger, { outcome: 'COMPLETED' });
    assert.equal(replay.status, 200);
    assert.equal(replay.json?.replayed, true);
    assert.equal(replay.json?.data?.completedAt, ended.json?.data?.completedAt);
    const reactivate = await call('POST', `/api/v1/journeys/${ids.completionJourney}/activate`, ids.passenger);
    assert.equal(reactivate.status, 409);
    assert.equal(reactivate.json?.error?.code, 'journey_already_finished');

    const stored = await pool.query<{ state: string; started_at: Date | null; completed_at: Date | null; leg_state: string }>(
      `SELECT j.state,j.started_at,j.completed_at,l.state AS leg_state
         FROM journeys j JOIN journey_legs l ON l.journey_id=j.id WHERE j.id=$1`, [ids.completionJourney],
    );
    assert.equal(stored.rows[0]?.state, 'COMPLETED');
    assert.ok(stored.rows[0]?.started_at instanceof Date);
    assert.ok(stored.rows[0]?.completed_at instanceof Date);
    assert.equal(stored.rows[0]?.leg_state, 'SUGGESTED', 'navigation end does not change the leg business state');
    const audit = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_events WHERE entity_id=$1 AND action='journey.completed'`, [ids.completionJourney],
    );
    assert.equal(audit.rows[0]?.count, 1);
  });

  it('allows an unbooked plan to be cancelled and preserves null lifecycle timestamps', async () => {
    const ended = await call('POST', `/api/v1/journeys/${ids.cancellationJourney}/end`, ids.passenger, { outcome: 'CANCELLED' });
    assert.equal(ended.status, 200);
    assert.equal(ended.json?.data?.state, 'CANCELLED');
    assert.equal(ended.json?.data?.startedAt, null);
    assert.equal(ended.json?.data?.completedAt, null);
    const replay = await call('POST', `/api/v1/journeys/${ids.cancellationJourney}/end`, ids.passenger, { outcome: 'CANCELLED' });
    assert.equal(replay.status, 200);
    assert.equal(replay.json?.replayed, true);
    const reactivate = await call('POST', `/api/v1/journeys/${ids.cancellationJourney}/activate`, ids.passenger);
    assert.equal(reactivate.status, 409);
    const stored = await pool.query<{ state: string; started_at: Date | null; completed_at: Date | null }>(
      'SELECT state,started_at,completed_at FROM journeys WHERE id=$1', [ids.cancellationJourney],
    );
    assert.deepEqual(stored.rows[0], { state: 'CANCELLED', started_at: null, completed_at: null });
  });
});
