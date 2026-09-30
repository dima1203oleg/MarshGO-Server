import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { Pool } from 'pg';

const databaseUrl = process.env.JOURNEY_TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const pool = enabled && databaseUrl ? new Pool({ connectionString: databaseUrl, max: 1 }) : undefined;

describe('Journey domain schema (opt-in local integration test)', { skip: !enabled }, () => {
  it('persists an owned Journey, typed Community leg and preferences with spatial constraints', async () => {
    assert.ok(pool);
    const client = await pool.connect();
    const userId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO users(id,phone_e164,display_name) VALUES($1,$2,'Journey Test')`, [userId, `journey-test-${userId}`]);
      const journey = await client.query<{ id: string; strategy: string; state: string }>(
        `INSERT INTO journeys(user_id,origin,origin_name,destination,destination_name,requested_departure_at,strategy,passenger_count)
         VALUES($1,ST_SetSRID(ST_MakePoint(23.85,49.26),4326)::geography,'Стрий',ST_SetSRID(ST_MakePoint(24.03,49.84),4326)::geography,'Львів',now()+interval '1 day','FASTEST',1)
         RETURNING id,strategy,state`, [userId],
      );
      const journeyId = journey.rows[0].id;
      assert.equal(journey.rows[0].strategy, 'FASTEST');
      assert.equal(journey.rows[0].state, 'PLANNING');

      const leg = await client.query<{ id: string; mode: string; price_status: string; availability_status: string }>(
        `INSERT INTO journey_legs(journey_id,ordinal,mode,origin,origin_name,destination,destination_name,price_status,availability_status,offer_id)
         VALUES($1,0,'COMMUNITY',ST_SetSRID(ST_MakePoint(23.85,49.26),4326)::geography,'Стрий',ST_SetSRID(ST_MakePoint(24.03,49.84),4326)::geography,'Львів','LOCKED','AVAILABLE',NULL)
         RETURNING id,mode,price_status,availability_status`, [journeyId],
      );
      assert.deepEqual(leg.rows[0], { id: leg.rows[0].id, mode: 'COMMUNITY', price_status: 'LOCKED', availability_status: 'AVAILABLE' });
      await client.query(`INSERT INTO journey_preferences(journey_id,allow_community,minimum_transfer_buffer_s) VALUES($1,true,900)`, [journeyId]);
      await client.query('UPDATE journeys SET current_leg_id=$2 WHERE id=$1', [journeyId, leg.rows[0].id]);
      const stored = await client.query<{ leg_count: string; preference_count: string; srid: number }>(
        `SELECT (SELECT count(*) FROM journey_legs WHERE journey_id=$1)::text AS leg_count,
                (SELECT count(*) FROM journey_preferences WHERE journey_id=$1)::text AS preference_count,
                ST_SRID(origin::geometry) AS srid
           FROM journeys WHERE id=$1`, [journeyId],
      );
      assert.deepEqual(stored.rows[0], { leg_count: '1', preference_count: '1', srid: 4326 });
      await assert.rejects(
        client.query(`UPDATE journeys SET strategy='NOT_A_STRATEGY' WHERE id=$1`, [journeyId]),
        { code: '23514' },
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('keeps spatial indexes on passenger request pickup and dropoff coordinates', async () => {
    assert.ok(pool);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'
         AND indexname IN ('passenger_demands_origin_gix','passenger_demands_destination_gix') ORDER BY indexname`,
    );
    assert.deepEqual(indexes.rows.map(({ indexname }) => indexname), [
      'passenger_demands_destination_gix', 'passenger_demands_origin_gix',
    ]);
  });
});

after(async () => { await pool?.end(); });
