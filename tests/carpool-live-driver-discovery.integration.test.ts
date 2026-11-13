import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';

// Carpool 5.0 P0.2-A — passenger→live-driver discovery (VIII.2 S1 prefilter, T20/G08, T12, G11): pure geospatial, provable without OSRM via seeded geometry; cards must leak no GPS/route.
const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('API integration tests are restricted to a loopback database');
}

type Point = [number, number];

describe('Carpool LIVE driver discovery (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const driver = crypto.randomUUID();
  const passenger = crypto.randomUUID();
  const passengerTwo = crypto.randomUUID();
  const vehicle = crypto.randomUUID();
  const allUsers = [driver, passenger, passengerTwo];
  const createdDrivers: string[] = [];
  const createdSessions: string[] = [];
  const createdDemands: string[] = [];
  const createdOffers: string[] = [];
  const createdBookings: string[] = [];
  const createdCandidates: string[] = [];

  const headers = (userId: string) => ({ 'x-dev-user-id': userId });
  const liveDrivers = (demandId: string, userId: string) =>
    fetch(`${apiUrl}/api/v1/demands/${demandId}/live-drivers`, { headers: headers(userId) });

  async function mkSession(opts: {
    driverId?: string; route?: Point[]; current?: Point; destination?: Point;
    optIn?: boolean; state?: string; gpsAgeSeconds?: number; seatCount?: number; routeVersion?: number;
  } = {}): Promise<string> {
    const id = crypto.randomUUID();
    const route = opts.route ?? [[24, 49], [25, 50]];
    const current = opts.current ?? [24, 49];
    const destination = opts.destination ?? [25, 50];
    // The schema enforces one active/paused session per driver, so each live driver is a
    // distinct user unless the test explicitly pins driverId (e.g. the self-dealing case).
    let driverId = opts.driverId;
    if (!driverId) {
      driverId = crypto.randomUUID();
      await pool.query(`INSERT INTO users(id,display_name,roles) VALUES($1,'Live discovery driver',ARRAY['driver'])`, [driverId]);
      createdDrivers.push(driverId);
    }
    await pool.query(
      `INSERT INTO navigation_sessions(id,driver_id,state,destination_name,destination,route,route_version,opt_in,
         current_location,current_location_at,vehicle_id,vehicle_seat_count)
       VALUES($1,$2,$3,'Live destination',ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,
         ST_SetSRID(ST_GeomFromGeoJSON($6),4326),$7,$8,
         ST_SetSRID(ST_MakePoint($9,$10),4326)::geography,now()-($11||' seconds')::interval,$12,$13)`,
      [id, driverId, opts.state ?? 'active', destination[0], destination[1],
        JSON.stringify({ type: 'LineString', coordinates: route }), opts.routeVersion ?? 1, opts.optIn ?? true,
        current[0], current[1], String(opts.gpsAgeSeconds ?? 0), vehicle, opts.seatCount ?? 4],
    );
    createdSessions.push(id);
    return id;
  }

  async function mkDemand(passengerId: string, origin: Point, destination: Point, count: number, opts: {
    originName?: string; destName?: string; status?: string; pastWindow?: boolean;
  } = {}): Promise<string> {
    const id = crypto.randomUUID();
    const earliest = opts.pastWindow ? "now()-interval '2 hours'" : "now()+interval '20 minutes'";
    const latest = opts.pastWindow ? "now()-interval '1 hour'" : "now()+interval '90 minutes'";
    await pool.query(
      `INSERT INTO passenger_demands(id,passenger_id,origin_name,destination_name,origin,destination,
         earliest_departure,latest_departure,passenger_count,status)
       VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,ST_SetSRID(ST_MakePoint($7,$8),4326)::geography,
         ${earliest},${latest},$9,$10)`,
      [id, passengerId, opts.originName ?? 'Live origin', opts.destName ?? 'Live destination',
        origin[0], origin[1], destination[0], destination[1], count, opts.status ?? 'open'],
    );
    createdDemands.push(id);
    return id;
  }

  // Seed a rider already onboard the driver's car: offer -> confirmed booking -> candidate ->
  // pickup waypoint visited + dropoff waypoint scheduled. This consumes `seats` of capacity.
  async function seedOnboard(sessionId: string, seats: number): Promise<void> {
    const offerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,
         departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats)
       VALUES($1,$2,$3,'Onboard origin','Onboard destination',
         ST_SetSRID(ST_MakePoint(24,49),4326)::geography,ST_SetSRID(ST_MakePoint(25,50),4326)::geography,
         ST_MakeLine(ST_SetSRID(ST_MakePoint(24,49),4326),ST_SetSRID(ST_MakePoint(25,50),4326)),
         now()+interval '1 hour',now()+interval '2 hours',140000,3600,'osrm',15000,4,4)`,
      [offerId, driver, vehicle],
    );
    createdOffers.push(offerId);
    const onboardDemand = await mkDemand(passengerTwo, [24.1, 49.1], [24.4, 49.4], seats);
    const bookingId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO bookings(id,offer_id,passenger_id,seat_count,unit_price_minor,total_price_minor,status,idempotency_key)
       VALUES($1,$2,$3,$4,15000,$5,'confirmed',$6)`,
      [bookingId, offerId, passengerTwo, seats, 15000 * seats, `onboard-${crypto.randomUUID()}`],
    );
    createdBookings.push(bookingId);
    const candidateId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO navigation_match_candidates(id,navigation_session_id,demand_id,route_version,status,
         detour_distance_m,detour_duration_s,pickup_eta,expires_at)
       VALUES($1,$2,$3,1,'passenger_confirmed',0,0,now()+interval '10 minutes',now()+interval '30 minutes')`,
      [candidateId, sessionId, onboardDemand],
    );
    createdCandidates.push(candidateId);
    await pool.query(
      `INSERT INTO navigation_waypoints(navigation_session_id,booking_id,candidate_id,ordinal,kind,place_name,location,state)
       VALUES($1,$2,$3,1,'pickup','Onboard pickup',ST_SetSRID(ST_MakePoint(24.1,49.1),4326)::geography,'visited'),
             ($1,$2,$3,2,'dropoff','Onboard dropoff',ST_SetSRID(ST_MakePoint(24.4,49.4),4326)::geography,'scheduled')`,
      [sessionId, bookingId, candidateId],
    );
  }

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES($1,'Live discovery driver',ARRAY['driver']),($2,'Live discovery passenger A',ARRAY['passenger']),($3,'Live discovery passenger B',ARRAY['passenger'])`, allUsers);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'driver'),($2,'passenger'),($3,'passenger')`, allUsers);
    await pool.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count,verification_status,is_active)
      VALUES($1,$2,'Test','Live car',2024,4,'verified',true)`, [vehicle, driver]);
  });

  beforeEach(async () => {
    // Sessions are the only cross-test interference (demands are queried by id). Clear them
    // so a leftover driver on the same corridor cannot leak into the next assertion.
    if (createdSessions.length) {
      await pool.query('DELETE FROM navigation_waypoints WHERE navigation_session_id=ANY($1::uuid[])', [createdSessions]);
      await pool.query('DELETE FROM navigation_match_candidates WHERE navigation_session_id=ANY($1::uuid[])', [createdSessions]);
      await pool.query('DELETE FROM navigation_sessions WHERE id=ANY($1::uuid[])', [createdSessions]);
      createdSessions.length = 0;
      createdCandidates.length = 0;
    }
  });

  after(async () => {
    const everyUser = [...allUsers, ...createdDrivers];
    if (createdSessions.length) {
      await pool.query('DELETE FROM navigation_waypoints WHERE navigation_session_id=ANY($1::uuid[])', [createdSessions]);
      await pool.query('DELETE FROM navigation_match_candidates WHERE navigation_session_id=ANY($1::uuid[])', [createdSessions]);
    }
    if (createdBookings.length) {
      await pool.query('DELETE FROM seat_occupancy_intervals WHERE booking_id=ANY($1::uuid[])', [createdBookings]);
      await pool.query('DELETE FROM conversations WHERE booking_id=ANY($1::uuid[])', [createdBookings]);
      await pool.query('DELETE FROM bookings WHERE id=ANY($1::uuid[])', [createdBookings]);
    }
    if (createdOffers.length) await pool.query('DELETE FROM offers WHERE id=ANY($1::uuid[])', [createdOffers]);
    if (createdDemands.length) await pool.query('DELETE FROM passenger_demands WHERE id=ANY($1::uuid[])', [createdDemands]);
    if (createdSessions.length) await pool.query('DELETE FROM navigation_sessions WHERE id=ANY($1::uuid[])', [createdSessions]);
    await pool.query('DELETE FROM user_blocks WHERE blocker_id=ANY($1::uuid[]) OR blocked_id=ANY($1::uuid[])', [everyUser]);
    await pool.query('DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[]) OR entity_id=ANY($2::uuid[])',
      [everyUser, [...createdSessions, ...createdDemands, ...createdOffers, ...createdBookings, vehicle]]);
    await pool.query('DELETE FROM realtime_outbox WHERE recipient_ids && $1::uuid[]', [everyUser]);
    await pool.query('DELETE FROM vehicles WHERE id=$1', [vehicle]);
    await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [everyUser]);
    await pool.query('DELETE FROM user_roles WHERE user_id=ANY($1::uuid[])', [everyUser]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [everyUser]);
    await pool.end();
  });

  it('T20/G08: finds a live opt-in driver whose remaining corridor covers pickup and dropoff, with a privacy-safe card', async () => {
    const session = await mkSession();
    const demand = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 1);
    const response = await liveDrivers(demand, passenger);
    assert.equal(response.status, 200, await response.clone().text());
    const { data } = await response.json() as { data: Array<Record<string, unknown>> };
    const card = data.find((item) => item.session_id === session);
    assert.ok(card, 'the live driver on the corridor must be discoverable by the passenger');
    assert.equal(card.driver_name, 'Live discovery driver');
    assert.equal(card.vehicle_make, 'Test');
    assert.equal(card.vehicle_model, 'Live car');
    assert.equal(card.available_seats, 4);
    assert.equal(card.match_kind, 'LIVE');
    assert.equal(card.confidence, 'GIS_PREFILTER');
    assert.equal(card.requires_confirmation, true);
    assert.equal(typeof card.origin_corridor_m, 'number');
    assert.equal(typeof card.destination_corridor_m, 'number');
    assert.ok((card.origin_corridor_m as number) >= 0);
    // Privacy: the card must never expose the driver's precise position or route geometry.
    for (const forbidden of ['current_location', 'route', 'coordinates', 'origin', 'destination', 'current_location_at']) {
      assert.equal(forbidden in card, false, `card must not leak ${forbidden}`);
    }
  });

  it('T20: discovery is decided by road corridor geometry, not origin/destination name strings', async () => {
    await mkSession();
    // Same city names, but coordinates far off the driver's route -> must NOT match.
    const offRoute = await mkDemand(passenger, [30, 55], [31, 56], 1, { originName: 'Lviv', destName: 'Kyiv' });
    const offResponse = await liveDrivers(offRoute, passenger);
    assert.equal(offResponse.status, 200);
    assert.equal((await offResponse.json() as { data: unknown[] }).data.length, 0, 'identical city names off the corridor must not match');
    // Same city names, coordinates on the corridor -> must match.
    const onRoute = await mkDemand(passenger, [24.3, 49.3], [24.6, 49.6], 1, { originName: 'Lviv', destName: 'Kyiv' });
    const onResponse = await liveDrivers(onRoute, passenger);
    assert.equal(onResponse.status, 200);
    assert.ok((await onResponse.json() as { data: unknown[] }).data.length >= 1, 'on-corridor coordinates must match regardless of name');
  });

  it('T12: excludes a pickup the driver has already passed (future-order guard)', async () => {
    // Driver is at fraction 0.6 along the route; a demand behind them must not surface.
    await mkSession({ current: [24.6, 49.6] });
    const behind = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 1);
    assert.equal((await (await liveDrivers(behind, passenger)).json() as { data: unknown[] }).data.length, 0, 'a passed pickup must not be offered');
    const ahead = await mkDemand(passenger, [24.7, 49.7], [24.9, 49.9], 1);
    assert.ok((await (await liveDrivers(ahead, passenger)).json() as { data: unknown[] }).data.length >= 1, 'a future pickup must be offered');
  });

  it('G11: capacity gate uses vehicle seats minus onboard occupancy', async () => {
    const session = await mkSession({ seatCount: 4 });
    await seedOnboard(session, 2); // 2 seats physically onboard -> 2 available
    const tooMany = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 3);
    assert.equal((await (await liveDrivers(tooMany, passenger)).json() as { data: unknown[] }).data.length, 0, '3 seats requested but only 2 free must not match');
    const fits = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 2);
    const { data } = await (await liveDrivers(fits, passenger)).json() as { data: Array<Record<string, unknown>> };
    const card = data.find((item) => item.session_id === session);
    assert.ok(card, '2 seats requested with 2 free must match');
    assert.equal(card.available_seats, 2);
  });

  it('G11: a simple seat-count gate rejects demands larger than the vehicle', async () => {
    await mkSession({ seatCount: 2 });
    const big = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 3);
    assert.equal((await (await liveDrivers(big, passenger)).json() as { data: unknown[] }).data.length, 0);
    const small = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 2);
    assert.ok((await (await liveDrivers(small, passenger)).json() as { data: unknown[] }).data.length >= 1);
  });

  it('LIVE gates: opt-out, paused state and stale GPS each hide the driver', async () => {
    const demand = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 1);
    const optedOut = await mkSession({ optIn: false });
    const paused = await mkSession({ state: 'paused' });
    const stale = await mkSession({ gpsAgeSeconds: 120 });
    const { data } = await (await liveDrivers(demand, passenger)).json() as { data: Array<Record<string, unknown>> };
    const ids = new Set(data.map((item) => item.session_id));
    assert.equal(ids.has(optedOut), false, 'opt-out driver must not be discoverable');
    assert.equal(ids.has(paused), false, 'paused driver must not be discoverable');
    assert.equal(ids.has(stale), false, 'stale-GPS driver must not be discoverable');
  });

  it('respects user blocks in both directions', async () => {
    const session = await mkSession();
    const { rows } = await pool.query<{ driver_id: string }>('SELECT driver_id FROM navigation_sessions WHERE id=$1', [session]);
    const sessionDriver = rows[0].driver_id;
    const demand = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 1);
    const idsOf = async () => new Set(((await (await liveDrivers(demand, passenger)).json() as { data: Array<Record<string, unknown>> }).data).map((i) => i.session_id));
    await pool.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)', [passenger, sessionDriver]);
    assert.equal((await idsOf()).has(session), false, 'a driver blocked by the passenger must be hidden');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [passenger, sessionDriver]);
    await pool.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2)', [sessionDriver, passenger]);
    assert.equal((await idsOf()).has(session), false, 'a passenger blocked by the driver must be hidden');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [sessionDriver, passenger]);
    assert.equal((await idsOf()).has(session), true, 'after unblocking the driver is discoverable again');
  });

  it('excludes the passenger’s own session (no self-dealing)', async () => {
    await mkSession({ driverId: passenger }); // the demand owner also drives
    const demand = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 1);
    const { data } = await (await liveDrivers(demand, passenger)).json() as { data: Array<Record<string, unknown>> };
    assert.equal(data.length, 0, 'a passenger must not be matched to their own driving session');
  });

  it('ownership and demand-state guards: 404 for strangers/unknown, 400 for malformed id, 409 for non-open', async () => {
    const demand = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 1);
    assert.equal((await liveDrivers(demand, passengerTwo)).status, 404, 'another passenger cannot search someone else’s demand');
    assert.equal((await liveDrivers(crypto.randomUUID(), passenger)).status, 404, 'unknown demand is 404');
    assert.equal((await liveDrivers('not-a-uuid', passenger)).status, 400, 'malformed demand id is 400');
    await pool.query("UPDATE passenger_demands SET status='cancelled' WHERE id=$1", [demand]);
    const cancelled = await liveDrivers(demand, passenger);
    assert.equal(cancelled.status, 409);
    assert.equal((await cancelled.json() as { error: { code: string } }).error.code, 'demand_not_open');
  });

  it('T12: an open demand whose departure window has closed yields no live drivers', async () => {
    await mkSession();
    const expired = await mkDemand(passenger, [24.2, 49.2], [24.5, 49.5], 1, { pastWindow: true });
    const response = await liveDrivers(expired, passenger);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { data: unknown[] }).data.length, 0, 'a stale demand window must not surface live drivers');
  });
});