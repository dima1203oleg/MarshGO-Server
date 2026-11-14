import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { composeCommunityTransitJourneys, type CommunityRideOption, type TransitPathSummary } from '../server/journey/communityComposition';
import type { GtfsItinerary } from '../server/journey/gtfsTimetable';

// Carpool 5.0 CP5-A02 / gate G14: fare_basis must survive publication, booking,
// price edits and every passenger-facing offer read. TOTAL_ALL quotes the whole
// group price once; PER_SEAT multiplies by the seat count.
const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
const inventorySource = readFileSync(new URL('../server/bookings/seatInventory.ts', import.meta.url), 'utf8');

const extract = (start: string, end: string) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `cannot extract ${start}`);
  return source.slice(first, last);
};
const transpile = (code: string) => ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
const apiError = extract('class ApiError extends Error', '\nasync function usersBlockEachOther');

// Execute the real seat-inventory module so constants and occupancy SQL are not re-implemented.
const inventory: Record<string, any> = {};
runInNewContext(transpile(inventorySource), { exports: inventory, module: { exports: inventory } });
const { WHOLE_ROUTE_BOARDING, WHOLE_ROUTE_ALIGHTING, MAX_PARTIAL_ALIGHTING,
  maxOccupancyOverInterval, globalMaxOccupancy, recordOccupancy, releaseOccupancy, refreshAvailableSeats } = inventory;

type Handler = (req: any, res: any) => Promise<void>;
const insertColumns = (sql: string, table: string) => {
  const match = sql.match(new RegExp(`INSERT INTO ${table}\\(([^)]+)\\)`));
  assert.ok(match, `INSERT INTO ${table} not found`);
  return match[1].split(',').map((column) => column.trim());
};
// Map a column to its bound value through the VALUES placeholder ($n), because a
// placeholder can be reused (offers binds available_seats and total_seats to $16).
const columnValue = (sql: string, table: string, values: unknown[], column: string) => {
  const columns = insertColumns(sql, table);
  const index = columns.indexOf(column);
  if (index < 0) return undefined;
  const head = sql.match(new RegExp(`INSERT INTO ${table}\\([^)]+\\)\\s*VALUES\\s*\\(`));
  assert.ok(head);
  const items: string[] = [];
  let depth = 0, item = '';
  for (let i = head.index! + head[0].length; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === '(') depth += 1;
    if (char === ')') { if (depth === 0) { items.push(item); break; } depth -= 1; }
    if (char === ',' && depth === 0) { items.push(item); item = ''; continue; }
    item += char;
  }
  const placeholder = items[index]?.match(/\$(\d+)/);
  return placeholder ? values[Number(placeholder[1]) - 1] : undefined;
};
const responder = () => {
  const state = { status: 200, body: undefined as any };
  return { state, res: { status(value: number) { state.status = value; return this; }, json(value: any) { state.body = value; } } };
};
const rejected = (status: number, code?: string) => (error: unknown) => {
  const value = error as { status?: number; code?: string };
  assert.equal(value.status, status);
  if (code) assert.equal(value.code, code);
  return true;
};

