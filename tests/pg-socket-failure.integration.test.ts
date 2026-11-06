import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { observePgPoolClientErrors } from '../server/database/poolClientErrors';

/**
 * Real-socket evidence for the merged checked-out-client error listener
 * (server/database/poolClientErrors.ts). Opt-in: PG_SOCKET_FAILURE_TEST=1 plus
 * API_TEST_DATABASE_URL pointing at the disposable CI Postgres. The test
 * terminates only the backend pid it created itself, writes no application
 * data, and never logs the connection URL or its credentials.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const TEST_DATABASE_PATTERN = /^marshgo_e2e(_[a-z0-9_]+)?$/;

/** Refuses anything that is not the loopback disposable marshgo_e2e test database. */
function parseTestOnlyDatabaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PG socket-failure test: the database URL is not parseable; refusing to run.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`PG socket-failure test: refusing non-loopback host "${hostname}"; only the disposable CI Postgres is allowed.`);
  }
  const database = url.pathname.replace(/^\//, '');
  if (!TEST_DATABASE_PATTERN.test(database)) {
    throw new Error(`PG socket-failure test: refusing database "${database}"; only the marshgo_e2e test-only prefix is allowed.`);
  }
  return url;
}

test('guard: only loopback marshgo_e2e-prefixed databases pass', () => {
  for (const raw of [
    'postgres://u:p@127.0.0.1:5434/marshgo_e2e',
    'postgres://u:p@localhost:5432/marshgo_e2e_ci',
    'postgres://u:p@[::1]:5432/marshgo_e2e',
  ]) {
    assert.doesNotThrow(() => parseTestOnlyDatabaseUrl(raw));
  }
});

test('guard: production/staging-looking endpoints are refused without leaking credentials', () => {
  const refused = [
    'postgres://u:secret@db.prod.example.com:5432/marshgo',
    'postgres://u:secret@10.0.0.5:5432/marshgo_e2e',
    'postgres://u:secret@127.0.0.1:5432/marshgo',
    'postgres://u:secret@127.0.0.1:5432/marshgo_staging',
    'postgres://u:secret@127.0.0.1:5432/postgres',
    'not-a-url',
  ];
  for (const raw of refused) {
    assert.throws(() => parseTestOnlyDatabaseUrl(raw), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('secret'), 'refusal messages must never echo credentials');
      return true;
    }, `must refuse: ${raw.replace(/:[^:@/]*@/, ':***@')}`);
  }
});

const databaseUrl = process.env.API_TEST_DATABASE_URL;
const optIn = process.env.PG_SOCKET_FAILURE_TEST === '1';
const enabled = optIn && Boolean(databaseUrl);
// Opt-in with an unsafe endpoint must fail loudly at load time, never silently skip.
const parsedUrl = enabled ? parseTestOnlyDatabaseUrl(databaseUrl!) : undefined;

interface ClientErrorEvent {
  level: 'error';
  event: 'database.client_error';
  name: string;
}

describe('PostgreSQL checked-out client socket failure (opt-in integration)', { skip: !enabled }, () => {
  const events: ClientErrorEvent[] = [];
  const pool = enabled
    ? new Pool({ connectionString: databaseUrl, max: 2, idleTimeoutMillis: 30_000 })
    : undefined;
  if (pool) {
    observePgPoolClientErrors(pool, (entry) => events.push(entry));
  }

  after(async () => {
    await pool?.end();
  });

  test('own backend termination is observed and sanitized, the process survives, and a fresh query succeeds', { timeout: 30_000 }, async () => {
    const victim = await pool!.connect();
    let victimOpen = true;
    let releaseControl: (() => void) | undefined;
    try {
      const database = await victim.query('SELECT current_database() AS name');
      assert.match(database.rows[0].name, TEST_DATABASE_PATTERN, 'connected database must carry the test-only prefix');
      const victimPid: number = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      const control = await pool!.connect();
      releaseControl = () => control.release();
      const controlPid: number = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      assert.notEqual(controlPid, victimPid, 'control connection must be a distinct physical backend');

      // Terminate only the backend this test created. The victim is checked out and
      // idle, so pg-pool itself does not handle its 'error' event — exactly the
      // production crash scenario the merged listener must absorb.
      const terminated = await control.query('SELECT pg_terminate_backend($1) AS ok', [victimPid]);
      assert.equal(terminated.rows[0].ok, true, 'pg_terminate_backend must confirm it killed our own pid');

      const deadline = Date.now() + 10_000;
      while (events.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(events.length >= 1, 'the checked-out client error was not observed within 10s');
      for (const entry of events) {
        assert.equal(entry.level, 'error');
        assert.equal(entry.event, 'database.client_error');
        assert.equal(typeof entry.name, 'string');
        assert.ok(entry.name.length > 0);
        assert.deepEqual(Object.keys(entry).sort(), ['event', 'level', 'name'], 'log entries must stay minimal');
      }
      const serialized = JSON.stringify(events);
      assert.ok(!serialized.includes(databaseUrl!), 'sanitized events must not contain the connection URL');
      if (parsedUrl!.password) {
        assert.ok(!serialized.includes(parsedUrl!.password), 'sanitized events must not contain the password');
      }
      assert.equal(victim.listenerCount('error'), 1, 'exactly one error listener per physical client');

      // Reaching this line proves the process survived the socket failure: an
      // unhandled EventEmitter 'error' would have terminated the test runner.
      // Discard the dead client so the pool cannot hand it out again.
      victim.release(true);
      victimOpen = false;
      const recovered = await pool!.query('SELECT pg_backend_pid() AS pid, 1 AS ok');
      assert.equal(recovered.rows[0].ok, 1, 'a fresh query must succeed after pool recovery');
      assert.notEqual(recovered.rows[0].pid, victimPid, 'recovery must use a fresh physical connection');
    } finally {
      if (victimOpen) victim.release(true);
      releaseControl?.();
    }
  });
});
