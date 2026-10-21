import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { Pool } from 'pg';

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('Live journey integration tests are restricted to a loopback database');
}

describe('live journey API (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const providerId = randomUUID();
  const journeyId = randomUUID();
  const legId = randomUUID();

  after(async () => {
    await pool.query('DELETE FROM journeys WHERE id=$1', [journeyId]);
    await pool.query('DELETE FROM mobility_providers WHERE id=$1', [providerId]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId, otherUserId]]);
    await pool.end();
  });

  it('scopes the live overlay to an owned transit leg and returns an explicit unavailable state for disabled providers', async () => {
    assert.ok(apiUrl);
    await pool.query(`INSERT INTO users(id,display_name) VALUES($1,'Live journey test'),($2,'Other live journey test')`, [userId, otherUserId]);
    await pool.query(
      `INSERT INTO mobility_providers(id,name,city,provider_type,source_type,feed_url,status,health)
       VALUES($1,'Live journey integration fixture','Fixture City','public_transit','gtfs','https://example.invalid/feed.zip','disabled','offline')`,
      [providerId],
    );
    await pool.query(
      `INSERT INTO journeys(id,user_id,origin,origin_name,destination,destination_name,requested_departure_at,passenger_count)
       VALUES($1,$2,ST_SetSRID(ST_MakePoint(30.52,50.45),4326)::geography,'Origin',
         ST_SetSRID(ST_MakePoint(30.53,50.46),4326)::geography,'Destination',now()+interval '20 minutes',1)`,
      [journeyId, userId],
    );
    await pool.query(
      `INSERT INTO journey_legs(id,journey_id,ordinal,mode,origin,origin_name,destination,destination_name,
         scheduled_departure_at,scheduled_arrival_at,provider_id,metadata)
       VALUES($1,$2,0,'BUS',ST_SetSRID(ST_MakePoint(30.52,50.45),4326)::geography,'Origin',
         ST_SetSRID(ST_MakePoint(30.53,50.46),4326)::geography,'Destination',now()+interval '20 minutes',
         now()+interval '35 minutes',$3,$4::jsonb)`,
      [legId, journeyId, providerId, JSON.stringify({ tripId: 'fixture-trip', routeId: 'fixture-route', fromStopFeedId: 'fixture-stop' })],
    );

    const unauthorized = await fetch(`${apiUrl}/api/v1/journeys/${journeyId}/live?legId=${legId}`);
    assert.equal(unauthorized.status, 401);

    const notOwner = await fetch(`${apiUrl}/api/v1/journeys/${journeyId}/live?legId=${legId}`, {
      headers: { 'x-dev-user-id': otherUserId },
    });
    assert.equal(notOwner.status, 404);

    const response = await fetch(`${apiUrl}/api/v1/journeys/${journeyId}/live?legId=${legId}`, {
      headers: { 'x-dev-user-id': userId },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data: { journeyId: string; segments: Array<{ legId: string; status: string; reason?: string;
        vehiclePositionStatus: string; boardingStopArrival: { status: string }; lineRoutes: unknown[]; vehicles: unknown[] }> };
    };
    assert.equal(body.data.journeyId, journeyId);
    assert.deepEqual(body.data.segments, [{
      legId,
      status: 'UNVERIFIED',
      reason: 'provider_unavailable',
      vehiclePositionStatus: 'UNAVAILABLE',
      boardingStopArrival: { status: 'UNAVAILABLE' },
      lineRoutes: [],
      vehicles: [],
    }]);

    const wrongLeg = await fetch(`${apiUrl}/api/v1/journeys/${journeyId}/live?legId=${randomUUID()}`, {
      headers: { 'x-dev-user-id': userId },
    });
    assert.equal(wrongLeg.status, 404);
  });
});
