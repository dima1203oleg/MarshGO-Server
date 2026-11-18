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
  const cancelledJourneyId = randomUUID();
  const cancelledLegId = randomUUID();

  async function waitForJourneyOutboxDelivery() {
    const expectedTypes = ['journey.started', 'journey.leg.started', 'journey.updated', 'journey.completed', 'journey.updated'].sort();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { rows } = await pool.query<{ event_type: string; published_at: Date | null; last_error: string | null }>(
        `SELECT event_type,published_at,last_error FROM realtime_outbox
          WHERE recipient_ids @> ARRAY[$1::uuid] ORDER BY event_type,id`, [userId],
      );
      assert.deepEqual(rows.map((row) => row.event_type).sort(), expectedTypes,
        'journey transitions should create exactly one idempotent event per state change');
      const failed = rows.find((row) => row.last_error !== null);
      assert.equal(failed, undefined, `realtime outbox delivery failed: ${failed?.last_error ?? ''}`);
      if (rows.every((row) => row.published_at !== null)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('realtime outbox did not publish journey lifecycle events within 5 seconds');
  }

  after(async () => {
    await pool.query('DELETE FROM realtime_outbox WHERE recipient_ids && $1::uuid[]', [[userId, otherUserId]]);
    await pool.query('DELETE FROM journeys WHERE id=$1', [journeyId]);
    await pool.query('DELETE FROM journeys WHERE id=$1', [cancelledJourneyId]);
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
      `INSERT INTO journeys(id,user_id,origin,origin_name,destination,destination_name,requested_departure_at,passenger_count,state)
       VALUES($1,$2,ST_SetSRID(ST_MakePoint(30.52,50.45),4326)::geography,'Origin',
         ST_SetSRID(ST_MakePoint(30.53,50.46),4326)::geography,'Destination',now()+interval '20 minutes',1,'PLANNED')`,
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

    const activateUrl = `${apiUrl}/api/v1/journeys/${journeyId}/activate`;
    assert.equal((await fetch(activateUrl, { method: 'POST' })).status, 401);
    const notOwnerActivation = await fetch(activateUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': otherUserId },
      body: JSON.stringify({ legId }),
    });
    assert.equal(notOwnerActivation.status, 404);
    const invalidLeg = await fetch(activateUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': userId },
      body: JSON.stringify({ legId: randomUUID() }),
    });
    assert.equal(invalidLeg.status, 409);
    const activated = await fetch(activateUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': userId },
      body: JSON.stringify({ legId }),
    });
    assert.equal(activated.status, 200);
    const activatedBody = await activated.json() as { data: { id: string; state: string; currentLegId: string; startedAt: string } };
    assert.deepEqual({ id: activatedBody.data.id, state: activatedBody.data.state, currentLegId: activatedBody.data.currentLegId },
      { id: journeyId, state: 'ACTIVE', currentLegId: legId });
    assert.ok(Number.isFinite(Date.parse(activatedBody.data.startedAt)));
    const activeState = await pool.query<{ state: string; journey_state: string; current_leg_id: string; actual_departure_at: Date | null }>(
      `SELECT l.state,j.state AS journey_state,j.current_leg_id,l.actual_departure_at
         FROM journeys j JOIN journey_legs l ON l.journey_id=j.id WHERE j.id=$1 AND l.id=$2`, [journeyId, legId],
    );
    assert.deepEqual(activeState.rows[0], {
      state: 'ACTIVE', journey_state: 'ACTIVE', current_leg_id: legId, actual_departure_at: null,
    });
    const replayedActivation = await fetch(activateUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': userId },
      body: JSON.stringify({ legId }),
    });
    assert.equal(replayedActivation.status, 200);

    const endUrl = `${apiUrl}/api/v1/journeys/${journeyId}/end`;
    const completed = await fetch(endUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': userId },
      body: JSON.stringify({ outcome: 'COMPLETED' }),
    });
    assert.equal(completed.status, 200);
    const completedBody = await completed.json() as { data: { id: string; state: string; currentLegId: string | null; completedAt: string } };
    assert.deepEqual({ id: completedBody.data.id, state: completedBody.data.state, currentLegId: completedBody.data.currentLegId },
      { id: journeyId, state: 'COMPLETED', currentLegId: null });
    assert.ok(Number.isFinite(Date.parse(completedBody.data.completedAt)));
    const completedReplay = await fetch(endUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': userId },
      body: JSON.stringify({ outcome: 'COMPLETED' }),
    });
    assert.equal(completedReplay.status, 200);
    const conflictingEnd = await fetch(endUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': userId },
      body: JSON.stringify({ outcome: 'CANCELLED' }),
    });
    assert.equal(conflictingEnd.status, 409);

    await pool.query(
      `INSERT INTO journeys(id,user_id,origin,origin_name,destination,destination_name,requested_departure_at,passenger_count,state)
       VALUES($1,$2,ST_SetSRID(ST_MakePoint(30.52,50.45),4326)::geography,'Origin',
         ST_SetSRID(ST_MakePoint(30.53,50.46),4326)::geography,'Destination',now()+interval '20 minutes',1,'PLANNED')`,
      [cancelledJourneyId, userId],
    );
    await pool.query(
      `INSERT INTO journey_legs(id,journey_id,ordinal,mode,origin,origin_name,destination,destination_name)
       VALUES($1,$2,0,'WALK',ST_SetSRID(ST_MakePoint(30.52,50.45),4326)::geography,'Origin',
         ST_SetSRID(ST_MakePoint(30.53,50.46),4326)::geography,'Destination')`,
      [cancelledLegId, cancelledJourneyId],
    );
    const cancelled = await fetch(`${apiUrl}/api/v1/journeys/${cancelledJourneyId}/end`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': userId },
      body: JSON.stringify({ outcome: 'CANCELLED' }),
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { data: { state: string } }).data.state, 'CANCELLED');
    await waitForJourneyOutboxDelivery();
  });
});
