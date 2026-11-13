import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';

// Carpool 5.0 P0.2-B wiring — loop-safe route progress through the real location endpoint and the
// UNCERTAIN gates on discovery + match refresh (spec VIII.4 / XXXIX.1, G03/T17). No OSRM required:
// progress is pure geometry, and the refresh negative control relies on routing being unavailable.
const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('API integration tests are restricted to a loopback database');
}

type Point = [number, number];
// 0.001° steps keep consecutive vertex jumps under the 250 m implausible-movement floor, so a
// genuine loop can be driven fix-by-fix through the API. v0 == v4 is the self-crossing point.
const LOOP: Point[] = [[24, 49], [24.001, 49], [24.001, 49.001], [24, 49.001], [24, 49]];
const CROSSING: Point = [24, 49];
const ORD3_MID: Point = [24.0005, 49.001];
const LINE: Point[] = [[24, 49], [24.001, 49], [24.002, 49]];

describe('Carpool route progress wiring (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const vehicleOwner = crypto.randomUUID();
  const passenger = crypto.randomUUID();
  const vehicle = crypto.randomUUID();
  const fixedUsers = [vehicleOwner, passenger];
  const createdDrivers: string[] = [];
  const createdSessions: string[] = [];
  const createdDemands: string[] = [];
  const createdCandidates: string[] = [];

  const headers = (userId: string) => ({ 'x-dev-user-id': userId });
  const postLocation = (sessionId: string, userId: string, coordinates: Point, capturedAt: Date, accuracyMeters = 5, headingDeg?: number) =>
    fetch(`${apiUrl}/api/v1/navigation/sessions/${sessionId}/location`, {
      method: 'POST', headers: { ...headers(userId), 'content-type': 'application/json' },
      body: JSON.stringify({ coordinates, accuracyMeters, capturedAt: capturedAt.toISOString(), ...(headingDeg !== undefined ? { headingDeg } : {}) }),
    });
  const liveDrivers = (demandId: string) => fetch(`${apiUrl}/api/v1/demands/${demandId}/live-drivers`, { headers: headers(passenger) });

  async function mkSession(opts: { route?: Point[]; current?: Point; destination?: Point; seatCount?: number } = {}): Promise<{ id: string; driverId: string }> {
    const id = crypto.randomUUID();
    const driverId = crypto.randomUUID();
    const route = opts.route ?? [[24, 49], [25, 50]];
    const current = opts.current ?? [24, 49];
    const destination = opts.destination ?? route[route.length - 1];
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES($1,'Progress driver',ARRAY['driver'])`, [driverId]);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'driver')`, [driverId]);
    createdDrivers.push(driverId);
    await pool.query(
      `INSERT INTO navigation_sessions(id,driver_id,state,destination_name,destination,route,route_version,opt_in,
         current_location,current_location_at,vehicle_id,vehicle_seat_count)
       VALUES($1,$2,'active','Progress destination',ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
         ST_SetSRID(ST_GeomFromGeoJSON($5),4326),1,true,
         ST_SetSRID(ST_MakePoint($6,$7),4326)::geography,now(),$8,$9)`,
      [id, driverId, destination[0], destination[1], JSON.stringify({ type: 'LineString', coordinates: route }),
        current[0], current[1], vehicle, opts.seatCount ?? 4],
    );
    createdSessions.push(id);
    return { id, driverId };
  }

  async function mkDemand(origin: Point, destination: Point, count: number): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO passenger_demands(id,passenger_id,origin_name,destination_name,origin,destination,
         earliest_departure,latest_departure,passenger_count,status)
       VALUES($1,$2,'Progress origin','Progress destination',ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
         ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,now()+interval '20 minutes',now()+interval '90 minutes',$7,'open')`,
      [id, passenger, origin[0], origin[1], destination[0], destination[1], count],
    );
    createdDemands.push(id);
    return id;
  }

  const progressOf = async (id: string) => (await pool.query<{ progress_ordinal: number | null; progress_status: string | null; progress_fraction: number | null; last_reliable_fix_at: Date | null }>(
    'SELECT progress_ordinal,progress_status,progress_fraction,last_reliable_fix_at FROM navigation_sessions WHERE id=$1', [id])).rows[0];

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES($1,'Progress vehicle owner',ARRAY['driver']),($2,'Progress passenger',ARRAY['passenger'])`, fixedUsers);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'driver'),($2,'passenger')`, fixedUsers);
    await pool.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count,verification_status,is_active)
      VALUES($1,$2,'Test','Progress car',2024,4,'verified',true)`, [vehicle, vehicleOwner]);
  });

  beforeEach(async () => {
    if (createdSessions.length) {
      await pool.query('DELETE FROM navigation_waypoints WHERE navigation_session_id=ANY($1::uuid[])', [createdSessions]);
      await pool.query('DELETE FROM navigation_match_candidates WHERE navigation_session_id=ANY($1::uuid[])', [createdSessions]);
      await pool.query('DELETE FROM navigation_sessions WHERE id=ANY($1::uuid[])', [createdSessions]);
      createdSessions.length = 0;
      createdCandidates.length = 0;
    }
  });

  after(async () => {
    const everyUser = [...fixedUsers, ...createdDrivers];
    if (createdSessions.length) {
      await pool.query('DELETE FROM navigation_waypoints WHERE navigation_session_id=ANY($1::uuid[])', [createdSessions]);
      await pool.query('DELETE FROM navigation_match_candidates WHERE navigation_session_id=ANY($1::uuid[])', [createdSessions]);
    }
    if (createdDemands.length) await pool.query('DELETE FROM passenger_demands WHERE id=ANY($1::uuid[])', [createdDemands]);
    if (createdSessions.length) await pool.query('DELETE FROM navigation_sessions WHERE id=ANY($1::uuid[])', [createdSessions]);
    await pool.query('DELETE FROM user_blocks WHERE blocker_id=ANY($1::uuid[]) OR blocked_id=ANY($1::uuid[])', [everyUser]);
    await pool.query('DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[]) OR entity_id=ANY($2::uuid[])',
      [everyUser, [...createdSessions, ...createdDemands, vehicle]]);
    await pool.query('DELETE FROM realtime_outbox WHERE recipient_ids && $1::uuid[]', [everyUser]);
    await pool.query('DELETE FROM vehicles WHERE id=$1', [vehicle]);
    await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [everyUser]);
    await pool.query('DELETE FROM user_roles WHERE user_id=ANY($1::uuid[])', [everyUser]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [everyUser]);
    await pool.end();
  });

  it('T17/G03: a self-crossing loop resolves forward to the later occurrence when history disambiguates', async () => {
    const { id, driverId } = await mkSession({ route: LOOP, current: CROSSING });
    const r1 = await postLocation(id, driverId, ORD3_MID, new Date(Date.now() + 1000));
    assert.equal(r1.status, 200, await r1.clone().text());
    const d1 = (await r1.json() as { data: Record<string, unknown> }).data;
    assert.equal(d1.progressStatus, 'RELIABLE');
    assert.equal(d1.progressOrdinal, 3);
    const r2 = await postLocation(id, driverId, CROSSING, new Date(Date.now() + 2000));
    assert.equal(r2.status, 200, await r2.clone().text());
    const d2 = (await r2.json() as { data: Record<string, unknown> }).data;
    assert.equal(d2.progressStatus, 'RELIABLE', 'history at ordinal 3 must resolve the crossing forward, not ambiguous');
    assert.equal(d2.progressOrdinal, 4);
    assert.ok((d2.progressFraction as number) > 0.9, `expected fraction>0.9 at the loop end, got ${d2.progressFraction}`);
    const persisted = await progressOf(id);
    assert.equal(persisted.progress_ordinal, 4);
    assert.equal(persisted.progress_status, 'RELIABLE');
    assert.ok(persisted.last_reliable_fix_at, 'a reliable fix must stamp last_reliable_fix_at');
  });

  it('T17/G03: the same crossing with no history is UNCERTAIN, not a confident wrong fraction', async () => {
    const { id, driverId } = await mkSession({ route: LOOP, current: CROSSING });
    const r = await postLocation(id, driverId, CROSSING, new Date(Date.now() + 1000));
    assert.equal(r.status, 200, await r.clone().text());
    const d = (await r.json() as { data: Record<string, unknown> }).data;
    assert.equal(d.progressStatus, 'UNCERTAIN');
    const persisted = await progressOf(id);
    assert.equal(persisted.progress_status, 'UNCERTAIN');
    assert.equal(persisted.last_reliable_fix_at, null, 'an uncertain fix must not stamp last_reliable_fix_at');
  });

  it('T17: heading disambiguates the crossing toward the aligned occurrence', async () => {
    const { id, driverId } = await mkSession({ route: LOOP, current: CROSSING });
    // Ordinal 4 runs south (bearing 180°); a southbound heading must pick it over ordinal 1 (east).
    const r = await postLocation(id, driverId, CROSSING, new Date(Date.now() + 1000), 5, 180);
    assert.equal(r.status, 200, await r.clone().text());
    const d = (await r.json() as { data: Record<string, unknown> }).data;
    assert.equal(d.progressStatus, 'RELIABLE');
    assert.equal(d.progressOrdinal, 4);
  });

  it('G03: progress advances monotonically along a simple line', async () => {
    const { id, driverId } = await mkSession({ route: LINE, current: [24, 49] });
    const r1 = await postLocation(id, driverId, [24.0005, 49], new Date(Date.now() + 1000));
    assert.equal(r1.status, 200, await r1.clone().text());
    const d1 = (await r1.json() as { data: Record<string, unknown> }).data;
    assert.equal(d1.progressStatus, 'RELIABLE');
    assert.equal(d1.progressOrdinal, 1);
    const r2 = await postLocation(id, driverId, [24.0015, 49], new Date(Date.now() + 2000));
    assert.equal(r2.status, 200, await r2.clone().text());
    const d2 = (await r2.json() as { data: Record<string, unknown> }).data;
    assert.equal(d2.progressStatus, 'RELIABLE');
    assert.equal(d2.progressOrdinal, 2);
    assert.ok((d2.progressFraction as number) > (d1.progressFraction as number), 'fraction must increase forward');
  });

  it('G03: a fix behind the previous progress is UNCERTAIN (no confident backward jump)', async () => {
    const { id, driverId } = await mkSession({ route: LINE, current: [24, 49] });
    const r1 = await postLocation(id, driverId, [24.0015, 49], new Date(Date.now() + 1000));
    assert.equal((await r1.json() as { data: Record<string, unknown> }).data.progressOrdinal, 2);
    const r2 = await postLocation(id, driverId, [24.0002, 49], new Date(Date.now() + 2000));
    assert.equal(r2.status, 200, await r2.clone().text());
    assert.equal((await r2.json() as { data: Record<string, unknown> }).data.progressStatus, 'UNCERTAIN');
  });

  it('G03: a fix far off the corridor is OFF_ROUTE with no ordinal', async () => {
    const { id, driverId } = await mkSession({ route: LINE, current: [24, 49] });
    // 111 m perpendicular: within the 250 m implausible floor but beyond the 65 m match tolerance.
    const r = await postLocation(id, driverId, [24, 49.001], new Date(Date.now() + 1000));
    assert.equal(r.status, 200, await r.clone().text());
    const d = (await r.json() as { data: Record<string, unknown> }).data;
    assert.equal(d.progressStatus, 'OFF_ROUTE');
    assert.equal(d.progressOrdinal, null);
  });

  it('G03/T17: an UNCERTAIN driver is hidden from discovery; RELIABLE and NULL are shown', async () => {
    const demand = await mkDemand([24.2, 49.2], [24.5, 49.5], 1);
    const { id } = await mkSession({ route: [[24, 49], [25, 50]], current: [24, 49] });
    const found = async () => {
      const res = await liveDrivers(demand);
      assert.equal(res.status, 200, await res.clone().text());
      return ((await res.json() as { data: Array<Record<string, unknown>> }).data).some((card) => card.session_id === id);
    };
    await pool.query("UPDATE navigation_sessions SET progress_status='UNCERTAIN' WHERE id=$1", [id]);
    assert.equal(await found(), false, 'UNCERTAIN progress must hide the driver from passengers');
    await pool.query("UPDATE navigation_sessions SET progress_status='RELIABLE' WHERE id=$1", [id]);
    assert.equal(await found(), true, 'RELIABLE progress must show the driver');
    await pool.query('UPDATE navigation_sessions SET progress_status=NULL WHERE id=$1', [id]);
    assert.equal(await found(), true, 'NULL (legacy) progress must show the driver');
  });

  it('G03/T17: refresh short-circuits on UNCERTAIN (preserves candidates); non-UNCERTAIN reaches routing', async () => {
    const { id, driverId } = await mkSession({ route: [[24, 49], [25, 50]], current: [24, 49] });
    const demand = await mkDemand([24.2, 49.2], [24.5, 49.5], 1);
    const cand = crypto.randomUUID();
    await pool.query(
      `INSERT INTO navigation_match_candidates(id,navigation_session_id,demand_id,route_version,status,detour_distance_m,detour_duration_s,pickup_eta,expires_at)
       VALUES($1,$2,$3,1,'suggested',0,0,now()+interval '10 minutes',now()+interval '30 minutes')`, [cand, id, demand]);
    createdCandidates.push(cand);
    const refresh = () => fetch(`${apiUrl}/api/v1/navigation/sessions/${id}/matches/refresh`, { method: 'POST', headers: headers(driverId) });
    await pool.query("UPDATE navigation_sessions SET progress_status='UNCERTAIN' WHERE id=$1", [id]);
    const r1 = await refresh();
    assert.equal(r1.status, 200, await r1.clone().text());
    const d1 = (await r1.json() as { data: Array<Record<string, unknown>> }).data;
    assert.ok(d1.some((c) => c.id === cand), 'UNCERTAIN refresh must preserve the existing candidate without routing');
    // Negative control: NULL progress must proceed past the gate into the (unavailable) router -> 503.
    await pool.query('UPDATE navigation_sessions SET progress_status=NULL WHERE id=$1', [id]);
    const r2 = await refresh();
    assert.equal(r2.status, 503, 'non-UNCERTAIN refresh must reach routing (503 with OSRM off), proving the gate is load-bearing');
    assert.equal((await r2.json() as { error: { code: string } }).error.code, 'routing_unavailable');
  });
});