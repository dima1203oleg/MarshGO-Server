import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Eligible S1 candidates reach the unavailable router; transaction races use a controlled insertion solver.
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
    if (createdDemands.length) {
      await pool.query('DELETE FROM passenger_demands WHERE id=ANY($1::uuid[])', [createdDemands]);
      createdDemands.length = 0;
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

  it('actual route replacement and end SQL clear all seven occurrence fields (rolled-back local database execution)', async () => {
    const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    const geometry = JSON.stringify({ type: 'LineString', coordinates: LINE });
    for (const kind of ['destination', 'reroute', 'accept', 'end']) {
      const { id, driverId } = await mkSession({ route: LINE });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE navigation_sessions SET state=$2,current_location_at=date_trunc('milliseconds',current_location_at),
          progress_ordinal=1,progress_offset_m=10,progress_cumulative_m=10,progress_fraction=0.2,
          progress_status='RELIABLE',progress_uncertainty_m=5,last_reliable_fix_at=now() WHERE id=$1`, [id, kind === 'accept' ? 'paused' : 'active']);
        const snapshot = (await client.query('SELECT current_location_at FROM navigation_sessions WHERE id=$1', [id])).rows[0];
        const marker = kind === 'accept' ? "app.post('/api/v1/proposals/:id/accept'" : `app.${kind === 'destination' ? 'put' : 'post'}('/api/v1/navigation/sessions/:id/${kind}'`;
        const handler = source.indexOf(marker);
        const start = source.indexOf('`UPDATE navigation_sessions SET', handler);
        const finish = source.indexOf('`', start + 1);
        assert.ok(handler >= 0 && start > handler && finish > start, `${kind} UPDATE literal is reachable`);
        const sql = source.slice(start + 1, finish);
        const values = kind === 'destination' ? [id, driverId, 'Reset destination', 24.002, 49, geometry, 200, 30, 1, '[]']
          : kind === 'reroute' ? [id, driverId, 1, geometry, 200, 30, snapshot.current_location_at, '[]']
          : kind === 'accept' ? [id, driverId, geometry, 200, 30, 1, '[]'] : [id, driverId];
        assert.equal((await client.query(sql, values)).rowCount, 1, `${kind} UPDATE must execute, not skip`);
        const progress = (await client.query(`SELECT progress_ordinal,progress_offset_m,progress_cumulative_m,progress_fraction,
          progress_status,progress_uncertainty_m,last_reliable_fix_at FROM navigation_sessions WHERE id=$1`, [id])).rows[0];
        assert.deepEqual(Object.values(progress), Array(7).fill(null), `${kind} must clear history belonging to the old route`);
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
  });

  it('owner GETs serialize persisted progress for NULL, RELIABLE, UNCERTAIN and OFF_ROUTE; non-owners cannot read it', async () => {
    const { id, driverId } = await mkSession({ route: LINE, current: [24, 49] });
    const assertOwnerProgress = async (status: string | null) => {
      const persisted = await progressOf(id);
      assert.equal(persisted.progress_status, status);
      const expected = { ...persisted, last_reliable_fix_at: persisted.last_reliable_fix_at?.toISOString() ?? null };
      for (const endpoint of ['active', id]) {
        const response = await fetch(`${apiUrl}/api/v1/navigation/sessions/${endpoint}`, { headers: headers(driverId) });
        assert.equal(response.status, 200, await response.clone().text());
        const data = (await response.json() as { data: Record<string, unknown> }).data;
        assert.equal(data.id, id);
        assert.deepEqual({
          progress_status: data.progress_status, progress_ordinal: data.progress_ordinal,
          progress_fraction: data.progress_fraction, last_reliable_fix_at: data.last_reliable_fix_at,
        }, expected, `${endpoint} must serialize stored progress, including nullable fields and timestamp`);
      }
    };
    await assertOwnerProgress(null);
    const capturedAt = Date.now() + 1000;
    for (const [index, fix] of [
      { coordinates: [24.0015, 49] as Point, status: 'RELIABLE' },
      { coordinates: [24.0002, 49] as Point, status: 'UNCERTAIN' },
      { coordinates: [24.0002, 49.001] as Point, status: 'OFF_ROUTE' },
    ].entries()) {
      const response = await postLocation(id, driverId, fix.coordinates, new Date(capturedAt + index * 1000));
      assert.equal(response.status, 200, await response.clone().text());
      await assertOwnerProgress(fix.status);
    }
    const foreignSession = await fetch(`${apiUrl}/api/v1/navigation/sessions/${id}`, { headers: headers(passenger) });
    assert.equal(foreignSession.status, 404, 'session-by-id must remain owner-only');
    const foreignActive = await fetch(`${apiUrl}/api/v1/navigation/sessions/active`, { headers: headers(passenger) });
    assert.equal(foreignActive.status, 200, await foreignActive.clone().text());
    assert.equal((await foreignActive.json() as { data: unknown }).data, null, 'active GET must not expose another owner');
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

  it('unreliable fixes cannot replace the last reliable occurrence or make repeated backward fixes reliable', async () => {
    const { id, driverId } = await mkSession({ route: LINE, current: [24, 49] });
    const start = Date.now();
    assert.equal((await postLocation(id, driverId, [24.0015, 49], new Date(start + 1000))).status, 200);
    const anchor = await progressOf(id);
    assert.equal(anchor.progress_status, 'RELIABLE');
    for (const [index, coordinates] of ([[24.0002, 49], [24.0002, 49], [24.0015, 49.001]] as Point[]).entries()) {
      const response = await postLocation(id, driverId, coordinates, new Date(start + (index + 2) * 1000));
      assert.equal(response.status, 200, await response.clone().text());
      const data = (await response.json()).data;
      assert.equal(data.progressStatus, index === 2 ? 'OFF_ROUTE' : 'UNCERTAIN');
      assert.equal(data.progressOrdinal, anchor.progress_ordinal, 'response exposes the persisted reliable anchor, not a tentative occurrence');
      const persisted = await progressOf(id);
      assert.equal(persisted.progress_ordinal, anchor.progress_ordinal);
      assert.equal(persisted.progress_fraction, anchor.progress_fraction);
      assert.deepEqual(persisted.last_reliable_fix_at, anchor.last_reliable_fix_at);
    }
    const recovered = await postLocation(id, driverId, [24.0018, 49], new Date(start + 5000));
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.equal((await recovered.json()).data.progressStatus, 'RELIABLE');
    assert.ok((await progressOf(id)).progress_fraction! > anchor.progress_fraction!);
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

  it('G03/T17: UNCERTAIN and OFF_ROUTE drivers are hidden from discovery; RELIABLE and NULL are shown', async () => {
    const demand = await mkDemand([24.2, 49.2], [24.5, 49.5], 1);
    const { id } = await mkSession({ route: [[24, 49], [25, 50]], current: [24, 49] });
    const found = async () => {
      const res = await liveDrivers(demand);
      assert.equal(res.status, 200, await res.clone().text());
      return ((await res.json() as { data: Array<Record<string, unknown>> }).data).some((card) => card.session_id === id);
    };
    await pool.query("UPDATE navigation_sessions SET progress_status='UNCERTAIN' WHERE id=$1", [id]);
    assert.equal(await found(), false, 'UNCERTAIN progress must hide the driver from passengers');
    await pool.query("UPDATE navigation_sessions SET progress_status='OFF_ROUTE' WHERE id=$1", [id]);
    assert.equal(await found(), false, 'OFF_ROUTE progress must hide the driver from passengers');
    await pool.query("UPDATE navigation_sessions SET progress_status='RELIABLE',progress_ordinal=1 WHERE id=$1", [id]);
    assert.equal(await found(), true, 'RELIABLE progress must show the driver');
    await pool.query('UPDATE navigation_sessions SET progress_status=NULL WHERE id=$1', [id]);
    assert.equal(await found(), true, 'NULL (legacy) progress must show the driver');
  });

  const repeatedRoute: Point[] = [[24, 49], [24.01, 49], [24.01, 49.01], [24, 49.01], [24, 49], [24.01, 49], [24.02, 49]];
  async function assertBothDirections(id: string, driverId: string, demandId: string, expected: boolean) {
    const discovery = await liveDrivers(demandId);
    assert.equal(discovery.status, 200, await discovery.clone().text());
    assert.equal((await discovery.json()).data.some((card: { session_id: string }) => card.session_id === id), expected, 'passenger discovery');
    const refresh = await fetch(`${apiUrl}/api/v1/navigation/sessions/${id}/matches/refresh`, { method: 'POST', headers: headers(driverId) });
    assert.equal(refresh.status, expected ? 503 : 200, await refresh.clone().text());
    if (expected) assert.equal((await refresh.json()).error.code, 'routing_unavailable', 'eligible driver-side candidate reaches routing');
    else assert.deepEqual((await refresh.json()).data, [], 'no driver-side candidate reaches routing');
  }

  it('G03/C10: both S1 directions retain an upcoming repeated pickup after its first occurrence was passed', async () => {
    const { id, driverId } = await mkSession({ route: repeatedRoute, current: [24.005, 49.01] });
    await pool.query("UPDATE navigation_sessions SET progress_status='RELIABLE',progress_ordinal=3 WHERE id=$1", [id]);
    const demand = await mkDemand([24.005, 49], [24.015, 49], 1);
    await assertBothDirections(id, driverId, demand, true);
  });

  it('G03/C10: both S1 directions reject passed stops when GPS revisits an earlier route coordinate', async () => {
    const { id, driverId } = await mkSession({ route: repeatedRoute, current: [24.008, 49] });
    await pool.query("UPDATE navigation_sessions SET progress_status='RELIABLE',progress_ordinal=5 WHERE id=$1", [id]);
    const demand = await mkDemand([24.005, 49.01], [24, 49.005], 1);
    await assertBothDirections(id, driverId, demand, false);
  });

  it('G03/C10: a loop without reliable occurrence history is withheld until progress is known', async () => {
    const { id, driverId } = await mkSession({ route: repeatedRoute, current: [24.005, 49.01] });
    const demand = await mkDemand([24.005, 49], [24.015, 49], 1);
    await assertBothDirections(id, driverId, demand, false);
    await pool.query("UPDATE navigation_sessions SET progress_status='RELIABLE',progress_ordinal=3 WHERE id=$1", [id]);
    await assertBothDirections(id, driverId, demand, true);
  });

  it('refresh rechecks GPS revision, reliability, freshness and route version after asynchronous routing before any candidate writes', async () => {
    const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    const sqlStart = source.indexOf('const navigationCorridorSql = `');
    const sqlEnd = source.indexOf('`;', sqlStart) + 2;
    const functionStart = source.indexOf('async function refreshNavigationMatches(');
    const functionEnd = source.indexOf('\n// Foreground navigation', functionStart);
    assert.ok(sqlStart >= 0 && sqlEnd > sqlStart && functionStart > sqlEnd && functionEnd > functionStart);
    const executable = ts.transpileModule(`${source.slice(sqlStart, sqlEnd)}\n${source.slice(functionStart, functionEnd)}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    class ApiError extends Error {
      constructor(public status: number, message: string, public code: string) { super(message); }
    }
    const { id, driverId } = await mkSession({ route: LINE, current: [24, 49] });
    const demand = await mkDemand([24.0005, 49], [24.0015, 49], 1);
    const candidateId = crypto.randomUUID();
    await pool.query(`INSERT INTO navigation_match_candidates(id,navigation_session_id,demand_id,route_version,status,
      detour_distance_m,detour_duration_s,pickup_eta,expires_at)
      VALUES($1,$2,$3,1,'driver_interested',0,0,now()+interval '10 minutes',now()+interval '30 minutes')`, [candidateId, id, demand]);
    createdCandidates.push(candidateId);
    const baseline = (await pool.query('SELECT * FROM navigation_match_candidates WHERE navigation_session_id=$1', [id])).rows;
    const mutations = [
      "progress_status='UNCERTAIN'", "progress_status='OFF_ROUTE'",
      "current_location_at=current_location_at+interval '1 microsecond'",
      "current_location_at=now()-interval '61 seconds'", 'route_version=route_version+1',
    ];
    let routed = 0;
    for (const mutation of [...mutations, null]) {
      await pool.query("UPDATE navigation_sessions SET progress_status='RELIABLE',progress_ordinal=1,current_location_at=now(),route_version=1 WHERE id=$1", [id]);
      const solver = async () => {
        routed += 1;
        if (mutation) await pool.query(`UPDATE navigation_sessions SET ${mutation} WHERE id=$1`, [id]);
        return { pickupEta: new Date(Date.now() + 60_000), detourDistanceM: 0, detourDurationS: 0, pickupOrdinal: 1, dropoffOrdinal: 2 };
      };
      const refresh = new Function('pool', 'optimizeStopInsertion', 'getRoadRouteThroughPoints', 'ApiError', 'RoutingUnavailableError', 'crypto', 'listNavigationMatches',
        `${executable}; return refreshNavigationMatches;`)(pool, solver, () => {}, ApiError, class extends Error {}, crypto,
        async () => (await pool.query('SELECT * FROM navigation_match_candidates WHERE navigation_session_id=$1', [id])).rows);
      if (mutation) {
        await assert.rejects(refresh(id, driverId), (error: ApiError) => error.status === 409 && error.code === 'navigation_session_changed', mutation);
        assert.deepEqual((await pool.query('SELECT * FROM navigation_match_candidates WHERE navigation_session_id=$1', [id])).rows, baseline, 'stale computation preserves existing interest');
      } else {
        await pool.query('DELETE FROM navigation_match_candidates WHERE id=$1', [candidateId]);
        assert.equal((await refresh(id, driverId)).length, 1, 'unchanged GPS, including PostgreSQL microseconds, persists the new candidate');
      }
    }
    assert.equal(routed, mutations.length + 1, 'every case must execute the actual async routing path');
  });

  it('G03/T17: refresh preserves candidates on UNCERTAIN and OFF_ROUTE; NULL reaches routing', async () => {
    const { id, driverId } = await mkSession({ route: [[24, 49], [25, 50]], current: [24, 49] });
    const demand = await mkDemand([24.2, 49.2], [24.5, 49.5], 1);
    const cand = crypto.randomUUID();
    await pool.query(
      `INSERT INTO navigation_match_candidates(id,navigation_session_id,demand_id,route_version,status,detour_distance_m,detour_duration_s,pickup_eta,expires_at)
       VALUES($1,$2,$3,1,'suggested',0,0,now()+interval '10 minutes',now()+interval '30 minutes')`, [cand, id, demand]);
    createdCandidates.push(cand);
    const refresh = () => fetch(`${apiUrl}/api/v1/navigation/sessions/${id}/matches/refresh`, { method: 'POST', headers: headers(driverId) });
    const candidateBefore = (await pool.query('SELECT * FROM navigation_match_candidates WHERE id=$1', [cand])).rows[0];
    for (const status of ['UNCERTAIN', 'OFF_ROUTE']) {
      await pool.query('UPDATE navigation_sessions SET progress_status=$2 WHERE id=$1', [id, status]);
      const r1 = await refresh();
      assert.equal(r1.status, 200, await r1.clone().text());
      const d1 = (await r1.json() as { data: Array<Record<string, unknown>> }).data;
      assert.equal(d1.length, 1, `${status} refresh must not create new candidates`);
      assert.ok(d1.some((c) => c.id === cand), `${status} refresh must preserve the existing candidate without routing`);
      const candidateAfter = (await pool.query('SELECT * FROM navigation_match_candidates WHERE id=$1', [cand])).rows[0];
      assert.deepEqual(candidateAfter, candidateBefore, `${status} refresh must not mutate the stored candidate`);
    }
    // Negative control: NULL progress must proceed past the gate into the (unavailable) router -> 503.
    await pool.query('UPDATE navigation_sessions SET progress_status=NULL WHERE id=$1', [id]);
    const r2 = await refresh();
    assert.equal(r2.status, 503, 'NULL refresh must reach routing (503 with OSRM off), proving the gate is load-bearing');
    assert.equal((await r2.json() as { error: { code: string } }).error.code, 'routing_unavailable');
  });
});