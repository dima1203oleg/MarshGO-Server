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

function nextKyivMorningDeparture(now = new Date()): string {
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => localDate.find((value) => value.type === type)?.value ?? '';
  const nextDay = new Date(Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')) + 1));
  const year = nextDay.getUTCFullYear();
  const month = String(nextDay.getUTCMonth() + 1).padStart(2, '0');
  const day = String(nextDay.getUTCDate()).padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  const offsetLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv', timeZoneName: 'shortOffset', hour: '2-digit',
  }).formatToParts(new Date(`${date}T08:00:00Z`)).find((value) => value.type === 'timeZoneName')?.value ?? 'GMT';
  const offset = offsetLabel.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  const zone = offset ? `${offset[1]}${offset[2]!.padStart(2, '0')}:${offset[3] ?? '00'}` : '+00:00';
  return new Date(`${date}T08:00:00${zone}`).toISOString();
}

describe('API booking transaction (opt-in local integration test)', { skip: !enabled }, () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let healthyLvivGtfsEnabled = false;
  let healthyLvivRealGtfsEnabled = false;
  const ids = {
    driver: crypto.randomUUID(),
    passengers: Array.from({ length: 20 }, () => crypto.randomUUID()),
    admin: crypto.randomUUID(),
    vehicle: crypto.randomUUID(),
    offer: crypto.randomUUID(),
    journeyOffer: crypto.randomUUID(),
    transitCompositionOffer: crypto.randomUUID(),
    rendezvousOffer: crypto.randomUUID(),
    expiredOffer: crypto.randomUUID(),
    gtfsFixtureProvider: crypto.randomUUID(),
  };
  const keys = Array.from({ length: 20 }, () => `api-test-${crypto.randomUUID()}`);
  const passengerA = ids.passengers[0];
  const passengerB = ids.passengers[1];
  const compositionPassenger = ids.passengers[2];
  let apiCreatedVehicleId: string | null = null;
  const extraVehicleIds: string[] = [];
  const verificationIds: string[] = [];
  const moderationCaseIds: string[] = [];
  let otpUserId: string | null = null;
  let journeyOfferDepartureAt: Date;

  before(async () => {
    const scheduledJourney = await pool.query<{ departure_at: Date }>(
      `SELECT now() + interval '10 days' AS departure_at`,
    );
    journeyOfferDepartureAt = scheduledJourney.rows[0]!.departure_at;
    if (process.env.API_TEST_GTFS_FIXTURE === '1') {
      await pool.query(`DELETE FROM mobility_providers WHERE name='MARSHGO HTTP GTFS integration fixture'
        AND city='Львів' AND feed_url='https://gtfs-api-fixture.invalid/lviv.zip'`);
      await pool.query(`INSERT INTO mobility_providers(id,name,city,provider_type,source_type,feed_url,priority,status,health,access,last_report)
        VALUES ($1,'MARSHGO HTTP GTFS integration fixture','Львів','public_transit','gtfs',
          'https://gtfs-api-fixture.invalid/lviv.zip',1,'enabled','healthy','open',
          '{"bbox":[23.9,49.7,24.15,49.95],"counts":{"routes_bus":1,"routes_tram":1}}'::jsonb)`, [ids.gtfsFixtureProvider]);
      const fixtureCandidate = await pool.query<{ id: string }>(`SELECT id FROM (
        SELECT id FROM mobility_providers
         WHERE provider_type='public_transit' AND source_type='gtfs' AND access='open'
           AND status='enabled' AND health IN ('healthy','degraded')
         ORDER BY priority,name LIMIT 101
      ) AS bounded_candidates WHERE id=$1`, [ids.gtfsFixtureProvider]);
      assert.equal(fixtureCandidate.rowCount, 1, 'the fixture provider must survive the same bounded registry selection used by the API');
    }
    const lvivProvider = await pool.query<{ enabled: boolean; real_feed_enabled: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM mobility_providers
        WHERE city='Львів' AND source_type='gtfs' AND status='enabled' AND health='healthy') AS enabled,
        EXISTS (SELECT 1 FROM mobility_providers
        WHERE city='Львів' AND source_type='gtfs' AND status='enabled' AND health='healthy'
          AND feed_url <> 'https://gtfs-api-fixture.invalid/lviv.zip') AS real_feed_enabled`,
    );
    healthyLvivGtfsEnabled = lvivProvider.rows[0]?.enabled === true;
    healthyLvivRealGtfsEnabled = lvivProvider.rows[0]?.real_feed_enabled === true;
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
        $4,$4::timestamptz+interval '1 hour',78000,3600,'osrm',15000,1,1)`, [ids.journeyOffer, ids.driver, ids.vehicle, journeyOfferDepartureAt]);
    const ratingBookingId = crypto.randomUUID();
    await pool.query(`INSERT INTO bookings(id,offer_id,passenger_id,seat_count,unit_price_minor,total_price_minor,status,idempotency_key)
      VALUES ($1,$2,$3,1,15000,15000,'completed',$4)`, [ratingBookingId, ids.journeyOffer, passengerB, `rating-fixture-${ratingBookingId}`]);
    await pool.query(`INSERT INTO reviews(booking_id,author_id,target_id,rating) VALUES ($1,$2,$3,5)`, [ratingBookingId, passengerB, ids.driver]);
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
    await pool.query('DELETE FROM mobility_providers WHERE id=$1', [ids.gtfsFixtureProvider]);
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
    const otpEmail = `otp-user-${crypto.randomUUID()}@example.test`;
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
      method: 'PATCH', headers: authHeaders, body: JSON.stringify({ email: otpEmail }),
    });
    assert.equal((await profile.json() as { data: { email: string } }).data.email, otpEmail);
    const updatedName = await fetch(`${apiUrl}/api/v1/users/me`, {
      method: 'PATCH', headers: authHeaders, body: JSON.stringify({ displayName: 'Updated OTP User' }),
    });
    const updatedProfile = await updatedName.json() as { data: { email: string; display_name: string } };
    assert.equal(updatedProfile.data.email, otpEmail);
    assert.equal(updatedProfile.data.display_name, 'Updated OTP User');

    const enabledDriver = await fetch(`${apiUrl}/api/v1/users/me/roles`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ role: 'driver' }),
    });
    const roleBody = await enabledDriver.json() as { data?: { roles: string[] }; error?: { message: string } };
    assert.equal(enabledDriver.status, 200, roleBody.error?.message);
    assert.deepEqual(roleBody.data?.roles, ['driver', 'passenger']);
    const ownCar = await fetch(`${apiUrl}/api/v1/vehicles`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ make: 'Test', model: 'OTP Car', modelYear: 2022, seats: 4, plate: `AA${crypto.randomUUID().slice(0, 6).toUpperCase()}` }),
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

  it('rejects unscoped stop IDs rather than guessing among provider feeds', async () => {
    const invalid = await fetch(`${apiUrl}/api/v1/transit/stops/unscoped-stop/arrivals?lat=49.84&lon=24.02`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'invalid_stop_id');

    const missingProvider = await fetch(`${apiUrl}/api/v1/transit/stops/${crypto.randomUUID()}:sample-stop/arrivals?lat=49.84&lon=24.02`);
    assert.equal(missingProvider.status, 404);
    assert.equal((await missingProvider.json() as { error: { code: string } }).error.code, 'provider_unavailable');
  });

  it('searches real Community offer snapshots and persists representative Journey alternatives', async () => {
    const body = {
      origin: { name: 'Journey Test Origin', coordinates: [23.8561, 49.2567] },
      destination: { name: 'Journey Test Destination', coordinates: [24.0297, 49.8397] },
      departureAt: new Date(journeyOfferDepartureAt.getTime() - 60_000).toISOString(),
      passengers: 1,
      strategy: 'CHEAPEST',
      preferences: { allowCommunity: true, maxPriceMinor: 20000 },
    };
    for (const maximumDurationMinutes of [30, 60, 120]) {
      const maximumDurationSeconds = maximumDurationMinutes * 60;
      const boundedTransitSearch = await fetch(`${apiUrl}/api/v1/journeys/search`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA },
        body: JSON.stringify({
          ...body,
          origin: { name: 'Малоголосківська, Львів', coordinates: [24.0029933, 49.8681678] },
          destination: { name: 'Сихів, Львів', coordinates: [24.057585, 49.794117] },
          departureAt: nextKyivMorningDeparture(),
          strategy: 'FASTEST',
          preferences: { allowCommunity: false, allowedTransportTypes: ['bus', 'tram'], maxTotalDurationSeconds: maximumDurationSeconds },
        }),
      });
      assert.equal(boundedTransitSearch.status, 200, `${maximumDurationMinutes}-minute transit search must remain valid at the API boundary`);
      const boundedData = (await boundedTransitSearch.json() as { data: {
        journeys: Array<{ totalDurationSeconds: number }>;
        providerErrors: string[];
      } }).data;
      assert.ok(boundedData.journeys.every((journey) => journey.totalDurationSeconds <= maximumDurationSeconds),
        `${maximumDurationMinutes}-minute search must not return an over-horizon journey`);
      if (healthyLvivGtfsEnabled) {
        assert.equal(boundedData.providerErrors.some((message) => message.startsWith('GTFS-пошук тимчасово недоступний')), false,
          `${maximumDurationMinutes}-minute search must not silently discard a healthy GTFS search because transfer wait exceeds the journey horizon`);
      }
    }
    const modeMatrix: Array<{ type: string; journeys: number; blocked: boolean; walkingLegs: number }> = [];
    for (const transportType of ['bus','marshrutka','trolleybus','tram','metro','carpool','taxi','train','bike','scooter','carsharing','transfer']) {
      const modeSearch = ['bus','marshrutka','tram'].includes(transportType) ? {
        ...body,
        origin: { name: 'Малоголосківська, Львів', coordinates: [24.0029933, 49.8681678] },
        destination: { name: 'Сихів, Львів', coordinates: [24.057585, 49.794117] },
        departureAt: nextKyivMorningDeparture(),
      } : body;
      const modeResponse = await fetch(`${apiUrl}/api/v1/journeys/search`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA },
        body: JSON.stringify({ ...modeSearch, strategy: 'FASTEST', preferences: { allowCommunity: true, allowedTransportTypes: [transportType] } }),
      });
      assert.equal(modeResponse.status, 200, `${transportType} search responds successfully`);
      const modeData = (await modeResponse.json() as { data: {
        blockedProviders: string[];
        journeys: Array<{ offerId: string | null; origin: { name: string; coordinates: [number, number] }; destination: { name: string; coordinates: [number, number] }; legs: Array<{
          mode: string; transportType?: string; source?: string; providerId?: string; routeId?: string; headsign?: string;
          origin?: { name: string; coordinates: [number, number] };
          destination?: { name: string; coordinates: [number, number] };
          stops?: Array<{ id: string; name: string; coordinates: [number, number]; arrivalAt: string; departureAt: string }>;
        }> }>;
      } }).data;
      const assertScheduledStopCalls = (leg: typeof modeData.journeys[number]['legs'][number]) => {
        if (!['gtfs-static', 'gtfs-realtime-trip-updates'].includes(leg.source ?? '')) return;
        const stops = leg.stops ?? [];
        assert.ok(leg.providerId, `${leg.transportType ?? leg.mode} response carries its provider scope for stop queries`);
        assert.ok(leg.routeId, `${leg.transportType ?? leg.mode} response carries its feed route ID`);
        assert.ok(leg.headsign, `${leg.transportType ?? leg.mode} response carries its direction for stop queries`);
        assert.ok(stops.length >= 2, `${leg.transportType ?? leg.mode} response carries boarding/alighting calls and every published intermediate call`);
        assert.deepEqual(stops[0]?.coordinates, leg.origin?.coordinates, 'the first stop call matches the selected boarding stop');
        assert.deepEqual(stops.at(-1)?.coordinates, leg.destination?.coordinates, 'the final stop call matches the selected alighting stop');
        assert.ok(stops.every((stop, index) => index === 0
          || Date.parse(stops[index - 1]!.arrivalAt) <= Date.parse(stop.arrivalAt)), 'stop calls retain GTFS sequence order');
      };
      const acceptedTypes = transportType === 'bus' ? ['bus','intercity_bus']
        : transportType === 'train' ? ['train','suburban_train','city_train'] : [transportType];
      for (const journey of modeData.journeys) {
        assert.deepEqual(journey.origin, modeSearch.origin, 'the journey keeps the requested origin instead of the first nearby transport stop');
        assert.deepEqual(journey.destination, modeSearch.destination, 'the journey keeps the requested destination instead of the last nearby transport stop');
        if (journey.offerId) assert.equal(transportType, 'carpool', `${transportType} must not leak a carpool offer`);
        for (const leg of journey.legs) {
          if (leg.mode === 'WALK') continue;
          if (leg.mode === 'COMMUNITY') {
            assert.equal(transportType, 'carpool', 'Community offers are the carpool category');
            continue;
          }
          assert.ok(acceptedTypes.includes(leg.transportType ?? ''), `${transportType} selection leaked ${leg.transportType ?? leg.mode}`);
          assertScheduledStopCalls(leg);
        }
      }
      assert.equal(modeData.journeys.some((journey) => journey.offerId === ids.journeyOffer), transportType === 'carpool',
        `${transportType} selection controls the direct carpool offer`);
      if (['bus','tram'].includes(transportType) && !healthyLvivGtfsEnabled) {
        assert.equal(modeData.journeys.length, 0, `${transportType} does not invent trips without an enabled Lviv GTFS provider`);
        assert.ok(modeData.blockedProviders.some((value) => value.startsWith(`transportType:${transportType}:`)),
          `${transportType} search reports the missing routed provider`);
      }
      modeMatrix.push({
        type: transportType,
        journeys: modeData.journeys.length,
        blocked: modeData.blockedProviders.some((value) => value.startsWith(`transportType:${transportType}:`)),
        walkingLegs: modeData.journeys.flatMap((journey) => journey.legs).filter((leg) => leg.mode === 'WALK').length,
      });
    }
    const multiSearchDeparture = nextKyivMorningDeparture();
    const multiResponse = await fetch(`${apiUrl}/api/v1/journeys/search`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA },
      body: JSON.stringify({
        ...body,
        origin: { name: 'Малоголосківська, Львів', coordinates: [24.0029933, 49.8681678] },
        destination: { name: 'Сихів, Львів', coordinates: [24.057585, 49.794117] },
        departureAt: multiSearchDeparture,
        strategy: 'BALANCED',
        preferences: { allowCommunity: true, allowedTransportTypes: ['bus','tram'] },
      }),
    });
    assert.equal(multiResponse.status, 200);
    const multiData = (await multiResponse.json() as { data: { availableStrategies: string[]; blockedProviders: string[]; providerErrors?: string[]; returnedCount: number; journeys: Array<{ offerId: string | null; source?: string; strategyRanks?: Record<string, number>; totalDurationSeconds: number; totalPriceMinor: number | null; legs: Array<{
      mode: string; source?: string; providerId?: string; transportType?: string; routeGeometry?: [number, number][];
      departureAt?: string; arrivalAt?: string;
      origin?: { coordinates: [number, number] }; destination?: { coordinates: [number, number] };
      stops?: Array<{ id: string; name: string; coordinates: [number, number]; arrivalAt: string; departureAt: string }>;
    }> }> } }).data;
    assert.equal(multiData.returnedCount, multiData.journeys.length, 'response metadata matches persisted alternatives');
    if (process.env.API_TEST_GTFS_FIXTURE === '1') {
      const fixtureJourney = multiData.journeys.find((candidate) => candidate.source === 'gtfs-static'
        && candidate.legs.some((leg) => leg.providerId === ids.gtfsFixtureProvider));
      assert.ok(fixtureJourney, `the authenticated HTTP search returns a journey parsed from the exact local GTFS fixture provider; diagnostics=${JSON.stringify({
        providerErrors: multiData.providerErrors, blockedProviders: multiData.blockedProviders,
        journeys: multiData.journeys.map((candidate) => ({ source: candidate.source, legs: candidate.legs.map((leg) => ({ source: leg.source, providerId: leg.providerId, transportType: leg.transportType })) })),
      })}`);
      const fixtureTransitLegs = fixtureJourney.legs.filter((leg) => leg.providerId === ids.gtfsFixtureProvider);
      assert.ok(fixtureTransitLegs.some((leg) => leg.transportType === 'bus'));
      assert.ok(fixtureTransitLegs.some((leg) => leg.transportType === 'tram'));
      assert.ok(fixtureTransitLegs.every((leg) => leg.source === 'gtfs-static'
        && (leg.routeGeometry?.length ?? 0) >= 2), 'fixture bus/tram legs expose scheduled source and renderable GTFS shape geometry');
      for (const strategy of ['BALANCED', 'FASTEST'] as const) {
        assert.ok(multiData.availableStrategies.includes(strategy), `GTFS fixture participates in ${strategy} API ranking`);
        assert.ok(Number.isInteger(fixtureJourney.strategyRanks?.[strategy]),
          `the authenticated API response includes the GTFS fixture's ${strategy} rank`);
      }
      if (fixtureJourney.totalPriceMinor !== null) {
        assert.ok(multiData.availableStrategies.includes('CHEAPEST'), 'a fixture journey with a known fare keeps CHEAPEST available');
        assert.ok(Number.isInteger(fixtureJourney.strategyRanks?.CHEAPEST),
          'the authenticated API response includes the known-fare GTFS fixture in CHEAPEST ranking');
      } else {
        assert.equal(fixtureJourney.strategyRanks?.CHEAPEST, undefined,
          'an unknown transit fare is never represented as a CHEAPEST ranking');
      }
      for (const leg of fixtureTransitLegs) {
        assert.ok((leg.stops?.length ?? 0) >= 2, `${leg.transportType} HTTP response preserves scheduled boarding and alighting calls`);
        assert.ok(leg.stops!.every((stop, index) => index === 0
          || Date.parse(leg.stops![index - 1]!.arrivalAt) <= Date.parse(stop.arrivalAt)),
        `${leg.transportType} HTTP response preserves GTFS stop-time order`);
        assert.ok(leg.departureAt && leg.arrivalAt
          && Date.parse(leg.departureAt) < Date.parse(leg.arrivalAt),
        `${leg.transportType} HTTP response preserves a valid scheduled interval`);
      }
    }
    if (healthyLvivRealGtfsEnabled) {
      assert.ok(multiData.availableStrategies.includes('BALANCED'));
      assert.ok(multiData.journeys.some((journey) => typeof journey.strategyRanks?.BALANCED === 'number'),
        'each returned result exposes its place in the selected strategy ranking');
      for (const strategy of ['BALANCED', 'FASTEST', 'CHEAPEST']) {
        if (!multiData.availableStrategies.includes(strategy)) continue;
        const ranked = multiData.journeys
          .filter((journey) => Number.isInteger(journey.strategyRanks?.[strategy]))
          .sort((left, right) => left.strategyRanks![strategy]! - right.strategyRanks![strategy]!);
        assert.ok(ranked.length > 0, `${strategy} returns ranked route alternatives`);
        assert.deepEqual(ranked.map((journey) => journey.strategyRanks![strategy]),
          ranked.map((_, index) => index + 1), `${strategy} ranks are unique and contiguous`);
        if (strategy === 'FASTEST') {
          assert.ok(ranked.every((journey, index) => index === 0
            || ranked[index - 1]!.totalDurationSeconds <= journey.totalDurationSeconds),
          'FASTEST rank order never places a longer returned route ahead of a shorter one');
        }
        if (strategy === 'CHEAPEST') {
          assert.ok(ranked.every((journey) => journey.totalPriceMinor !== null),
            'CHEAPEST never ranks a route whose fare is unknown');
          assert.ok(ranked.every((journey, index) => index === 0
            || ranked[index - 1]!.totalPriceMinor! <= journey.totalPriceMinor!),
          'CHEAPEST rank order never places a higher known fare ahead of a lower one');
        }
      }
      const realBusTramChain = multiData.journeys.find((journey) => {
        const modes = new Set(journey.legs.filter((leg) => leg.mode !== 'WALK').map((leg) => leg.transportType));
        return modes.has('bus') && modes.has('tram');
      });
      assert.ok(realBusTramChain, 'the real Lviv timetable composes a bus + tram itinerary when both modes are selected');
      for (const leg of realBusTramChain.legs.filter((item) => item.mode !== 'WALK')) {
        assert.ok((leg.routeGeometry?.length ?? 0) >= 2, `${leg.transportType} includes renderable route geometry`);
        assert.ok((leg.stops?.length ?? 0) >= 2, `${leg.transportType} includes boarding and alighting stop calls`);
        assert.deepEqual(leg.routeGeometry?.[0], leg.origin?.coordinates, 'GTFS geometry starts at its selected boarding stop');
        assert.deepEqual(leg.routeGeometry?.at(-1), leg.destination?.coordinates, 'GTFS geometry ends at its selected alighting stop');
        assert.ok(leg.stops!.every((stop, index) => index === 0
          || Date.parse(leg.stops![index - 1]!.arrivalAt) <= Date.parse(stop.arrivalAt)), 'GTFS stop calls remain in time order');
      }

      // Use the checked-in fixture for the transactional composition scenario.
      // The live Lviv timetable is still verified above, but its next-day
      // service and stop pairs are upstream data and cannot be a stable test
      // prerequisite for creating a synthetic Community handoff offer.
      const transitLegs = multiData.journeys.flatMap((candidate) => candidate.legs
        .filter((leg) => leg.mode !== 'WALK' && leg.providerId === ids.gtfsFixtureProvider));
      const buses = transitLegs.filter((leg) => leg.transportType === 'bus' && leg.origin && leg.destination && leg.arrivalAt);
      const trams = transitLegs.filter((leg) => leg.transportType === 'tram' && leg.origin && leg.destination);
      const compositionPair = buses.flatMap((bus) => trams.flatMap((tram) => {
        const busArrival = Date.parse(bus.arrivalAt!);
        const requestAt = Date.parse(multiSearchDeparture);
        const gapMeters = Math.hypot(
          (bus.destination!.coordinates[0] - tram.origin!.coordinates[0]) * 111_320,
          (bus.destination!.coordinates[1] - tram.origin!.coordinates[1]) * 110_574,
        );
        if (busArrival - requestAt < 60_000 || busArrival - requestAt > 100 * 60_000 || gapMeters < 250 || gapMeters > 10_000) return [];
        return [{ bus, tram, gapMeters }];
      }))[0];
      assert.ok(compositionPair, 'the deterministic Lviv fixture exposes a feasible bus-to-tram handoff for the integration scenario');
      const suffixProbeDeparture = new Date(Date.parse(compositionPair.bus.arrivalAt!) + 25 * 60_000);
      const suffixProbeResponse = await fetch(`${apiUrl}/api/v1/journeys/search`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': compositionPassenger },
        body: JSON.stringify({ origin: { name: 'API tram boarding stop', coordinates: compositionPair.tram.origin!.coordinates },
          destination: { name: 'API tram alighting stop', coordinates: compositionPair.tram.destination!.coordinates },
          departureAt: suffixProbeDeparture.toISOString(), passengers: 1, strategy: 'FASTEST',
          preferences: { allowedTransportTypes: ['tram'] } }),
      });
      assert.equal(suffixProbeResponse.status, 200);
      const suffixProbe = (await suffixProbeResponse.json() as { data: { journeys: Array<{ legs: Array<{
        transportType?: string; departureAt?: string;
      }> }> } }).data;
      const nextTramDeparture = suffixProbe.journeys.flatMap((journey) => journey.legs)
        .find((leg) => leg.transportType === 'tram' && leg.departureAt)?.departureAt;
      assert.ok(nextTramDeparture, 'the static Lviv feed has a later tram service after the private-ride transfer buffer');
      const compositionDepartureAt = new Date(Date.parse(compositionPair.bus.arrivalAt!) + 10 * 60_000);
      const compositionArrivalAt = new Date(Date.parse(nextTramDeparture) - 10 * 60_000);
      const compositionDurationSeconds = Math.ceil((compositionArrivalAt.getTime() - compositionDepartureAt.getTime()) / 1000);
      assert.ok(compositionDurationSeconds >= 300, 'the offer has time to make the connection after both 10-minute transfer buffers');
      const offerOrigin = compositionPair.bus.destination!.coordinates;
      const offerDestination = compositionPair.tram.origin!.coordinates;
      const offerDistanceMeters = Math.max(250, Math.ceil(compositionPair.gapMeters * 1.3));
      const offerRouteGeoJson = JSON.stringify({ type: 'LineString', coordinates: [offerOrigin, offerDestination] });
      await pool.query(
        `INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats)
         VALUES($1,$2,$3,'API transit handoff pickup','API transit handoff dropoff',
           ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,ST_SetSRID(ST_MakePoint($6,$7),4326)::geography,
           ST_SetSRID(ST_GeomFromGeoJSON($8),4326),$9,$10,$11,$12,'api_integration_fixture',1000,2,2)`,
        [ids.transitCompositionOffer, ids.driver, ids.vehicle, offerOrigin[0], offerOrigin[1], offerDestination[0], offerDestination[1],
          offerRouteGeoJson, compositionDepartureAt, compositionArrivalAt, offerDistanceMeters, compositionDurationSeconds],
      );
      const composedSearch = await fetch(`${apiUrl}/api/v1/journeys/search`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': compositionPassenger },
        body: JSON.stringify({
          origin: { name: 'API bus departure stop', coordinates: compositionPair.bus.origin!.coordinates },
          destination: { name: 'API tram arrival stop', coordinates: compositionPair.tram.destination!.coordinates },
          departureAt: multiSearchDeparture, passengers: 1, strategy: 'FASTEST',
          preferences: { allowCommunity: true, allowedTransportTypes: ['bus','tram','carpool'] },
        }),
      });
      assert.equal(composedSearch.status, 200);
      const composedPayload = (await composedSearch.json() as { data: { candidateCount?: number; returnedCount?: number; partial: boolean; partialReasons: string[]; providerErrors?: string[]; blockedProviders?: string[]; resultsTruncated: boolean; candidateGenerationTruncated: boolean; resultSamplingTruncated: boolean; journeys: Array<{
        id: string; offerId: string | null; source?: string; state: string;
        legs: Array<{ id: string; mode: string; offerId: string | null; availabilityStatus: string }>;
      }> } });
      const composedData = composedPayload.data;
      assert.equal(typeof composedData.partial, 'boolean');
      assert.equal(composedData.partial, composedData.partialReasons.length > 0,
        'the API partial flag must agree with its explicit reasons');
      assert.equal(composedData.resultsTruncated,
        composedData.candidateGenerationTruncated || composedData.resultSamplingTruncated,
        'the API must surface both candidate-generation truncation and sampled result pages');
      assert.equal(composedData.partialReasons.includes('candidate_generation_truncated'), composedData.candidateGenerationTruncated,
        'candidate omission must be explained as an explicit partial reason');
      const composedJourney = composedData.journeys.find((candidate) => candidate.source === 'community-transit'
        && candidate.offerId === ids.transitCompositionOffer);
      assert.ok(composedJourney, 'the production API composes and persists a real GTFS prefix, Community ride, and GTFS suffix');
      assert.deepEqual(composedJourney.legs.map((leg) => leg.mode), ['BUS','COMMUNITY','TRAM']);
      assert.equal(composedJourney.legs[1]!.offerId, ids.transitCompositionOffer);
      assert.equal(composedJourney.legs[1]!.availabilityStatus, 'AVAILABLE');

      const transferLimitedSearch = await fetch(`${apiUrl}/api/v1/journeys/search`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': compositionPassenger },
        body: JSON.stringify({
          origin: { name: 'API bus departure stop', coordinates: compositionPair.bus.origin!.coordinates },
          destination: { name: 'API tram arrival stop', coordinates: compositionPair.tram.destination!.coordinates },
          departureAt: multiSearchDeparture, passengers: 1, strategy: 'FASTEST',
          preferences: { allowCommunity: true, allowedTransportTypes: ['bus','tram','carpool'], maxTransfers: 1 },
        }),
      });
      assert.equal(transferLimitedSearch.status, 200);
      const transferLimitedData = (await transferLimitedSearch.json() as { data: { journeys: Array<{
        offerId: string | null; source?: string;
      }> } }).data;
      assert.equal(transferLimitedData.journeys.some((candidate) => candidate.source === 'community-transit'
        && candidate.offerId === ids.transitCompositionOffer), false,
      'a BUS → COMMUNITY → TRAM journey has two vehicle changes and must not appear under maxTransfers=1');

      const storedComposition = await pool.query<{ state: string; modes: string[]; leg_states: string[] }>(
        `SELECT j.state,array_agg(l.mode ORDER BY l.ordinal) AS modes,array_agg(l.state ORDER BY l.ordinal) AS leg_states
           FROM journeys j JOIN journey_legs l ON l.journey_id=j.id WHERE j.id=$1 AND j.user_id=$2 GROUP BY j.id`,
        [composedJourney.id, compositionPassenger],
      );
      assert.deepEqual(storedComposition.rows[0], { state: 'PLANNED', modes: ['BUS','COMMUNITY','TRAM'], leg_states: ['SUGGESTED','SELECTED','SUGGESTED'] });
      const selectedCommunityLeg = composedJourney.legs[1]!;
      const compositionBooking = await fetch(`${apiUrl}/api/v1/bookings`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': compositionPassenger,
          'idempotency-key': `composed-leg-${crypto.randomUUID()}` },
        body: JSON.stringify({ offerId: ids.transitCompositionOffer, seats: 1,
          journeyId: composedJourney.id, journeyLegId: selectedCommunityLeg.id }),
      });
      assert.equal(compositionBooking.status, 201, 'the selected private leg can be booked through the normal atomic booking API');
      const bookedComposition = await pool.query<{ state: string; confirmed: number; stillSuggestedTransit: number }>(
        `SELECT j.state,
                count(*) FILTER (WHERE l.mode='COMMUNITY' AND l.state='CONFIRMED')::int AS confirmed,
                count(*) FILTER (WHERE l.mode IN ('BUS','TRAM') AND l.state='SUGGESTED')::int AS still_suggested_transit
           FROM journeys j JOIN journey_legs l ON l.journey_id=j.id WHERE j.id=$1 GROUP BY j.id`, [composedJourney.id],
      );
      assert.deepEqual(bookedComposition.rows[0], { state: 'PARTIALLY_RESERVED', confirmed: 1, still_suggested_transit: 2 },
        'booking the private leg does not pretend the transit legs are reservations');
    } else if (!healthyLvivGtfsEnabled) {
      assert.equal(multiData.journeys.length, 0, 'an empty provider registry must not produce fabricated transit alternatives');
      assert.ok(multiData.blockedProviders.some((value) => value.startsWith('transportType:bus:')));
      assert.ok(multiData.blockedProviders.some((value) => value.startsWith('transportType:tram:')));
    }
    for (const journey of multiData.journeys) {
      assert.equal(journey.offerId, null, 'a bus + tram selection excludes direct carpool offers');
      for (const leg of journey.legs) {
        if (leg.mode !== 'WALK') assert.ok(['bus','intercity_bus','tram'].includes(leg.transportType ?? ''), `multi-select leaked ${leg.transportType ?? leg.mode}`);
      }
    }
    console.info(`JOURNEY_MULTISELECT ${JSON.stringify(multiData.journeys.map((journey) => [...new Set(journey.legs.map((leg) => leg.transportType ?? leg.mode))]))}`);
    console.info(`JOURNEY_MODE_MATRIX ${JSON.stringify(modeMatrix)}`);
    const unauthorized = await fetch(`${apiUrl}/api/v1/journeys/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${apiUrl}/api/v1/journeys/search`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-user-id': passengerA }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { data: { partial: boolean; partialReasons: string[]; blockedProviders: string[]; unsupportedPreferences: string[]; availableStrategies: string[]; journeys: Array<{ id: string; offerId: string | null; strategy: string; recommendedStrategies?: string[]; strategyRanks?: Record<string, number>; confirmedPriceMinor: number | null; totalPriceMinor: number | null; source?: string; legs: Array<{ id: string; mode: string; priceStatus: string; availabilityStatus: string; driver?: { averageRating: number | null } }> }> } };
    assert.equal(result.data.partial, true);
    assert.ok(result.data.partialReasons.length > 0);
    assert.ok(result.data.blockedProviders.some((provider) => provider.startsWith('transportType:taxi:')));
    assert.equal(result.data.blockedProviders.some((provider) => provider.startsWith('transportType:bus:')), !healthyLvivGtfsEnabled,
      healthyLvivGtfsEnabled ? 'the enabled local GTFS bus feed is recognized' : 'a missing GTFS source is reported instead of being implied available');
    const communityJourneys = result.data.journeys.filter((item) => item.offerId === ids.journeyOffer);
    assert.equal(communityJourneys.length, 1);
    const journey = communityJourneys[0];
    assert.ok(journey);
    for (const strategy of ['BALANCED', 'FASTEST', 'CHEAPEST']) {
      assert.ok(result.data.availableStrategies.includes(strategy),
        `a known-price community offer keeps ${strategy} available at the authenticated API boundary`);
      assert.equal(journey.strategyRanks?.[strategy], 1,
        `the persisted community result has a rank for ${strategy}`);
      assert.ok(journey.recommendedStrategies?.includes(strategy),
        `the API recommendation labels the community result for ${strategy}`);
    }
    assert.equal(journey.confirmedPriceMinor, null);
    assert.equal(journey.totalPriceMinor, 15000);
    assert.equal(journey.legs[0].driver?.averageRating, 5);
    assert.equal(typeof journey.legs[0].driver?.averageRating, 'number');
    assert.deepEqual(journey.legs.map((leg) => [leg.mode, leg.priceStatus, leg.availabilityStatus]), [['COMMUNITY', 'ESTIMATED', 'AVAILABLE']]);
    assert.ok(result.data.availableStrategies.includes('CHEAPEST'),
      'a known UAH community fare keeps CHEAPEST available even when a different provider has unknown pricing');
    assert.ok(result.data.journeys.filter((item) => typeof item.strategyRanks?.CHEAPEST === 'number')
      .every((item) => item.totalPriceMinor !== null),
    'the API never labels an unknown-fare journey as part of CHEAPEST');
    if (result.data.availableStrategies.includes('CHEAPEST')) {
      assert.ok(result.data.journeys.filter((item) => typeof item.strategyRanks?.CHEAPEST === 'number')
        .every((item) => item.totalPriceMinor !== null),
      'the cheapest ranking only includes routes with a known comparable fare');
    }
    if (result.data.unsupportedPreferences.includes('maxPriceMinor:public-transit-fare-unavailable')) {
      assert.equal(result.data.journeys.some((item) => item.source === 'gtfs-static'), false,
        'a transit route without a fare is excluded when the passenger sets a maximum price');
    }
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
        departureAt: new Date(journeyOfferDepartureAt.getTime() - 60_000).toISOString(), passengers: 1, strategy: 'FASTEST' }),
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
    const communityDisabled = (await disabledCommunity.json() as { data: { journeys: Array<{ offerId: string | null }> } }).data.journeys;
    assert.equal(communityDisabled.some((journey) => journey.offerId === ids.journeyOffer), false,
      'disabling Community suppresses the offer while still allowing real scheduled routes');
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
    const approachesBeforeConsent = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/approaches`, { headers: passengerHeaders });
    assert.equal(approachesBeforeConsent.status, 409);
    const prematureLocation = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/location`, {
      method: 'POST', headers: passengerHeaders,
      body: JSON.stringify({ longitude: 24, latitude: 49, accuracyMeters: 5, capturedAt: new Date().toISOString() }),
    });
    assert.equal(prematureLocation.status, 403);

    const activate = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/rendezvous/activate`, { method: 'POST', headers: driverHeaders });
    assert.equal(activate.status, 200);
    const active = await activate.json() as { data: { state: string; locationSharingEnabled: boolean } };
    assert.deepEqual({ state: active.data.state, sharing: active.data.locationSharingEnabled }, { state: 'ACTIVE', sharing: false });

    const passengerConsent = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/consent`, {
      method: 'POST', headers: passengerHeaders, body: JSON.stringify({ enabled: true }),
    });
    assert.equal(passengerConsent.status, 200);
    const passengerConsented = await passengerConsent.json() as { data: { currentParticipantConsent: boolean; locationSharingEnabled: boolean } };
    assert.deepEqual({ consent: passengerConsented.data.currentParticipantConsent, sharing: passengerConsented.data.locationSharingEnabled }, { consent: true, sharing: false });

    const driverBeforeConsent = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/location`, {
      method: 'POST', headers: driverHeaders,
      body: JSON.stringify({ longitude: 24.0001, latitude: 49, accuracyMeters: 8, capturedAt: new Date().toISOString() }),
    });
    assert.equal(driverBeforeConsent.status, 403, 'one participant cannot transmit location before their own consent');

    const driverConsent = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/consent`, {
      method: 'POST', headers: driverHeaders, body: JSON.stringify({ enabled: true }),
    });
    assert.equal(driverConsent.status, 200);
    const driverConsented = await driverConsent.json() as { data: { currentParticipantConsent: boolean; otherParticipantConsent: boolean; locationSharingEnabled: boolean } };
    assert.deepEqual({ own: driverConsented.data.currentParticipantConsent, other: driverConsented.data.otherParticipantConsent, sharing: driverConsented.data.locationSharingEnabled }, { own: true, other: true, sharing: true });

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

    const driverCapturedAt = new Date(Date.parse(capturedAt) + 1_000).toISOString();
    const driverLocation = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/location`, {
      method: 'POST', headers: driverHeaders,
      body: JSON.stringify({ longitude: 24.0001, latitude: 49, accuracyMeters: 8, capturedAt: driverCapturedAt }),
    });
    assert.equal(driverLocation.status, 200);
    const passengerView = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/rendezvous`, { headers: passengerHeaders });
    const passengerState = await passengerView.json() as { data: { locations: { driver: { freshness: string; coordinates: number[] } | null } } };
    assert.deepEqual(passengerState.data.locations.driver?.coordinates, [24.0001, 49]);
    assert.equal(passengerState.data.locations.driver?.freshness, 'LIVE');
    const approaches = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/approaches`, { headers: passengerHeaders });
    assert.equal(approaches.status, 200);
    const approachData = await approaches.json() as { data: {
      driver: { approach: { status: string; geometry: unknown; distanceMeters: number | null } };
      passenger: { approach: { status: string; geometry: unknown; distanceMeters: number | null } };
    } };
    assert.equal(approachData.data.driver.approach.status, 'ROUTING_UNAVAILABLE');
    assert.equal(approachData.data.driver.approach.geometry, null);
    assert.equal(approachData.data.driver.approach.distanceMeters, null);
    assert.equal(approachData.data.passenger.approach.status, 'ROUTING_UNAVAILABLE');
    assert.equal(approachData.data.passenger.approach.geometry, null);
    const outsiderApproaches = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/approaches`, { headers: { 'x-dev-user-id': passengerB } });
    assert.equal(outsiderApproaches.status, 404);

    const revokeConsent = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/consent`, {
      method: 'POST', headers: passengerHeaders, body: JSON.stringify({ enabled: false }),
    });
    assert.equal(revokeConsent.status, 200);
    const revoked = await revokeConsent.json() as { data: { locationSharingEnabled: boolean; locations: { driver: unknown; passenger: unknown } } };
    assert.deepEqual({ sharing: revoked.data.locationSharingEnabled, driver: revoked.data.locations.driver, passenger: revoked.data.locations.passenger }, { sharing: false, driver: null, passenger: null });
    const renewConsent = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/consent`, {
      method: 'POST', headers: passengerHeaders, body: JSON.stringify({ enabled: true }),
    });
    assert.equal(renewConsent.status, 200);
    const oldDriverSample = await fetch(`${apiUrl}/api/v1/rendezvous/${initial.data.id}/location`, {
      method: 'POST', headers: driverHeaders,
      body: JSON.stringify({ longitude: 24.0001, latitude: 49, accuracyMeters: 8, capturedAt }),
    });
    assert.equal(oldDriverSample.status, 409, 'a sample from before the renewed mutual-consent period cannot reappear');

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
    const corridorOfferId = crypto.randomUUID();
    const farOfferId = crypto.randomUUID();
    const noSeatsOfferId = crypto.randomUUID();
    await pool.query(`INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,route_source,price_per_seat_minor,total_seats,available_seats)
      VALUES
      ($1,$2,$3,'Rescue Nearby Origin','Rescue Nearby Destination',
        ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
        NULL,now()+interval '10 days 30 minutes',NULL,22000,4,4),
      ($6,$2,$3,'Rescue Corridor Origin','Rescue Corridor Destination',
        ST_SetSRID(ST_MakePoint(24.5,49.5),4326)::geography,ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
        ST_SetSRID(ST_GeomFromGeoJSON('{"type":"LineString","coordinates":[[24.5,49.5],[25.0,50.0]]}'),4326),
        now()+interval '10 days 40 minutes','osrm',24000,4,4),
      ($4,$2,$3,'Rescue Far Origin','Rescue Far Destination',
        ST_SetSRID(ST_MakePoint(27.0,52.0),4326)::geography,ST_SetSRID(ST_MakePoint(28.0,53.0),4326)::geography,
        NULL,now()+interval '10 days 30 minutes',NULL,18000,4,4),
      ($5,$2,$3,'Rescue Sold Out Origin','Rescue Sold Out Destination',
        ST_SetSRID(ST_MakePoint(24.0,49.0),4326)::geography,ST_SetSRID(ST_MakePoint(25.0,50.0),4326)::geography,
        NULL,now()+interval '10 days 30 minutes',NULL,16000,4,0)`, [nearbyOfferId, ids.driver, ids.vehicle, farOfferId, noSeatsOfferId, corridorOfferId]);
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
    const rescue = await rescueResponse.json() as { data: { booking_id: string; checked_at: string; radius_m: number; alternatives: Array<{ id: string; source: string; available_seats: number; origin_distance_m: number; destination_distance_m: number; rescue_match: string; route_origin_distance_m: number | null }> } };
    assert.equal(rescue.data.booking_id, booking.data.id);
    assert.ok(Number.isFinite(Date.parse(rescue.data.checked_at)));
    assert.equal(rescue.data.radius_m, 20_000);
    assert.deepEqual(rescue.data.alternatives.map(item => item.id), [nearbyOfferId, corridorOfferId]);
    assert.equal(rescue.data.alternatives[0].source, 'MARSHGO Community');
    assert.equal(rescue.data.alternatives[0].available_seats, 4);
    assert.equal(rescue.data.alternatives[0].origin_distance_m, 0);
    assert.equal(rescue.data.alternatives[0].destination_distance_m, 0);
    assert.equal(rescue.data.alternatives[0].rescue_match, 'ENDPOINTS');
    assert.equal(rescue.data.alternatives[1].rescue_match, 'ALONG_CANCELLED_ROUTE');
    assert.ok((rescue.data.alternatives[1].route_origin_distance_m ?? Infinity) < 1_000);
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
      body: JSON.stringify({ make: 'Kia', model: 'Ceed', modelYear: 2022, seats: 3, plate: 'AA7441KC' }),
    });
    assert.equal(vehicleResponse.status, 201);
    const vehicle = await vehicleResponse.json() as { data: { id: string; verification_status: string; is_active: boolean } };
    apiCreatedVehicleId = vehicle.data.id;
    assert.equal(vehicle.data.verification_status, 'pending');
    assert.equal((vehicle.data as { trust_level?: number }).trust_level, 0, 'a new vehicle starts below level 1 until its photo is validated');
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
      body: JSON.stringify({ make: 'Skoda', model: 'Octavia', modelYear: 2023, seats: 4, plate: 'AA7441SO' }),
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

    // Level 1 is normally reached automatically when a validated photo is attached to a vehicle with a plate.
    await pool.query("UPDATE vehicles SET trust_level = 1 WHERE id = $1", [apiCreatedVehicleId]);
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

  it('matches community rides along the route in direction and flags date fallback', async () => {
    const corridorOfferId = crypto.randomUUID();
    const departureAt = new Date(Date.now() + 4 * 86_400_000);
    const arrivalAt = new Date(departureAt.getTime() + 6 * 60 * 60_000);
    await pool.query(`INSERT INTO offers(id,driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats)
      VALUES($1,$2,$3,'Дрогобич','Київ',
        ST_SetSRID(ST_MakePoint(23.5,49.35),4326)::geography,
        ST_SetSRID(ST_MakePoint(30.52,50.45),4326)::geography,
        ST_MakeLine(ARRAY[
          ST_SetSRID(ST_MakePoint(23.5,49.35),4326),
          ST_SetSRID(ST_MakePoint(23.8556,49.2603),4326),
          ST_SetSRID(ST_MakePoint(24.0297,49.8397),4326),
          ST_SetSRID(ST_MakePoint(30.52,50.45),4326)
        ]),$4,$5,600000,21600,'osrm',20000,4,3)`, [corridorOfferId, ids.driver, ids.vehicle, departureAt, arrivalAt]);

    const tripDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(departureAt);
    const search = async (from: number[], to: number[], date: string, seats = 1) => {
      const query = new URLSearchParams({
        origin: 'Стрий', destination: 'Львів', originLon: String(from[0]), originLat: String(from[1]),
        destinationLon: String(to[0]), destinationLat: String(to[1]), date, seats: String(seats),
      });
      const response = await fetch(`${apiUrl}/api/v1/offers?${query}`);
      assert.equal(response.status, 200);
      return (await response.json() as { data: Array<{ id: string; other_date: boolean }> }).data;
    };

    const stryi = [23.8556, 49.2603], lviv = [24.0297, 49.8397];
    const onRoute = await search(stryi, lviv, tripDay);
    assert.ok(onRoute.some((offer) => offer.id === corridorOfferId && !offer.other_date), 'a passenger along the route matches in the same direction on the chosen day');
    assert.equal((await search(lviv, stryi, tripDay)).some((offer) => offer.id === corridorOfferId), false, 'the route geometry must not match reverse travel');
    assert.equal((await search(stryi, lviv, tripDay, 4)).some((offer) => offer.id === corridorOfferId), false, 'a corridor match must still respect seat inventory');
    const fallback = await search(stryi, lviv, '2031-01-01');
    assert.ok(fallback.some((offer) => offer.id === corridorOfferId && offer.other_date), 'an empty requested day can return real inventory clearly marked as another date');
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
    const verifiedVehicle = await pool.query('SELECT verification_status,trust_level FROM vehicles WHERE id=$1', [apiCreatedVehicleId]);
    assert.equal(verifiedVehicle.rows[0].verification_status, 'verified');
    assert.equal(verifiedVehicle.rows[0].trust_level, 3, 'both document approvals raise the vehicle to the driver-verified trust level');
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
    await pool.query("UPDATE vehicles SET verification_status='verified',trust_level=3 WHERE id=$1", [apiCreatedVehicleId]);
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
    const passengerBookingsAfterReview = await fetch(`${apiUrl}/api/v1/bookings`, { headers: headers(passengerA) });
    assert.equal(passengerBookingsAfterReview.status, 200);
    const bookingAfterReview = (await passengerBookingsAfterReview.json() as {
      data: Array<{ id: string; current_user_has_review: boolean }>;
    }).data.find((item) => item.id === booking.data.id);
    assert.equal(bookingAfterReview?.current_user_has_review, true);
    const duplicateReview = await fetch(`${apiUrl}/api/v1/bookings/${booking.data.id}/reviews`, {
      method: 'POST', headers: headers(passengerA), body: JSON.stringify({ rating: 1 }),
    });
    assert.equal(duplicateReview.status, 409);
    const offerDate = new Date(Date.now() + 10 * 86400_000);
    const localOfferDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(offerDate);
    const ratedOffers = await fetch(`${apiUrl}/api/v1/offers?origin=API%20Publish%20Origin&destination=API%20Publish%20Destination&date=${localOfferDate}&seats=2`);
    const rated = (await ratedOffers.json() as { data: Array<{ average_rating: string | number; review_count: number }> }).data[0];
    assert.equal(Number(rated.average_rating), 5);
    assert.equal(rated.review_count, 2, 'one seeded Journey rating plus the completed lifecycle review');
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
    const unreadForDriver = await fetch(`${apiUrl}/api/v1/conversation-unread-counts`, { headers: headers(ids.driver) });
    assert.equal(unreadForDriver.status, 200);
    const driverUnread = await unreadForDriver.json() as { data: Array<{ conversation_id: string; booking_id: string; unread_count: number }> };
    assert.deepEqual(driverUnread.data.find((item) => item.conversation_id === conversation.data.id), {
      conversation_id: conversation.data.id, booking_id: booking.data.id, unread_count: 1,
    });
    const unreadForOutsider = await fetch(`${apiUrl}/api/v1/conversation-unread-counts`, { headers: headers(passengerB) });
    assert.equal(unreadForOutsider.status, 200);
    assert.equal((await unreadForOutsider.json() as { data: Array<{ conversation_id: string }> }).data.some((item) => item.conversation_id === conversation.data.id), false);
    const history = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}/messages`, {
      headers: headers(ids.driver),
    });
    assert.equal((await history.json() as { data: Array<{ body: string }> }).data[0].body, 'Підтверджую час виїзду.');
    const markRead = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}/read`, { method: 'POST', headers: headers(ids.driver) });
    assert.equal(markRead.status, 200);
    const driverReadState = (await markRead.json() as { data: { conversation_id: string; last_read_message_id: string; unread_count: number } }).data;
    assert.equal(driverReadState.conversation_id, conversation.data.id);
    assert.ok(driverReadState.last_read_message_id);
    assert.equal(driverReadState.unread_count, 0);
    const driverReply = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}/messages`, {
      method: 'POST', headers: headers(ids.driver), body: JSON.stringify({ body: 'Чекаю біля входу.' }),
    });
    assert.equal(driverReply.status, 201);
    const latestMessagePage = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}/messages?limit=1`, { headers: headers(ids.driver) });
    assert.equal(latestMessagePage.status, 200);
    const latestMessagePageBody = await latestMessagePage.json() as {
      data: { messages: Array<{ body: string }>; pagination: { hasMore: boolean; nextCursor: string | null } };
    };
    assert.deepEqual(latestMessagePageBody.data.messages.map((item) => item.body), ['Чекаю біля входу.']);
    assert.equal(latestMessagePageBody.data.pagination.hasMore, true);
    assert.ok(latestMessagePageBody.data.pagination.nextCursor);
    const olderMessagePage = await fetch(
      `${apiUrl}/api/v1/conversations/${conversation.data.id}/messages?limit=1&before=${encodeURIComponent(latestMessagePageBody.data.pagination.nextCursor!)}`,
      { headers: headers(ids.driver) },
    );
    assert.equal(olderMessagePage.status, 200);
    const olderMessagePageBody = await olderMessagePage.json() as {
      data: { messages: Array<{ body: string }>; pagination: { hasMore: boolean; nextCursor: string | null } };
    };
    assert.deepEqual(olderMessagePageBody.data.messages.map((item) => item.body), ['Підтверджую час виїзду.']);
    assert.equal(olderMessagePageBody.data.pagination.hasMore, false);
    assert.equal(olderMessagePageBody.data.pagination.nextCursor, null);
    const unreadForPassenger = await fetch(`${apiUrl}/api/v1/conversation-unread-counts`, { headers: headers(passengerA) });
    const passengerUnread = await unreadForPassenger.json() as { data: Array<{ conversation_id: string; unread_count: number }> };
    assert.equal(passengerUnread.data.find((item) => item.conversation_id === conversation.data.id)?.unread_count, 1);
    const passengerMarkRead = await fetch(`${apiUrl}/api/v1/conversations/${conversation.data.id}/read`, { method: 'POST', headers: headers(passengerA) });
    assert.equal(passengerMarkRead.status, 200);
    assert.equal((await passengerMarkRead.json() as { data: { unread_count: number } }).data.unread_count, 0);
    const invalidRead = await fetch(`${apiUrl}/api/v1/conversations/not-a-uuid/read`, { method: 'POST', headers: headers(passengerA) });
    assert.equal(invalidRead.status, 404);
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

  it('serves map layers only to signed-in users and rejects oversized or malformed viewports', async () => {
    const devUser = crypto.randomUUID();
    await pool.query(`INSERT INTO users(id,display_name,roles) VALUES($1,'Layer reader',ARRAY['passenger'])`, [devUser]);
    await pool.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'passenger')`, [devUser]);
    try {
      const headers = { 'x-dev-user-id': devUser };
      for (const path of ['layers', 'fares?city=Київ', 'routes?bbox=24,49,24.1,49.1&types=bus', 'stops?bbox=24,49,24.1,49.1&types=bus', 'vehicles?bbox=24,49,24.1,49.1&types=bus', 'micromobility?bbox=24,49,24.1,49.1&types=scooter', 'micromobility?bbox=24,49,24.1,49.1&types=carsharing']) {
        assert.equal((await fetch(`${apiUrl}/api/v1/transport/${path}`)).status, 401, `${path} requires sign-in`);
      }
      const layers = await fetch(`${apiUrl}/api/v1/transport/layers`, { headers });
      assert.equal(layers.status, 200);
      const ids = (await layers.json() as { data: Array<{ id: string; available: boolean }> }).data.map((item) => item.id);
      assert.deepEqual(ids, ['PUBLIC_TRANSPORT', 'BUS', 'MINIBUS', 'TROLLEYBUS', 'TRAM', 'METRO', 'TRAIN', 'CITY_TRAIN', 'FUNICULAR', 'CARPOOL', 'TAXI', 'TRANSFER', 'BICYCLE', 'SCOOTER', 'CARSHARING', 'STOPS', 'RENTAL_POINTS']);
      const faresResponse = await fetch(`${apiUrl}/api/v1/transport/fares?city=${encodeURIComponent('Київ')}`, { headers });
      assert.equal(faresResponse.status, 200);
      const fares = (await faresResponse.json() as { data: Array<{ id: string; priceMinor: number | null }> }).data;
      assert.equal(fares.find((fare) => fare.id === 'kyiv-communal-single-ride')?.priceMinor, 3_000);
      assert.equal(fares.find((fare) => fare.id === 'kyiv-90-minute-transfer-ticket')?.priceMinor, 6_000);
      assert.ok(fares.every((fare) => !fare.id.includes('taxi')), 'city-filtered public fares do not include taxi quotes');
      for (const path of ['routes?types=bus', 'routes?bbox=24,49,24.1,49.1', 'routes?bbox=20,45,30,55&types=bus', 'stops?bbox=24,49,25,50&types=bus', 'vehicles?bbox=x&types=bus', 'micromobility?bbox=24,49,25,50&types=scooter', 'micromobility?bbox=24,49,24.1,49.1&types=cars']) {
        assert.equal((await fetch(`${apiUrl}/api/v1/transport/${path}`, { headers })).status, 400, `${path} must be rejected`);
      }
      const empty = await fetch(`${apiUrl}/api/v1/transport/routes?bbox=-10,-10,-9.9,-9.9&types=bus`, { headers });
      assert.equal(empty.status, 200);
      assert.deepEqual((await empty.json() as { data: { features: unknown[] } }).data.features, []);
    } finally {
      await pool.query('DELETE FROM user_roles WHERE user_id=$1', [devUser]);
      await pool.query('DELETE FROM users WHERE id=$1', [devUser]);
    }
  });
});