function offersPostFixture() {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  let handler: Handler | undefined;
  const { state, res } = responder();
  const query = async (sql: string, values: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes('FROM vehicles v')) return { rows: [{ seat_count: 4, has_photo: true }] };
    if (sql.startsWith('INSERT INTO offers(')) {
      writes.push({ sql, values });
      const row: Record<string, unknown> = { id: 'offer', status: 'published' };
      for (const column of ['fare_basis', 'price_per_seat_minor', 'total_seats', 'available_seats']) {
        row[column] = columnValue(sql, 'offers', values, column);
      }
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO audit_events')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release() {} };
  runInNewContext(transpile(apiError + '\n' + extract("app.post('/api/v1/offers'", "\napp.get('/api/v1/bookings'")), {
    app: { post: (...args: any[]) => { handler = args[args.length - 1]; } },
    requireAuth: () => {}, requireRole: () => () => {}, asyncHandler: (registered: Handler) => registered,
    pool: { connect: async () => client }, process: { env: { NODE_ENV: 'test' } },
    MAX_PLACE_NAME_LENGTH: 300, getRoadRoute: async () => { throw new Error('road routing must stay disabled in this fixture'); },
    RoutingUnavailableError: class RoutingUnavailableError extends Error {},
  });
  assert.ok(handler);
  return {
    writes, state,
    invoke: (body: unknown) => handler!({ userId: 'driver', body }, res),
  };
}

const validOfferBody = {
  vehicleId: '11111111-1111-4111-8111-111111111111', originName: 'Лівий берег', destinationName: 'Правий берег',
  origin: [30.6, 50.4], destination: [30.5, 50.45], departureAt: new Date(Date.now() + 86400000).toISOString(),
  pricePerSeatMinor: 45000, seats: 2,
};

function bookingsFixture(options: { fareBasis: string; price: number; seats: number; totalSeats?: number }) {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const occupancy: unknown[] = [];
  const outbox: unknown[][] = [];
  const fees: number[] = [];
  let handler: Handler | undefined;
  const { state, res } = responder();
  const totalSeats = options.totalSeats ?? 4;
  const query = async (sql: string, values: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes('FROM offers WHERE id = $1 FOR UPDATE')) return { rows: [{
      price_per_seat_minor: options.price, currency: 'UAH', available_seats: totalSeats, total_seats: totalSeats,
      fare_basis: options.fareBasis, driver_id: 'driver', status: 'published', departure_at: new Date(Date.now() + 86400000),
    }] };
    if (sql.includes('FROM bookings WHERE passenger_id')) return { rows: [] };
    if (sql.includes('SELECT $2::smallint AS ord')) return { rows: [{ max_occ: 0 }] };
    if (sql.startsWith('INSERT INTO bookings(')) {
      writes.push({ sql, values });
      const row: Record<string, unknown> = { id: 'booking', status: 'confirmed' };
      for (const column of ['seat_count', 'unit_price_minor', 'total_price_minor', 'fare_basis', 'boarding_ordinal', 'alighting_ordinal']) {
        row[column] = columnValue(sql, 'bookings', values, column);
      }
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO seat_occupancy_intervals')) { occupancy.push(Array.from(values)); return { rows: [] }; }
    if (sql.includes('SELECT DISTINCT oi.boarding_ordinal')) return { rows: [{ max_occ: 0 }] };
    if (sql.startsWith('UPDATE offers SET available_seats')) return { rows: [{ available_seats: totalSeats - options.seats }] };
    if (/^INSERT INTO (conversations|booking_events|conversation_members|audit_events)/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release() {} };
  runInNewContext(transpile(apiError + '\n' + extract("app.post('/api/v1/bookings'", "\napp.post('/api/v1/bookings/:id/cancel'")), {
    app: { post: (...args: any[]) => { handler = args[args.length - 1]; } },
    requireAuth: () => {}, asyncHandler: (registered: Handler) => registered,
    pool: { connect: async () => client },
    WHOLE_ROUTE_BOARDING, WHOLE_ROUTE_ALIGHTING, MAX_PARTIAL_ALIGHTING,
    maxOccupancyOverInterval, recordOccupancy, refreshAvailableSeats,
    calculatePlatformFee: (total: number) => { fees.push(total); return { feeClass: 'community', platformFeeMinor: 0, ruleVersion: 'community-0pct-v1' }; },
    insertRealtimeOutbox: async (...args: unknown[]) => { outbox.push(args); },
  });
  assert.ok(handler);
  return {
    writes, occupancy, outbox, fees, state,
    invoke: (seats: number) => handler!({
      userId: 'passenger', body: { offerId: '22222222-2222-4222-8222-222222222222', seats },
      get: () => 'fare-basis-test-key-0001',
    }, res),
  };
}

function patchFixture(options: { bookingFareBasis: string; unitPrice: number; newPrice: number; seatCount: number }) {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  let handler: Handler | undefined;
  const { state, res } = responder();
  const query = async (sql: string, values: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes('FROM offers WHERE id=$1 AND driver_id=$2 FOR UPDATE')) return { rows: [{
      id: 'offer', status: 'published', departure_at: new Date(Date.now() + 86400000), arrival_at: null,
      price_per_seat_minor: options.unitPrice, total_seats: 4, available_seats: 2, vehicle_id: 'vehicle',
    }] };
    if (sql.includes('SELECT DISTINCT oi.boarding_ordinal')) return { rows: [{ max_occ: options.seatCount }] };
    if (sql.startsWith('UPDATE offers SET price_per_seat_minor')) return { rows: [{ id: 'offer', price_per_seat_minor: options.newPrice }] };
    if (sql.startsWith('INSERT INTO offer_changes')) return { rows: [] };
    if (sql.startsWith('INSERT INTO audit_events')) return { rows: [] };
    if (sql.includes("FROM bookings WHERE offer_id=$1 AND status='confirmed' FOR UPDATE")) return { rows: [{
      id: 'booking', passenger_id: 'passenger', seat_count: options.seatCount, unit_price_minor: options.unitPrice,
    }] };
    if (sql.startsWith('UPDATE bookings SET unit_price_minor')) { writes.push({ sql, values }); return { rows: [] }; }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release() {} };
  runInNewContext(transpile(apiError + '\n' + extract('const SIGNIFICANT_DEPARTURE_SHIFT_MS', "\napp.post('/api/v1/offers/:id/cancel'")), {
    app: { patch: (...args: any[]) => { handler = args[args.length - 1]; } },
    requireAuth: () => {}, requireRole: () => () => {}, asyncHandler: (registered: Handler) => registered,
    pool: { connect: async () => client }, globalMaxOccupancy,
    insertRealtimeOutbox: async () => {},
  });
  assert.ok(handler);
  return { writes, state, invoke: () => handler!({ params: { id: 'offer' }, userId: 'driver', body: { pricePerSeatMinor: options.newPrice } }, res) };
}

function decideFixture(options: { newUnit: number; seatCount: number }) {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  let handler: Handler | undefined;
  const { state, res } = responder();
  const query = async (sql: string, values: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes('FROM booking_change_approvals a')) return { rows: [{
      id: 'approval', status: 'pending', booking_id: 'booking', new_unit_price_minor: options.newUnit,
      passenger_id: 'passenger', driver_id: 'driver', offer_id: 'offer', seat_count: options.seatCount, booking_status: 'confirmed',
    }] };
    if (sql.startsWith('UPDATE bookings SET unit_price_minor')) { writes.push({ sql, values }); return { rows: [] }; }
    if (sql.startsWith('UPDATE booking_change_approvals')) return { rows: [] };
    if (sql.startsWith('INSERT INTO audit_events')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const client = { query, release() {} };
  runInNewContext(transpile(apiError + '\n' + extract('const decideBookingChange', "\napp.get('/api/v1/offers'")), {
    app: { post: (...args: any[]) => { if (String(args[0]).includes('/accept')) handler = args[args.length - 1]; } },
    requireAuth: () => {}, asyncHandler: (registered: Handler) => registered,
    pool: { connect: async () => client }, releaseOccupancy, refreshAvailableSeats,
    insertRealtimeOutbox: async () => {},
  });
  assert.ok(handler);
  return { writes, state, invoke: () => handler!({ params: { id: 'approval' }, userId: 'passenger' }, res) };
}

function readFixture(marker: string, end: string, method: 'get' = 'get') {
  const statements: string[] = [];
  let handler: Handler | undefined;
  const { state, res } = responder();
  const query = async (sql: string) => {
    statements.push(sql);
    return { rows: [{ id: 'offer', fare_basis: 'TOTAL_ALL', price_per_seat_minor: 45000, vehicle_photo_key: null }] };
  };
  runInNewContext(transpile(apiError + '\n' + extract(marker, end)), {
    app: { [method]: (...args: any[]) => { handler = args[args.length - 1]; } },
    requireAuth: () => {}, requireRole: () => () => {}, asyncHandler: (registered: Handler) => registered,
    pool: { query }, getVehiclePhotoUrl: async () => null, MAX_PLACE_NAME_LENGTH: 300,
  });
  assert.ok(handler);
  return { statements, state, invoke: () => handler!({ params: { id: '22222222-2222-4222-8222-222222222222' }, userId: 'passenger', query: { origin: 'Лівий берег', destination: 'Правий берег' } }, res) };
}

test('G14: publication accepts TOTAL_ALL and snapshots fare_basis into the offer row', async () => {
  const state = offersPostFixture();
  await state.invoke({ ...validOfferBody, fareBasis: 'TOTAL_ALL' });
  assert.equal(state.state.status, 201);
  const insert = state.writes.find((write) => write.sql.startsWith('INSERT INTO offers('));
  assert.ok(insert);
  const columns = insertColumns(insert.sql, 'offers');
  assert.ok(columns.includes('fare_basis'), 'offers INSERT must persist fare_basis');
  assert.equal(columnValue(insert.sql, 'offers', insert.values, 'fare_basis'), 'TOTAL_ALL');
  assert.equal(state.state.body.data.fare_basis, 'TOTAL_ALL');
});

test('publication defaults to PER_SEAT and rejects an unknown basis before any write', async () => {
  const defaults = offersPostFixture();
  await defaults.invoke(validOfferBody);
  const insert = defaults.writes.find((write) => write.sql.startsWith('INSERT INTO offers('));
  assert.ok(insert);
  const columns = insertColumns(insert.sql, 'offers');
  assert.ok(columns.includes('fare_basis'), 'offers INSERT must persist fare_basis');
  assert.equal(columnValue(insert.sql, 'offers', insert.values, 'fare_basis'), 'PER_SEAT');
  assert.equal(defaults.state.body.data.fare_basis, 'PER_SEAT');
  for (const fareBasis of ['HOURLY', 'total_all', '', null, 5]) {
    const invalid = offersPostFixture();
    await assert.rejects(invalid.invoke({ ...validOfferBody, fareBasis }), rejected(400));
    assert.equal(invalid.writes.length, 0);
  }
});

test('G14: a TOTAL_ALL booking keeps the quoted group total for two passengers', async () => {
  const state = bookingsFixture({ fareBasis: 'TOTAL_ALL', price: 45000, seats: 2 });
  await state.invoke(2);
  assert.equal(state.state.status, 201);
  assert.equal(state.state.body.data.total_price_minor, 45000, 'TOTAL_ALL 450 UAH must remain 450 UAH for two passengers');
  assert.equal(state.state.body.data.fare_basis, 'TOTAL_ALL');
  assert.equal(state.state.body.data.unit_price_minor, 45000);
  assert.deepEqual(state.fees, [45000]);
  assert.deepEqual(state.occupancy, [['22222222-2222-4222-8222-222222222222', 'booking', WHOLE_ROUTE_BOARDING, WHOLE_ROUTE_ALIGHTING, 2]]);
  assert.equal(state.outbox.length, 1);
});

test('G14: a PER_SEAT booking still multiplies the unit price by the seat count', async () => {
  const state = bookingsFixture({ fareBasis: 'PER_SEAT', price: 15000, seats: 2 });
  await state.invoke(2);
  assert.equal(state.state.status, 201);
  assert.equal(state.state.body.data.total_price_minor, 30000);
  assert.equal(state.state.body.data.fare_basis, 'PER_SEAT');
  assert.deepEqual(state.fees, [30000]);
});

test('G14: a driver price drop applies the group total once for TOTAL_ALL bookings', async () => {
  const state = patchFixture({ bookingFareBasis: 'TOTAL_ALL', unitPrice: 45000, newPrice: 40000, seatCount: 2 });
  await state.invoke();
  assert.equal(state.state.status, 200);
  const update = state.writes.find((write) => write.sql.startsWith('UPDATE bookings SET unit_price_minor'));
  assert.ok(update, 'a cheaper price must update the confirmed booking');
  assert.equal(update.values[1], 40000);
  assert.ok(update.sql.includes('fare_basis') && update.sql.includes('CASE'),
    'the total must branch on the booking fare_basis, not blindly multiply by seat_count');
  assert.ok(!update.sql.includes('$2*seat_count'), 'blind multiplication doubles a TOTAL_ALL group price');
});

test('G14: accepting a significant price change keeps the TOTAL_ALL total unmultiplied', async () => {
  const state = decideFixture({ newUnit: 48000, seatCount: 2 });
  await state.invoke();
  assert.equal(state.state.status, 200);
  const update = state.writes.find((write) => write.sql.startsWith('UPDATE bookings SET unit_price_minor'));
  assert.ok(update);
  assert.equal(update.values[1], 48000);
  assert.ok(update.sql.includes('fare_basis') && update.sql.includes('CASE'));
  assert.ok(!update.sql.includes('$2*seat_count'));
});

test('offer search, detail and mine all select fare_basis for the passenger and driver', async () => {
  const list = readFixture("app.get('/api/v1/offers'", "\napp.get('/api/v1/offers/:id'");
  await list.invoke();
  assert.ok(list.statements.some((sql) => sql.includes('fare_basis')), 'search SELECT must include fare_basis');
  const detail = readFixture("app.get('/api/v1/offers/:id'", '\nconst journeySelect');
  await detail.invoke();
  assert.ok(detail.statements.some((sql) => sql.includes('fare_basis')), 'detail SELECT must include fare_basis');
  const mine = readFixture("app.get('/api/v1/offers/mine'", '\n// ---- Editing a published trip');
  await mine.invoke();
  assert.ok(mine.statements.some((sql) => sql.includes('fare_basis')), 'mine SELECT must include fare_basis');
});

test('G14: a multimodal carpool leg quotes TOTAL_ALL once, PER_SEAT per passenger', () => {
  const base = Date.parse('2026-10-12T08:00:00Z');
  const at = (minutes: number) => new Date(base + minutes * 60_000);
  const prefix: TransitPathSummary = {
    id: 'bus-prefix', segments: [{ mode: 'BUS', providerId: 'provider-BUS' } as GtfsItinerary['segments'][number]],
    departureAt: at(0), arrivalAt: at(30), durationSeconds: 30 * 60, waitingSeconds: 180, transfers: 0,
    walkingMeters: 250, fare: { currency: 'UAH', priceMinor: 1500 } as GtfsItinerary['fare'],
  } as TransitPathSummary;
  const ride = (fareBasis: 'PER_SEAT' | 'TOTAL_ALL'): CommunityRideOption => ({
    id: 'offer-1', driverId: 'driver-1', departureAt: at(40), arrivalAt: at(70),
    origin: { name: 'Pickup', coordinates: [24.0315, 49.8419] },
    destination: { name: 'Dropoff', coordinates: [24.0628, 49.7915] },
    distanceMeters: 12_000, pricePerSeatMinor: 45000, fareBasis, currency: 'UAH', availableSeats: 2,
    routeGeometry: [[24.0315, 49.8419], [24.0628, 49.7915]], snapshotAt: at(0), metadata: {},
  });
  const compose = (fareBasis: 'PER_SEAT' | 'TOTAL_ALL') => composeCommunityTransitJourneys({
    offer: ride(fareBasis), prefixes: [prefix], suffixes: [], requestedDepartureAt: at(0),
    origin: [24.0315, 49.8419], destination: [24.0628, 49.7915], passengers: 2,
    minimumTransferBufferSeconds: 600, maximumDurationSeconds: 4 * 60 * 60,
  })[0];
  assert.equal(compose('TOTAL_ALL')?.priceMinor, 1500 + 45000, 'TOTAL_ALL group price must not be doubled for two passengers');
  assert.equal(compose('PER_SEAT')?.priceMinor, 1500 + 90000, 'PER_SEAT still multiplies by the passenger count');
});