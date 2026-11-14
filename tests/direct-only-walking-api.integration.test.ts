import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const walkingStubUrl = process.env.API_TEST_WALKING_STUB_URL;
const enabled = Boolean(apiUrl && databaseUrl && walkingStubUrl && process.env.API_TEST_GTFS_FIXTURE === '1');
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('Direct-only walking API integration tests are restricted to a loopback database');
}

function nextKyivMorningDeparture(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const next = new Date(Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day')) + 1));
  const date = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  const offsetName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv', timeZoneName: 'shortOffset', hour: '2-digit',
  }).formatToParts(new Date(`${date}T08:00:00Z`)).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const offset = offsetName.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  const zone = offset ? `${offset[1]}${offset[2]!.padStart(2, '0')}:${offset[3] ?? '00'}` : '+00:00';
  return new Date(`${date}T08:00:00${zone}`).toISOString();
}

describe('direct-only walking retry at the HTTP API boundary (opt-in integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const userId = crypto.randomUUID();
  const providerId = crypto.randomUUID();
  const feedUrl = 'https://gtfs-api-fixture.invalid/direct-only.zip';

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES ($1,'Direct-only API test',ARRAY['passenger'])`, [userId]);
    await pool.query(`INSERT INTO mobility_providers(id,name,city,provider_type,source_type,feed_url,priority,status,health,access,license,commercial_use,last_report)
      VALUES ($1,'MARSHGO direct-only walking fixture','Львів','public_transit','gtfs',$2,1,'enabled','healthy','open','CC BY 4.0',TRUE,
        '{"bbox":[23.9,49.7,24.15,49.95],"counts":{"routes_bus":1}}'::jsonb)`, [providerId, feedUrl]);
  });

  after(async () => {
    await pool.query('DELETE FROM journeys WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM user_roles WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await pool.query('DELETE FROM mobility_providers WHERE id=$1', [providerId]);
    await pool.end();
  });

  it('retries after measured-walk rejection and returns feasible direct geometry from beyond standard reach', async () => {
    const origin = { name: 'Тестовий початок', coordinates: [24.0100000, 49.8681678] as [number, number] };
    const destination = { name: 'Тестовий фініш', coordinates: [24.0575850, 49.7941170] as [number, number] };
    const response = await fetch(`${apiUrl}/api/v1/journeys/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-user-id': userId },
      body: JSON.stringify({ origin, destination, departureAt: nextKyivMorningDeparture(), passengers: 1,
        strategy: 'FASTEST', preferences: { allowCommunity: false, allowPublicTransport: true,
          allowedTransportTypes: ['bus'], maxTransfers: 0, maxWalkingMeters: 4_000 } }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { data: { providerErrors: string[]; journeys: Array<{
      id: string; legs: Array<{ mode: string; routeId?: string; transportType?: string; source?: string;
        routeGeometry?: Array<[number, number]>; origin: { coordinates: [number, number] };
        destination: { coordinates: [number, number] } }>;
    }> } };
    assert.ok(result.data.providerErrors.some((message) => message.includes('фактичний час або відстань пішохідного шляху')),
      'the standard-reach itinerary must be rejected by measured pedestrian feasibility before retry');

    const isDirectOnlyRoute = (routeId: string | undefined) => routeId?.split(':').at(-1) === 'direct-only';
    const direct = result.data.journeys.find((journey) => journey.legs.some((leg) => isDirectOnlyRoute(leg.routeId)));
    assert.ok(direct, `the expanded direct trip should be returned after standard reach fails; journeys=${JSON.stringify(result.data.journeys.map((journey) => journey.legs.map((leg) => leg.routeId ?? leg.mode)))}`);
    assert.equal(direct.legs.filter((leg) => leg.mode !== 'WALK').length, 1, 'the retry must retain zero transfers');
    const transit = direct.legs.find((leg) => isDirectOnlyRoute(leg.routeId));
    assert.ok(transit?.routeGeometry && transit.routeGeometry.length >= 2, 'the GTFS trip keeps its confirmed route geometry');
    const walks = direct.legs.filter((leg) => leg.mode === 'WALK');
    assert.equal(walks.length, 2, 'the itinerary exposes access and egress walks');
    assert.ok(walks.every((leg) => leg.source === 'osrm-foot-route' && (leg.routeGeometry?.length ?? 0) >= 2),
      'both expanded endpoint walks use confirmed foot-router geometry');

    const stubStats = await fetch(`${walkingStubUrl}/_stats`).then((value) => value.json()) as { requests: Array<{
      from: [number, number]; to: [number, number];
    }> };
    const samePoint = (left: [number, number], right: [number, number]) =>
      Math.abs(left[0] - right[0]) < 1e-6 && Math.abs(left[1] - right[1]) < 1e-6;
    assert.ok(stubStats.requests.some((request) => samePoint(request.from, origin.coordinates)
      && samePoint(request.to, [24.0029933, 49.8681678])), 'the failed standard trip was measured by the foot router');
    assert.ok(stubStats.requests.some((request) => samePoint(request.from, origin.coordinates)
      && samePoint(request.to, [24.0420000, 49.8681678])), 'the expanded trip was revalidated with the same request-scoped foot router');
    assert.ok(stubStats.requests.some((request) => samePoint(request.from, [24.0500000, 49.7941170])
      && samePoint(request.to, destination.coordinates)), 'the expanded egress geometry was also confirmed');
  });
});
