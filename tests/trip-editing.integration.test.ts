import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { refreshProviderHealth } from '../server/mobility/healthMonitor';

const apiUrl = process.env.API_TEST_URL;
const databaseUrl = process.env.API_TEST_DATABASE_URL;
const enabled = Boolean(apiUrl && databaseUrl);
if (enabled && !['127.0.0.1', 'localhost', '::1'].includes(new URL(databaseUrl!).hostname)) throw new Error('Integration tests are restricted to a loopback database');

describe('editing and cancelling a published trip (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const driver = crypto.randomUUID(), passengerA = crypto.randomUUID(), passengerB = crypto.randomUUID(), stranger = crypto.randomUUID();
  const vehicle = crypto.randomUUID(), vehicleTwo = crypto.randomUUID(), smallVehicle = crypto.randomUUID(), offer = crypto.randomUUID();
  const headers = (userId: string, extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-dev-user-id': userId, ...extra });
  const call = (path: string, userId: string, method = 'GET', body?: unknown) => fetch(`${apiUrl}/api/v1${path}`, { method, headers: headers(userId), body: body === undefined ? undefined : JSON.stringify(body) });
  const departure = new Date(Date.now() + 3 * 86_400_000);
  const bookingIds: string[] = [];

  before(async () => {
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES($1,'Edit driver',ARRAY['driver']),($2,'Edit passenger A',ARRAY['passenger']),($3,'Edit passenger B',ARRAY['passenger']),($4,'Stranger',ARRAY['driver'])`, [driver, passengerA, passengerB, stranger]);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'driver'),($2,'passenger'),($3,'passenger'),($4,'driver')`, [driver, passengerA, passengerB, stranger]);
    await pool.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count,is_active,trust_level,plate) VALUES
      ($1,$4,'Avatr','11',2024,4,true,1,'EDIT001'),($2,$4,'Tesla','Model Y',2023,4,false,1,'EDIT002'),($3,$4,'Smart','ForTwo',2020,1,false,1,'EDIT003')`, [vehicle, vehicleTwo, smallVehicle, driver]);
    await pool.query(`INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats)
      VALUES ($1,$2,$3,'Львів','Стрий',ST_SetSRID(ST_MakePoint(24.03,49.84),4326)::geography,ST_SetSRID(ST_MakePoint(23.85,49.26),4326)::geography,
        ST_MakeLine(ST_SetSRID(ST_MakePoint(24.03,49.84),4326),ST_SetSRID(ST_MakePoint(23.85,49.26),4326)),$4,$5,70000,3600,'osrm',15000,3,3)`,
      [offer, driver, vehicle, departure, new Date(departure.getTime() + 3_600_000)]);
    for (const passenger of [passengerA, passengerB]) {
      const response = await fetch(`${apiUrl}/api/v1/bookings`, { method: 'POST', headers: headers(passenger, { 'idempotency-key': `edit-${crypto.randomUUID()}` }), body: JSON.stringify({ offerId: offer, seats: 1 }) });
      assert.equal(response.status, 201);
      bookingIds.push((await response.json() as { data: { id: string } }).data.id);
    }
  });

  after(async () => {
    await pool.query('DELETE FROM booking_change_approvals WHERE booking_id=ANY($1::uuid[])', [bookingIds]);
    await pool.query('DELETE FROM booking_events WHERE booking_id=ANY($1::uuid[])', [bookingIds]);
    await pool.query('DELETE FROM conversations WHERE booking_id=ANY($1::uuid[])', [bookingIds]);
    await pool.query('DELETE FROM realtime_outbox WHERE payload->>\'offer_id\'=$1', [offer]);
    await pool.query('DELETE FROM bookings WHERE id=ANY($1::uuid[])', [bookingIds]);
    await pool.query('DELETE FROM offer_changes WHERE offer_id=$1', [offer]);
    await pool.query('DELETE FROM offers WHERE id=$1', [offer]);
    await pool.query('DELETE FROM vehicles WHERE id=ANY($1::uuid[])', [[vehicle, vehicleTwo, smallVehicle]]);
    await pool.query('DELETE FROM audit_events WHERE actor_id=ANY($1::uuid[])', [[driver, passengerA, passengerB, stranger]]);
    await pool.query('DELETE FROM user_roles WHERE user_id=ANY($1::uuid[])', [[driver, passengerA, passengerB, stranger]]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[driver, passengerA, passengerB, stranger]]);
    await pool.end();
  });

  it('validates edits and protects other drivers’ trips and booked seats', async () => {
    assert.equal((await call(`/offers/${offer}`, stranger, 'PATCH', { pricePerSeatMinor: 1 })).status, 404);
    assert.equal((await call(`/offers/${offer}`, driver, 'PATCH', {})).status, 400);
    assert.equal((await call(`/offers/${offer}`, driver, 'PATCH', { pricePerSeatMinor: -1 })).status, 400);
    assert.equal((await call(`/offers/${offer}`, driver, 'PATCH', { departureAt: new Date(Date.now() - 60_000).toISOString() })).status, 400);
    const tooFew = await call(`/offers/${offer}`, driver, 'PATCH', { totalSeats: 1 });
    assert.equal(tooFew.status, 409, 'two seats are already booked');
    assert.equal((await tooFew.json() as { error: { code: string } }).error.code, 'seats_below_booked');
    assert.equal((await call(`/offers/${offer}`, driver, 'PATCH', { vehicleId: smallVehicle })).status, 409, 'the vehicle must fit the offered seats');
  });

  it('applies minor changes at once: cheaper price lowers confirmed bookings, a small time shift only notifies', async () => {
    const response = await call(`/offers/${offer}`, driver, 'PATCH', { pricePerSeatMinor: 12000, departureAt: new Date(departure.getTime() + 15 * 60_000).toISOString(), totalSeats: 4 });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { price_per_seat_minor: number; total_seats: number; available_seats: number; approvalsRequested: number } };
    assert.deepEqual([body.data.price_per_seat_minor, body.data.total_seats, body.data.available_seats, body.data.approvalsRequested], [12000, 4, 2, 0]);
    const prices = await pool.query<{ total_price_minor: number }>('SELECT total_price_minor FROM bookings WHERE id=ANY($1::uuid[])', [bookingIds]);
    assert.deepEqual(prices.rows.map((row) => row.total_price_minor), [12000, 12000]);
    const history = await (await call(`/offers/${offer}/changes`, passengerA)).json() as { data: Array<{ field: string; significant: boolean }> };
    assert.deepEqual(history.data.map((item) => item.field).sort(), ['departure', 'price', 'seats']);
    assert.equal(history.data.some((item) => item.significant), false);
    assert.equal((await call(`/offers/${offer}/changes`, stranger)).status, 404, 'history is only for the driver and booked passengers');
  });

  it('asks each passenger to approve a significant change; accepting keeps the booking at the new price, declining frees the seat', async () => {
    const response = await call(`/offers/${offer}`, driver, 'PATCH', { pricePerSeatMinor: 18000, departureAt: new Date(departure.getTime() + 2 * 3_600_000).toISOString(), vehicleId: vehicleTwo, reason: 'Інше авто' });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { data: { approvalsRequested: number } }).data.approvalsRequested, 2);
    const list = await (await call('/bookings', passengerA)).json() as { data: Array<{ id: string; pending_change: { id: string; summary: { price: { old: number; new: number }; vehicle: { new: string } } } | null }> };
    const mine = list.data.find((item) => item.id === bookingIds[0])!;
    assert.deepEqual(mine.pending_change?.summary.price, { old: 12000, new: 18000 });
    assert.equal(mine.pending_change?.summary.vehicle.new, 'Tesla Model Y');
    const prices = await pool.query<{ total_price_minor: number }>('SELECT total_price_minor FROM bookings WHERE id=$1', [bookingIds[0]]);
    assert.equal(prices.rows[0].total_price_minor, 12000, 'a higher price is never applied silently');

    const other = (await (await call('/bookings', passengerB)).json() as { data: Array<{ id: string; pending_change: { id: string } | null }> }).data.find((item) => item.id === bookingIds[1])!;
    assert.equal((await call(`/booking-changes/${mine.pending_change!.id}/accept`, passengerB, 'POST')).status, 404, 'only the booking passenger decides');
    const accepted = await call(`/booking-changes/${mine.pending_change!.id}/accept`, passengerA, 'POST');
    assert.equal(accepted.status, 200);
    assert.equal((await call(`/booking-changes/${mine.pending_change!.id}/accept`, passengerA, 'POST')).status, 409, 'a decision is final');
    const after = await pool.query<{ total_price_minor: number; status: string }>('SELECT total_price_minor,status FROM bookings WHERE id=$1', [bookingIds[0]]);
    assert.deepEqual(after.rows[0], { total_price_minor: 18000, status: 'confirmed' });

    const rejected = await call(`/booking-changes/${other.pending_change!.id}/reject`, passengerB, 'POST');
    assert.equal(rejected.status, 200);
    const declined = await pool.query<{ status: string }>('SELECT status FROM bookings WHERE id=$1', [bookingIds[1]]);
    assert.equal(declined.rows[0].status, 'cancelled');
    const seats = await pool.query<{ available_seats: number }>('SELECT available_seats FROM offers WHERE id=$1', [offer]);
    assert.equal(seats.rows[0].available_seats, 3, 'the declined seat goes back to the trip');
    const events = await pool.query<{ event_type: string }>("SELECT event_type FROM realtime_outbox WHERE payload->>'offer_id'=$1", [offer]);
    assert.ok(events.rows.some((row) => row.event_type === 'booking.change-requested'));
  });

  it('cancels the trip for everyone, idempotently, and blocks further edits', async () => {
    assert.equal((await call(`/offers/${offer}/cancel`, stranger, 'POST')).status, 404);
    const cancelled = await call(`/offers/${offer}/cancel`, driver, 'POST', { reason: 'Захворів' });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { data: { cancelledBookings: number } }).data.cancelledBookings, 1);
    assert.equal((await call(`/offers/${offer}/cancel`, driver, 'POST')).status, 200);
    const booking = await pool.query<{ status: string }>('SELECT status FROM bookings WHERE id=$1', [bookingIds[0]]);
    assert.equal(booking.rows[0].status, 'cancelled');
    assert.equal((await call(`/offers/${offer}`, driver, 'PATCH', { pricePerSeatMinor: 100 })).status, 409);
    const events = await pool.query<{ event_type: string }>("SELECT event_type FROM realtime_outbox WHERE payload->>'offer_id'=$1 AND event_type='trip.cancelled'", [offer]);
    assert.equal(events.rows.length, 1);
  });

  it('keeps the driver photo on the person and validates its upload references', async () => {
    assert.equal((await call('/users/me/driver-photo/upload-url', driver, 'POST', { contentType: 'image/gif' })).status, 400);
    assert.equal((await call('/users/me/driver-photo', driver, 'POST', { key: `driver-photos/${stranger}/${crypto.randomUUID()}`, contentType: 'image/jpeg' })).status, 400, 'a key of another user is rejected');
    assert.equal((await call('/users/me/driver-photo', driver, 'POST', { key: `vehicle-photos/${driver}/${vehicle}/${crypto.randomUUID()}`, contentType: 'image/jpeg' })).status, 400, 'a vehicle photo cannot become the driver photo');
    const me = await (await call('/users/me', driver)).json() as { data: { driver_photo_url: string | null } };
    assert.equal(me.data.driver_photo_url, null);
    assert.equal((await call('/users/me/driver-photo', driver, 'DELETE')).status, 200);
  });

  it('archives a vehicle instead of erasing it, hands "active" to the next one, and refuses while it has upcoming trips', async () => {
    const owner = crypto.randomUUID(), first = crypto.randomUUID(), second = crypto.randomUUID();
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES($1,'Garage owner',ARRAY['driver'])`, [owner]);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'driver')`, [owner]);
    await pool.query(`INSERT INTO vehicles(id,owner_id,make,model,model_year,seat_count,is_active,trust_level,plate,created_at) VALUES
      ($1,$3,'Avatr','11',2024,4,false,1,'GAR0001',now()-interval '1 day'),($2,$3,'Tesla','Model Y',2023,4,true,1,'GAR0002',now())`, [first, second, owner]);
    const upcoming = crypto.randomUUID();
    await pool.query(`INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,departure_at,price_per_seat_minor,total_seats,available_seats)
      VALUES($1,$2,$3,'A','B',ST_SetSRID(ST_MakePoint(24,49),4326)::geography,ST_SetSRID(ST_MakePoint(25,50),4326)::geography,now()+interval '2 days',10000,2,2)`, [upcoming, owner, second]);
    try {
      assert.equal((await call(`/vehicles/${second}`, owner, 'DELETE')).status, 409, 'a vehicle on an upcoming published trip cannot be removed');
      await pool.query("UPDATE offers SET status='cancelled' WHERE id=$1", [upcoming]);
      const removed = await call(`/vehicles/${second}`, owner, 'DELETE');
      assert.equal(removed.status, 200);
      assert.deepEqual(await removed.json(), { data: { id: second, archived: true, activatedVehicleId: first } });
      const list = await (await call('/vehicles', owner)).json() as { data: Array<{ id: string; is_active: boolean }> };
      assert.deepEqual(list.data.map((item) => [item.id, item.is_active]), [[first, true]], 'the archived car is hidden, the other one is active');
      const kept = await pool.query('SELECT archived_at FROM vehicles WHERE id=$1', [second]);
      assert.ok(kept.rows[0].archived_at, 'archived, not erased: history keeps pointing at it');
      assert.equal((await call(`/vehicles/${second}`, owner, 'DELETE')).status, 404, 'deleting twice is a clean 404');
      assert.equal((await call(`/vehicles/${first}`, stranger, 'DELETE')).status, 404, 'only the owner can delete');
      const last = await call(`/vehicles/${first}`, owner, 'DELETE');
      assert.equal((await last.json() as { data: { activatedVehicleId: string | null } }).data.activatedVehicleId, null, 'no vehicle left to activate');
    } finally {
      await pool.query('DELETE FROM audit_events WHERE actor_id=$1', [owner]);
      await pool.query('DELETE FROM offers WHERE id=$1', [upcoming]);
      await pool.query('DELETE FROM vehicles WHERE owner_id=$1', [owner]);
      await pool.query('DELETE FROM user_roles WHERE user_id=$1', [owner]);
      await pool.query('DELETE FROM users WHERE id=$1', [owner]);
    }
  });

  it('health monitor marks an unreachable source offline without changing the administrator’s status', async () => {
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO mobility_providers(name,city,provider_type,source_type,feed_url,status,health,access,country,last_checked_at)
      VALUES($1,'Тест','public_transit','gtfs','https://unreachable.invalid/gtfs.zip','enabled','healthy','open','UA',now()-interval '10 years') RETURNING id`, [`Health monitor ${crypto.randomUUID()}`]);
    try {
      await refreshProviderHealth(pool);
      const after = await pool.query<{ status: string; health: string; last_error: string | null }>('SELECT status,health,last_error FROM mobility_providers WHERE id=$1', [rows[0].id]);
      assert.equal(after.rows[0].status, 'enabled');
      assert.equal(after.rows[0].health, 'offline');
      assert.ok(after.rows[0].last_error);
    } finally { await pool.query('DELETE FROM mobility_providers WHERE id=$1', [rows[0].id]); }
  });
});
