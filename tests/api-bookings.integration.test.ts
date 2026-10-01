import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { expireDueProposals } from '../server/proposals/expiry';

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
const database = databaseUrl ? new URL(databaseUrl) : null;
if (enabled && database && !['127.0.0.1', 'localhost', '::1'].includes(database.hostname)) {
  throw new Error('API integration tests are restricted to a loopback database');
}

describe('API booking transaction (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ids = {
    driver: crypto.randomUUID(),
    passengers: Array.from({ length: 20 }, () => crypto.randomUUID()),
    admin: crypto.randomUUID(),
    vehicle: crypto.randomUUID(),
    offer: crypto.randomUUID(),
    journeyOffer: crypto.randomUUID(),
    rendezvousOffer: crypto.randomUUID(),
    expiredOffer: crypto.randomUUID(),
  };
  const keys = Array.from({ length: 20 }, () => `api-test-${crypto.randomUUID()}`);
  const passengerA = ids.passengers[0];
  const passengerB = ids.passengers[1];
  let apiCreatedVehicleId: string | null = null;
  const extraVehicleIds: string[] = [];
  const verificationIds: string[] = [];
  const moderationCaseIds: string[] = [];
  let otpUserId: string | null = null;

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES
      ($1,'API test driver',ARRAY['driver']),($2,'API test administrator',ARRAY['admin'])`,
    [ids.driver, ids.admin]);
    await pool.query(`INSERT INTO users(id,display_name,roles)
      SELECT user_id,
             CASE user_id WHEN $2::uuid THEN 'API test passenger A' WHEN $3::uuid THEN 'API test passenger B' ELSE 'API test concurrent passenger' END,
             ARRAY['passenger']
        FROM unnest($1::uuid[]) AS user_id`, [ids.passengers, passengerA, passengerB]);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES
      ($1,'driver'),($2,'admin')`, [ids.driver, ids.admin]);
    await pool.query(`INSERT INTO user_roles(user_id,role)
      SELECT user_id, 'passenger' FROM unnest($1::uuid[]) AS user_id`, [ids.passengers]);
    await pool.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count)
      VALUES ($1,$2,'Test','Vehicle',2024,4)`, [ids.vehicle, ids.driver]);
    await pool.query(`INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats)
      VALUES ($1,$2,$3,'API Test Origin','API Test Destination',
        ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,
        ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
        ST_MakeLine(ST_SetSRID(ST_MakePoint(24.0,49.0),4326),ST_SetSRID(ST_MakePoint(25.0,50.0),4326)),
        now()+interval '10 days',now()+interval '10 days 1 hour',140000,3600,'osrm',15000,1,1)`, [ids.offer, ids.driver, ids.vehicle]);
    await pool.query(`INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats)
      VALUES ($1,$2,$3,'Journey Test Origin','Journey Test Destination',
        ST_SetSRID(ST_MakePoint(23.8561,49.2567),4326)::geography,
        ST_SetSRID(ST_MakePoint(24.0297,49.8397),4326)::geography,
        ST_SetSRID(ST_GeomFromGeoJSON('{"type":"LineString","coordinates":[[23.8561,49.2567],[24.0297,49.8397]]}'),4326),
        now()+interval '10 days',now()+interval '10 days 1 hour',78000,3600,'osrm',15000,1,1)`, [ids.journeyOffer, ids.driver, ids.vehicle]);
    await pool.query(`INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats)
      VALUES ($1,$2,$3,'Pickup point','Rendezvous destination',
        ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,
        ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
        ST_MakeLine(ST_SetSRID(ST_MakePoint(24.0,49.0),4326),ST_SetSRID(ST_MakePoint(25.0,50.0),4326)),
        now()+interval '5 minutes',now()+interval '65 minutes',78000,3600,'osrm',15000,2,2)`, [ids.rendezvousOffer, ids.driver, ids.vehicle]);
    await pool.query(`INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,departure_at,price_per_seat_minor,total_seats,available_seats)
      VALUES ($1,$2,$3,'Expired API Test Origin','Expired API Test Destination',
        ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,
        ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
        now()-interval '1 minute',15000,1,1)`, [ids.expiredOffer, ids.driver, ids.vehicle]);
  });

  after(async () => {
    if (otpUserId) await pool.query('DELETE FROM audit_events WHERE actor_id=$1', [otpUserId]);
    await pool.query('DELETE FROM vehicles WHERE owner_id IN (SELECT id FROM users WHERE phone_e164 LIKE $1)', [`+38099${process.pid}%`]);
    await pool.query('DELETE FROM users WHERE phone_e164 LIKE $1', [`+38099${process.pid}%`]);
    await pool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [[ids.driver, ...ids.passengers]]);
    await pool.query('DELETE FROM journeys WHERE user_id = ANY($1::uuid[])', [[ids.driver, ...ids.passengers]]);
    await pool.query('DELETE FROM verification_records WHERE user_id = ANY($1::uuid[]) OR id=ANY($2::uuid[])', [[ids.driver, ...ids.passengers, ids.admin], verificationIds]);
    await pool.query('DELETE FROM otp_challenges WHERE phone_e164 LIKE $1', [`+38099${process.pid}%`]);
    await pool.query("DELETE FROM audit_events WHERE actor_id = ANY($1::uuid[]) AND action IN ('vehicle.created','offer.created','demand.created','demand.cancelled','proposal.created','proposal.countered','proposal.agreed','proposal.accepted','user.blocked','user.unblocked','journey.leg.booked','journey.replanning')", [[ids.driver, ...ids.passengers]]);
    await pool.query("DELETE FROM audit_events WHERE entity_id=ANY($1::uuid[]) OR (actor_id=ANY($2::uuid[]) AND action LIKE 'moderation.%')", [moderationCaseIds, [passengerA, ids.admin]]);
    await pool.query('DELETE FROM moderation_cases WHERE id=ANY($1::uuid[])', [moderationCaseIds]);
    await pool.query('DELETE FROM realtime_outbox WHERE recipient_ids && $1::uuid[]', [[ids.driver, ...ids.passengers, ids.admin]]);
    await pool.query("DELETE FROM audit_events WHERE (actor_id=ANY($1::uuid[]) AND action LIKE 'verification.%') OR entity_id=ANY($2::uuid[])", [[ids.driver, ids.admin], verificationIds]);
    await pool.query('DELETE FROM audit_events WHERE entity_id IN (SELECT id FROM bookings WHERE offer_id IN (SELECT id FROM offers WHERE driver_id = $1)) OR entity_id = ANY($2::uuid[])',
      [ids.driver, [ids.vehicle, ...(apiCreatedVehicleId ? [apiCreatedVehicleId] : []), ...extraVehicleIds, ...verificationIds]]);
    await pool.query('DELETE FROM reviews WHERE booking_id IN (SELECT id FROM bookings WHERE offer_id IN (SELECT id FROM offers WHERE driver_id=$1))', [ids.driver]);
    await pool.query('DELETE FROM conversations WHERE booking_id IN (SELECT id FROM bookings WHERE offer_id IN (SELECT id FROM offers WHERE driver_id = $1))', [ids.driver]);
    await pool.query('DELETE FROM bookings WHERE offer_id IN (SELECT id FROM offers WHERE driver_id = $1)', [ids.driver]);
    await pool.query('DELETE FROM proposals WHERE driver_id=$1 OR demand_id IN (SELECT id FROM passenger_demands WHERE passenger_id=$2)', [ids.driver, passengerA]);
    await pool.query('DELETE FROM passenger_demands WHERE passenger_id=$1', [passengerA]);
    await pool.query('DELETE FROM offers WHERE driver_id = $1', [ids.driver]);
    await pool.query('DELETE FROM vehicles WHERE owner_id = $1', [ids.driver]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ids.driver, ...ids.passengers, ids.admin]]);
    await pool.end();
  });

  it('registers with development OTP, persists profile, and rotates refresh sessions', async () => {
    const capacitorHealth = await fetch(`${apiUrl}/healthz`, { headers: { origin: 'capacitor://localhost' } });
    assert.equal(capacitorHealth.headers.get('access-control-allow-origin'), 'capacitor://localhost');

    const phone = `+38099${process.pid}${crypto.randomInt(1000, 9999)}`;
    const requested = await fetch(`${apiUrl}/api/v1/auth/otp/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, displayName: 'OTP Integration User' }),
    });
    assert.equal(requested.status, 200);
    const requestBody = await requested.json() as { developmentCode?: string };
    assert.match(requestBody.developmentCode ?? '', /^\d{6}$/);
    const verified = await fetch(`${apiUrl}/api/v1/auth/otp/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, code: requestBody.developmentCode }),
    });
    assert.equal(verified.status, 200);
    const auth = await verified.json() as { data: { user: { id: string; roles: string[] }; accessToken: string } };
    assert.ok(auth.data.user.id);
    otpUserId = auth.data.user.id;
    assert.deepEqual(auth.data.user.roles, ['passenger']);
    const authHeaders = { authorization: `Bearer ${auth.data.accessToken}`, 'content-type': 'application/json' };
    const unavailableRoute = await fetch(`${apiUrl}/api/v1/routing/route`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ origin: [23.86, 49.25], destination: [24.03, 49.84] }),
    });
    assert.equal(unavailableRoute.status, 503);
    const invalidCanonicalRoute = await fetch(`${apiUrl}/api/v1/routing/calculate`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ origin: [23.86, 49.25], destination: [24.03, 49.84] }),
    });
    assert.equal(invalidCanonicalRoute.status, 400, 'canonical route endpoint runtime-validates its versioned request schema');
    const unavailableCanonicalRoute = await fetch(`${apiUrl}/api/v1/routing/calculate`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ origin: [23.86, 49.25], destination: [24.03, 49.84], profile: { mode: 'CAR' }, requestId: crypto.randomUUID() }),
    });
    assert.equal(unavailableCanonicalRoute.status, 503, 'canonical route endpoint fails gracefully when OSRM is not configured');
    const me = await fetch(`${apiUrl}/api/v1/users/me`, { headers: authHeaders });
    assert.equal(me.status, 200);
    const profile = await fetch(`${apiUrl}/api/v1/users/me`, {
      method: 'PATCH', headers: authHeaders, body: JSON.stringify({ email: 'otp-user@example.test' }),
    });
    assert.equal((await profile.json() as { data: { email: string } }).data.email, 'otp-user@example.test');
    const updatedName = await fetch(`${apiUrl}/api/v1/users/me`, {
      method: 'PATCH', headers: authHeaders, body: JSON.stringify({ displayName: 'Updated OTP User' }),
    });
    const updatedProfile = await updatedName.json() as { data: { email: string; display_name: string } };
    assert.equal(updatedProfile.data.email, 'otp-user@example.test');
    assert.equal(updatedProfile.data.display_name, 'Updated OTP User');

    const enabledDriver = await fetch(`${apiUrl}/api/v1/users/me/roles`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ role: 'driver' }),
    });
    const roleBody = await enabledDriver.json() as { data?: { roles: string[] }; error?: { message: string } };
    assert.equal(enabledDriver.status, 200, roleBody.error?.message);
    assert.deepEqual(roleBody.data?.roles, ['driver', 'passenger']);
    const ownCar = await fetch(`${apiUrl}/api/v1/vehicles`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ make: 'Test', model: 'OTP Car', modelYear: 2022, seats: 4 }),
    });
    assert.equal(ownCar.status, 201);
    const createdVehicle = await ownCar.json() as { data: { id: string } };
    const blockedUpload = await fetch(`${apiUrl}/api/v1/vehicles/${createdVehicle.data.id}/photos/upload-url`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ contentType: 'image/jpeg' }),
    });
    assert.equal(blockedUpload.status, 503);

    const verifyCookie = verified.headers.get('set-cookie');
    assert.ok(verifyCookie?.includes('mg_refresh='));
    const cookie = verifyCookie?.split(';')[0];
    const refreshed = await fetch(`${apiUrl}/api/v1/auth/refresh`, { method: 'POST', headers: { cookie: cookie ?? '' } });
    assert.equal(refreshed.status, 200);
    const rotatedCookie = refreshed.headers.get('set-cookie')?.split(';')[0];
    assert.ok(rotatedCookie && rotatedCookie !== cookie);
    const refreshBody = await refreshed.json() as { data: { accessToken: string } };
    const logout = await fetch(`${apiUrl}/api/v1/auth/logout-all`, {
      method: 'POST', headers: { authorization: `Bearer ${refreshBody.data.accessToken}` },
    });
    assert.equal(logout.status, 200);
    const oldRefresh = await fetch(`${apiUrl}/api/v1/auth/refresh`, { method: 'POST', headers: { cookie: rotatedCookie ?? '' } });
    assert.equal(oldRefresh.status, 401);
    const oldAccess = await fetch(`${apiUrl}/api/v1/users/me`, { headers: { authorization: `Bearer ${refreshBody.data.accessToken}` } });
    assert.equal(oldAccess.status, 401);
  });

  it('searches real Community offer snapshots and persists representative Journey alternatives', async () => {
    const body = {
      origin: { name: 'Journey Test Origin', coordinates: [23.8561, 49.2567] },
      destination: { name: 'Journey Test Destination', coordinates: [24.0297, 49.8397] },
      departureAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000 - 60_000).toISOString(),
      passengers: 1,
      strategy: 'CHEAPEST',
      preferences: { allowCommunity: true, maxPriceMinor: 20000 },
    };
    const unauthorized = await fetch(`${apiUrl}/api/v1/journeys/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${apiUrl}/api/v1/journeys/search`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { data: { partial: boolean; blockedProviders: string[]; journeys: Array<{ id: string; offerId: string; strategy: string; confirmedPriceMinor: number | null; totalPriceMinor: number; legs: Array<{ id: string; mode: string; priceStatus: string; availabilityStatus: string }> }> } };
    assert.equal(result.data.partial, true);
    assert.ok(result.data.blockedProviders.includes('bus'));
    assert.equal(result.data.journeys.length, 1);
    const [journey] = result.data.journeys;
    assert.equal(journey.offerId, ids.journeyOffer);
    assert.equal(journey.strategy, 'CHEAPEST');
    assert.equal(journey.confirmedPriceMinor, null);
    assert.equal(journey.totalPriceMinor, 15000);
    assert.deepEqual(journey.legs.map((leg) => [leg.mode, leg.priceStatus, leg.availabilityStatus]), [['COMMUNITY', 'ESTIMATED', 'AVAILABLE']]);
    const sourceOffer = await fetch(`${apiUrl}/api/v1/offers/${ids.journeyOffer}`);
    assert.equal(sourceOffer.status, 200);
    const offerDetails = await sourceOffer.json() as { data: { id: string; available_seats: number; driver_name: string; vehicle_photo_url: string | null } };
    assert.equal(offerDetails.data.id, ids.journeyOffer);
    assert.equal(offerDetails.data.available_seats, 1);
    assert.equal(offerDetails.data.driver_name, 'API test driver');
    assert.equal(offerDetails.data.vehicle_photo_url, null);
    assert.equal((await fetch(`${apiUrl}/api/v1/offers/not-a-uuid`)).status, 400);
    const stored = await pool.query<{ state: string; price_minor: number; offer_id: string }>(
      `SELECT j.state,l.price_minor,l.offer_id FROM journeys j JOIN journey_legs l ON l.journey_id=j.id WHERE j.id=$1 AND j.user_id=$2`, [journey.id, passengerA],
    );
    assert.deepEqual(stored.rows[0], { state: 'PLANNED', price_minor: 15000, offer_id: ids.journeyOffer });
    const history = await fetch(`${apiUrl}/api/v1/journeys/me`, { headers: { 'x-dev-user-id': passengerA } });
    assert.equal((await history.json() as { data: Array<{ id: string }> }).data[0].id, journey.id);
    const owned = await fetch(`${apiUrl}/api/v1/journeys/${journey.id}`, { headers: { 'x-dev-user-id': passengerA } });
    assert.equal(owned.status, 200);
    const privateJourney = await fetch(`${apiUrl}/api/v1/journeys/${journey.id}`, { headers: { 'x-dev-user-id': passengerB } });
    assert.equal(privateJourney.status, 404);

    const bookingKey = `journey-book-${crypto.randomUUID()}`;
    const linkedBookingResponse = await fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA, 'idempotency-key': bookingKey },
      body: JSON.stringify({ offerId: ids.journeyOffer, seats: 1, journeyId: journey.id, journeyLegId: journey.legs[0].id }),
    });
    assert.equal(linkedBookingResponse.status, 201);
    const linkedBooking = await linkedBookingResponse.json() as { data: { id: string; total_price_minor: number } };
    assert.equal(linkedBooking.data.total_price_minor, 15000);
    const readyJourney = await pool.query<{ state: string; confirmed_price_minor: number; leg_state: string; price_status: string; price_minor: number; booking_id: string }>(
      `SELECT j.state,j.confirmed_price_minor,l.state AS leg_state,l.price_status,l.price_minor,l.booking_id
         FROM journeys j JOIN journey_legs l ON l.journey_id=j.id WHERE j.id=$1`, [journey.id],
    );
    assert.deepEqual(readyJourney.rows[0], { state: 'READY', confirmed_price_minor: 15000, leg_state: 'CONFIRMED', price_status: 'LOCKED', price_minor: 15000, booking_id: linkedBooking.data.id });
    const bookingReplay = await fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA, 'idempotency-key': bookingKey },
      body: JSON.stringify({ offerId: ids.journeyOffer, seats: 1, journeyId: journey.id, journeyLegId: journey.legs[0].id }),
    });
    assert.equal(bookingReplay.status, 200);
    assert.equal((await bookingReplay.json() as { data: { id: string }; replayed: boolean }).data.id, linkedBooking.data.id);
    const mismatchedReplay = await fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA, 'idempotency-key': bookingKey },
      body: JSON.stringify({ offerId: ids.journeyOffer, seats: 1 }),
    });
    assert.equal(mismatchedReplay.status, 409);
    const cancelLinkedBooking = () => fetch(`${apiUrl}/api/v1/bookings/${linkedBooking.data.id}/cancel`, {
      method: 'POST', headers: { 'x-dev-user-id': passengerA },
    });
    assert.equal((await cancelLinkedBooking()).status, 200);
    assert.equal((await cancelLinkedBooking()).status, 200);
    const replanningJourney = await pool.query<{ state: string; total_price_minor: number | null; confirmed_price_minor: number | null; estimated_price_min_minor: number | null; estimated_price_max_minor: number | null; leg_state: string; booking_id: string }>(
      `SELECT j.state,j.total_price_minor,j.confirmed_price_minor,j.estimated_price_min_minor,j.estimated_price_max_minor,l.state AS leg_state,l.booking_id
         FROM journeys j JOIN journey_legs l ON l.journey_id=j.id WHERE j.id=$1`, [journey.id],
    );
    assert.deepEqual(replanningJourney.rows[0], { state: 'REPLANNING', total_price_minor: null, confirmed_price_minor: null, estimated_price_min_minor: null, estimated_price_max_minor: null, leg_state: 'CANCELLED', booking_id: linkedBooking.data.id });
    const journeyEvents = await pool.query<{ recipient_ids: string[]; payload: { state: string; journey_id: string } }>(
      `SELECT recipient_ids,payload FROM realtime_outbox WHERE event_type='journey.updated' AND payload->>'journey_id'=$1 ORDER BY created_at,id`, [journey.id],
    );
    assert.deepEqual(journeyEvents.rows.map(event => event.payload.state), ['READY','REPLANNING']);
    assert.ok(journeyEvents.rows.every(event => event.recipient_ids.length === 1 && event.recipient_ids[0] === passengerA));

    let persistedNotifications = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM user_notifications WHERE user_id=$1 AND (payload->>'journey_id'=$2 OR payload->>'booking_id'=$3)`,
        [passengerA, journey.id, linkedBooking.data.id],
      );
      persistedNotifications = Number(count.rows[0].count);
      if (persistedNotifications >= 4) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(persistedNotifications, 4, 'outbox delivery persists booking and Journey updates to the inbox');
    const inbox = await fetch(`${apiUrl}/api/v1/notifications?limit=1`, { headers: { 'x-dev-user-id': passengerA } });
    assert.equal(inbox.status, 200);
    const inboxBody = await inbox.json() as { data: { items: Array<{ id: string; title: string; body: string; payload: Record<string, unknown> }>; nextCursor: string | null; unreadCount: number } };
    assert.equal(inboxBody.data.items.length, 1);
    assert.ok(inboxBody.data.nextCursor);
    assert.equal(inboxBody.data.unreadCount, 4);
    const latestNotification = inboxBody.data.items[0];
    assert.equal(latestNotification.title, 'План маршруту оновлено');
    assert.equal(JSON.stringify(latestNotification).includes('phone'), false);
    assert.equal(JSON.stringify(latestNotification).includes('API test passenger'), false);
    const privateRead = await fetch(`${apiUrl}/api/v1/notifications/${latestNotification.id}/read`, {
      method: 'POST', headers: { 'x-dev-user-id': passengerB },
    });
    assert.equal(privateRead.status, 404);
    const markedRead = await fetch(`${apiUrl}/api/v1/notifications/${latestNotification.id}/read`, {
      method: 'POST', headers: { 'x-dev-user-id': passengerA },
    });
    assert.equal(markedRead.status, 200);
    const readAgain = await fetch(`${apiUrl}/api/v1/notifications/${latestNotification.id}/read`, {
      method: 'POST', headers: { 'x-dev-user-id': passengerA },
    });
    assert.equal(readAgain.status, 200);
    const unreadAfterRead = await fetch(`${apiUrl}/api/v1/notifications?limit=10`, { headers: { 'x-dev-user-id': passengerA } });
    const unreadData = await unreadAfterRead.json() as { data: { unreadCount: number } };
    assert.equal(unreadData.data.unreadCount, 3);

    const completionSearch = await fetch(`${apiUrl}/api/v1/journeys/search`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA },
      body: JSON.stringify({ origin: { name: 'Journey Test Origin', coordinates: [23.8561, 49.2567] },
        destination: { name: 'Journey Test Destination', coordinates: [24.0297, 49.8397] },
        departureAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000 - 60_000).toISOString(), passengers: 1, strategy: 'FASTEST' }),
    });
    assert.equal(completionSearch.status, 200);
    const completionJourney = (await completionSearch.json() as { data: { journeys: Array<{ id: string; legs: Array<{ id: string }> }> } }).data.journeys[0];
    const completionBookingResponse = await fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA, 'idempotency-key': `journey-complete-${crypto.randomUUID()}` },
      body: JSON.stringify({ offerId: ids.journeyOffer, seats: 1, journeyId: completionJourney.id, journeyLegId: completionJourney.legs[0].id }),
    });
    assert.equal(completionBookingResponse.status, 201);
    const completionBooking = (await completionBookingResponse.json() as { data: { id: string } }).data;
    const ticketResponse = await fetch(`${apiUrl}/api/v1/bookings/${completionBooking.id}/ticket`, { headers: { 'x-dev-user-id': ids.driver } });
    assert.equal(ticketResponse.status, 200);
    const ticket = (await ticketResponse.json() as { data: { token: string } }).data;
    const boarding = await fetch(`${apiUrl}/api/v1/bookings/${completionBooking.id}/boarding`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': ids.driver }, body: JSON.stringify({ ticket: ticket.token }),
    });
    assert.equal(boarding.status, 200);
    const start = await fetch(`${apiUrl}/api/v1/bookings/${completionBooking.id}/start`, { method: 'POST', headers: { 'x-dev-user-id': ids.driver } });
    assert.equal(start.status, 200);
    const activeJourney = await pool.query<{ journey_state: string; leg_state: string; started_at: Date | null }>(
      `SELECT j.state AS journey_state,l.state AS leg_state,j.started_at FROM journeys j JOIN journey_legs l ON l.journey_id=j.id WHERE j.id=$1`, [completionJourney.id],
    );
    assert.equal(activeJourney.rows[0].journey_state, 'ACTIVE');
    assert.equal(activeJourney.rows[0].leg_state, 'ACTIVE');
    assert.ok(activeJourney.rows[0].started_at);
    const firstCompletion = await fetch(`${apiUrl}/api/v1/bookings/${completionBooking.id}/complete`, { method: 'POST', headers: { 'x-dev-user-id': passengerA } });
    assert.equal((await firstCompletion.json() as { data: { confirmations: number } }).data.confirmations, 1);
    const secondCompletion = await fetch(`${apiUrl}/api/v1/bookings/${completionBooking.id}/complete`, { method: 'POST', headers: { 'x-dev-user-id': ids.driver } });
    assert.equal((await secondCompletion.json() as { data: { status: string } }).data.status, 'completed');
    const completedJourney = await pool.query<{ journey_state: string; leg_state: string; completed_at: Date | null; actual_arrival_at: Date | null }>(
      `SELECT j.state AS journey_state,l.state AS leg_state,j.completed_at,l.actual_arrival_at FROM journeys j JOIN journey_legs l ON l.journey_id=j.id WHERE j.id=$1`, [completionJourney.id],
    );
    assert.equal(completedJourney.rows[0].journey_state, 'COMPLETED');
    assert.equal(completedJourney.rows[0].leg_state, 'COMPLETED');
    assert.ok(completedJourney.rows[0].completed_at);
    assert.ok(completedJourney.rows[0].actual_arrival_at);
    const completionUpdates = await pool.query<{ state: string }>(
      `SELECT payload->>'state' AS state FROM realtime_outbox WHERE event_type='journey.updated'
       AND payload->>'journey_id'=$1 ORDER BY created_at,id`, [completionJourney.id],
    );
    assert.deepEqual(completionUpdates.rows.map((row) => row.state), ['READY','ACTIVE','COMPLETED']);

    const disabledCommunity = await fetch(`${apiUrl}/api/v1/journeys/search`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA },
      body: JSON.stringify({ ...body, preferences: { allowCommunity: false } }),
    });
    assert.equal((await disabledCommunity.json() as { data: { journeys: unknown[] } }).data.journeys.length, 0);
  });

  it('shares confirmed rendezvous locations ephemerally and requires both users to confirm arrival', async () => {
    const booked = await fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA, 'idempotency-key': `rendezvous-book-${crypto.randomUUID()}` },
      body: JSON.stringify({ offerId: ids.rendezvousOffer, seats: 1 }),
    });
    assert.equal(booked.status, 201);
    const booking = await booked.json() as { data: { id: string } };
    const passengerHeaders = { 'content-type': 'application/json', 'x-dev-user-id': passengerA };
    const driverHeaders = { 'content-type': 'application/json', 'x-dev-user-id': ids.driver };
    const outsider = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/rendezvous`, { headers: { 'x-dev-user-id': passengerB } });
    assert.equal(outsider.status, 404);

    const sessionResponse = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/rendezvous`, { headers: passengerHeaders });
    assert.equal(sessionResponse.status, 200);
    const initial = await sessionResponse.json() as { data: { id: string; state: string; locationSharingEnabled: boolean } };
    assert.equal(initial.data.state, 'SCHEDULED');
    assert.equal(initial.data.locationSharingEnabled, false);
    const prematureLocation = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/location`, {
      method: 'POST', headers: passengerHeaders,
      body: JSON.stringify({ longitude: 24, latitude: 49, accuracyMeters: 5, capturedAt: new Date().toISOString() }),
    });
    assert.equal(prematureLocation.status, 409);

    const activate = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/rendezvous/activate`, { method: 'POST', headers: driverHeaders });
    assert.equal(activate.status, 200);
    const active = await activate.json() as { data: { state: string; locationSharingEnabled: boolean } };
    assert.deepEqual({ state: active.data.state, sharing: active.data.locationSharingEnabled }, { state: 'ACTIVE', sharing: true });

    const capturedAt = new Date().toISOString();
    const location = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/location`, {
      method: 'POST', headers: passengerHeaders,
      body: JSON.stringify({ longitude: 24, latitude: 49, accuracyMeters: 5, capturedAt }),
    });
    assert.equal(location.status, 200);
    const locationBody = await location.json() as { data: { nearPickup: boolean; storedEphemerally: boolean } };
    assert.equal(locationBody.data.nearPickup, true);
    assert.equal(locationBody.data.storedEphemerally, true);
    const outOfOrder = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/location`, {
      method: 'POST', headers: passengerHeaders,
      body: JSON.stringify({ longitude: 24.01, latitude: 49.01, accuracyMeters: 5, capturedAt: new Date(Date.parse(capturedAt) - 1_000).toISOString() }),
    });
    assert.equal(outOfOrder.status, 409);
    const driverView = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/rendezvous`, { headers: driverHeaders });
    const driverState = await driverView.json() as { data: { locations: { passenger: { freshness: string; coordinates: number[] } | null } } };
    assert.deepEqual(driverState.data.locations.passenger?.coordinates, [24, 49]);
    assert.equal(driverState.data.locations.passenger?.freshness, 'LIVE');

    const driverArrived = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/status`, {
      method: 'POST', headers: driverHeaders, body: JSON.stringify({ action: 'arrived' }),
    });
    assert.equal(driverArrived.status, 200);
    assert.equal((await driverArrived.json() as { data: { state: string } }).data.state, 'DRIVER_WAITING');
    const passengerArrived = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/status`, {
      method: 'POST', headers: passengerHeaders, body: JSON.stringify({ action: 'arrived' }),
    });
    assert.equal(passengerArrived.status, 200);
    assert.equal((await passengerArrived.json() as { data: { state: string } }).data.state, 'BOTH_NEARBY');
    const boarding = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/boarding`, { method: 'POST', headers: driverHeaders });
    assert.equal(boarding.status, 200);
    assert.equal((await boarding.json() as { data: { state: string } }).data.state, 'BOARDING');
    const ended = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/end`, { method: 'POST', headers: passengerHeaders });
    assert.equal(ended.status, 200);
    const final = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/rendezvous`, { headers: passengerHeaders });
    const finalState = await final.json() as { data: { state: string; locationSharingEnabled: boolean; locations: { passenger: unknown } } };
    assert.equal(finalState.data.state, 'CANCELLED');
    assert.equal(finalState.data.locationSharingEnabled, false);
    assert.equal(finalState.data.locations.passenger, null);
    const persistedLocation = await pool.query("SELECT count(*)::int AS n FROM rendezvous_events WHERE metadata ? 'coordinates'");
    assert.equal(persistedLocation.rows[0].n, 0);
  });

  it('allows exactly one of 20 concurrent accounts to book the last seat and cancels idempotently', async () => {
    const anonymous = await fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(anonymous.status, 401);

    const book = (userId: string, key: string, seats = 1) => fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-user-id': userId, 'idempotency-key': key },
      body: JSON.stringify({ offerId: ids.offer, seats }),
    });
    const attempts = await Promise.all(ids.passengers.map((userId, index) => book(userId, keys[index])));
    assert.equal(attempts.filter((response) => response.status === 201).length, 1);
    assert.equal(attempts.filter((response) => response.status === 409).length, 19);
    const acceptedIndex = attempts.findIndex((response) => response.status === 201);
    const acceptedResponse = attempts[acceptedIndex];
    const acceptedUser = ids.passengers[acceptedIndex];
    const acceptedKey = keys[acceptedIndex];
    const accepted = await acceptedResponse.json() as { data: { id: string; total_price_minor: number; platform_fee_minor: number; fee_class: string; fee_rule_version: string } };
    assert.equal(accepted.data.total_price_minor, 15000);
    assert.deepEqual({ feeClass: accepted.data.fee_class, feeMinor: accepted.data.platform_fee_minor, rule: accepted.data.fee_rule_version },
      { feeClass: 'community', feeMinor: 0, rule: 'community-0pct-v1' });
    await assert.rejects(
      pool.query('UPDATE bookings SET platform_fee_minor = 1 WHERE id = $1', [accepted.data.id]),
      { code: '23514', message: /booking fee snapshot is immutable/ },
    );

    const replay = await book(acceptedUser, acceptedKey);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
    assert.equal((await book(acceptedUser, acceptedKey, 2)).status, 409);
    const beforeCancel = await pool.query<{ available_seats: number; booking_count: string }>(
      `SELECT o.available_seats, (SELECT count(*) FROM bookings b WHERE b.offer_id=o.id AND b.status='confirmed') AS booking_count
         FROM offers o WHERE o.id=$1`, [ids.offer],
    );
    assert.equal(beforeCancel.rows[0].available_seats, 0);
    assert.equal(Number(beforeCancel.rows[0].booking_count), 1);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cancelled = await fetch(`${apiUrl}/api/v1/bookings/${accepted.data.id}/cancel`, {
        method: 'POST', headers: { 'x-dev-user-id': acceptedUser },
      });
      assert.equal(cancelled.status, 200);
    }
    const { rows } = await pool.query('SELECT available_seats FROM offers WHERE id = $1', [ids.offer]);
    assert.equal(rows[0].available_seats, 1);
    const lifecycle = await pool.query<{ to_status: string; count: string }>(
      'SELECT to_status,count(*) FROM booking_events WHERE booking_id=$1 GROUP BY to_status', [accepted.data.id],
    );
    assert.deepEqual(Object.fromEntries(lifecycle.rows.map((row) => [row.to_status, Number(row.count)])), { confirmed: 1, cancelled: 1 });
  });

  it('rejects a new booking on a published offer after its departure without changing inventory', async () => {
    const response = await fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA, 'idempotency-key': `expired-${crypto.randomUUID()}` },
      body: JSON.stringify({ offerId: ids.expiredOffer, seats: 1 }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'offer_expired');
    const inventory = await pool.query<{ available_seats: number; booking_count: string }>(
      `SELECT o.available_seats,(SELECT count(*) FROM bookings b WHERE b.offer_id=o.id) AS booking_count
         FROM offers o WHERE o.id=$1`, [ids.expiredOffer],
    );
    assert.equal(inventory.rows[0].available_seats, 1);
    assert.equal(Number(inventory.rows[0].booking_count), 0);
  });

  it('allows the trip driver to cancel a confirmed booking once and denies nonparticipants', async () => {
    const bookingResponse = await fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerB, 'idempotency-key': `driver-cancel-book-${crypto.randomUUID()}` },
      body: JSON.stringify({ offerId: ids.offer, seats: 1 }),
    });
    assert.equal(bookingResponse.status, 201);
    const booking = await bookingResponse.json() as { data: { id: string } };
    const denied = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/cancel`, {
      method: 'POST', headers: { 'x-dev-user-id': ids.passengers[2] },
    });
    assert.equal(denied.status, 404);

    const cancelled = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/cancel`, {
      method: 'POST', headers: { 'x-dev-user-id': ids.driver },
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { replayed: boolean }).replayed, false);
    const repeated = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/cancel`, {
      method: 'POST', headers: { 'x-dev-user-id': ids.driver },
    });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json() as { replayed: boolean }).replayed, true);

    const inventory = await pool.query<{ available_seats: number; cancellation_events: string }>(
      `SELECT o.available_seats,(SELECT count(*) FROM booking_events e WHERE e.booking_id=$2 AND e.to_status='cancelled') AS cancellation_events
         FROM offers o WHERE o.id=$1`, [ids.offer, booking.data.id],
    );
    assert.equal(inventory.rows[0].available_seats, 1);
    assert.equal(Number(inventory.rows[0].cancellation_events), 1);
  });

  it('returns only current nearby MARSHGO rides with enough seats for a cancelled booking', async () => {
    const nearbyOfferId = crypto.randomUUID();
    const farOfferId = crypto.randomUUID();
    const noSeatsOfferId = crypto.randomUUID();
    await pool.query(`INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,departure_at,price_per_seat_minor,total_seats,available_seats)
      VALUES
      ($1,$2,$3,'Rescue Nearby Origin','Rescue Nearby Destination',
        ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
        now()+interval '10 days 30 minutes',22000,4,4),
      ($4,$2,$3,'Rescue Far Origin','Rescue Far Destination',
        ST_SetSRID(ST_MakePoint(27.0,52.0),4326)::geography,ST_SetSRID(ST_MakePoint(28.0,53.0),4326)::geography,
        now()+interval '10 days 30 minutes',18000,4,4),
      ($5,$2,$3,'Rescue Sold Out Origin','Rescue Sold Out Destination',
        ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
        now()+interval '10 days 30 minutes',16000,4,0)`, [nearbyOfferId, ids.driver, ids.vehicle, farOfferId, noSeatsOfferId]);
    const bookingResponse = await fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA, 'idempotency-key': `rescue-book-${crypto.randomUUID()}` },
      body: JSON.stringify({ offerId: ids.offer, seats: 1 }),
    });
    assert.equal(bookingResponse.status, 201);
    const booking = await bookingResponse.json() as { data: { id: string } };
    const activeRescue = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/rescue`, { headers: { 'x-dev-user-id': passengerA } });
    assert.equal(activeRescue.status, 409);

    const cancelled = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/cancel`, {
      method: 'POST', headers: { 'x-dev-user-id': passengerA },
    });
    assert.equal(cancelled.status, 200);
    const denied = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/rescue`, { headers: { 'x-dev-user-id': passengerB } });
    assert.equal(denied.status, 404);
    const rescueResponse = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/rescue`, { headers: { 'x-dev-user-id': passengerA } });
    assert.equal(rescueResponse.status, 200);
    const rescue = await rescueResponse.json() as { data: { booking_id: string; checked_at: string; radius_m: number; alternatives: Array<{ id: string; source: string; available_seats: number; origin_distance_m: number; destination_distance_m: number }> } };
    assert.equal(rescue.data.booking_id, booking.data.id);
    assert.ok(Number.isFinite(Date.parse(rescue.data.checked_at)));
    assert.equal(rescue.data.radius_m, 20_000);
    assert.deepEqual(rescue.data.alternatives.map(item => item.id), [nearbyOfferId]);
    assert.equal(rescue.data.alternatives[0].source, 'MARSHGO Community');
    assert.equal(rescue.data.alternatives[0].available_seats, 4);
    assert.equal(rescue.data.alternatives[0].origin_distance_m, 0);
    assert.equal(rescue.data.alternatives[0].destination_distance_m, 0);
  });

  it('accepts private safety reports only from booking participants and restricts staff review', async () => {
    const bookingResponse = await fetch(`${apiUrl}/api/v1/bookings`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA, 'idempotency-key': `report-${crypto.randomUUID()}` },
      body: JSON.stringify({ offerId: ids.offer, seats: 1 }),
    });
    assert.equal(bookingResponse.status, 201);
    const booking = await bookingResponse.json() as { data: { id: string } };
    const report = await fetch(`${apiUrl}/api/v1/reports`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA },
      body: JSON.stringify({ bookingId: booking.data.id, category: 'safety', details: 'Driver drove dangerously near the destination.' }),
    });
    assert.equal(report.status, 201);
    const reportBody = await report.json() as { data: { id: string; status: string } };
    moderationCaseIds.push(reportBody.data.id);
    assert.equal(reportBody.data.status, 'open');

    const repeated = await fetch(`${apiUrl}/api/v1/reports`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA },
      body: JSON.stringify({ bookingId: booking.data.id, category: 'safety', details: 'A second open report for the same booking.' }),
    });
    assert.equal(repeated.status, 409);
    const outsider = await fetch(`${apiUrl}/api/v1/reports`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerB },
      body: JSON.stringify({ bookingId: booking.data.id, category: 'other', details: 'I am not a participant here.' }),
    });
    assert.equal(outsider.status, 404);

    const forbiddenQueue = await fetch(`${apiUrl}/api/v1/admin/moderation?status=all`, { headers: { 'x-dev-user-id': passengerB } });
    assert.equal(forbiddenQueue.status, 403);
    const forbiddenRealtimeMetrics = await fetch(`${apiUrl}/api/v1/admin/ops/realtime`, { headers: { 'x-dev-user-id': passengerB } });
    assert.equal(forbiddenRealtimeMetrics.status, 403);
    const realtimeMetrics = await fetch(`${apiUrl}/api/v1/admin/ops/realtime`, { headers: { 'x-dev-user-id': ids.admin } });
    assert.equal(realtimeMetrics.status, 200);
    const realtimeBody = await realtimeMetrics.json() as { data: { pending_count: number; retrying_count: number; max_attempt_count: number; redis: string; last_error?: string } };
    assert.ok(realtimeBody.data.pending_count >= 0);
    assert.ok(realtimeBody.data.retrying_count >= 0);
    assert.ok(realtimeBody.data.max_attempt_count >= 0);
    assert.equal(typeof realtimeBody.data.redis, 'string');
    assert.equal('last_error' in realtimeBody.data, false, 'operational metrics must not expose raw provider errors');
    const queue = await fetch(`${apiUrl}/api/v1/admin/moderation?status=open`, { headers: { 'x-dev-user-id': ids.admin } });
    assert.equal(queue.status, 200);
    const queueBody = await queue.json() as { data: Array<{ id: string; reporter_name: string; reported_user_name: string }> };
    assert.equal(queueBody.data.some((item) => item.id === reportBody.data.id && item.reporter_name === 'API test passenger A' && item.reported_user_name === 'API test driver'), true);

    const startReview = await fetch(`${apiUrl}/api/v1/admin/moderation/${reportBody.data.id}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': ids.admin }, body: JSON.stringify({ status: 'in_review' }),
    });
    assert.equal(startReview.status, 200);
    const resolution = await fetch(`${apiUrl}/api/v1/admin/moderation/${reportBody.data.id}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': ids.admin },
      body: JSON.stringify({ status: 'resolved', action: 'no_action', note: 'Reviewed the report and documented follow-up.' }),
    });
    assert.equal(resolution.status, 200);
    const closedReport = await pool.query('SELECT status,resolution_action,resolved_at FROM moderation_cases WHERE id=$1', [reportBody.data.id]);
    assert.equal(closedReport.rows[0].status, 'resolved');
    assert.equal(closedReport.rows[0].resolution_action, 'no_action');
    assert.ok(closedReport.rows[0].resolved_at);
  });

  it('enforces driver role, vehicle ownership, and vehicle verification before publishing', async () => {
    const passengerVehicle = await fetch(`${apiUrl}/api/v1/vehicles`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA },
      body: JSON.stringify({ make: 'Toyota', model: 'Test', modelYear: 2024, seats: 4 }),
    });
    assert.equal(passengerVehicle.status, 403);

    const vehicleResponse = await fetch(`${apiUrl}/api/v1/vehicles`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': ids.driver },
      body: JSON.stringify({ make: 'Kia', model: 'Ceed', modelYear: 2022, seats: 3 }),
    });
    assert.equal(vehicleResponse.status, 201);
    const vehicle = await vehicleResponse.json() as { data: { id: string; verification_status: string; is_active: boolean } };
    apiCreatedVehicleId = vehicle.data.id;
    assert.equal(vehicle.data.verification_status, 'pending');
    assert.equal(vehicle.data.is_active, true);

    const forbiddenEdit = await fetch(`${apiUrl}/api/v1/vehicles/${apiCreatedVehicleId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA },
      body: JSON.stringify({ model: 'Hijacked' }),
    });
    assert.equal(forbiddenEdit.status, 403);
    const ownerEdit = await fetch(`${apiUrl}/api/v1/vehicles/${apiCreatedVehicleId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-dev-user-id': ids.driver },
      body: JSON.stringify({ model: 'Ceed Updated' }),
    });
    assert.equal((await ownerEdit.json() as { data: { model: string } }).data.model, 'Ceed Updated');

    const secondVehicle = await fetch(`${apiUrl}/api/v1/vehicles`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': ids.driver },
      body: JSON.stringify({ make: 'Skoda', model: 'Octavia', modelYear: 2023, seats: 4 }),
    });
    const second = await secondVehicle.json() as { data: { id: string; is_active: boolean } };
    extraVehicleIds.push(second.data.id);
    assert.equal(second.data.is_active, false);
    const activated = await fetch(`${apiUrl}/api/v1/vehicles/${second.data.id}/activate`, {
      method: 'POST', headers: { 'x-dev-user-id': ids.driver },
    });
    assert.equal((await activated.json() as { data: { is_active: boolean } }).data.is_active, true);
    const vehicleCount = await pool.query('SELECT count(*)::int AS active_count FROM vehicles WHERE owner_id=$1 AND is_active', [ids.driver]);
    assert.equal(vehicleCount.rows[0].active_count, 1);

    const offerPayload = {
      vehicleId: apiCreatedVehicleId,
      originName: 'API Publish Origin', destinationName: 'API Publish Destination',
      origin: [24.0, 49.0], destination: [25.0, 50.0],
      departureAt: new Date(Date.now() + 10 * 86400_000).toISOString(),
      pricePerSeatMinor: 15000, seats: 2,
    };
    const pendingOffer = await fetch(`${apiUrl}/api/v1/offers`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': ids.driver },
      body: JSON.stringify(offerPayload),
    });
    assert.equal(pendingOffer.status, 404);

    await pool.query("UPDATE vehicles SET verification_status = 'verified' WHERE id = $1", [apiCreatedVehicleId]);
    const missingPhoto = await fetch(`${apiUrl}/api/v1/offers`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': ids.driver },
      body: JSON.stringify(offerPayload),
    });
    assert.equal(missingPhoto.status, 409);
    await pool.query('INSERT INTO vehicle_photos(vehicle_id,object_key,is_primary) VALUES ($1,$2,true)', [apiCreatedVehicleId, `vehicle-photos/test/${apiCreatedVehicleId}/fixture`]);
    const published = await fetch(`${apiUrl}/api/v1/offers`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': ids.driver },
      body: JSON.stringify(offerPayload),
    });
    assert.equal(published.status, 201);
    const response = await published.json() as { data: { id: string; available_seats: number; route_source: string } };
    assert.equal(response.data.available_seats, 2);
    assert.equal(response.data.route_source, 'development_unrouted');
    const myOffers = await fetch(`${apiUrl}/api/v1/offers/mine`, { headers: { 'x-dev-user-id': ids.driver } });
    assert.equal(myOffers.status, 200);
    assert.equal((await myOffers.json() as { data: Array<{ id: string; status: string }> }).data.some((offer) => offer.id === response.data.id && offer.status === 'published'), true);
    const otherUsersOffers = await fetch(`${apiUrl}/api/v1/offers/mine`, { headers: { 'x-dev-user-id': passengerA } });
    assert.equal(otherUsersOffers.status, 403);
    const localDepartureDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date(offerPayload.departureAt));
    const found = await fetch(`${apiUrl}/api/v1/offers?origin=API%20Publish%20Origin&destination=API%20Publish%20Destination&date=${localDepartureDate}&seats=2`);
    assert.equal(found.status, 200);
    const foundOffers = (await found.json() as { data: Array<{ id: string; vehicle_photo_key?: string; vehicle_photo_url: string | null }> }).data;
    assert.equal(foundOffers.some((offer) => offer.id === response.data.id), true);
    const foundOffer = foundOffers.find((offer) => offer.id === response.data.id);
    assert.equal(foundOffer?.vehicle_photo_key, undefined);
    assert.equal(foundOffer?.vehicle_photo_url, null);
    const geoFound = await fetch(`${apiUrl}/api/v1/offers?origin=Стрий&destination=Львів&date=${localDepartureDate}&seats=2&originLon=24.02&originLat=49.02&destinationLon=25.01&destinationLat=50.01`);
    assert.equal(geoFound.status, 200);
    assert.equal((await geoFound.json() as { data: Array<{ id: string }> }).data.some((offer) => offer.id === response.data.id), true);
    const geoMiss = await fetch(`${apiUrl}/api/v1/offers?origin=Стрий&destination=Львів&date=${localDepartureDate}&seats=2&originLon=23&originLat=48&destinationLon=25.01&destinationLat=50.01`);
    assert.equal((await geoMiss.json() as { data: Array<{ id: string }> }).data.some((offer) => offer.id === response.data.id), false);
    const partialGeo = await fetch(`${apiUrl}/api/v1/offers?origin=Стрий&destination=Львів&originLon=24&originLat=49`);
    assert.equal(partialGeo.status, 400);
    const tooMany = await fetch(`${apiUrl}/api/v1/offers?origin=API%20Publish%20Origin&destination=API%20Publish%20Destination&date=${localDepartureDate}&seats=5`);
    assert.equal((await tooMany.json() as { data: unknown[] }).data.length, 0);
  });

  it('keeps verification evidence staff-only and updates a vehicle only after both approvals', async () => {
    assert.ok(apiCreatedVehicleId);
    const vehicleRecord = crypto.randomUUID();
    const licenseRecord = crypto.randomUUID();
    verificationIds.push(vehicleRecord, licenseRecord);
    await pool.query(
      `INSERT INTO verification_records(id,user_id,vehicle_id,verification_type,evidence_ref)
       VALUES ($1,$2,$3,'vehicle','verification-evidence/test/registration.pdf'),
              ($4,$2,$3,'driver_license','verification-evidence/test/license.pdf')`,
      [vehicleRecord, ids.driver, apiCreatedVehicleId, licenseRecord],
    );

    const anonymousQueue = await fetch(`${apiUrl}/api/v1/admin/verification`);
    assert.equal(anonymousQueue.status, 401);
    const driverHeaders = { 'content-type': 'application/json', 'x-dev-user-id': ids.driver };
    const passengerQueue = await fetch(`${apiUrl}/api/v1/admin/verification`, { headers: { 'x-dev-user-id': passengerA } });
    assert.equal(passengerQueue.status, 403);
    const selfUpload = await fetch(`${apiUrl}/api/v1/vehicles/${apiCreatedVehicleId}/verification/evidence/upload-url`, {
      method: 'POST', headers: { ...driverHeaders, 'x-dev-user-id': passengerA },
      body: JSON.stringify({ contentType: 'application/pdf' }),
    });
    assert.equal(selfUpload.status, 403);
    const storageUnavailable = await fetch(`${apiUrl}/api/v1/vehicles/${apiCreatedVehicleId}/verification/evidence/upload-url`, {
      method: 'POST', headers: driverHeaders, body: JSON.stringify({ contentType: 'application/pdf' }),
    });
    assert.equal(storageUnavailable.status, 503);

    const staffHeaders = { 'content-type': 'application/json', 'x-dev-user-id': ids.admin };
    const queueResponse = await fetch(`${apiUrl}/api/v1/admin/verification`, { headers: staffHeaders });
    assert.equal(queueResponse.status, 200);
    const queue = await queueResponse.json() as { data: Array<{ id: string; evidence_ref?: string; phone_e164?: string }> };
    const expectedRecords = new Set<string>([vehicleRecord, licenseRecord]);
    assert.equal(queue.data.filter((item) => expectedRecords.has(item.id)).length, 2);
    assert.equal(queue.data.some((item) => item.evidence_ref !== undefined), false);
    assert.equal(queue.data.some((item) => item.phone_e164 !== undefined), false);

    const forbiddenEvidence = await fetch(`${apiUrl}/api/v1/admin/verification/${vehicleRecord}/evidence`, { headers: { 'x-dev-user-id': passengerA } });
    assert.equal(forbiddenEvidence.status, 403);
    const unconfiguredEvidence = await fetch(`${apiUrl}/api/v1/admin/verification/${vehicleRecord}/evidence`, { headers: staffHeaders });
    assert.equal(unconfiguredEvidence.status, 503);

    const decide = (id: string) => fetch(`${apiUrl}/api/v1/admin/verification/${id}/decision`, {
      method: 'POST', headers: staffHeaders, body: JSON.stringify({ decision: 'approved' }),
    });
    const unopenedDecision = await decide(vehicleRecord);
    assert.equal(unopenedDecision.status, 409);
    await pool.query('UPDATE verification_records SET evidence_accessed_at=now() WHERE id=ANY($1::uuid[])', [[vehicleRecord, licenseRecord]]);

    const vehicleApproval = await decide(vehicleRecord);
    assert.equal(vehicleApproval.status, 200);
    const stillPending = await pool.query('SELECT verification_status FROM vehicles WHERE id=$1', [apiCreatedVehicleId]);
    assert.equal(stillPending.rows[0].verification_status, 'pending');
    const licenseApproval = await decide(licenseRecord);
    assert.equal(licenseApproval.status, 200);
    const verifiedVehicle = await pool.query('SELECT verification_status FROM vehicles WHERE id=$1', [apiCreatedVehicleId]);
    assert.equal(verifiedVehicle.rows[0].verification_status, 'verified');
    const verifiedDriver = await pool.query('SELECT verification_level,profile_status FROM driver_profiles WHERE user_id=$1', [ids.driver]);
    assert.deepEqual(verifiedDriver.rows[0], { verification_level: 'identity', profile_status: 'active' });
    assert.equal((await decide(vehicleRecord)).status, 409);

    const rejectedVehicleRecord = crypto.randomUUID();
    const rejectedLicenseRecord = crypto.randomUUID();
    verificationIds.push(rejectedVehicleRecord, rejectedLicenseRecord);
    await pool.query(
      `INSERT INTO verification_records(id,user_id,vehicle_id,verification_type,evidence_ref)
       VALUES ($1,$2,$3,'vehicle','verification-evidence/test/replacement-registration.pdf'),
              ($4,$2,$3,'driver_license','verification-evidence/test/replacement-license.pdf')`,
      [rejectedVehicleRecord, ids.driver, apiCreatedVehicleId, rejectedLicenseRecord],
    );
    await pool.query('UPDATE verification_records SET evidence_accessed_at=now() WHERE id=$1', [rejectedVehicleRecord]);
    const rejected = await fetch(`${apiUrl}/api/v1/admin/verification/${rejectedVehicleRecord}/decision`, {
      method: 'POST', headers: staffHeaders, body: JSON.stringify({ decision: 'rejected', note: 'Document is unreadable' }),
    });
    assert.equal(rejected.status, 200);
    const rejectionState = await pool.query('SELECT status FROM verification_records WHERE id=ANY($1::uuid[]) ORDER BY id', [[rejectedVehicleRecord, rejectedLicenseRecord]]);
    assert.deepEqual(rejectionState.rows.map((row) => row.status), ['rejected', 'rejected']);
    const rejectedVehicle = await pool.query('SELECT verification_status FROM vehicles WHERE id=$1', [apiCreatedVehicleId]);
    assert.equal(rejectedVehicle.rows[0].verification_status, 'rejected');
    const ownerVerificationResponse = await fetch(`${apiUrl}/api/v1/users/me/verification`, { headers: { 'x-dev-user-id': ids.driver } });
    assert.equal(ownerVerificationResponse.status, 200);
    const ownerVerification = await ownerVerificationResponse.json() as { data: Array<{ id: string; vehicle_id: string; status: string; review_note: string | null }> };
    const ownerRejectedRecord = ownerVerification.data.find((record) => record.id === rejectedVehicleRecord);
    assert.deepEqual(ownerRejectedRecord && {
      id: ownerRejectedRecord.id,
      vehicle_id: ownerRejectedRecord.vehicle_id,
      status: ownerRejectedRecord.status,
      review_note: ownerRejectedRecord.review_note,
    }, {
      id: rejectedVehicleRecord,
      vehicle_id: apiCreatedVehicleId,
      status: 'rejected',
      review_note: 'Document is unreadable',
    });
    const unrelatedUserVerification = await fetch(`${apiUrl}/api/v1/users/me/verification`, { headers: { 'x-dev-user-id': passengerA } });
    assert.equal((await unrelatedUserVerification.json() as { data: unknown[] }).data.length, 0);
    // This shared fixture is used by the next negotiation test; restore its verified state after asserting rejection behavior.
    await pool.query("UPDATE vehicles SET verification_status='verified' WHERE id=$1", [apiCreatedVehicleId]);
  });

  it('keeps negotiation history and atomically converts an accepted proposal into a booking', async () => {
    assert.ok(apiCreatedVehicleId);
    const headers = (userId: string) => ({ 'content-type': 'application/json', 'x-dev-user-id': userId });
    const now = Date.now();
    const earliest = new Date(now + 9 * 86400_000);
    const latest = new Date(now + 10 * 86400_000);
    const demandResponse = await fetch(`${apiUrl}/api/v1/demands`, {
      method: 'POST', headers: headers(passengerA),
      body: JSON.stringify({
        originName: 'Reverse Origin', destinationName: 'Reverse Destination',
        origin: [23.86, 49.25], destination: [24.03, 49.84],
        earliestDeparture: earliest.toISOString(), latestDeparture: latest.toISOString(), passengers: 2, budgetMinor: 16000,
        budgetType: 'total_all', notes: 'One suitcase', requirements: { luggage: true },
      }),
    });
    assert.equal(demandResponse.status, 201);
    const demand = await demandResponse.json() as { data: { id: string; status: string; budget_type: string; notes: string; requirements: { luggage: boolean } } };
    assert.equal(demand.data.budget_type, 'total_all');
    assert.equal(demand.data.notes, 'One suitcase');
    assert.equal(demand.data.requirements.luggage, true);

    const blocked = await fetch(`${apiUrl}/api/v1/users/${ids.driver}/block`, { method: 'POST', headers: headers(passengerA) });
    assert.equal(blocked.status, 204);
    const blocks = await fetch(`${apiUrl}/api/v1/users/me/blocks`, { headers: headers(passengerA) });
    assert.equal((await blocks.json() as { data: Array<{ user_id: string }> }).data[0]?.user_id, ids.driver);
    const blockedProposal = await fetch(`${apiUrl}/api/v1/demands/${demand.data.id}/proposals`, {
      method: 'POST', headers: headers(ids.driver),
      body: JSON.stringify({ vehicleId: apiCreatedVehicleId, priceMinor: 17000, departureAt: earliest.toISOString() }),
    });
    assert.equal(blockedProposal.status, 404);
    const unblocked = await fetch(`${apiUrl}/api/v1/users/${ids.driver}/block`, { method: 'DELETE', headers: headers(passengerA) });
    assert.equal(unblocked.status, 204);

    const ownDemands = await fetch(`${apiUrl}/api/v1/demands/mine`, { headers: headers(passengerA) });
    assert.equal(ownDemands.status, 200);
    assert.equal((await ownDemands.json() as { data: Array<{ id: string; proposal_count: number }> }).data.find((item) => item.id === demand.data.id)?.proposal_count, 0);

    const driverDemands = await fetch(`${apiUrl}/api/v1/demands`, { headers: headers(ids.driver) });
    assert.equal((await driverDemands.json() as { data: Array<{ id: string }> }).data.some((item) => item.id === demand.data.id), true);
    const directDemand = await fetch(`${apiUrl}/api/v1/demands/${demand.data.id}`, { headers: headers(ids.driver) });
    assert.equal(directDemand.status, 200);
    assert.equal((await directDemand.json() as { data: { id: string } }).data.id, demand.data.id);
    const unrelatedDemand = await fetch(`${apiUrl}/api/v1/demands/${demand.data.id}`, { headers: headers(passengerB) });
    assert.equal(unrelatedDemand.status, 403);
    const noProposals = await fetch(`${apiUrl}/api/v1/demands/${demand.data.id}/proposals`, { headers: headers(ids.driver) });
    assert.equal(noProposals.status, 200);
    assert.deepEqual((await noProposals.json() as { data: unknown[] }).data, []);

    const proposalResponse = await fetch(`${apiUrl}/api/v1/demands/${demand.data.id}/proposals`, {
      method: 'POST', headers: headers(ids.driver),
      body: JSON.stringify({ vehicleId: apiCreatedVehicleId, priceMinor: 17000, departureAt: earliest.toISOString(), comment: 'Can take two passengers' }),
    });
    assert.equal(proposalResponse.status, 201);
    const proposal = await proposalResponse.json() as { data: { id: string; demand_id: string } };

    const sameActorCounter = await fetch(`${apiUrl}/api/v1/proposals/${proposal.data.id}/counter`, {
      method: 'POST', headers: headers(ids.driver),
      body: JSON.stringify({ priceMinor: 16000, departureAt: earliest.toISOString() }),
    });
    assert.equal(sameActorCounter.status, 409);

    const counter = await fetch(`${apiUrl}/api/v1/proposals/${proposal.data.id}/counter`, {
      method: 'POST', headers: headers(passengerA),
      body: JSON.stringify({ priceMinor: 15000, departureAt: earliest.toISOString(), comment: 'Agreed at this price' }),
    });
    assert.equal(counter.status, 200);
    const prematureAccept = await fetch(`${apiUrl}/api/v1/proposals/${proposal.data.id}/accept`, {
      method: 'POST', headers: headers(passengerA),
    });
    assert.equal(prematureAccept.status, 409);
    const agreedByDriver = await fetch(`${apiUrl}/api/v1/proposals/${proposal.data.id}/agree`, {
      method: 'POST', headers: headers(ids.driver),
    });
    assert.equal(agreedByDriver.status, 200);
    const revisions = await fetch(`${apiUrl}/api/v1/proposals/${proposal.data.id}/revisions`, {
      headers: headers(ids.driver),
    });
    const proposalHistory = await revisions.json() as { data: Array<{ actor_role: string; price_minor: number }> };
    assert.equal(proposalHistory.data.length, 3);
    assert.equal(proposalHistory.data[2].actor_role, 'driver');
    assert.equal(proposalHistory.data[2].price_minor, 15000);

    const accepted = await fetch(`${apiUrl}/api/v1/proposals/${proposal.data.id}/accept`, {
      method: 'POST', headers: headers(passengerA),
    });
    assert.equal(accepted.status, 201);
    const booking = await accepted.json() as { data: { id: string; total_price_minor: number; seat_count: number; platform_fee_minor: number; fee_class: string; fee_rule_version: string }; agreedTotalMinor: number };
    assert.equal(booking.data.total_price_minor, 15000);
    assert.equal(booking.data.seat_count, 2);
    assert.deepEqual({ feeClass: booking.data.fee_class, feeMinor: booking.data.platform_fee_minor, rule: booking.data.fee_rule_version },
      { feeClass: 'community', feeMinor: 0, rule: 'community-0pct-v1' });
    assert.equal(booking.agreedTotalMinor, 15000);
    const negotiationEvents = await pool.query<{ event_type: string; recipient_ids: string[]; payload: { proposal_id?: string } }>(
      `SELECT event_type,recipient_ids,payload FROM realtime_outbox
        WHERE dedupe_key LIKE $1 ORDER BY created_at,id`, [`%:${proposal.data.id}%`],
    );
    assert.deepEqual(negotiationEvents.rows.map((event) => event.event_type).sort(), ['proposal.accepted','proposal.countered','proposal.created','proposal.updated'].sort());
    assert.ok(negotiationEvents.rows.every((event) => event.recipient_ids.includes(passengerA) && event.recipient_ids.includes(ids.driver)));
    assert.ok(negotiationEvents.rows.every((event) => event.payload.proposal_id === proposal.data.id));

    const raceDemandResponse = await fetch(`${apiUrl}/api/v1/demands`, {
      method: 'POST', headers: headers(passengerA),
      body: JSON.stringify({
        originName: 'Acceptance Race Origin', destinationName: 'Acceptance Race Destination',
        origin: [23.86, 49.25], destination: [24.03, 49.84],
        earliestDeparture: earliest.toISOString(), latestDeparture: latest.toISOString(), passengers: 1,
      }),
    });
    assert.equal(raceDemandResponse.status, 201);
    const raceDemand = await raceDemandResponse.json() as { data: { id: string } };
    const competingProposalIds: string[] = [];
    for (const priceMinor of [8000, 9000]) {
      const competingProposalResponse: Response = await fetch(`${apiUrl}/api/v1/demands/${raceDemand.data.id}/proposals`, {
        method: 'POST', headers: headers(ids.driver),
        body: JSON.stringify({ vehicleId: apiCreatedVehicleId, priceMinor, departureAt: earliest.toISOString() }),
      });
      assert.equal(competingProposalResponse.status, 201);
      competingProposalIds.push((await competingProposalResponse.json() as { data: { id: string } }).data.id);
    }
    const simultaneousAccepts = await Promise.all(competingProposalIds.map(proposalId => fetch(`${apiUrl}/api/v1/proposals/${proposalId}/accept`, {
      method: 'POST', headers: headers(passengerA),
    })));
    assert.deepEqual(simultaneousAccepts.map(response => response.status).sort(), [201, 409]);
    const raceState = await pool.query<{ demand_status: string; accepted_count: string; rejected_count: string; booking_count: string }>(
      `SELECT d.status AS demand_status,
              (SELECT count(*) FROM proposals p WHERE p.demand_id=d.id AND p.status='accepted') AS accepted_count,
              (SELECT count(*) FROM proposals p WHERE p.demand_id=d.id AND p.status='rejected') AS rejected_count,
              (SELECT count(*) FROM bookings b JOIN offers o ON o.id=b.offer_id
                WHERE o.origin_name=d.origin_name AND o.destination_name=d.destination_name AND o.driver_id=$2) AS booking_count
         FROM passenger_demands d WHERE d.id=$1`, [raceDemand.data.id, ids.driver],
    );
    assert.deepEqual(raceState.rows[0], { demand_status: 'matched', accepted_count: '1', rejected_count: '1', booking_count: '1' });

    const cancellationDemand = await fetch(`${apiUrl}/api/v1/demands`, {
      method: 'POST', headers: headers(passengerA),
      body: JSON.stringify({
        originName: 'Cancel Origin', destinationName: 'Cancel Destination', origin: [23.86, 49.25], destination: [24.03, 49.84],
        earliestDeparture: earliest.toISOString(), latestDeparture: latest.toISOString(), passengers: 1,
      }),
    });
    const cancellationDemandId = (await cancellationDemand.json() as { data: { id: string } }).data.id;
    const cancellationProposalResponse = await fetch(`${apiUrl}/api/v1/demands/${cancellationDemandId}/proposals`, {
      method: 'POST', headers: headers(ids.driver),
      body: JSON.stringify({ vehicleId: apiCreatedVehicleId, priceMinor: 11000, departureAt: earliest.toISOString() }),
    });
    assert.equal(cancellationProposalResponse.status, 201);
    const cancellationProposal = await cancellationProposalResponse.json() as { data: { id: string } };
    const cancelled = await fetch(`${apiUrl}/api/v1/demands/${cancellationDemandId}/cancel`, { method: 'POST', headers: headers(passengerA) });
    assert.equal((await cancelled.json() as { data: { status: string } }).data.status, 'cancelled');
    const closedProposal = await pool.query<{ status: string }>('SELECT status FROM proposals WHERE id=$1', [cancellationProposal.data.id]);
    assert.equal(closedProposal.rows[0].status, 'rejected');
    const cancelledProposalEvent = await pool.query<{ event_type: string; recipient_ids: string[]; payload: { reason: string } }>(
      'SELECT event_type,recipient_ids,payload FROM realtime_outbox WHERE dedupe_key=$1', [`proposal.closed:${cancellationProposal.data.id}:demand_cancelled`],
    );
    assert.equal(cancelledProposalEvent.rows[0].event_type, 'proposal.closed');
    assert.equal(cancelledProposalEvent.rows[0].payload.reason, 'demand_cancelled');
    assert.deepEqual(new Set(cancelledProposalEvent.rows[0].recipient_ids), new Set([ids.driver, passengerA]));
    const cancelledAgain = await fetch(`${apiUrl}/api/v1/demands/${cancellationDemandId}/cancel`, { method: 'POST', headers: headers(passengerA) });
    assert.equal((await cancelledAgain.json() as { replayed: boolean }).replayed, true);

    const ticketResponse = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/ticket`, { headers: headers(ids.driver) });
    assert.equal(ticketResponse.status, 200);
    const ticket = await ticketResponse.json() as { data: { token: string } };
    const invalidTicket = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/boarding`, {
      method: 'POST', headers: headers(ids.driver), body: JSON.stringify({ ticket: 'bad.signature' }),
    });
    assert.equal(invalidTicket.status, 400);
    const wrongBoarding = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/boarding`, {
      method: 'POST', headers: headers(passengerA), body: JSON.stringify({ ticket: ticket.data.token }),
    });
    assert.equal(wrongBoarding.status, 404);
    const boarding = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/boarding`, {
      method: 'POST', headers: headers(ids.driver), body: JSON.stringify({ ticket: ticket.data.token }),
    });
    assert.equal((await boarding.json() as { data: { status: string } }).data.status, 'boarding');
    const passengerStart = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/start`, {
      method: 'POST', headers: headers(passengerA),
    });
    assert.equal(passengerStart.status, 404);
    const started = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/start`, {
      method: 'POST', headers: headers(ids.driver),
    });
    assert.equal((await started.json() as { data: { status: string } }).data.status, 'in_progress');
    const earlyReview = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/reviews`, {
      method: 'POST', headers: headers(passengerA), body: JSON.stringify({ rating: 5 }),
    });
    assert.equal(earlyReview.status, 409);
    const firstCompletion = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/complete`, {
      method: 'POST', headers: headers(passengerA),
    });
    assert.deepEqual((await firstCompletion.json() as { data: { status: string; confirmations: number } }).data, {
      id: booking.data.id, status: 'in_progress', confirmations: 1, requiredConfirmations: 2,
    });
    const secondCompletion = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/complete`, {
      method: 'POST', headers: headers(ids.driver),
    });
    assert.equal((await secondCompletion.json() as { data: { status: string } }).data.status, 'completed');
    const passengerReview = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/reviews`, {
      method: 'POST', headers: headers(passengerA), body: JSON.stringify({ rating: 5, comment: 'Доїхали вчасно.' }),
    });
    assert.equal(passengerReview.status, 201);
    const driverReview = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/reviews`, {
      method: 'POST', headers: headers(ids.driver), body: JSON.stringify({ rating: 4 }),
    });
    assert.equal(driverReview.status, 201);
    const duplicateReview = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/reviews`, {
      method: 'POST', headers: headers(passengerA), body: JSON.stringify({ rating: 1 }),
    });
    assert.equal(duplicateReview.status, 409);
    const offerDate = new Date(Date.now() + 10 * 86400_000);
    const localOfferDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(offerDate);
    const ratedOffers = await fetch(`${apiUrl}/api/v1/offers?origin=API%20Publish%20Origin&destination=API%20Publish%20Destination&date=${localOfferDate}&seats=2`);
    const rated = (await ratedOffers.json() as { data: Array<{ average_rating: string | number; review_count: number }> }).data[0];
    assert.equal(Number(rated.average_rating), 5);
    assert.equal(rated.review_count, 1);
    const bookingEvents = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/events`, { headers: headers(ids.driver) });
    assert.deepEqual((await bookingEvents.json() as { data: Array<{ to_status: string }> }).data.map((event) => event.to_status), [
      'confirmed', 'boarding', 'in_progress', 'completed',
    ]);

    const duplicateAccept = await fetch(`${apiUrl}/api/v1/proposals/${proposal.data.id}/accept`, {
      method: 'POST', headers: headers(passengerA),
    });
    assert.equal(duplicateAccept.status, 409);
    const matchedDemandReload = await fetch(`${apiUrl}/api/v1/demands/${proposal.data.demand_id}`, { headers: headers(ids.driver) });
    assert.equal(matchedDemandReload.status, 200);
    assert.equal((await matchedDemandReload.json() as { data: { id: string; status: string } }).data.status, 'matched');

    const conversationResponse = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/conversation`, {
      headers: headers(ids.driver),
    });
    assert.equal(conversationResponse.status, 200);
    const conversation = await conversationResponse.json() as { data: { id: string } };
    const conversationById = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}`, { headers: headers(passengerA) });
    assert.equal(conversationById.status, 200);
    assert.equal((await conversationById.json() as { data: { booking_id: string } }).data.booking_id, booking.data.id);
    const unrelatedConversation = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}`, { headers: headers(passengerB) });
    assert.equal(unrelatedConversation.status, 404);
    const message = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}/messages`, {
      method: 'POST', headers: headers(passengerA), body: JSON.stringify({ body: 'Підтверджую час виїзду.' }),
    });
    assert.equal(message.status, 201);
    const history = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}/messages`, {
      headers: headers(ids.driver),
    });
    assert.equal((await history.json() as { data: Array<{ body: string }> }).data[0].body, 'Підтверджую час виїзду.');
    const outside = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}/messages`, {
      method: 'POST', headers: headers(passengerB), body: JSON.stringify({ body: 'I should not see this.' }),
    });
    assert.equal(outside.status, 404);
    const blockAfterBooking = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/block-other`, { method: 'POST', headers: headers(passengerA) });
    assert.equal(blockAfterBooking.status, 204);
    const blockedHistory = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}/messages`, { headers: headers(ids.driver) });
    assert.equal(blockedHistory.status, 404);
    const blockedChatSend = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}/messages`, {
      method: 'POST', headers: headers(ids.driver), body: JSON.stringify({ body: 'blocked chat should fail' }),
    });
    assert.equal(blockedChatSend.status, 404);
    const finalUnblock = await fetch(`${apiUrl}/api/v1/users/${ids.driver}/block`, { method: 'DELETE', headers: headers(passengerA) });
    assert.equal(finalUnblock.status, 204);

    const expiryDemandResponse = await fetch(`${apiUrl}/api/v1/demands`, {
      method: 'POST', headers: headers(passengerA),
      body: JSON.stringify({
        originName: 'Expiry Origin', destinationName: 'Expiry Destination', origin: [23.86, 49.25], destination: [24.03, 49.84],
        earliestDeparture: earliest.toISOString(), latestDeparture: latest.toISOString(), passengers: 1,
      }),
    });
    assert.equal(expiryDemandResponse.status, 201);
    const expiryDemandId = (await expiryDemandResponse.json() as { data: { id: string } }).data.id;
    const expiryProposalResponse = await fetch(`${apiUrl}/api/v1/demands/${expiryDemandId}/proposals`, {
      method: 'POST', headers: headers(ids.driver),
      body: JSON.stringify({ vehicleId: apiCreatedVehicleId, priceMinor: 12000, departureAt: earliest.toISOString() }),
    });
    assert.equal(expiryProposalResponse.status, 201);
    const expiryProposalId = (await expiryProposalResponse.json() as { data: { id: string } }).data.id;
    await pool.query('UPDATE proposals SET expires_at=now()-interval \'1 second\' WHERE id=$1', [expiryProposalId]);
    await expireDueProposals(pool, async (client, proposal) => {
      await client.query(
        `INSERT INTO realtime_outbox(event_type,dedupe_key,recipient_ids,payload,created_at)
         VALUES('proposal.expired',$1,$2,$3::jsonb,clock_timestamp()) ON CONFLICT(dedupe_key) DO NOTHING`,
        [`proposal.expired:${proposal.id}`, [proposal.driver_id, proposal.passenger_id], JSON.stringify({ proposal_id: proposal.id, demand_id: proposal.demand_id, status: 'expired' })],
      );
    });
    const expiredProposal = await pool.query<{ status: string }>('SELECT status FROM proposals WHERE id=$1', [expiryProposalId]);
    assert.equal(expiredProposal.rows[0].status, 'expired');
    const expiryEvent = await pool.query<{ event_type: string; recipient_ids: string[] }>(
      'SELECT event_type,recipient_ids FROM realtime_outbox WHERE dedupe_key=$1', [`proposal.expired:${expiryProposalId}`],
    );
    assert.equal(expiryEvent.rows[0].event_type, 'proposal.expired');
    assert.deepEqual(new Set(expiryEvent.rows[0].recipient_ids), new Set([ids.driver, passengerA]));
    const expiredProposals = await fetch(`${apiUrl}/api/v1/demands/${expiryDemandId}/proposals`, { headers: headers(passengerA) });
    const expiredProposalUiData = await expiredProposals.json() as { data: Array<{ id: string; status: string }> };
    assert.equal(expiredProposalUiData.data.find((item) => item.id === expiryProposalId)?.status, 'expired');
  });
});
