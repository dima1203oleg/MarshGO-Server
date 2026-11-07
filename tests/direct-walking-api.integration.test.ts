import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('Direct walking API integration tests are restricted to a loopback database');
}

describe('direct walking API geometry coverage (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const userId = crypto.randomUUID();

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES ($1,'Direct walking API test',ARRAY['passenger'])`, [userId]);
  });

  after(async () => {
    await pool.query('DELETE FROM journeys WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM user_roles WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await pool.end();
  });

  it('does not expose or persist a short route when the foot graph snaps away from the requested origin', async () => {
    const response = await fetch(`${apiUrl}/api/v1/journeys/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-user-id': userId },
      body: JSON.stringify({
        origin: { name: 'Львів', coordinates: [24.0315921, 49.841952] },
        destination: { name: 'Площа Ринок', coordinates: [24.0323731, 49.8419316] },
        departureAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        passengers: 1,
        strategy: 'FASTEST',
        preferences: { allowCommunity: false, allowPublicTransport: false, allowedTransportTypes: ['carpool'] },
      }),
    });
    assert.equal(response.status, 200);

    const result = await response.json() as { data: {
      providerErrors: string[];
      journeys: Array<{ id: string; source?: string; legs: Array<{ mode: string; source?: string; routeGeometry?: unknown }> }>;
    } };
    assert.ok(result.data.providerErrors.some((message) => message.includes('прив’язав точки до дороги надто далеко')),
      'the API should disclose that the foot graph could not cover the requested endpoints');
    assert.equal(result.data.journeys.some((journey) => journey.source === 'osrm-foot-route'
      || journey.legs.some((leg) => leg.mode === 'WALK' && leg.source === 'osrm-foot-route')), false,
    'a snapped-away road segment must not be presented as a door-to-door walk');

    const stored = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM journeys j JOIN journey_legs l ON l.journey_id=j.id
        WHERE j.user_id=$1 AND l.data_source='osrm-foot-route'`, [userId],
    );
    assert.equal(stored.rows[0]?.count, 0, 'no incomplete foot geometry may be persisted for this user');
  });
});
