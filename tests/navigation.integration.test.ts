import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { retainNavigationSessions } from '../server/navigation/sessionRetention';

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
  const passengerTwo = crypto.randomUUID();
  const vehicle = crypto.randomUUID();
  const headers = (userId: string) => ({ 'content-type': 'application/json', 'x-dev-user-id': userId });
  let sessionId = '';
  let offlineSessionId = '';
  let forwardDemandId = '';
  let reverseDemandId = '';
  let overCapacityDemandId = '';
  let secondDemandId = '';
  const bookingIds: string[] = [];
  const acceptedOfferIds: string[] = [];

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES($1,'Navigation test driver',ARRAY['driver']),($2,'Navigation test passenger A',ARRAY['passenger']),($3,'Navigation test passenger B',ARRAY['passenger'])`, [driver, passenger, passengerTwo]);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'driver'),($2,'passenger'),($3,'passenger')`, [driver, passenger, passengerTwo]);
    await pool.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count,verification_status,is_active)
      VALUES($1,$2,'Test','Verified car',2024,4,'verified',true)`, [vehicle, driver]);
  });

  after(async () => {
    const demandIds = [forwardDemandId, reverseDemandId, overCapacityDemandId, secondDemandId].filter(Boolean);
    if (demandIds.length) await pool.query('DELETE FROM proposals WHERE demand_id=ANY($1::uuid[])', [demandIds]);
    if (bookingIds.length) {
      await pool.query('DELETE FROM conversations WHERE booking_id=ANY($1::uuid[])', [bookingIds]);
      await pool.query('DELETE FROM navigation_waypoints WHERE booking_id=ANY($1::uuid[])', [bookingIds]);
      await pool.query('DELETE FROM booking_events WHERE booking_id=ANY($1::uuid[])', [bookingIds]);
      await pool.query('DELETE FROM bookings WHERE id=ANY($1::uuid[])', [bookingIds]);
      if (acceptedOfferIds.length) await pool.query('DELETE FROM offers WHERE id=ANY($1::uuid[])', [acceptedOfferIds]);
    }
    if (sessionId) {
      await pool.query('DELETE FROM audit_events WHERE entity_id=$1', [sessionId]);
      await pool.query('DELETE FROM navigation_sessions WHERE id=$1', [sessionId]);
    }
    if (offlineSessionId) {
      await pool.query('DELETE FROM audit_events WHERE entity_id=$1', [offlineSessionId]);
      await pool.query('DELETE FROM navigation_sessions WHERE id=$1', [offlineSessionId]);
    }
    if (demandIds.length) {
      await pool.query('DELETE FROM passenger_demands WHERE id=ANY($1::uuid[])', [demandIds]);
    }
    await pool.query('DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[])', [[driver, passenger, passengerTwo]]);
    await pool.query('DELETE FROM vehicles WHERE id=$1', [vehicle]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[driver, passenger, passengerTwo]]);
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
    const createDemand = async (origin: [number, number], destination: [number, number], count: number, name: string, passengerId = passenger) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO passenger_demands(passenger_id,origin_name,destination_name,origin,destination,earliest_departure,latest_departure,passenger_count,budget_minor,budget_type)
         VALUES($1,$2,'Lviv',ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,$7,$8,$9,30000,'total_all') RETURNING id`,
        [passengerId, name, origin[0], origin[1], destination[0], destination[1], departureStart, departureEnd, count],
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
    const prematureProposal = await fetch(`${apiUrl}/api/v1/demands/${forwardDemandId}/proposals`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ vehicleId: vehicle, priceMinor: 30000, departureAt: departureStart.toISOString(), navigationCandidateId: candidate.id }),
    });
    assert.equal(prematureProposal.status, 409, 'navigation proposals require explicit passenger confirmation');
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
    const proposalResponse = await fetch(`${apiUrl}/api/v1/demands/${forwardDemandId}/proposals`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ vehicleId: vehicle, priceMinor: 30000, departureAt: departureStart.toISOString(), comment: 'Навігаційна пропозиція', navigationCandidateId: candidate.id }),
    });
    assert.equal(proposalResponse.status, 201);
    const linkedProposal = (await proposalResponse.json() as { data: { id: string; navigation_candidate_id: string } }).data;
    assert.equal(linkedProposal.navigation_candidate_id, candidate.id);
    const duplicateProposal = await fetch(`${apiUrl}/api/v1/demands/${forwardDemandId}/proposals`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ vehicleId: vehicle, priceMinor: 30000, departureAt: departureStart.toISOString(), navigationCandidateId: candidate.id }),
    });
    assert.equal(duplicateProposal.status, 409, 'one candidate can produce only one proposal');
    const acceptedNavigationProposal = await fetch(`${apiUrl}/api/v1/proposals/${linkedProposal.id}/accept`, { method: 'POST', headers: headers(passenger) });
    assert.equal(acceptedNavigationProposal.status, 201, 'passenger confirmation of the price creates the single booking and updates the route');
    const acceptedBody = await acceptedNavigationProposal.json() as { data: { id: string; offer_id: string; status: string; total_price_minor: number } };
    bookingIds.push(acceptedBody.data.id); acceptedOfferIds.push(acceptedBody.data.offer_id);
    assert.equal(acceptedBody.data.status, 'confirmed');
    assert.equal(acceptedBody.data.total_price_minor, 30000);
    const updatedNavigation = await pool.query<{ route_version: number; opt_in: boolean; route: [number, number][] }>(
      `SELECT route_version,opt_in,ST_AsGeoJSON(route)::json->'coordinates' AS route FROM navigation_sessions WHERE id=$1`, [sessionId],
    );
    assert.equal(updatedNavigation.rows[0].route_version, 2);
    assert.equal(updatedNavigation.rows[0].opt_in, false, 'route matching pauses after inserting a passenger to prevent matching against an incomplete multi-stop baseline');
    assert.deepEqual(updatedNavigation.rows[0].route, [[24,49],[24.2,49.2],[24.5,49.5],[25,50]]);
    const insertedWaypoints = await pool.query<{ kind: string; place_name: string }>(
      'SELECT kind,place_name FROM navigation_waypoints WHERE booking_id=$1 ORDER BY ordinal', [acceptedBody.data.id],
    );
    assert.deepEqual(insertedWaypoints.rows.map((waypoint) => [waypoint.kind, waypoint.place_name]), [
      ['pickup', 'Forward demand'], ['dropoff', 'Lviv'],
    ]);
    secondDemandId = await createDemand([24.35,49.35], [24.65,49.65], 1, 'Second rider demand', passengerTwo);
    const resumeForMatching = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/resume`, { method: 'POST', headers: headers(driver) });
    assert.equal(resumeForMatching.status, 200);
    const freshFix = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/location`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ coordinates: [24, 49], accuracyMeters: 8, capturedAt: new Date().toISOString() }),
    });
    assert.equal(freshFix.status, 200);
    const secondOptIn = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matching`, {
      method: 'PATCH', headers: headers(driver), body: JSON.stringify({ enabled: true }),
    });
    assert.equal(secondOptIn.status, 200, 'the driver can opt in for a second rider when segment capacity allows it');
    const secondCandidatesResponse = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matches/refresh`, { method: 'POST', headers: headers(driver) });
    assert.equal(secondCandidatesResponse.status, 200);
    const secondCandidate = (await secondCandidatesResponse.json() as { data: Array<{ id: string; demand_id: string; pickup_ordinal: number; dropoff_ordinal: number }> }).data
      .find((item) => item.demand_id === secondDemandId);
    assert.ok(secondCandidate, 'the real road route admits a second rider on a later segment');
    assert.ok(secondCandidate.pickup_ordinal < secondCandidate.dropoff_ordinal);
    await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/pause`, { method: 'POST', headers: headers(driver) });
    const secondInterest = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matches/${secondCandidate.id}/interest`, { method: 'POST', headers: headers(driver) });
    assert.equal(secondInterest.status, 200);
    const secondConfirmation = await fetch(`${apiUrl}/api/v1/navigation/matches/${secondCandidate.id}/passenger-confirm`, { method: 'POST', headers: headers(passengerTwo) });
    assert.equal(secondConfirmation.status, 200);
    const secondProposalResponse = await fetch(`${apiUrl}/api/v1/demands/${secondDemandId}/proposals`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ vehicleId: vehicle, priceMinor: 30000, departureAt: departureStart.toISOString(), comment: 'Second passenger', navigationCandidateId: secondCandidate.id }),
    });
    assert.equal(secondProposalResponse.status, 201);
    const secondProposal = (await secondProposalResponse.json() as { data: { id: string } }).data;
    const secondAccepted = await fetch(`${apiUrl}/api/v1/proposals/${secondProposal.id}/accept`, { method: 'POST', headers: headers(passengerTwo) });
    assert.equal(secondAccepted.status, 201, 'both passengers are attached to the navigation route after explicit mutual agreement');
    const secondAcceptedData = (await secondAccepted.json() as { data: { id: string; offer_id: string } }).data;
    bookingIds.push(secondAcceptedData.id); acceptedOfferIds.push(secondAcceptedData.offer_id);
    const finalWaypoints = await pool.query<{ booking_id: string; ordinal: number; kind: string; state: string }>(
      `SELECT booking_id,ordinal,kind,state FROM navigation_waypoints WHERE navigation_session_id=$1 ORDER BY ordinal`, [sessionId],
    );
    assert.equal(finalWaypoints.rows.length, 4);
    assert.deepEqual(finalWaypoints.rows.map((row) => row.ordinal), [1,2,3,4]);
    for (const id of bookingIds) {
      const stops = finalWaypoints.rows.filter((row) => row.booking_id === id);
      assert.equal(stops.length, 2);
      assert.equal(stops[0].kind, 'pickup');
      assert.equal(stops[1].kind, 'dropoff');
    }
    assert.deepEqual(new Set(finalWaypoints.rows.map((row) => row.booking_id)), new Set(bookingIds));
    const bookingsAfter = await pool.query('SELECT count(*)::int AS count FROM bookings WHERE passenger_id=$1', [passenger]);
    assert.equal(bookingsAfter.rows[0].count, bookingsBefore.rows[0].count + 1);
    const optOut = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/matching`, {
      method: 'PATCH', headers: headers(driver), body: JSON.stringify({ enabled: false }),
    });
    assert.equal(optOut.status, 200);
    const staleProposalAccept = await fetch(`${apiUrl}/api/v1/proposals/${linkedProposal.id}/accept`, { method: 'POST', headers: headers(passenger) });
    assert.equal(staleProposalAccept.status, 409, 'a navigation proposal cannot be accepted a second time');
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

    const rerouteFix = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/location`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ coordinates: [24, 49], accuracyMeters: 8, capturedAt: new Date().toISOString() }),
    });
    assert.equal(rerouteFix.status, 200);
    const versionBeforeReroute = await pool.query<{ route_version: number }>('SELECT route_version FROM navigation_sessions WHERE id=$1', [sessionId]);
    const reroute = await fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/reroute`, { method: 'POST', headers: headers(driver) });
    assert.equal(reroute.status, 200);
    const rerouted = (await reroute.json() as { data: { route_version: number; opt_in: boolean; route: [number, number][] } }).data;
    assert.equal(rerouted.route_version, Number(versionBeforeReroute.rows[0].route_version) + 1);
    assert.equal(rerouted.opt_in, false, 'route changes require a fresh passenger-matching opt-in');
    assert.deepEqual(rerouted.route, [[24, 49], [25, 50]]);

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

    const offlineCreated = await fetch(`${apiUrl}/api/v1/navigation/sessions`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ origin: [24, 49], destination: [25, 50], destinationName: 'Offline resume destination' }),
    });
    assert.equal(offlineCreated.status, 201);
    offlineSessionId = (await offlineCreated.json() as { data: { id: string } }).data.id;
    const offlineFix = await fetch(`${apiUrl}/api/v1/navigation/sessions/${offlineSessionId}/location`, {
      method: 'POST', headers: headers(driver),
      body: JSON.stringify({ coordinates: [24, 49], accuracyMeters: 8, capturedAt: new Date().toISOString() }),
    });
    assert.equal(offlineFix.status, 200);
    await pool.query('UPDATE navigation_sessions SET current_location_at=now()-interval \'3 minutes\',last_activity_at=now() WHERE id=$1', [offlineSessionId]);
    const clearedLocation = await retainNavigationSessions(pool);
    assert.ok(clearedLocation.clearedLocations >= 1);
    const resumable = await pool.query<{ state: string; route: unknown; destination: unknown; current_location: unknown }>(
      'SELECT state,route,destination,current_location FROM navigation_sessions WHERE id=$1', [offlineSessionId],
    );
    assert.equal(resumable.rows[0].state, 'active');
    assert.ok(resumable.rows[0].route, 'a temporary GPS gap must preserve the active route');
    assert.ok(resumable.rows[0].destination);
    assert.equal(resumable.rows[0].current_location, null, 'stale precise position is purged independently');
    await pool.query('UPDATE navigation_sessions SET last_activity_at=now()-interval \'25 hours\' WHERE id=$1', [offlineSessionId]);
    const abandonedSession = await retainNavigationSessions(pool);
    assert.ok(abandonedSession.endedSessions >= 1);
    const expired = await pool.query<{ state: string; route: unknown; destination: unknown }>(
      'SELECT state,route,destination FROM navigation_sessions WHERE id=$1', [offlineSessionId],
    );
    assert.equal(expired.rows[0].state, 'ended');
    assert.equal(expired.rows[0].route, null);
    assert.equal(expired.rows[0].destination, null);
  });
});
