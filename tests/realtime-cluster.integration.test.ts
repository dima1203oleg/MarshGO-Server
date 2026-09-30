import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';

const primaryUrl = process.env.API_TEST_URL;
const secondaryUrl = process.env.API_TEST_SECONDARY_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(primaryUrl && secondaryUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('Realtime integration tests are restricted to a loopback database');
}

type AuthResult = { data: { user: { id: string }; accessToken: string } };
type ApiResult<T> = { data: T };
type RealtimeEvent = { type: string; data: { id?: string; booking_id?: string; candidate_id?: string; demand_id?: string; status?: string; sender_id?: string; body?: string } };
const realtimeEventQueues = new WeakMap<WebSocket, RealtimeEvent[]>();

function trackRealtimeSocket(socket: WebSocket) {
  const queue: RealtimeEvent[] = [];
  realtimeEventQueues.set(socket, queue);
  socket.on('message', (raw) => {
    try {
      queue.push(JSON.parse(raw.toString()) as RealtimeEvent);
      if (queue.length > 100) queue.shift();
    } catch { /* Test assertions only consume valid server events. */ }
  });
}

async function register(phone: string, displayName: string) {
  const requested = await fetch(`${primaryUrl}/api/v1/auth/otp/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, displayName }),
  });
  assert.equal(requested.status, 200);
  const requestBody = await requested.json() as { developmentCode?: string };
  assert.match(requestBody.developmentCode ?? '', /^\d{6}$/);
  const verified = await fetch(`${primaryUrl}/api/v1/auth/otp/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code: requestBody.developmentCode }),
  });
  assert.equal(verified.status, 200);
  return await verified.json() as AuthResult;
}

function waitForSocketEvent(socket: WebSocket, type: string, timeoutMs = 10_000) {
  const queue = realtimeEventQueues.get(socket);
  if (!queue) return Promise.reject(new Error('Realtime socket must be tracked before waiting for events'));
  const takeEvent = () => {
    const index = queue.findIndex((event) => event.type === type);
    return index < 0 ? undefined : queue.splice(index, 1)[0];
  };
  const buffered = takeEvent();
  if (buffered) return Promise.resolve(buffered);
  return new Promise<RealtimeEvent>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for realtime ${type}`));
    }, timeoutMs);
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onMessage = () => {
      const event = takeEvent();
      if (!event) return;
      cleanup();
      resolve(event);
    };
    socket.on('message', onMessage);
    socket.once('error', onError);
  });
}

async function waitForPublished(pool: Pool, dedupeKey: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM realtime_outbox WHERE dedupe_key=$1', [dedupeKey],
    );
    if (result.rows[0]?.published_at) return result.rows[0].published_at;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Outbox row ${dedupeKey} did not reach published state`);
}

