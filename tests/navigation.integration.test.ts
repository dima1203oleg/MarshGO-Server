import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = process.env.API_TEST_NAVIGATION === 'true' && Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('Navigation integration tests are restricted to a loopback database');
}

describe('foreground navigation session API (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const driver = crypto.randomUUID();
  const passenger = crypto.randomUUID();
  const vehicle = crypto.randomUUID();
  const headers = (userId: string) => ({ 'content-type': 'application/json', 'x-dev-user-id': userId });
  let sessionId = '';
  let forwardDemandId = '';
  let reverseDemandId = '';
  let overCapacityDemandId = '';

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES($1,'Navigation test driver',ARRAY['driver']),($2,'Navigation test passenger',ARRAY['passenger'])`, [driver, passenger]);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'driver'),($2,'passenger')`, [driver, passenger]);
    await pool.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count,verification_status,is_active)
      VALUES($1,$2,'Test','Verified car',2024,4,'verified',true)`, [vehicle, driver]);
  });

  after(async () => {
    if (sessionId) {
      await pool.query('DELETE FROM audit_events WHERE entity_id=$1', [sessionId]);
      await pool.query('DELETE FROM navigation_sessions WHERE id=$1', [sessionId]);
    }
    const demandIds = [forwardDemandId, reverseDemandId, overCapacityDemandId].filter(Boolean);
    if (demandIds.length) await pool.query('DELETE FROM passenger_demands WHERE id=ANY($1::uuid[])', [demandIds]);
    await pool.query('DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[])', [[driver, passenger]]);
    await pool.query('DELETE FROM vehicles WHERE id=$1', [vehicle]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[driver, passenger]]);
    await pool.end();
  });

  it('persists an owner-only real-route session, validates GPS, and deletes precise location on end', async () => {
    const created = await fetch(`${apiUrl}/api/v1/navigation/sessions`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ origin: [24, 49], destination: [25, 50], destinationName: 'Integration destination' }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { data: { id: string; state: string; route: [number, number][]; route_distance_m: number; matching_vehicle_available: boolean } };
    sessionId = createdBody.data.id;
    assert.equal(createdBody.data.state, 'active');
    assert.deepEqual(createdBody.data.route, [[24, 49], [25, 50]]);
    assert.ok(createdBody.data.route_distance_m > 0);
    assert.equal(createdBody.data.matching_vehicle_available, true);
    const active = await fetch(`${apiUrl}/api/v1/navigation/sessions/active`, { headers: headers(driver) });
    const activeBody = await active.json() as { data: { id: string; route: [number, number][] } };
    assert.equal(active.status, 200);
    assert.equal(activeBody.data.id, sessionId);
    assert.deepEqual(activeBody.data.route, createdBody.data.route);
    const ownSession = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}`, { headers: headers(driver) });
    assert.equal(ownSession.status, 200);
    const duplicate = await fetch(`${apiUrl}/api/v1/navigation/sessions`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ origin: [24, 49], destination: [25, 50], destinationName: 'Duplicate session' }),
    });
    assert.equal(duplicate.status, 409);

    const hidden = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}`, { headers: headers(passenger) });
    assert.equal(hidden.status, 403);
    const forbiddenStart = await fetch(`${apiUrl}/api/v1/navigation/sessions`, {
      method: 'POST', headers: headers(passenger),
      body: JSON.stringify({ origin: [24, 49], destination: [25, 50], destinationName: 'No driver role' }),
    });
    assert.equal(forbiddenStart.status, 403);

    const fix = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/location`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ coordinates: [24, 49], accuracyMeters: 8, capturedAt: new Date().toISOString() }),
    });
    assert.equal(fix.status, 200);
    assert.equal((await fix.json() as { data: { onRoute: boolean } }).data.onRoute, true);

    const departureStart = new Date(Date.now() + 20 * 60_000);
    const departureEnd = new Date(Date.now() + 90 * 60_000);
    const createDemand = async (origin: [number, number], destination: [number, number], count: number, name: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO passenger_demands(passenger_id,origin_name,destination_name,origin,destination,earliest_departure,latest_departure,passenger_count,budget_minor,budget_type)
         VALUES($1,$2,'Lviv',ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,$7,$8,$9,30000,'total_all') RETURNING id`,
        [passenger, name, origin[0], origin[1], destination[0], destination[1], departureStart, departureEnd, count],
      );
      return rows[0].id;
    };
    forwardDemandId = await createDemand([24.2,49.2], [24.5,49.5], 1, 'Forward demand');
    reverseDemandId = await createDemand([24.7,49.7], [24.1,49.1], 1, 'Reverse demand');
    overCapacityDemandId = await createDemand([24.2,49.2], [24.5,49.5], 5, 'Over-capacity demand');
    const optIn = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matching`, {
      method: 'PATCH', headers: headers(driver), body: JSON.stringify({ enabled: true }),
    });
    assert.equal(optIn.status, 200);
    const blockDriver = await fetch(`${apiUrl}/api/v1/users/${driver}/block`, { method: 'POST', headers: headers(passenger) });
    assert.equal(blockDriver.status, 204);
    const suppressed = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matches/refresh`, { method: 'POST', headers: headers(driver) });
    assert.equal((await suppressed.json() as { data: Array<{ demand_id: string }> }).data.some((item) => item.demand_id === forwardDemandId), false);
    const unblockDriver = await fetch(`${apiUrl}/api/v1/users/${driver}/block`, { method: 'DELETE', headers: headers(passenger) });
    assert.equal(unblockDriver.status, 204);
    const matchesResponse = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matches/refresh`, { method: 'POST', headers: headers(driver) });
    assert.equal(matchesResponse.status, 200);
    const candidates = await matchesResponse.json() as { data: Array<{ id: string; demand_id: string; status: string; detour_distance_m: number; detour_duration_s: number }> };
    const candidate = candidates.data.find((item) => item.demand_id === forwardDemandId);
    assert.ok(candidate);
    assert.equal(candidates.data.some((item) => item.demand_id === reverseDemandId || item.demand_id === overCapacityDemandId), false);
    assert.equal(candidate.status, 'suggested');
    assert.ok(candidate.detour_distance_m <= 100);
    assert.equal(candidate.detour_duration_s, 0);

    const prematureInterest = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matches/${candidate.id}/interest`, { method: 'POST', headers: headers(driver) });
    assert.equal(prematureInterest.status, 409);
    const pause = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/pause`, { method: 'POST', headers: headers(driver) });
    assert.equal(pause.status, 200);
    const interest = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matches/${candidate.id}/interest`, { method: 'POST', headers: headers(driver) });
    assert.equal(interest.status, 200);
    const duplicateInterest = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matches/${candidate.id}/interest`, { method: 'POST', headers: headers(driver) });
    assert.equal(duplicateInterest.status, 409);
    const hiddenCandidate = await fetch(`${apiUrl}/api/v1/navigation/matches/${candidate.id}/passenger-confirm`, { method: 'POST', headers: headers(driver) });
    assert.equal(hiddenCandidate.status, 403);
    const passengerMatches = await fetch(`${apiUrl}/api/v1/demands/mine/navigation-matches`, { headers: headers(passenger) });
    assert.equal(passengerMatches.status, 200);
    const passengerCandidate = (await passengerMatches.json() as { data: Array<{ candidate_id: string; status: string; driver_name: string | null }> }).data.find((item) => item.candidate_id === candidate.id);
    assert.ok(passengerCandidate);
    assert.equal(passengerCandidate.candidate_id, candidate.id);
    assert.equal(passengerCandidate.status, 'driver_interested');
    assert.equal(passengerCandidate.driver_name, null);
    const bookingsBefore = await pool.query('SELECT count(*)::int AS count FROM bookings WHERE passenger_id=$1', [passenger]);
    const confirmation = await fetch(`${apiUrl}/api/v1/navigation/matches/${candidate.id}/passenger-confirm`, { method: 'POST', headers: headers(passenger) });
    assert.equal(confirmation.status, 200);
    assert.deepEqual((await confirmation.json() as { data: { status: string; nextStep: string } }).data, { id: candidate.id, demandId: forwardDemandId, status: 'passenger_confirmed', nextStep: 'price_negotiation' });
    const repeatedConfirmation = await fetch(`${apiUrl}/api/v1/navigation/matches/${candidate.id}/passenger-confirm`, { method: 'POST', headers: headers(passenger) });
    assert.equal((await repeatedConfirmation.json() as { replayed: boolean }).replayed, true);
    const visibleCandidate = await fetch(`${apiUrl}/api/v1/demands/mine/navigation-matches`, { headers: headers(passenger) });
    const visibleMatch = (await visibleCandidate.json() as { data: Array<{ candidate_id: string; status: string; driver_name: string | null }> }).data.find((item) => item.candidate_id === candidate.id);
    assert.ok(visibleMatch);
    assert.equal(visibleMatch.status, 'passenger_confirmed');
    assert.equal(visibleMatch.driver_name, 'Navigation test driver');
    const bookingsAfter = await pool.query('SELECT count(*)::int AS count FROM bookings WHERE passenger_id=$1', [passenger]);
    assert.equal(bookingsAfter.rows[0].count, bookingsBefore.rows[0].count);
    const optOut = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matching`, {
      method: 'PATCH', headers: headers(driver), body: JSON.stringify({ enabled: false }),
    });
    assert.equal(optOut.status, 200);
    const withdrawnMatches = await fetch(`${apiUrl}/api/v1/demands/mine/navigation-matches`, { headers: headers(passenger) });
    assert.equal((await withdrawnMatches.json() as { data: Array<{ candidate_id: string }> }).data.some((item) => item.candidate_id === candidate.id), false);
    const resume = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/resume`, { method: 'POST', headers: headers(driver) });
    assert.equal(resume.status, 200);
    const driverMatches = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matches`, { headers: headers(driver) });
    const driverCandidates = (await driverMatches.json() as { data: Array<{ id: string; status: string }> }).data;
    assert.equal(driverCandidates.some((item) => item.id === candidate.id), false);

    const stale = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/location`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ coordinates: [24, 49], accuracyMeters: 8, capturedAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
    });
    assert.equal(stale.status, 400);
    const teleport = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/location`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ coordinates: [24.2, 49.2], accuracyMeters: 8, capturedAt: new Date(Date.now() + 2_000).toISOString() }),
    });
    assert.equal(teleport.status, 422);

    const ended = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/end`, { method: 'POST', headers: headers(driver) });
    assert.equal(ended.status, 200);
    const replay = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/end`, { method: 'POST', headers: headers(driver) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { data: { replayed: boolean } }).data.replayed, true);
    const persisted = await pool.query('SELECT state,route,current_location,destination,destination_name FROM navigation_sessions WHERE id=$1', [sessionId]);
    assert.equal(persisted.rows[0].state, 'ended');
    assert.equal(persisted.rows[0].route, null);
    assert.equal(persisted.rows[0].current_location, null);
    assert.equal(persisted.rows[0].destination, null);
    assert.equal(persisted.rows[0].destination_name, null);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM navigation_match_candidates WHERE navigation_session_id=$1 AND demand_id=$2', [sessionId, forwardDemandId])).rows[0].count, 1);
    await pool.query('DELETE FROM passenger_demands WHERE id=ANY($1::uuid[])', [[forwardDemandId, reverseDemandId, overCapacityDemandId]]);
  });
});
