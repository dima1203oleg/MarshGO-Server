import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl && process.env.API_TEST_RESTART === 'true');
const parsedDatabaseUrl = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && parsedDatabaseUrl && !['127.0.0.1', 'localhost', '::1'].includes(parsedDatabaseUrl.hostname)) {
  throw new Error('API restart integration tests are restricted to a loopback database');
}

describe('booking durability across API process restart (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const port = Number(process.env.API_TEST_RESTART_PORT ?? 3308);
  const apiUrl = `http://127.0.0.1:${port}`;
  const ids = {
    driver: crypto.randomUUID(),
    passenger: crypto.randomUUID(),
    vehicle: crypto.randomUUID(),
    offer: crypto.randomUUID(),
  };
  const idempotencyKey = `restart-${crypto.randomUUID()}`;
  const children: ChildProcess[] = [];

  after(async () => {
    for (const child of children) await stopApi(child);
    await pool.query('DELETE FROM audit_events WHERE entity_id IN (SELECT id FROM bookings WHERE offer_id=$1) OR actor_id=ANY($2::uuid[])', [ids.offer, [ids.driver, ids.passenger]]);
    await pool.query('DELETE FROM realtime_outbox WHERE recipient_ids && $1::uuid[]', [[ids.driver, ids.passenger]]);
    await pool.query('DELETE FROM conversations WHERE booking_id IN (SELECT id FROM bookings WHERE offer_id=$1)', [ids.offer]);
    await pool.query('DELETE FROM booking_events WHERE booking_id IN (SELECT id FROM bookings WHERE offer_id=$1)', [ids.offer]);
    await pool.query('DELETE FROM bookings WHERE offer_id=$1', [ids.offer]);
    await pool.query('DELETE FROM offers WHERE id=$1', [ids.offer]);
    await pool.query('DELETE FROM vehicles WHERE id=$1', [ids.vehicle]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ids.driver, ids.passenger]]);
    await pool.end();
  });

  it('returns the same durable booking and inventory after the API process restarts', async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES
      ($1,'Restart API test driver',ARRAY['driver']),($2,'Restart API test passenger',ARRAY['passenger'])`, [ids.driver, ids.passenger]);
    await pool.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count)
      VALUES ($1,$2,'Restart Test','Vehicle',2024,4)`, [ids.vehicle, ids.driver]);
    await pool.query(`INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,departure_at,price_per_seat_minor,total_seats,available_seats)
      VALUES ($1,$2,$3,'Restart Test Origin','Restart Test Destination',
        ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,
        ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
        now()+interval '10 days',15000,4,4)`, [ids.offer, ids.driver, ids.vehicle]);

    const first = await startApi();
    const original = await book();
    assert.equal(original.status, 201);
    const originalBody = await original.json() as { data: { id: string; status: string }; replayed: boolean };
    assert.equal(originalBody.replayed, false);
    assert.equal(originalBody.data.status, 'confirmed');
    await stopApi(first);

    const second = await startApi();
    const replay = await book();
    assert.equal(replay.status, 200);
    const replayBody = await replay.json() as { data: { id: string; status: string }; replayed: boolean };
    assert.equal(replayBody.replayed, true);
    assert.equal(replayBody.data.id, originalBody.data.id);
    assert.equal(replayBody.data.status, 'confirmed');
    const mismatch = await book(2);
    assert.equal(mismatch.status, 409);

    const persisted = await pool.query<{ available_seats: number; booking_count: string; confirmed_count: string }>(
      `SELECT o.available_seats,
              (SELECT count(*) FROM bookings b WHERE b.offer_id=o.id) AS booking_count,
              (SELECT count(*) FROM bookings b WHERE b.offer_id=o.id AND b.status='confirmed') AS confirmed_count
         FROM offers o WHERE o.id=$1`, [ids.offer],
    );
    assert.deepEqual(persisted.rows[0], { available_seats: 3, booking_count: '1', confirmed_count: '1' });
    await stopApi(second);
  });

  async function startApi(): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['./node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        AUTH_DEV_BYPASS: 'true',
        DATABASE_URL: databaseUrl!,
        API_HOST: '127.0.0.1',
        API_PORT: String(port),
        REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
        SESSION_SECRET: 'integration-test-session-secret-32chars',
        // Shares the suite's Redis rate-limit window with the other integration suites.
        API_RATE_LIMIT_LIMIT: process.env.API_RATE_LIMIT_LIMIT ?? '1000',
      },
      stdio: 'ignore',
    });
    children.push(child);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`API process exited before ready with code ${child.exitCode}`);
      try {
        const response = await fetch(`${apiUrl}/healthz`);
        if (response.ok) return child;
      } catch {
        // The API is still starting; poll the health endpoint again.
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await stopApi(child);
    throw new Error(`API process did not become healthy at ${apiUrl}`);
  }

  async function stopApi(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.killed) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<false>(resolve => { shutdownTimer = setTimeout(() => resolve(false), 10_000); }),
    ]);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    if (!stopped) {
      child.kill('SIGKILL');
      await exited;
      throw new Error('API process did not stop after SIGTERM');
    }
  }

  function book(seats = 1): Promise<Response> {
    return fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dev-user-id': ids.passenger,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ offerId: ids.offer, seats }),
    });
  }
});