describe('Redis-backed realtime across API instances', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const phonePrefix = `+38098${process.pid}`;
  let driverId = '';
  let passengerId = '';
  let vehicleId = '';
  let offerId = '';
  let bookingId = '';
  let conversationId = '';
  let navigationSessionId = '';
  let navigationDemandId = '';
  let socket: WebSocket | undefined;
  let usedTicketUrl = '';
  let passengerAccessToken = '';

  before(async () => {
    assert.ok(primaryUrl && secondaryUrl && databaseUrl);
    assert.equal((await fetch(`${primaryUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${secondaryUrl}/healthz`)).status, 200);
    const driverAuth = await register(`${phonePrefix}101`, 'Cluster driver');
    const passengerAuth = await register(`${phonePrefix}102`, 'Cluster passenger');
    driverId = driverAuth.data.user.id;
    passengerId = passengerAuth.data.user.id;
    passengerAccessToken = passengerAuth.data.accessToken;
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO vehicles(owner_id,make,model,model_year,seat_count) VALUES($1,'Test','Realtime',2024,2) RETURNING id`, [driverId],
    );
    vehicleId = inserted.rows[0].id;
    const offer = await pool.query<{ id: string }>(
      `INSERT INTO offers(driver_id,vehicle_id,origin_name,destination_name,origin,destination,departure_at,price_per_seat_minor,total_seats,available_seats)
       VALUES($1,$2,'Cluster Origin','Cluster Destination',ST_SetSRID(ST_MakePoint(24,49),4326)::geography,
       ST_SetSRID(ST_MakePoint(25,50),4326)::geography,now()+interval '10 days',15000,2,2) RETURNING id`, [driverId, vehicleId],
    );
    offerId = offer.rows[0].id;
    const booking = await fetch(`${primaryUrl}/api/v1/bookings`, {
      method: 'POST', headers: { authorization: `Bearer ${passengerAuth.data.accessToken}`, 'content-type': 'application/json', 'idempotency-key': `redis-cluster-${crypto.randomUUID()}` },
      body: JSON.stringify({ offerId, seats: 1 }),
    });
    const bookingText = await booking.text();
    assert.equal(booking.status, 201, bookingText);
    bookingId = (JSON.parse(bookingText) as ApiResult<{ id: string }>).data.id;
    const conversation = await fetch(`${primaryUrl}/api/v1/bookings/${bookingId}/conversation`, {
      headers: { authorization: `Bearer ${passengerAuth.data.accessToken}` },
    });
    assert.equal(conversation.status, 200);
    conversationId = (await conversation.json() as ApiResult<{ id: string }>).data.id;

    const ticketResponse = await fetch(`${primaryUrl}/api/v1/realtime/ticket`, {
      method: 'POST', headers: { authorization: `Bearer ${passengerAuth.data.accessToken}` },
    });
    assert.equal(ticketResponse.status, 201);
    const ticket = (await ticketResponse.json() as ApiResult<{ ticket: string }>).data.ticket;
    usedTicketUrl = `${secondaryUrl!.replace(/^http/, 'ws')}/api/v1/realtime?ticket=${encodeURIComponent(ticket)}`;
    socket = new WebSocket(usedTicketUrl);
    trackRealtimeSocket(socket);
    const ready = waitForSocketEvent(socket, 'connection.ready');
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    await ready;
  });

  after(async () => {
    socket?.close();
    if (navigationSessionId) await pool.query('DELETE FROM navigation_sessions WHERE id=$1', [navigationSessionId]);
    if (navigationDemandId) await pool.query('DELETE FROM passenger_demands WHERE id=$1', [navigationDemandId]);
    if (conversationId) await pool.query('DELETE FROM conversations WHERE id=$1', [conversationId]);
    if (driverId || passengerId) await pool.query('DELETE FROM realtime_outbox WHERE recipient_ids && $1::uuid[]', [[driverId, passengerId].filter(Boolean)]);
    if (bookingId) await pool.query('DELETE FROM booking_events WHERE booking_id=$1', [bookingId]);
    if (bookingId) await pool.query('DELETE FROM bookings WHERE id=$1', [bookingId]);
    if (offerId) await pool.query('DELETE FROM offers WHERE id=$1', [offerId]);
    if (vehicleId) await pool.query('DELETE FROM vehicles WHERE id=$1', [vehicleId]);
    if (driverId || passengerId) {
      const ids = [driverId, passengerId].filter(Boolean);
      await pool.query('DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[]) OR entity_id=ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM user_roles WHERE user_id=ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [ids]);
    }
    await pool.query('DELETE FROM otp_challenges WHERE phone_e164 LIKE $1', [`${phonePrefix}%`]);
    await pool.end();
  });

  it('consumes a Redis ticket on one API instance and delivers persisted messages from another', async () => {
    assert.ok(socket && driverId && passengerId && conversationId);
    const retryKey = `integration-retry:${crypto.randomUUID()}`;
    const retryEvent = waitForSocketEvent(socket, 'booking.changed');
    await pool.query(
      `INSERT INTO realtime_outbox(event_type,dedupe_key,recipient_ids,payload)
       VALUES('integration.unsupported', $1, $2::uuid[], '{}'::jsonb)`, [retryKey, [passengerId]],
    );
    let attempts = 0;
    for (let index = 0; index < 100; index += 1) {
      const result = await pool.query<{ attempt_count: number; published_at: Date | null }>(
        'SELECT attempt_count,published_at FROM realtime_outbox WHERE dedupe_key=$1', [retryKey],
      );
      attempts = Number(result.rows[0]?.attempt_count ?? 0);
      if (attempts > 0 && !result.rows[0]?.published_at) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(attempts, 1, 'a failed dispatch must record its attempt before retry');
    await pool.query(
      `UPDATE realtime_outbox SET event_type='booking.changed',payload=$2::jsonb,available_at=now()
       WHERE dedupe_key=$1`, [retryKey, JSON.stringify({ booking_id: bookingId, status: 'retry_verified' })],
    );
    const retriedEvent = await retryEvent;
    assert.equal(retriedEvent.data.booking_id, bookingId);
    assert.equal(retriedEvent.data.status, 'retry_verified');
    assert.ok(await waitForPublished(pool, retryKey));

    const messageWait = waitForSocketEvent(socket, 'conversation.message.created');
    const response = await fetch(`${primaryUrl}/api/v1/conversations/${conversationId}/messages`, {
      method: 'POST', headers: { 'x-dev-user-id': driverId, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Message crossed API instances through Redis' }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 201, responseText);
    const persisted = (JSON.parse(responseText) as ApiResult<{ id: string; body: string }>).data;
    const delivered = await messageWait;
    assert.equal(delivered.data.id, persisted.id);
    assert.equal(delivered.data.sender_id, driverId);
    assert.equal(delivered.data.body, persisted.body);
    assert.ok(await waitForPublished(pool, `conversation.message.created:${persisted.id}`));
    const outbox = await pool.query<{ event_type: string; attempt_count: number; published_at: Date | null }>(
      'SELECT event_type,attempt_count,published_at FROM realtime_outbox WHERE dedupe_key=$1', [`conversation.message.created:${persisted.id}`],
    );
    assert.equal(outbox.rows[0]?.event_type, 'conversation.message.created');
    assert.ok(Number(outbox.rows[0]?.attempt_count) >= 1);
    assert.ok(outbox.rows[0]?.published_at);

    await pool.query("INSERT INTO user_roles(user_id,role) VALUES($1,'driver') ON CONFLICT DO NOTHING", [driverId]);
    const navigation = await pool.query<{ id: string }>(
      `INSERT INTO navigation_sessions(driver_id,vehicle_id,vehicle_seat_count,state,destination_name,destination,
         route,route_distance_m,route_duration_s,opt_in,current_location,current_location_accuracy_m,current_location_at)
       VALUES($1,$2,2,'paused','Realtime destination',ST_SetSRID(ST_MakePoint(25,50),4326)::geography,
         ST_SetSRID(ST_GeomFromGeoJSON('{"type":"LineString","coordinates":[[24,49],[25,50]]}'),4326),1000,600,true,
         ST_SetSRID(ST_MakePoint(24,49),4326)::geography,8,now()) RETURNING id`, [driverId, vehicleId],
    );
    navigationSessionId = navigation.rows[0].id;
    const demand = await pool.query<{ id: string }>(
      `INSERT INTO passenger_demands(passenger_id,origin_name,destination_name,origin,destination,earliest_departure,latest_departure,passenger_count,budget_minor)
       VALUES($1,'Realtime pickup','Realtime destination',ST_SetSRID(ST_MakePoint(24.1,49.1),4326)::geography,
         ST_SetSRID(ST_MakePoint(24.8,49.8),4326)::geography,now()+interval '10 minutes',now()+interval '1 hour',1,30000) RETURNING id`, [passengerId],
    );
    navigationDemandId = demand.rows[0].id;
    const candidate = await pool.query<{ id: string }>(
      `INSERT INTO navigation_match_candidates(navigation_session_id,demand_id,route_version,detour_distance_m,detour_duration_s,pickup_eta,expires_at)
       VALUES($1,$2,1,1200,180,now()+interval '12 minutes',now()+interval '5 minutes') RETURNING id`, [navigationSessionId, navigationDemandId],
    );
    const navigationEventWait = waitForSocketEvent(socket, 'navigation.match.driver-interested');
    const interest = await fetch(`${primaryUrl}/api/v1/navigation/sessions/${navigationSessionId}/matches/${candidate.rows[0].id}/interest`, {
      method: 'POST', headers: { 'x-dev-user-id': driverId },
    });
    assert.equal(interest.status, 200);
    assert.ok(await waitForPublished(pool, `navigation.match.driver-interested:${candidate.rows[0].id}`));
    const navigationEvent = await navigationEventWait;
    assert.deepEqual(navigationEvent.data, {
      candidate_id: candidate.rows[0].id, demand_id: navigationDemandId, status: 'driver_interested',
    }, 'the event contains no precise driver coordinates or other location data');
    const passengerCandidates = await fetch(`${primaryUrl}/api/v1/demands/mine/navigation-matches`, {
      headers: { authorization: `Bearer ${passengerAccessToken}` },
    });
    assert.equal(passengerCandidates.status, 200);
    const passengerCandidateBody = await passengerCandidates.json() as ApiResult<Array<{ candidate_id: string; status: string }>>;
    assert.ok(passengerCandidateBody.data.some((item) => item.candidate_id === candidate.rows[0].id && item.status === 'driver_interested'));

    const bookingCreated = await pool.query<{ event_type: string; published_at: Date | null; payload: { status: string; booking_id: string } }>(
      'SELECT event_type,published_at,payload FROM realtime_outbox WHERE dedupe_key=$1', [`booking.confirmed:${bookingId}`],
    );
    assert.equal(bookingCreated.rows[0]?.event_type, 'booking.confirmed');
    assert.equal(bookingCreated.rows[0]?.payload.status, 'confirmed');
    assert.equal(bookingCreated.rows[0]?.payload.booking_id, bookingId);
    assert.ok(bookingCreated.rows[0]?.published_at);

    const cancellationWait = waitForSocketEvent(socket, 'booking.cancelled');
    const cancellation = await fetch(`${primaryUrl}/api/v1/bookings/${bookingId}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${passengerAccessToken}` },
    });
    assert.equal(cancellation.status, 200);
    const cancellationEvent = await cancellationWait;
    assert.equal(cancellationEvent.data.booking_id, bookingId);
    assert.equal(cancellationEvent.data.status, 'cancelled');
    assert.ok(await waitForPublished(pool, `booking.cancelled:${bookingId}`));

    const replay = new WebSocket(usedTicketUrl);
    const replayStatus = await new Promise<number>((resolve, reject) => {
      replay.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      replay.once('open', () => reject(new Error('Realtime ticket was accepted more than once')));
      replay.once('error', () => undefined);
    });
    assert.equal(replayStatus, 401, 'ticket issued on API A must be spent by the first API instance that consumes it');

    const closed = new Promise<number>((resolve) => socket!.once('close', (code) => resolve(code)));
    const logout = await fetch(`${primaryUrl}/api/v1/auth/logout-all`, {
      method: 'POST', headers: { authorization: `Bearer ${passengerAccessToken}` },
    });
    assert.equal(logout.status, 200);
    assert.equal(await closed, 1008, 'session revocation on API A must close the socket connected to API B');
  });
});
