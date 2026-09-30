import 'dotenv/config';
import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { Pool, PoolClient } from 'pg';
import { WebSocket, WebSocketServer } from 'ws';
import { createClient } from 'redis';
import { RedisRateLimitStore } from './redisRateLimitStore';
import type { Duplex } from 'node:stream';
import { sendVerificationCode, SmsProviderUnavailableError } from './sms';
import { getRoadRoute, getRoadRouteThroughPoints, RoutingUnavailableError } from './routing';
import { calculatePlatformFee } from './fees';
import { validateRuntimeConfig } from './config';
import { parseJourneySearchRequest } from './journey/search';
import { selectRepresentativeJourneys } from './journey/scoring';
import { JOURNEY_STRATEGIES, type JourneyOption, type JourneyStrategy } from './journey/types';
import { GeocodingUnavailableError, suggestPlaces } from './geocoding';
import {
  createVehiclePhotoUpload, createVerificationEvidenceUpload, deleteStoredVehiclePhoto, getVehiclePhotoUrl,
  getVerificationEvidenceUrl, isAllowedPhotoType, isAllowedVerificationEvidenceType, ObjectStorageUnavailableError, StoredEvidenceUnavailableError,
  verifyVehiclePhotoObject, verifyVerificationEvidenceObject,
} from './objectStorage';

const app = express();
validateRuntimeConfig(process.env);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12, idleTimeoutMillis: 30_000 });
type RealtimeTicket = { userId: string; sessionId: string; expiresAt: number };
type RealtimeMessage = { id: string; conversation_id: string; sender_id: string; sender_name: string; body: string; created_at: Date };
const realtimeTickets = new Map<string, RealtimeTicket>();
const realtimeClients = new Map<string, Set<WebSocket>>();
const realtimeInstanceId = crypto.randomUUID();
const realtimeChannel = 'marshgo:realtime:v1';
const realtimeTicketKey = (hash: string) => `marshgo:realtime-ticket:${hash}`;
type RedisConnection = ReturnType<typeof createClient>;
let realtimeRedis: RedisConnection | undefined;
let realtimeSubscriber: RedisConnection | undefined;
const realtimeSessionBySocket = new WeakMap<WebSocket, string>();
const aliveRealtimeSockets = new WeakSet<WebSocket>();
const realtimeServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
let realtimeOutboxTimer: NodeJS.Timeout | undefined;
let realtimeOutboxDispatch: Promise<void> | undefined;
function closeRealtimeConnectionsLocally(userId: string, sessionId?: string) {
  for (const client of realtimeClients.get(userId) ?? []) {
    if (!sessionId || realtimeSessionBySocket.get(client) === sessionId) client.close(1008, 'session revoked');
  }
}
function closeRealtimeConnections(userId: string, sessionId?: string) {
  closeRealtimeConnectionsLocally(userId, sessionId);
  if (process.env.REDIS_URL && realtimeRedis?.isReady) {
    void realtimeRedis.publish(realtimeChannel, JSON.stringify({ instanceId: realtimeInstanceId, kind: 'session.revoke', userId, sessionId }))
      .catch((error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'realtime.revoke_publish_failed', message: error instanceof Error ? error.message : 'unknown_error' })));
  }
}
function deliverRealtime(userIds: string[], event: string) {
  for (const userId of userIds) {
    for (const client of realtimeClients.get(userId) ?? []) {
      if (client.readyState === WebSocket.OPEN) client.send(event);
    }
  }
}
const supportedOutboxEvents = new Set([
  'conversation.message.created', 'booking.confirmed', 'booking.cancelled', 'booking.changed',
  'proposal.created', 'proposal.countered', 'proposal.updated', 'proposal.accepted', 'proposal.closed',
  'navigation.match.driver-interested', 'navigation.match.passenger-confirmed', 'navigation.route-updated',
]);
async function insertRealtimeOutbox(
  client: PoolClient,
  eventType: string,
  dedupeKey: string,
  recipientIds: string[],
  payload: Record<string, unknown>,
) {
  if (!supportedOutboxEvents.has(eventType) || recipientIds.length === 0) throw new Error('invalid realtime outbox event');
  await client.query(
    `INSERT INTO realtime_outbox(event_type,dedupe_key,recipient_ids,payload)
     VALUES($1,$2,$3,$4::jsonb)`,
    [eventType, dedupeKey, [...new Set(recipientIds)], JSON.stringify(payload)],
  );
}
async function broadcastRealtime(userIds: string[], type: string, data: unknown) {
  const event = JSON.stringify({ type, data });
  if (process.env.REDIS_URL) {
    if (!realtimeRedis?.isReady) throw new Error('Redis is not ready for realtime event delivery');
    await realtimeRedis.publish(realtimeChannel, JSON.stringify({ instanceId: realtimeInstanceId, kind: 'event', userIds, event }));
  }
  deliverRealtime(userIds, event);
}
type RealtimeOutboxRow = { id: string; event_type: string; recipient_ids: string[]; payload: unknown; attempt_count: number };
let lastRealtimeOutboxCleanupAt = 0;
async function dispatchRealtimeOutbox() {
  if (process.env.REDIS_URL && !realtimeRedis?.isReady) throw new Error('Redis is not ready for realtime outbox delivery');
  if (Date.now() - lastRealtimeOutboxCleanupAt > 60 * 60 * 1000) {
    await pool.query(
      `DELETE FROM realtime_outbox WHERE id IN (
         SELECT id FROM realtime_outbox WHERE published_at<now()-interval '7 days' ORDER BY published_at LIMIT 1000
       )`,
    );
    lastRealtimeOutboxCleanupAt = Date.now();
  }
  const client = await pool.connect();
  let rows: RealtimeOutboxRow[];
  try {
    await client.query('BEGIN');
    const claimed = await client.query<RealtimeOutboxRow>(
      `WITH available AS (
         SELECT id FROM realtime_outbox
          WHERE published_at IS NULL AND available_at<=now() AND (locked_until IS NULL OR locked_until<now())
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 25
       )
       UPDATE realtime_outbox o SET locked_until=now()+interval '30 seconds',attempt_count=o.attempt_count+1
        FROM available WHERE o.id=available.id
       RETURNING o.id,o.event_type,o.recipient_ids::text[] AS recipient_ids,o.payload,o.attempt_count`,
    );
    rows = claimed.rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }

  for (const row of rows) {
    try {
      if (!supportedOutboxEvents.has(row.event_type)) throw new Error(`unsupported realtime outbox event type: ${row.event_type}`);
      if (!Array.isArray(row.recipient_ids) || row.recipient_ids.length === 0) throw new Error(`invalid realtime outbox recipients: ${typeof row.recipient_ids}`);
      await broadcastRealtime(row.recipient_ids, row.event_type, row.payload);
      await pool.query('UPDATE realtime_outbox SET published_at=now(),locked_until=NULL,last_error=NULL WHERE id=$1', [row.id]);
    } catch (error) {
      const retrySeconds = Math.min(300, 2 ** Math.min(Number(row.attempt_count) || 1, 8));
      await pool.query(
        `UPDATE realtime_outbox SET available_at=now()+($2::double precision*interval '1 second'),locked_until=NULL,last_error=$3 WHERE id=$1`,
        [row.id, retrySeconds, error instanceof Error ? error.message.slice(0, 500) : 'unknown_error'],
      );
      console.error(JSON.stringify({ level: 'error', event: 'realtime.outbox_retry', outboxId: row.id, attempt: row.attempt_count, retrySeconds }));
    }
  }
}
const port = Number(process.env.API_PORT || 3002);
const host = process.env.API_HOST || '127.0.0.1';
const allowedOrigins = new Set((process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,capacitor://localhost').split(',').map((origin) => origin.trim()));
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const accessLifetimeMs = 15 * 60 * 1000;
const refreshLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const rateLimitPrefix = process.env.API_RATE_LIMIT_PREFIX || 'marshgo:rate-limit:v1:';
const placeSearchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  ...(process.env.REDIS_URL ? { store: new RedisRateLimitStore(() => realtimeRedis, `${rateLimitPrefix}place-search:`) } : {}),
});
const apiRateLimitWindowMs = Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const apiRateLimitLimit = Number(process.env.API_RATE_LIMIT_LIMIT) || 300;
const apiRateLimitStore = process.env.REDIS_URL ? new RedisRateLimitStore(() => realtimeRedis, rateLimitPrefix) : undefined;

app.disable('x-powered-by');
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key');
    return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '32kb', strict: true }));
app.use('/api', rateLimit({
  windowMs: apiRateLimitWindowMs,
  limit: apiRateLimitLimit,
  ...(apiRateLimitStore ? { store: apiRateLimitStore } : {}),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limit_exceeded', message: 'Too many requests', requestId: res.locals.requestId } }),
}));

type AuthenticatedRequest = Request & { userId?: string; sessionId?: string };
function sha256(value: string) { return crypto.createHash('sha256').update(value).digest('hex'); }
function otpHash(phone: string, code: string) { return crypto.createHmac('sha256', sessionSecret).update(`${phone}:${code}`).digest('hex'); }
function token() { return crypto.randomBytes(32).toString('base64url'); }
type BookingTicketClaims = { bookingId: string; expiresAt: number; nonce: string; version: 1 };
function createBookingTicket(bookingId: string, departureAt: Date) {
  const expiresAt = Math.floor((departureAt.getTime() + 24 * 60 * 60 * 1000) / 1000);
  const claims: BookingTicketClaims = { bookingId, expiresAt, nonce: token(), version: 1 };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return { token: `${payload}.${signature}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
}
function validBookingTicket(value: unknown, bookingId: string) {
  if (typeof value !== 'string') return false;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url'));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as BookingTicketClaims;
    return claims.version === 1 && claims.bookingId === bookingId && Number.isInteger(claims.expiresAt) && claims.expiresAt > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
function cookieValue(req: Request, name: string) {
  const value = req.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value ? decodeURIComponent(value) : undefined;
}
function setRefreshCookie(res: Response, value: string, maxAgeMs: number) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `mg_refresh=${encodeURIComponent(value)}; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`);
}
function clearRefreshCookie(res: Response) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `mg_refresh=; Path=/api/v1/auth; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}
async function insertSession(client: PoolClient, userId: string, familyId: string = crypto.randomUUID()) {
  const accessToken = token();
  const refreshToken = token();
  const accessExpiresAt = new Date(Date.now() + accessLifetimeMs);
  const refreshExpiresAt = new Date(Date.now() + refreshLifetimeMs);
  await client.query(
    `INSERT INTO sessions(user_id,token_hash,expires_at,refresh_token_hash,refresh_expires_at,family_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, sha256(accessToken), accessExpiresAt.toISOString(), sha256(refreshToken), refreshExpiresAt.toISOString(), familyId],
  );
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}
function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const bearer = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    pool.query<{ id: string; user_id: string }>(
      `SELECT s.id,s.user_id FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.account_status='active'`,
      [sha256(bearer)],
    ).then(({ rows }) => {
      if (!rows[0]) return res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required', requestId: res.locals.requestId } });
      req.userId = rows[0].user_id;
      req.sessionId = rows[0].id;
      next();
    }).catch(next);
    return;
  }

  // Explicit local-only escape hatch for API development; never accepted in production.
  const devUserId = req.get('x-dev-user-id');
  if (process.env.NODE_ENV === 'development' && process.env.AUTH_DEV_BYPASS === 'true' && devUserId) {
    req.userId = devUserId;
    next();
    return;
  }
  res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required', requestId: res.locals.requestId } });
}

class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code = message.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')) { super(message); }
}
async function usersBlockEachOther(userA: string, userB: string, executor: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = pool) {
  const { rows } = await executor.query<{ blocked: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)) AS blocked',
    [userA, userB],
  );
  return rows[0]?.blocked === true;
}
const asyncHandler = (handler: (req: AuthenticatedRequest, res: Response) => Promise<void>) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };
function requireRole(role: 'driver' | 'passenger') {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    pool.query<{ allowed: boolean }>('SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role=$2) AS allowed', [req.userId, role])
      .then(({ rows }) => {
        if (!rows[0]) return res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required', requestId: res.locals.requestId } });
        if (!rows[0].allowed) return res.status(403).json({ error: { code: 'forbidden', message: 'Required role is missing', requestId: res.locals.requestId } });
        next();
      }).catch(next);
  };
}
function requireStaff(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  pool.query<{ allowed: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role IN ('admin','moderator')) AS allowed`, [req.userId],
  ).then(({ rows }) => {
    if (!rows[0]) return res.status(401).json({ error: { code: 'unauthorized', message: 'Authentication required', requestId: res.locals.requestId } });
    if (!rows[0].allowed) return res.status(403).json({ error: { code: 'forbidden', message: 'Staff role is required', requestId: res.locals.requestId } });
    next();
  }).catch(next);
}

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/readyz', asyncHandler(async (_req, res) => {
  await pool.query('SELECT 1');
  const redisReady = !process.env.REDIS_URL || realtimeRedis?.isReady === true;
  const status = redisReady ? 'ready' : 'degraded';
  res.status(redisReady ? 200 : 503).json({ status, database: 'connected', realtime: redisReady ? 'connected' : 'disconnected' });
}));

app.get('/api/v1/admin/ops/realtime', requireAuth, requireStaff, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query<{
    pending_count: string;
    retrying_count: string;
    max_attempt_count: number;
    oldest_pending_seconds: number | null;
    oldest_locked_seconds: number | null;
    last_published_at: Date | null;
  }>(
    `SELECT count(*) FILTER (WHERE published_at IS NULL)::text AS pending_count,
       count(*) FILTER (WHERE published_at IS NULL AND attempt_count>0)::text AS retrying_count,
       COALESCE(max(attempt_count) FILTER (WHERE published_at IS NULL),0)::int AS max_attempt_count,
       EXTRACT(EPOCH FROM (now()-min(created_at) FILTER (WHERE published_at IS NULL)))::int AS oldest_pending_seconds,
       EXTRACT(EPOCH FROM (now()-(min(locked_until) FILTER (WHERE published_at IS NULL AND locked_until>now())-interval '30 seconds')))::int AS oldest_locked_seconds,
       max(published_at) AS last_published_at
     FROM realtime_outbox`,
  );
  res.json({ data: {
    ...rows[0],
    pending_count: Number(rows[0].pending_count),
    retrying_count: Number(rows[0].retrying_count),
    redis: process.env.REDIS_URL ? (realtimeRedis?.isReady ? 'connected' : 'disconnected') : 'single_process_development',
  } });
}));

app.post('/api/v1/routing/route', requireAuth, asyncHandler(async (req, res) => {
  const { origin, destination } = req.body ?? {};
  const isPoint = (point: unknown) => Array.isArray(point) && point.length === 2 && point.every((value) => typeof value === 'number' && Number.isFinite(value));
  if (!isPoint(origin) || !isPoint(destination) || Math.abs(origin[0]) > 180 || Math.abs(origin[1]) > 90 || Math.abs(destination[0]) > 180 || Math.abs(destination[1]) > 90) {
    throw new ApiError(400, 'origin and destination must be WGS84 coordinate pairs');
  }
  try {
    res.json({ data: await getRoadRoute(origin as [number, number], destination as [number, number]) });
  } catch (error) {
    if (error instanceof RoutingUnavailableError) throw new ApiError(503, error.message, 'routing_unavailable');
    throw error;
  }
}));

type NavigationMatch = {
  demandId: string; pickupEta: Date; detourDistanceM: number; detourDurationS: number;
  expiresAt: Date;
};

async function listNavigationMatches(sessionId: string, driverId: string) {
  const { rows } = await pool.query(
    `SELECT c.id,c.demand_id,c.status,c.detour_distance_m,c.detour_duration_s,c.pickup_eta,c.computed_at,c.expires_at,
       d.origin_name,d.destination_name,d.earliest_departure,d.latest_departure,d.passenger_count,d.budget_minor,d.budget_type,d.notes,d.requirements,
       v.make AS vehicle_make,v.model AS vehicle_model
     FROM navigation_match_candidates c
     JOIN navigation_sessions s ON s.id=c.navigation_session_id AND s.driver_id=$2
     JOIN passenger_demands d ON d.id=c.demand_id
     LEFT JOIN vehicles v ON v.id=s.vehicle_id
     WHERE c.navigation_session_id=$1 AND s.state IN ('active','paused') AND c.status NOT IN ('dismissed','expired') AND c.expires_at>now() AND d.status='open'
       AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=d.passenger_id AND b.blocked_id=s.driver_id) OR (b.blocker_id=s.driver_id AND b.blocked_id=d.passenger_id))
     ORDER BY c.status='driver_interested' DESC,c.detour_duration_s,c.pickup_eta LIMIT 20`, [sessionId, driverId],
  );
  return rows;
}

async function refreshNavigationMatches(sessionId: string, driverId: string) {
  const { rows: sessions } = await pool.query<{
    state: string; opt_in: boolean; vehicle_seat_count: number | null; current_location: [number, number] | null;
    current_location_at: Date | null; destination: [number, number] | null; route_version: number;
  }>(
    `SELECT state,opt_in,vehicle_seat_count,route_version,
       CASE WHEN current_location IS NULL THEN NULL ELSE ARRAY[ST_X(current_location::geometry),ST_Y(current_location::geometry)] END AS current_location,
       CASE WHEN destination IS NULL THEN NULL ELSE ARRAY[ST_X(destination::geometry),ST_Y(destination::geometry)] END AS destination,
       current_location_at
     FROM navigation_sessions WHERE id=$1 AND driver_id=$2`, [sessionId, driverId],
  );
  const session = sessions[0];
  if (!session) throw new ApiError(404, 'navigation session unavailable');
  if (session.state !== 'active' || !session.opt_in) throw new ApiError(409, 'Pause navigation and opt in before looking for passengers', 'matching_not_enabled');
  if (!session.vehicle_seat_count) throw new ApiError(409, 'A verified active vehicle is required for passenger matching', 'verified_vehicle_required');
  if (!session.current_location || !session.destination || !session.current_location_at || Date.now() - new Date(session.current_location_at).getTime() > 60_000) {
    throw new ApiError(409, 'A fresh GPS fix is required for route matching', 'location_stale');
  }

  const corridorMeters = Math.max(500, Math.min(10_000, Number(process.env.NAVIGATION_MATCH_CORRIDOR_METERS) || 3_000));
  const maxDetourMeters = Math.max(1_000, Math.min(100_000, Number(process.env.NAVIGATION_MATCH_MAX_DETOUR_METERS) || 25_000));
  const maxDetourSeconds = Math.max(300, Math.min(7_200, Number(process.env.NAVIGATION_MATCH_MAX_DETOUR_SECONDS) || 1_800));
  const { rows: demands } = await pool.query<{
    id: string; origin_name: string; destination_name: string; origin: [number, number]; destination: [number, number];
    earliest_departure: Date; latest_departure: Date; passenger_count: number;
  }>(
    `WITH remaining AS (
       SELECT s.id, ST_LineSubstring(s.route,
         LEAST(1, GREATEST(0, ST_LineLocatePoint(s.route, s.current_location::geometry))), 1) AS route
       FROM navigation_sessions s WHERE s.id=$1 AND s.driver_id=$2
     )
     SELECT d.id,d.origin_name,d.destination_name,
       ARRAY[ST_X(d.origin::geometry),ST_Y(d.origin::geometry)] AS origin,
       ARRAY[ST_X(d.destination::geometry),ST_Y(d.destination::geometry)] AS destination,
       d.earliest_departure,d.latest_departure,d.passenger_count
     FROM passenger_demands d JOIN navigation_sessions s ON s.id=$1 JOIN remaining r ON r.id=s.id
     WHERE s.driver_id=$2 AND s.state='active' AND s.opt_in=true AND d.status='open' AND d.passenger_id<>$2
       AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=d.passenger_id AND b.blocked_id=$2) OR (b.blocker_id=$2 AND b.blocked_id=d.passenger_id))
       AND d.latest_departure>now() AND d.earliest_departure<now()+interval '12 hours'
       AND d.passenger_count<=s.vehicle_seat_count
       AND ST_DWithin(s.route::geography,d.origin,$3)
       AND ST_DWithin(s.route::geography,d.destination,$3)
       AND ST_DWithin(r.route::geography,d.origin,$3)
       AND ST_DWithin(r.route::geography,d.destination,$3)
       AND ST_LineLocatePoint(s.route,d.origin::geometry)>ST_LineLocatePoint(s.route,s.current_location::geometry)
       AND ST_LineLocatePoint(s.route,d.destination::geometry)>ST_LineLocatePoint(s.route,d.origin::geometry)
     ORDER BY d.earliest_departure LIMIT 8`, [sessionId, driverId, corridorMeters],
  );
  if (!demands.length) return [];

  let baseline: Awaited<ReturnType<typeof getRoadRoute>>;
  try { baseline = await getRoadRoute(session.current_location, session.destination); }
  catch (error) {
    if (error instanceof RoutingUnavailableError) throw new ApiError(503, error.message, 'routing_unavailable');
    throw error;
  }
  const now = Date.now();
  const evaluated = await Promise.all(demands.map(async (demand): Promise<NavigationMatch | null> => {
    try {
      const [toPickup, withPassenger] = await Promise.all([
        getRoadRoute(session.current_location!, demand.origin),
        getRoadRouteThroughPoints([session.current_location!, demand.origin, demand.destination, session.destination!]),
      ]);
      const pickupEta = new Date(now + toPickup.durationSeconds * 1000);
      if (pickupEta < new Date(demand.earliest_departure) || pickupEta > new Date(demand.latest_departure)) return null;
      const detourDistanceM = Math.max(0, Math.round(withPassenger.distanceMeters - baseline.distanceMeters));
      const detourDurationS = Math.max(0, Math.round(withPassenger.durationSeconds - baseline.durationSeconds));
      if (detourDistanceM > maxDetourMeters || detourDurationS > maxDetourSeconds) return null;
      return {
        demandId: demand.id, pickupEta, detourDistanceM, detourDurationS,
        expiresAt: new Date(Math.min(new Date(demand.latest_departure).getTime() + 30 * 60_000, now + 5 * 60_000)),
      };
    } catch (error) {
      if (error instanceof RoutingUnavailableError) throw new ApiError(503, error.message, 'routing_unavailable');
      throw error;
    }
  }));
  const matches = evaluated.filter((match): match is NavigationMatch => Boolean(match));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ state: string; opt_in: boolean; route_version: number }>(
      'SELECT state,opt_in,route_version FROM navigation_sessions WHERE id=$1 AND driver_id=$2 FOR UPDATE', [sessionId, driverId],
    );
    if (!current.rows[0] || current.rows[0].state !== 'active' || !current.rows[0].opt_in || Number(current.rows[0].route_version) !== Number(session.route_version)) {
      throw new ApiError(409, 'Navigation session changed during matching; refresh candidates', 'navigation_session_changed');
    }
    await client.query(
      `UPDATE navigation_match_candidates SET status='expired' WHERE navigation_session_id=$1 AND status='suggested' AND expires_at<=now()`, [sessionId],
    );
    for (const match of matches) {
      await client.query(
        `INSERT INTO navigation_match_candidates(navigation_session_id,demand_id,route_version,detour_distance_m,detour_duration_s,pickup_eta,expires_at)
         SELECT $1,d.id,$3,$4,$5,$6,$7 FROM passenger_demands d WHERE d.id=$2 AND d.status='open' AND d.latest_departure>now()
         ON CONFLICT(navigation_session_id,demand_id) DO UPDATE SET route_version=EXCLUDED.route_version,
           detour_distance_m=EXCLUDED.detour_distance_m,detour_duration_s=EXCLUDED.detour_duration_s,pickup_eta=EXCLUDED.pickup_eta,
           computed_at=now(),expires_at=EXCLUDED.expires_at
         WHERE navigation_match_candidates.status IN ('suggested','expired')`,
        [sessionId, match.demandId, session.route_version, match.detourDistanceM, match.detourDurationS, match.pickupEta.toISOString(), match.expiresAt.toISOString()],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  return listNavigationMatches(sessionId, driverId);
}

// Foreground navigation stores only the driver's latest location. It is private to the
// authenticated driver and removed when the session ends. Matching starts opt-in only.
app.post('/api/v1/navigation/sessions', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { origin, destination, destinationName } = req.body ?? {};
  const pointValid = (point: unknown) => Array.isArray(point) && point.length === 2 &&
    point.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
  if (!pointValid(origin) || !pointValid(destination) || typeof destinationName !== 'string' ||
      destinationName.trim().length < 1 || destinationName.trim().length > 120) {
    throw new ApiError(400, 'A GPS origin, destination coordinates and destination name are required');
  }
  let route: Awaited<ReturnType<typeof getRoadRoute>>;
  try { route = await getRoadRoute(origin as [number, number], destination as [number, number]); }
  catch (error) {
    if (error instanceof RoutingUnavailableError) throw new ApiError(503, error.message, 'routing_unavailable');
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.userId]);
    const active = await client.query('SELECT id FROM navigation_sessions WHERE driver_id=$1 AND state IN (\'active\',\'paused\')', [req.userId]);
    if (active.rows[0]) throw new ApiError(409, 'End the existing navigation session before starting another', 'navigation_already_active');
    const verifiedVehicle = await client.query<{ id: string; seat_count: number }>(
      `SELECT id,seat_count FROM vehicles WHERE owner_id=$1 AND is_active=true AND verification_status='verified' AND archived_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR SHARE`, [req.userId],
    );
    const matchingVehicle = verifiedVehicle.rows[0];
    const { rows } = await client.query(
      `INSERT INTO navigation_sessions(driver_id,vehicle_id,vehicle_seat_count,destination_name,destination,route,route_distance_m,route_duration_s)
       VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,
         ST_SetSRID(ST_GeomFromGeoJSON($7),4326),$8,$9)
       RETURNING id,state,destination_name,route_distance_m,route_duration_s,route_version,opt_in,started_at,vehicle_id,vehicle_seat_count,(vehicle_id IS NOT NULL) AS matching_vehicle_available`,
      [req.userId, matchingVehicle?.id ?? null, matchingVehicle ? Number(matchingVehicle.seat_count) : null, destinationName.trim(), destination[0], destination[1],
        JSON.stringify({ type: 'LineString', coordinates: route.geometry }), Math.round(route.distanceMeters), Math.round(route.durationSeconds)],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4)', [req.userId, 'navigation.started', 'navigation_session', rows[0].id]);
    await client.query('COMMIT');
    res.status(201).json({ data: { ...rows[0], route: route.geometry, current_location: origin, current_location_accuracy_m: null, current_location_at: null } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.get('/api/v1/navigation/sessions/active', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,state,destination_name,route_distance_m,route_duration_s,route_version,opt_in,started_at,ended_at,vehicle_id,vehicle_seat_count,(vehicle_id IS NOT NULL) AS matching_vehicle_available,
       ST_AsGeoJSON(route)::json->'coordinates' AS route,
       CASE WHEN current_location IS NULL THEN NULL ELSE json_build_array(ST_X(current_location::geometry),ST_Y(current_location::geometry)) END AS current_location,
       current_location_accuracy_m,current_location_at
     FROM navigation_sessions WHERE driver_id=$1 AND state IN ('active','paused') LIMIT 1`, [req.userId],
  );
  res.json({ data: rows[0] ?? null });
}));

app.patch('/api/v1/navigation/sessions/:id/matching', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') throw new ApiError(400, 'enabled must be a boolean');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ state: string; vehicle_id: string | null; vehicle_seat_count: number | null }>(
      `SELECT state,vehicle_id,vehicle_seat_count FROM navigation_sessions WHERE id=$1 AND driver_id=$2 FOR UPDATE`, [req.params.id, req.userId],
    );
    const session = rows[0];
    if (!session || !['active','paused'].includes(session.state)) throw new ApiError(404, 'navigation session unavailable');
    if (enabled && (!session.vehicle_id || !session.vehicle_seat_count)) throw new ApiError(409, 'A verified active vehicle is required before passenger matching can be enabled', 'verified_vehicle_required');
    if (enabled) {
      const matchedPassenger = await client.query('SELECT 1 FROM navigation_waypoints WHERE navigation_session_id=$1 LIMIT 1', [req.params.id]);
      if (matchedPassenger.rowCount) throw new ApiError(409, 'This navigation already has a mutually agreed passenger. Finish this route before matching another passenger.', 'navigation_waypoint_active');
    }
    await client.query('UPDATE navigation_sessions SET opt_in=$3 WHERE id=$1 AND driver_id=$2', [req.params.id, req.userId, enabled]);
    if (!enabled) await client.query(
      `UPDATE navigation_match_candidates SET status='expired' WHERE navigation_session_id=$1 AND status IN ('suggested','driver_interested','passenger_confirmed')`, [req.params.id],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4)',
      [req.userId, enabled ? 'navigation.matching.enabled' : 'navigation.matching.disabled', 'navigation_session', req.params.id]);
    await client.query('COMMIT');
    res.json({ data: { id: req.params.id, enabled, default: false } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.post('/api/v1/navigation/sessions/:id/pause', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE navigation_sessions SET state='paused' WHERE id=$1 AND driver_id=$2 AND state='active'
     RETURNING id,state,opt_in,current_location_at`, [req.params.id, req.userId],
  );
  if (!rows[0]) throw new ApiError(409, 'Only active navigation can be paused');
  res.json({ data: rows[0] });
}));

app.post('/api/v1/navigation/sessions/:id/resume', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE navigation_sessions SET state='active' WHERE id=$1 AND driver_id=$2 AND state='paused'
     RETURNING id,state,opt_in,current_location_at`, [req.params.id, req.userId],
  );
  if (!rows[0]) throw new ApiError(409, 'Only a paused navigation session can be resumed');
  res.json({ data: rows[0] });
}));

app.get('/api/v1/navigation/sessions/:id/matches', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const owned = await pool.query('SELECT id FROM navigation_sessions WHERE id=$1 AND driver_id=$2', [req.params.id, req.userId]);
  if (!owned.rows[0]) throw new ApiError(404, 'navigation session unavailable');
  res.json({ data: await listNavigationMatches(req.params.id, req.userId!) });
}));

app.post('/api/v1/navigation/sessions/:id/matches/refresh', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  res.json({ data: await refreshNavigationMatches(req.params.id, req.userId!) });
}));

app.post('/api/v1/navigation/sessions/:id/matches/:candidateId/interest', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; demand_id: string; passenger_id: string; status: string; pickup_eta: Date; detour_distance_m: number; detour_duration_s: number }>(
      `UPDATE navigation_match_candidates c SET status='driver_interested'
       FROM navigation_sessions s,passenger_demands d
       WHERE c.id=$1 AND c.navigation_session_id=$2 AND s.id=c.navigation_session_id AND s.driver_id=$3
         AND s.state='paused' AND s.opt_in=true AND s.current_location_at>now()-interval '2 minutes'
         AND d.id=c.demand_id AND d.status='open' AND c.status='suggested' AND c.expires_at>now()
         AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=d.passenger_id AND b.blocked_id=s.driver_id) OR (b.blocker_id=s.driver_id AND b.blocked_id=d.passenger_id))
       RETURNING c.id,c.demand_id,d.passenger_id,c.status,c.pickup_eta,c.detour_distance_m,c.detour_duration_s`,
      [req.params.candidateId, req.params.id, req.userId],
    );
    const candidate = rows[0];
    if (!candidate) throw new ApiError(409, 'Candidate expired or unavailable. Pause the car and refresh matches.', 'candidate_unavailable');
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4)',
      [req.userId, 'navigation.match.driver_interested', 'navigation_match', candidate.id]);
    await insertRealtimeOutbox(client, 'navigation.match.driver-interested', `navigation.match.driver-interested:${candidate.id}`,
      [candidate.passenger_id], { candidate_id: candidate.id, demand_id: candidate.demand_id, status: candidate.status });
    await client.query('COMMIT');
    res.json({ data: {
      id: candidate.id, demand_id: candidate.demand_id, status: candidate.status, pickup_eta: candidate.pickup_eta,
      detour_distance_m: candidate.detour_distance_m, detour_duration_s: candidate.detour_duration_s,
    } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.get('/api/v1/demands/mine/navigation-matches', requireAuth, requireRole('passenger'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id AS candidate_id,c.demand_id,c.status,c.detour_distance_m,c.detour_duration_s,c.pickup_eta,c.expires_at,
       d.origin_name,d.destination_name,d.earliest_departure,d.latest_departure,d.passenger_count,d.budget_minor,d.budget_type,
       CASE WHEN c.status='passenger_confirmed' THEN u.display_name ELSE NULL END AS driver_name,
       CASE WHEN c.status='passenger_confirmed' THEN v.make ELSE NULL END AS vehicle_make,
       CASE WHEN c.status='passenger_confirmed' THEN v.model ELSE NULL END AS vehicle_model
     FROM navigation_match_candidates c JOIN passenger_demands d ON d.id=c.demand_id
     JOIN navigation_sessions s ON s.id=c.navigation_session_id JOIN users u ON u.id=s.driver_id
     LEFT JOIN vehicles v ON v.id=s.vehicle_id
     WHERE d.passenger_id=$1 AND d.status='open' AND c.status IN ('driver_interested','passenger_confirmed')
       AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=d.passenger_id AND b.blocked_id=s.driver_id) OR (b.blocker_id=s.driver_id AND b.blocked_id=d.passenger_id))
       AND c.expires_at>now() AND s.state IN ('active','paused')
     ORDER BY c.status='passenger_confirmed' DESC,c.pickup_eta LIMIT 50`, [req.userId],
  );
  res.json({ data: rows });
}));

app.post('/api/v1/navigation/matches/:candidateId/passenger-confirm', requireAuth, requireRole('passenger'), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; demand_id: string; passenger_id: string; driver_id: string; status: string; expires_at: Date }>(
      `SELECT c.id,c.demand_id,d.passenger_id,s.driver_id,c.status,c.expires_at
       FROM navigation_match_candidates c JOIN passenger_demands d ON d.id=c.demand_id
       JOIN navigation_sessions s ON s.id=c.navigation_session_id
       WHERE c.id=$1 AND s.state='paused' AND s.opt_in=true AND s.current_location_at>now()-interval '2 minutes'
         AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=d.passenger_id AND b.blocked_id=s.driver_id) OR (b.blocker_id=s.driver_id AND b.blocked_id=d.passenger_id))
         AND d.status='open' FOR UPDATE OF c,d`, [req.params.candidateId],
    );
    const candidate = rows[0];
    if (!candidate || candidate.passenger_id !== req.userId) throw new ApiError(404, 'navigation match unavailable');
    if (candidate.status === 'passenger_confirmed') {
      await client.query('COMMIT');
      res.json({ data: { id: candidate.id, demandId: candidate.demand_id, status: candidate.status }, replayed: true });
      return;
    }
    if (candidate.status !== 'driver_interested' || new Date(candidate.expires_at) <= new Date()) throw new ApiError(409, 'The driver has not expressed current interest in this match');
    await client.query("UPDATE navigation_match_candidates SET status='passenger_confirmed' WHERE id=$1", [candidate.id]);
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4)', [req.userId, 'navigation.match.passenger_confirmed', 'navigation_match', candidate.id]);
    await insertRealtimeOutbox(client, 'navigation.match.passenger-confirmed', `navigation.match.passenger-confirmed:${candidate.id}`,
      [candidate.driver_id], { candidate_id: candidate.id, demand_id: candidate.demand_id, status: 'passenger_confirmed' });
    await client.query('COMMIT');
    res.json({ data: { id: candidate.id, demandId: candidate.demand_id, status: 'passenger_confirmed', nextStep: 'price_negotiation' } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.get('/api/v1/navigation/sessions/:id', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,state,destination_name,route_distance_m,route_duration_s,route_version,opt_in,started_at,ended_at,vehicle_id,vehicle_seat_count,(vehicle_id IS NOT NULL) AS matching_vehicle_available,
       ST_AsGeoJSON(route)::json->'coordinates' AS route,
       CASE WHEN current_location IS NULL THEN NULL ELSE json_build_array(ST_X(current_location::geometry),ST_Y(current_location::geometry)) END AS current_location,
       current_location_accuracy_m,current_location_at
     FROM navigation_sessions WHERE id=$1 AND driver_id=$2 AND state IN ('active','paused')`, [req.params.id, req.userId],
  );
  if (!rows[0]) throw new ApiError(404, 'navigation session unavailable');
  res.json({ data: rows[0] });
}));

app.post('/api/v1/navigation/sessions/:id/location', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { coordinates, accuracyMeters, capturedAt } = req.body ?? {};
  const validPoint = Array.isArray(coordinates) && coordinates.length === 2 && coordinates.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    Math.abs(coordinates[0]) <= 180 && Math.abs(coordinates[1]) <= 90;
  const captured = new Date(capturedAt);
  const now = Date.now();
  if (!validPoint || typeof accuracyMeters !== 'number' || !Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > 100 ||
      !Number.isFinite(captured.getTime()) || captured.getTime() < now - 60_000 || captured.getTime() > now + 15_000) {
    throw new ApiError(400, 'GPS point is invalid, inaccurate, stale or has an invalid timestamp', 'invalid_location');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await client.query<{ current_location_at: Date | null; current_location_accuracy_m: number | null; state: string }>(
      `SELECT state,current_location_at,current_location_accuracy_m FROM navigation_sessions WHERE id=$1 AND driver_id=$2 FOR UPDATE`, [req.params.id, req.userId],
    );
    const current = session.rows[0];
    if (!current) throw new ApiError(404, 'navigation session unavailable');
    if (current.state !== 'active') throw new ApiError(409, 'navigation session is not active', 'navigation_not_active');
    if (current.current_location_at && captured <= new Date(current.current_location_at)) throw new ApiError(409, 'GPS sample is out of order', 'location_out_of_order');
    if (current.current_location_at) {
      const previous = await client.query<{ distance_m: number; elapsed_s: number }>(
        `SELECT ST_Distance(current_location,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography) AS distance_m,
         EXTRACT(EPOCH FROM ($4::timestamptz-current_location_at)) AS elapsed_s
         FROM navigation_sessions WHERE id=$1`, [req.params.id, coordinates[0], coordinates[1], captured.toISOString()],
      );
      const elapsedS = Math.max(0, Number(previous.rows[0]?.elapsed_s));
      const maxMeters = Math.max(250, elapsedS * 80 + accuracyMeters + Number(current.current_location_accuracy_m ?? 0));
      if (Number(previous.rows[0]?.distance_m) > maxMeters) throw new ApiError(422, 'GPS movement is implausible; navigation paused for safety', 'implausible_location');
    }
    const update = await client.query<{ on_route: boolean; current_location_at: Date }>(
      `UPDATE navigation_sessions SET current_location=ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
        current_location_accuracy_m=$5,current_location_at=$6
       WHERE id=$1 AND driver_id=$2
       RETURNING ST_DWithin(route::geography,current_location,500) AS on_route,current_location_at`,
      [req.params.id, req.userId, coordinates[0], coordinates[1], accuracyMeters, captured.toISOString()],
    );
    await client.query('COMMIT');
    res.json({ data: { accepted: true, onRoute: update.rows[0].on_route, capturedAt: update.rows[0].current_location_at } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.post('/api/v1/navigation/sessions/:id/end', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE navigation_sessions SET state='ended',opt_in=false,ended_at=COALESCE(ended_at,now()),destination_name=NULL,destination=NULL,route=NULL,
       current_location=NULL,current_location_accuracy_m=NULL,current_location_at=NULL
     WHERE id=$1 AND driver_id=$2 AND state<>'ended' RETURNING id,state,ended_at`, [req.params.id, req.userId],
  );
  if (!rows[0]) {
    const existing = await pool.query('SELECT id FROM navigation_sessions WHERE id=$1 AND driver_id=$2', [req.params.id, req.userId]);
    if (!existing.rows[0]) throw new ApiError(404, 'navigation session unavailable');
    res.json({ data: { id: req.params.id, state: 'ended', replayed: true } });
    return;
  }
  await pool.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4)', [req.userId, 'navigation.ended', 'navigation_session', req.params.id]);
  res.json({ data: rows[0] });
}));

async function expireStaleNavigationSessions() {
  await pool.query(
    `WITH expired AS (
       UPDATE navigation_sessions SET state='ended',opt_in=false,ended_at=now(),destination_name=NULL,destination=NULL,route=NULL,
         current_location=NULL,current_location_accuracy_m=NULL,current_location_at=NULL
       WHERE state IN ('active','paused') AND COALESCE(current_location_at,started_at)<now()-interval '5 minutes'
       RETURNING driver_id,id
     )
     INSERT INTO audit_events(actor_id,action,entity_type,entity_id)
       SELECT driver_id,'navigation.expired','navigation_session',id FROM expired`,
  );
}

app.post('/api/v1/auth/otp/request', asyncHandler(async (req, res) => {
  const phone = req.body?.phone;
  const requestedName = req.body?.displayName;
  if (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone)) throw new ApiError(400, 'Use a valid international phone number');
  if (requestedName !== undefined && (typeof requestedName !== 'string' || requestedName.trim().length < 2 || requestedName.trim().length > 80)) {
    throw new ApiError(400, 'Name must contain 2–80 characters');
  }

  const displayName = typeof requestedName === 'string' ? requestedName.trim() : null;
  if (!displayName) throw new ApiError(400, 'Name is required');

  const challengeId = crypto.randomUUID();
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const requestIpHash = sha256(`${sessionSecret}:${req.ip}`);
    for (const lockKey of [`phone:${phone}`, `ip:${requestIpHash}`].sort()) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);
    }
    const { rows } = await client.query<{ attempts_in_hour: number; ip_attempts_in_hour: number; seconds_since_latest: number | null }>(
      `SELECT (SELECT count(*)::int FROM otp_challenges WHERE phone_e164=$1 AND created_at>now()-interval '1 hour') AS attempts_in_hour,
              (SELECT count(*)::int FROM otp_challenges WHERE request_ip_hash=$2 AND created_at>now()-interval '1 hour') AS ip_attempts_in_hour,
              (SELECT EXTRACT(EPOCH FROM (now()-max(created_at)))::int FROM otp_challenges WHERE phone_e164=$1 AND created_at>now()-interval '1 hour') AS seconds_since_latest`, [phone, requestIpHash],
    );
    if (rows[0].seconds_since_latest !== null && rows[0].seconds_since_latest < 60) throw new ApiError(429, 'Wait before requesting another code');
    if (Number(rows[0].attempts_in_hour) >= 5) throw new ApiError(429, 'OTP request limit reached for this phone');
    if (Number(rows[0].ip_attempts_in_hour) >= 20) throw new ApiError(429, 'OTP request limit reached for this network');
    await client.query(
      `INSERT INTO otp_challenges(id,phone_e164,code_hash,display_name,request_ip_hash,expires_at)
       VALUES ($1,$2,$3,$4,$5,now()+interval '5 minutes')`,
      [challengeId, phone, otpHash(phone, code), displayName, requestIpHash],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  try {
    const delivery = await sendVerificationCode(phone, code);
    if (delivery.provider === 'development') {
      res.json({ data: { expiresInSeconds: 300, delivery: 'development', developmentCode: delivery.testCode }, developmentCode: delivery.testCode });
      return;
    }
    res.json({ data: { expiresInSeconds: 300, delivery: 'sent' } });
  } catch (error) {
    await pool.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challengeId]);
    if (error instanceof SmsProviderUnavailableError) throw new ApiError(503, 'SMS verification is not configured', 'sms_provider_unavailable');
    throw new ApiError(503, 'Could not deliver verification code', 'sms_delivery_failed');
  }
}));

app.post('/api/v1/auth/otp/verify', asyncHandler(async (req, res) => {
  const phone = req.body?.phone;
  const code = req.body?.code;
  if (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new ApiError(400, 'Phone and six-digit code are required');
  }
  const client = await pool.connect();
  let session: Awaited<ReturnType<typeof insertSession>> | undefined;
  let user: { id: string; display_name: string; phone_e164: string; roles: string[] } | undefined;
  let invalidCode = false;
  let unavailableAccount = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string; code_hash: string; display_name: string | null; attempts: number; expires_at: Date; consumed_at: Date | null;
    }>(
      'SELECT id,code_hash,display_name,attempts,expires_at,consumed_at FROM otp_challenges WHERE phone_e164=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [phone],
    );
    const challenge = rows[0];
    if (!challenge || challenge.consumed_at || new Date(challenge.expires_at) <= new Date() || Number(challenge.attempts) >= 5) {
      invalidCode = true;
    } else {
      const expected = Buffer.from(challenge.code_hash, 'hex');
      const actual = Buffer.from(otpHash(phone, code), 'hex');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        await client.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]);
        invalidCode = true;
      } else {
        await client.query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
        const found = await client.query<{ id: string; display_name: string; phone_e164: string; roles: string[]; account_status: string }>(
          'SELECT id,display_name,phone_e164,roles,account_status FROM users WHERE phone_e164=$1 FOR UPDATE', [phone],
        );
        if (found.rows[0]?.account_status !== undefined && found.rows[0].account_status !== 'active') {
          unavailableAccount = true;
        } else {
          if (found.rows[0]) {
            user = found.rows[0];
            await client.query('UPDATE users SET is_verified=true,updated_at=now() WHERE id=$1', [user.id]);
          } else {
            const inserted = await client.query<{ id: string; display_name: string; phone_e164: string; roles: string[] }>(
              `INSERT INTO users(phone_e164,display_name,roles,is_verified)
               VALUES ($1,$2,ARRAY['passenger']::text[],true) RETURNING id,display_name,phone_e164,roles`,
              [phone, challenge.display_name],
            );
            user = inserted.rows[0];
            await client.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)', [user.id, 'passenger']);
          }
          if (user) session = await insertSession(client, user.id);
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (invalidCode) throw new ApiError(401, 'Verification code is invalid or expired', 'otp_invalid');
  if (unavailableAccount || !user || !session) throw new ApiError(403, 'Account is not available', 'account_unavailable');
  setRefreshCookie(res, session.refreshToken, refreshLifetimeMs);
  res.json({ data: { user, accessToken: session.accessToken, accessExpiresAt: session.accessExpiresAt.toISOString() } });
}));

app.post('/api/v1/auth/refresh', asyncHandler(async (req, res) => {
  const refreshToken = cookieValue(req, 'mg_refresh');
  if (!refreshToken) throw new ApiError(401, 'Refresh session is missing', 'refresh_invalid');
  const client = await pool.connect();
  let rotated: Awaited<ReturnType<typeof insertSession>> | undefined;
  let userId: string | undefined;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string; user_id: string; family_id: string; revoked_at: Date | null; refresh_expires_at: Date | null;
    }>(
      'SELECT id,user_id,family_id,revoked_at,refresh_expires_at FROM sessions WHERE refresh_token_hash=$1 FOR UPDATE', [sha256(refreshToken)],
    );
    const current = rows[0];
    if (!current) throw new ApiError(401, 'Refresh session is invalid', 'refresh_invalid');
    if (current.revoked_at) {
      await client.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1', [current.family_id]);
      await client.query('COMMIT');
      clearRefreshCookie(res);
      throw new ApiError(401, 'Refresh token reuse detected; sign in again', 'refresh_reuse_detected');
    }
    if (!current.refresh_expires_at || new Date(current.refresh_expires_at) <= new Date()) throw new ApiError(401, 'Refresh session expired', 'refresh_expired');
    const account = await client.query<{ account_status: string }>('SELECT account_status FROM users WHERE id=$1', [current.user_id]);
    if (account.rows[0]?.account_status !== 'active') throw new ApiError(401, 'Account is not active', 'account_unavailable');
    await client.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [current.id]);
    rotated = await insertSession(client, current.user_id, current.family_id);
    userId = current.user_id;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (!rotated || !userId) throw new ApiError(401, 'Refresh session is invalid', 'refresh_invalid');
  const { rows: users } = await pool.query('SELECT id,display_name,phone_e164,roles FROM users WHERE id=$1', [userId]);
  setRefreshCookie(res, rotated.refreshToken, refreshLifetimeMs);
  res.json({ data: { user: users[0], accessToken: rotated.accessToken, accessExpiresAt: rotated.accessExpiresAt.toISOString() } });
}));

app.post('/api/v1/auth/logout', requireAuth, asyncHandler(async (req, res) => {
  if (req.sessionId) await pool.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [req.sessionId]);
  if (req.userId && req.sessionId) closeRealtimeConnections(req.userId, req.sessionId);
  clearRefreshCookie(res);
  res.json({ data: { loggedOut: true } });
}));

app.post('/api/v1/auth/logout-all', requireAuth, asyncHandler(async (req, res) => {
  await pool.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1', [req.userId]);
  if (req.userId) closeRealtimeConnections(req.userId);
  clearRefreshCookie(res);
  res.json({ data: { loggedOut: true } });
}));

app.get('/api/v1/users/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,phone_e164,display_name,email,roles,is_verified,account_status,created_at
       FROM users WHERE id=$1 AND account_status='active'`, [req.userId],
  );
  if (!rows[0]) throw new ApiError(404, 'user unavailable');
  res.json({ data: rows[0] });
}));

app.get('/api/v1/places/suggest', requireAuth, placeSearchLimiter, asyncHandler(async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (query.length < 3 || query.length > 120) throw new ApiError(400, 'place query must contain 3–120 characters');
  try {
    const data = await suggestPlaces(query);
    res.json({ data });
  } catch (error) {
    if (error instanceof GeocodingUnavailableError) throw new ApiError(503, error.message, 'geocoder_unavailable');
    throw error;
  }
}));

app.patch('/api/v1/users/me', requireAuth, asyncHandler(async (req, res) => {
  const { displayName, email } = req.body ?? {};
  if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length < 2 || displayName.trim().length > 80)) {
    throw new ApiError(400, 'Name must contain 2–80 characters');
  }
  if (email !== undefined && email !== null && (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new ApiError(400, 'Email address is invalid');
  }
  const { rows } = await pool.query(
    `UPDATE users SET display_name=COALESCE($2,display_name),email=CASE WHEN $3::boolean THEN $4 ELSE email END,updated_at=now()
      WHERE id=$1 AND account_status='active'
      RETURNING id,phone_e164,display_name,email,roles,is_verified,created_at`,
    [req.userId, displayName?.trim() ?? null, email !== undefined, email === null ? null : email?.toLowerCase()],
  );
  if (!rows[0]) throw new ApiError(404, 'user unavailable');
  res.json({ data: rows[0] });
}));

app.get('/api/v1/users/me/blocks', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.blocked_id AS user_id,u.display_name,b.created_at
       FROM user_blocks b JOIN users u ON u.id=b.blocked_id
      WHERE b.blocker_id=$1 ORDER BY b.created_at DESC`, [req.userId],
  );
  res.json({ data: rows });
}));

app.post('/api/v1/users/:id/block', requireAuth, asyncHandler(async (req, res) => {
  const targetId = req.params.id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId) || targetId === req.userId) {
    throw new ApiError(400, 'invalid user to block');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: users } = await client.query('SELECT id FROM users WHERE id=$1 AND account_status=\'active\'', [targetId]);
    if (!users[0]) throw new ApiError(404, 'user unavailable');
    await client.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.userId, targetId]);
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4)', [req.userId, 'user.blocked', 'user', targetId]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.delete('/api/v1/users/:id/block', requireAuth, asyncHandler(async (req, res) => {
  const targetId = req.params.id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId) || targetId === req.userId) {
    throw new ApiError(400, 'invalid user to unblock');
  }
  const { rowCount } = await pool.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [req.userId, targetId]);
  if (rowCount) await pool.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4)', [req.userId, 'user.unblocked', 'user', targetId]);
  res.status(204).end();
}));

app.post('/api/v1/users/me/roles', requireAuth, asyncHandler(async (req, res) => {
  const role = req.body?.role;
  if (role !== 'passenger' && role !== 'driver') throw new ApiError(400, 'Only passenger and driver roles can be self-enabled');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, role]);
    const { rows } = await client.query(
      `UPDATE users SET roles=(SELECT ARRAY(SELECT DISTINCT unnest(roles || ARRAY[$2]::text[]) ORDER BY 1)),updated_at=now()
        WHERE id=$1 AND account_status='active' RETURNING id,roles`, [req.userId, role],
    );
    if (!rows[0]) throw new ApiError(404, 'user unavailable');
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$1)', [req.userId, 'role.enabled', 'user']);
    await client.query('COMMIT');
    res.json({ data: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/v1/users/me/export', requireAuth, asyncHandler(async (req, res) => {
  const [profile, vehicles, bookings, demands] = await Promise.all([
    pool.query('SELECT id,phone_e164,display_name,email,roles,is_verified,created_at FROM users WHERE id=$1', [req.userId]),
    pool.query('SELECT id,make,model,model_year,seat_count,verification_status,created_at FROM vehicles WHERE owner_id=$1', [req.userId]),
    pool.query(
      `SELECT b.id,b.offer_id,b.seat_count,b.total_price_minor,b.currency,b.fee_class,b.platform_fee_minor,b.fee_rule_version,b.status,b.created_at
         FROM bookings b JOIN offers o ON o.id=b.offer_id WHERE b.passenger_id=$1 OR o.driver_id=$1`, [req.userId],
    ),
    pool.query('SELECT id,origin_name,destination_name,earliest_departure,latest_departure,passenger_count,budget_minor,status,created_at FROM passenger_demands WHERE passenger_id=$1', [req.userId]),
  ]);
  if (!profile.rows[0]) throw new ApiError(404, 'user unavailable');
  res.json({ data: { profile: profile.rows[0], vehicles: vehicles.rows, bookings: bookings.rows, demands: demands.rows } });
}));

app.post('/api/v1/users/me/deletion-requests', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `INSERT INTO account_deletion_requests(user_id) VALUES ($1)
     ON CONFLICT (user_id) WHERE status='pending' DO NOTHING
     RETURNING id,status,requested_at`, [req.userId],
  );
  if (!rows[0]) throw new ApiError(409, 'An account deletion request is already pending');
  res.status(202).json({ data: rows[0] });
}));

// Return only published, future inventory from the database. This route has no seed-data fallback.
app.get('/api/v1/offers/mine', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.id,o.origin_name,o.destination_name,o.departure_at,o.arrival_at,o.distance_m,o.duration_s,o.route_source,
            o.price_per_seat_minor,o.currency,o.available_seats,o.total_seats,u.display_name AS driver_name,
            ratings.average_rating,ratings.review_count,o.status,photo.object_key AS vehicle_photo_key
       FROM offers o JOIN users u ON u.id=o.driver_id
       LEFT JOIN vehicle_photos photo ON photo.vehicle_id=o.vehicle_id AND photo.is_primary=true
       LEFT JOIN LATERAL (SELECT round(avg(r.rating)::numeric,2) AS average_rating,count(*)::int AS review_count
                            FROM reviews r WHERE r.target_id=o.driver_id) ratings ON true
      WHERE o.driver_id=$1 ORDER BY o.departure_at DESC LIMIT 100`, [req.userId],
  );
  res.json({ data: await Promise.all(rows.map(async ({ vehicle_photo_key, ...offer }) => ({
    ...offer, vehicle_photo_url: vehicle_photo_key ? await getVehiclePhotoUrl(vehicle_photo_key).catch(() => null) : null,
  }))) });
}));

app.get('/api/v1/offers', asyncHandler(async (req, res) => {
  const origin = String(req.query.origin || '').trim();
  const destination = String(req.query.destination || '').trim();
  const date = req.query.date === undefined ? null : String(req.query.date);
  const seats = req.query.seats === undefined ? 1 : Number(req.query.seats);
  const coordinateKeys = ['originLon', 'originLat', 'destinationLon', 'destinationLat'] as const;
  const suppliedCoordinates = coordinateKeys.map((key) => req.query[key] !== undefined);
  const hasCoordinates = suppliedCoordinates.every(Boolean);
  if (suppliedCoordinates.some(Boolean) && !hasCoordinates) throw new ApiError(400, 'all four route coordinates are required');
  const coordinates = hasCoordinates ? coordinateKeys.map((key) => Number(req.query[key])) : [];
  if (!origin || !destination || origin.length > 120 || destination.length > 120) {
    throw new ApiError(400, 'origin and destination are required');
  }
  if (!Number.isInteger(seats) || seats < 1 || seats > 20 || (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) ||
      (hasCoordinates && (coordinates.some((coordinate) => !Number.isFinite(coordinate)) ||
        Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90 || Math.abs(coordinates[2]) > 180 || Math.abs(coordinates[3]) > 90))) {
    throw new ApiError(400, 'invalid date or passenger count');
  }
  const routeFilter = hasCoordinates
    ? `AND ST_DWithin(o.origin,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,20000)
       AND ST_DWithin(o.destination,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,20000)`
    : 'AND lower(o.origin_name)=lower($1) AND lower(o.destination_name)=lower($2)';
  const dateParameter = hasCoordinates ? 5 : 3;
  const seatsParameter = hasCoordinates ? 6 : 4;
  const filters = [
    routeFilter,
    `AND ($${dateParameter}::date IS NULL OR (o.departure_at AT TIME ZONE 'Europe/Kyiv')::date=$${dateParameter}::date)`,
    `AND o.available_seats >= $${seatsParameter}`,
  ].join('\n');
  const parameters = hasCoordinates ? [...coordinates, date, seats] : [origin, destination, date, seats];
  const { rows } = await pool.query(
    `SELECT o.id, o.origin_name, o.destination_name, o.departure_at, o.arrival_at,o.distance_m,o.duration_s,o.route_source,o.price_per_seat_minor,
            o.currency, o.available_seats, o.total_seats, u.display_name AS driver_name,
            ratings.average_rating,ratings.review_count,photo.object_key AS vehicle_photo_key
       FROM offers o JOIN users u ON u.id = o.driver_id
       LEFT JOIN vehicle_photos photo ON photo.vehicle_id=o.vehicle_id AND photo.is_primary=true
       LEFT JOIN LATERAL (SELECT round(avg(r.rating)::numeric,2) AS average_rating,count(*)::int AS review_count FROM reviews r WHERE r.target_id=o.driver_id) ratings ON true
      WHERE o.status = 'published' AND o.departure_at > now() AND o.available_seats > 0
        ${filters}
      ORDER BY o.departure_at ASC LIMIT 100`,
    parameters,
  );
  res.json({ data: await Promise.all(rows.map(async ({ vehicle_photo_key, ...offer }) => ({
    ...offer, vehicle_photo_url: vehicle_photo_key ? await getVehiclePhotoUrl(vehicle_photo_key).catch(() => null) : null,
  }))) });
}));

const journeySelect = `SELECT j.id,j.user_id,j.origin_name,j.destination_name,
       json_build_array(ST_X(j.origin::geometry),ST_Y(j.origin::geometry)) AS origin_coordinates,
       json_build_array(ST_X(j.destination::geometry),ST_Y(j.destination::geometry)) AS destination_coordinates,
       j.requested_departure_at,j.requested_arrival_at,j.strategy,j.state,j.passenger_count,j.total_price_minor,
       j.confirmed_price_minor,j.estimated_price_min_minor,j.estimated_price_max_minor,j.total_duration_s,
       j.walking_distance_m,j.transfer_count,j.reliability_score,j.comfort_score,j.current_leg_id,j.created_at,j.updated_at,
       COALESCE(json_agg(json_build_object(
         'id',l.id,'ordinal',l.ordinal,'mode',l.mode,'originName',l.origin_name,'originCoordinates',
         json_build_array(ST_X(l.origin::geometry),ST_Y(l.origin::geometry)),'destinationName',l.destination_name,
         'destinationCoordinates',json_build_array(ST_X(l.destination::geometry),ST_Y(l.destination::geometry)),
         'departureAt',l.scheduled_departure_at,'arrivalAt',l.scheduled_arrival_at,'durationSeconds',l.duration_s,
         'distanceMeters',l.distance_m,'priceMinor',l.price_minor,'priceMinMinor',l.price_min_minor,
         'priceMaxMinor',l.price_max_minor,'currency',l.currency,'priceStatus',l.price_status,
         'availabilityStatus',l.availability_status,'providerType',l.provider_type,'offerId',l.offer_id,
         'bookingId',l.booking_id,'demandId',l.demand_id,'state',l.state,'dataSource',l.data_source,
         'lastUpdatedAt',l.last_updated_at,'metadata',l.metadata
       ) ORDER BY l.ordinal) FILTER (WHERE l.id IS NOT NULL),'[]'::json) AS legs
  FROM journeys j LEFT JOIN journey_legs l ON l.journey_id=j.id`;

app.get('/api/v1/journeys/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`${journeySelect} WHERE j.user_id=$1 GROUP BY j.id ORDER BY j.updated_at DESC LIMIT 50`, [req.userId]);
  res.json({ data: rows });
}));

app.get('/api/v1/journeys/:id', requireAuth, asyncHandler(async (req, res) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
    throw new ApiError(400, 'invalid Journey ID', 'invalid_journey_id');
  }
  const { rows } = await pool.query(`${journeySelect} WHERE j.user_id=$1 AND j.id=$2 GROUP BY j.id`, [req.userId, req.params.id]);
  if (!rows[0]) throw new ApiError(404, 'Journey not found');
  res.json({ data: rows[0] });
}));

app.post('/api/v1/journeys/search', requireAuth, asyncHandler(async (req, res) => {
  let search;
  try {
    search = parseJourneySearchRequest(req.body);
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(400, error.message, 'invalid_journey_search');
    throw error;
  }
  if (search.preferences.allowCommunity === false) {
    res.json({ data: { journeys: [], partial: true, blockedProviders: ['community-disabled','taxi','bus','minibus','rail','public-transport','carsharing','transfer'], providerErrors: [] } });
    return;
  }

  const { rows } = await pool.query<{
    offer_id: string; driver_id: string; driver_name: string; vehicle_id: string;
    origin_name: string; destination_name: string; origin_lon: number; origin_lat: number;
    destination_lon: number; destination_lat: number; departure_at: Date; arrival_at: Date | null;
    duration_s: number; distance_m: number; route_source: string; price_per_seat_minor: number;
    currency: string; available_seats: number; average_rating: number | null; review_count: number;
    vehicle_make: string; vehicle_model: string; created_at: Date; snapshot_at: Date;
  }>(
    `SELECT o.id AS offer_id,o.driver_id,u.display_name AS driver_name,o.vehicle_id,
            o.origin_name,o.destination_name,ST_X(o.origin::geometry) AS origin_lon,ST_Y(o.origin::geometry) AS origin_lat,
            ST_X(o.destination::geometry) AS destination_lon,ST_Y(o.destination::geometry) AS destination_lat,
            o.departure_at,o.arrival_at,o.duration_s,o.distance_m,o.route_source,o.price_per_seat_minor,o.currency,o.available_seats,
            ratings.average_rating,ratings.review_count,v.make AS vehicle_make,v.model AS vehicle_model,o.created_at,now() AS snapshot_at
       FROM offers o JOIN users u ON u.id=o.driver_id JOIN vehicles v ON v.id=o.vehicle_id
       LEFT JOIN LATERAL (SELECT round(avg(r.rating)::numeric,2) AS average_rating,count(*)::int AS review_count FROM reviews r WHERE r.target_id=o.driver_id) ratings ON true
      WHERE o.status='published' AND o.departure_at >= $5 AND o.departure_at <= $5::timestamptz+interval '120 minutes'
        AND o.available_seats >= $6 AND o.driver_id<>$7 AND o.route IS NOT NULL
        AND o.duration_s IS NOT NULL AND o.duration_s>0 AND o.distance_m IS NOT NULL AND o.distance_m>0
        AND o.route_source IS NOT NULL AND o.route_source<>'development_unrouted'
        AND ST_DWithin(o.origin,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,25000)
        AND ST_DWithin(o.destination,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,25000)
        AND o.departure_at>now()
      ORDER BY o.departure_at ASC LIMIT 100`,
    [search.origin.coordinates[0], search.origin.coordinates[1], search.destination.coordinates[0], search.destination.coordinates[1], search.departureAt, search.passengers, req.userId],
  );

  const candidates = rows.flatMap((offer): Array<JourneyOption & { source: typeof offer; departureAt: Date; arrivalAt: Date; totalPriceMinor: number }> => {
    if (search.preferences.preferredVehicleClass) return [];
    const arrivalAt = offer.arrival_at ?? new Date(offer.departure_at.getTime() + offer.duration_s * 1000);
    const durationSeconds = Math.ceil((arrivalAt.getTime() - search.departureAt.getTime()) / 1000);
    const totalPriceMinor = Number(offer.price_per_seat_minor) * search.passengers;
    const rating = offer.average_rating === null ? null : Number(offer.average_rating);
    if (!Number.isSafeInteger(totalPriceMinor) || totalPriceMinor < 0 || durationSeconds <= 0) return [];
    if (search.preferences.maxPriceMinor !== undefined && totalPriceMinor > search.preferences.maxPriceMinor) return [];
    if (search.preferences.maxTotalDurationSeconds !== undefined && durationSeconds > search.preferences.maxTotalDurationSeconds) return [];
    if (search.preferences.minDriverRating !== undefined && search.preferences.minDriverRating > 0
      && (rating === null || offer.review_count < 1 || rating < search.preferences.minDriverRating)) return [];
    return [{
      id: offer.offer_id, source: offer, departureAt: offer.departure_at, arrivalAt,
      durationSeconds, priceMinor: totalPriceMinor, transfers: 0, walkingMeters: 0,
      reliability: null, transferRisk: 0, comfort: null, legs: [{ mode: 'COMMUNITY' }], totalPriceMinor,
    }];
  });

  const strategies: JourneyStrategy[] = [search.strategy, ...JOURNEY_STRATEGIES.filter((strategy) => strategy !== search.strategy)];
  const representatives = selectRepresentativeJourneys(candidates, strategies);
  const preferenceValues = search.preferences;
  const client = await pool.connect();
  const journeys: Array<Record<string, unknown>> = [];
  try {
    await client.query('BEGIN');
    for (const representative of representatives) {
      const candidate = representative.journey;
      const offer = candidate.source;
      const stored = await client.query<{ id: string }>(
        `INSERT INTO journeys(user_id,origin,origin_name,destination,destination_name,requested_departure_at,strategy,state,passenger_count,total_price_minor,estimated_price_min_minor,estimated_price_max_minor,total_duration_s,walking_distance_m,transfer_count,reliability_score,comfort_score)
         VALUES($1,ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,$7,$8,$9,'PLANNED',$10,$11,$11,$11,$12,0,0,NULL,NULL)
         RETURNING id`,
        [req.userId, search.origin.coordinates[0], search.origin.coordinates[1], search.origin.name,
          search.destination.coordinates[0], search.destination.coordinates[1], search.destination.name,
          search.departureAt, representative.strategy, search.passengers, candidate.totalPriceMinor, candidate.durationSeconds],
      );
      const journeyId = stored.rows[0].id;
      await client.query(
        `INSERT INTO journey_preferences(journey_id,max_price_minor,max_total_duration_s,max_transfers,max_walking_distance_m,min_driver_rating,allow_community,allow_taxi,allow_bus,allow_minibus,allow_rail,allow_public_transport,allow_carsharing,allow_transfer,preferred_vehicle_class,minimum_transfer_buffer_s,max_community_detour_s,max_community_detour_m)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [journeyId, preferenceValues.maxPriceMinor ?? null, preferenceValues.maxTotalDurationSeconds ?? null,
          preferenceValues.maxTransfers ?? null, preferenceValues.maxWalkingMeters ?? null, preferenceValues.minDriverRating ?? null,
          preferenceValues.allowCommunity ?? true, preferenceValues.allowTaxi ?? true, preferenceValues.allowBus ?? true,
          preferenceValues.allowMinibus ?? true, preferenceValues.allowRail ?? true, preferenceValues.allowPublicTransport ?? true,
          preferenceValues.allowCarsharing ?? false, preferenceValues.allowTransfer ?? true, preferenceValues.preferredVehicleClass ?? null,
          preferenceValues.minimumTransferBufferSeconds ?? 600, preferenceValues.maxCommunityDetourSeconds ?? 900,
          preferenceValues.maxCommunityDetourMeters ?? 10000],
      );
      const leg = await client.query<{ id: string }>(
        `INSERT INTO journey_legs(journey_id,ordinal,mode,origin,origin_name,destination,destination_name,scheduled_departure_at,scheduled_arrival_at,predicted_departure_at,predicted_arrival_at,duration_s,eta_uncertainty_seconds,distance_m,price_minor,price_min_minor,price_max_minor,currency,price_status,availability_status,provider_type,offer_id,reliability_score,transfer_risk_score,state,data_source,data_freshness_seconds,last_updated_at,metadata)
         VALUES($1,0,'COMMUNITY',ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,$7,$8,$9,NULL,NULL,$10,NULL,$11,$12,$12,$12,$13,'ESTIMATED','AVAILABLE','community',$14,NULL,NULL,'SELECTED','community-offer',0,$15,$16::jsonb)
         RETURNING id`,
        [journeyId, offer.origin_lon, offer.origin_lat, offer.origin_name, offer.destination_lon, offer.destination_lat,
          offer.destination_name, offer.departure_at, candidate.arrivalAt, offer.duration_s, offer.distance_m,
          candidate.totalPriceMinor, offer.currency, offer.offer_id, offer.snapshot_at,
          JSON.stringify({ driverId: offer.driver_id, driverName: offer.driver_name, vehicleId: offer.vehicle_id,
            vehicleMake: offer.vehicle_make, vehicleModel: offer.vehicle_model, rating: offer.average_rating,
            reviewCount: offer.review_count, availableSeatsAtSearch: offer.available_seats, offerCreatedAt: offer.created_at })],
      );
      await client.query('UPDATE journeys SET current_leg_id=$2 WHERE id=$1', [journeyId, leg.rows[0].id]);
      journeys.push({
        id: journeyId, offerId: offer.offer_id, strategy: representative.strategy, score: representative.score, state: 'PLANNED',
        totalDurationSeconds: candidate.durationSeconds, totalPriceMinor: candidate.totalPriceMinor,
        confirmedPriceMinor: null, estimatedPriceMinMinor: candidate.totalPriceMinor, estimatedPriceMaxMinor: candidate.totalPriceMinor,
        walkingMeters: 0, transfers: 0, reliabilityScore: null,
        legs: [{ id: leg.rows[0].id, mode: 'COMMUNITY', offerId: offer.offer_id,
          origin: { name: offer.origin_name, coordinates: [offer.origin_lon, offer.origin_lat] },
          destination: { name: offer.destination_name, coordinates: [offer.destination_lon, offer.destination_lat] },
          departureAt: offer.departure_at, arrivalAt: candidate.arrivalAt, durationSeconds: offer.duration_s,
          distanceMeters: offer.distance_m, priceMinor: candidate.totalPriceMinor, priceStatus: 'ESTIMATED',
          availabilityStatus: 'AVAILABLE', source: 'community-offer', lastUpdatedAt: offer.snapshot_at,
          driver: { id: offer.driver_id, name: offer.driver_name, averageRating: offer.average_rating, reviewCount: offer.review_count },
          vehicle: { id: offer.vehicle_id, make: offer.vehicle_make, model: offer.vehicle_model } }],
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.json({ data: {
    journeys,
    partial: true,
    blockedProviders: ['taxi','bus','minibus','rail','public-transport','carsharing','transfer','walking'],
    unsupportedPreferences: search.preferences.preferredVehicleClass ? ['preferredVehicleClass'] : [],
    providerErrors: [],
  } });
}));

app.get('/api/v1/vehicles', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, make, model, model_year, seat_count, verification_status, is_active, created_at
       FROM vehicles WHERE owner_id = $1 AND archived_at IS NULL ORDER BY is_active DESC,created_at DESC`, [req.userId],
  );
  res.json({ data: rows });
}));

app.get('/api/v1/users/me/verification', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (verification_type,vehicle_id)
            id,verification_type,vehicle_id,status,created_at,reviewed_at
       FROM verification_records WHERE user_id=$1
      ORDER BY verification_type,vehicle_id,created_at DESC,id DESC`, [req.userId],
  );
  res.json({ data: rows });
}));

app.post('/api/v1/vehicles/:id/verification/evidence/upload-url', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const contentType = req.body?.contentType;
  if (!isAllowedVerificationEvidenceType(contentType)) throw new ApiError(400, 'Only JPEG, PNG, and PDF verification evidence is allowed');
  const { rows } = await pool.query('SELECT 1 FROM vehicles WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL', [req.params.id, req.userId]);
  if (!rows[0]) throw new ApiError(404, 'vehicle unavailable');
  const key = `verification-evidence/${req.userId}/${req.params.id}/${crypto.randomUUID()}`;
  try {
    const upload = await createVerificationEvidenceUpload(key, contentType);
    res.json({ data: { key, ...upload } });
  } catch (error) {
    if (error instanceof ObjectStorageUnavailableError || (error instanceof Error && error.name === 'CredentialsProviderError')) {
      throw new ApiError(503, 'Private verification evidence storage is not configured', 'verification_storage_unavailable');
    }
    throw error;
  }
}));

app.post('/api/v1/vehicles/:id/verification', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const vehicleId = req.params.id;
  const vehiclePrefix = `verification-evidence/${req.userId}/${vehicleId}/`;
  const registrationKey = req.body?.registrationEvidenceKey;
  const licenseKey = req.body?.driverLicenseEvidenceKey;
  const validKey = (key: unknown): key is string => typeof key === 'string' && key.startsWith(vehiclePrefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key.slice(vehiclePrefix.length));
  const registrationType = req.body?.registrationContentType;
  const licenseType = req.body?.driverLicenseContentType;
  if (!validKey(registrationKey) || !validKey(licenseKey) || registrationKey === licenseKey ||
      !isAllowedVerificationEvidenceType(registrationType) || !isAllowedVerificationEvidenceType(licenseType)) {
    throw new ApiError(400, 'Vehicle registration and driver license evidence are required');
  }

  try {
    const [registrationValid, licenseValid] = await Promise.all([
      verifyVerificationEvidenceObject(registrationKey, registrationType),
      verifyVerificationEvidenceObject(licenseKey, licenseType),
    ]);
    if (!registrationValid || !licenseValid) throw new ApiError(400, 'Evidence does not match the required document format or size', 'invalid_verification_evidence');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof ObjectStorageUnavailableError || (error instanceof Error && error.name === 'CredentialsProviderError')) {
      throw new ApiError(503, 'Private verification evidence storage is not configured', 'verification_storage_unavailable');
    }
    throw new ApiError(503, 'Uploaded evidence could not be verified', 'verification_evidence_check_failed');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vehicle = await client.query('SELECT id FROM vehicles WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL FOR UPDATE', [vehicleId, req.userId]);
    if (!vehicle.rows[0]) throw new ApiError(404, 'vehicle unavailable');
    const pending = await client.query(
      `SELECT verification_type FROM verification_records
        WHERE user_id=$1 AND vehicle_id=$2 AND verification_type IN ('vehicle','driver_license') AND status='pending'`, [req.userId, vehicleId],
    );
    if (pending.rowCount) throw new ApiError(409, 'A verification review is already pending', 'verification_already_pending');
    await client.query(
      `INSERT INTO verification_records(user_id,vehicle_id,verification_type,evidence_ref)
       VALUES ($1,$2,'vehicle',$3),($1,$2,'driver_license',$4)`, [req.userId, vehicleId, registrationKey, licenseKey],
    );
    await client.query("UPDATE vehicles SET verification_status='pending' WHERE id=$1", [vehicleId]);
    await client.query('INSERT INTO driver_profiles(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [req.userId]);
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'verification.submitted', 'vehicle', vehicleId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.status(202).json({ data: { vehicleId, status: 'pending' } });
}));

app.get('/api/v1/admin/verification', requireAuth, requireStaff, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id,r.user_id,r.vehicle_id,r.verification_type,r.status,r.created_at,
            u.display_name,v.make,v.model,v.model_year,v.seat_count
       FROM verification_records r JOIN users u ON u.id=r.user_id
       LEFT JOIN vehicles v ON v.id=r.vehicle_id
      WHERE r.status='pending' ORDER BY r.created_at,r.id LIMIT 100`,
  );
  res.json({ data: rows });
}));

app.get('/api/v1/admin/verification/:id/evidence', requireAuth, requireStaff, asyncHandler(async (req, res) => {
  const { rows } = await pool.query<{ user_id: string; evidence_ref: string | null }>(
    `SELECT user_id,evidence_ref FROM verification_records WHERE id=$1 AND status='pending'`, [req.params.id],
  );
  if (!rows[0]?.evidence_ref) throw new ApiError(404, 'pending verification evidence unavailable');
  if (rows[0].user_id === req.userId) throw new ApiError(403, 'Reviewers cannot access their own verification evidence');
  let url: string;
  try { url = await getVerificationEvidenceUrl(rows[0].evidence_ref); }
  catch (error) {
    if (error instanceof StoredEvidenceUnavailableError) throw new ApiError(404, 'Private verification evidence is unavailable', 'verification_evidence_unavailable');
    if (error instanceof ObjectStorageUnavailableError || (error instanceof Error && error.name === 'CredentialsProviderError')) {
      throw new ApiError(503, 'Private verification evidence storage is not configured', 'verification_storage_unavailable');
    }
    throw error;
  }
  await pool.query('UPDATE verification_records SET evidence_accessed_at=now() WHERE id=$1 AND status=\'pending\'', [req.params.id]);
  await pool.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'verification.evidence.accessed', 'verification', req.params.id]);
  res.json({ data: { url, expiresInSeconds: 180 } });
}));

app.post('/api/v1/admin/verification/:id/decision', requireAuth, requireStaff, asyncHandler(async (req, res) => {
  const decision = req.body?.decision;
  const note = req.body?.note;
  if ((decision !== 'approved' && decision !== 'rejected') ||
      (note !== undefined && (typeof note !== 'string' || note.trim().length > 1000)) ||
      (decision === 'rejected' && (typeof note !== 'string' || note.trim().length < 3))) {
    throw new ApiError(400, 'Decision must be approved or rejected; rejection requires a short reason');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subject = await client.query<{ vehicle_id: string | null }>('SELECT vehicle_id FROM verification_records WHERE id=$1', [req.params.id]);
    if (!subject.rows[0]) throw new ApiError(404, 'verification record unavailable');
    if (subject.rows[0].vehicle_id) await client.query('SELECT id FROM vehicles WHERE id=$1 FOR UPDATE', [subject.rows[0].vehicle_id]);
    const found = await client.query<{
      id: string; user_id: string; vehicle_id: string | null; verification_type: string; status: string; evidence_accessed_at: Date | null;
    }>(`SELECT id,user_id,vehicle_id,verification_type,status,evidence_accessed_at
          FROM verification_records WHERE id=$1 FOR UPDATE`, [req.params.id]);
    const record = found.rows[0];
    if (!record) throw new ApiError(404, 'verification record unavailable');
    if (record.user_id === req.userId) throw new ApiError(403, 'Reviewers cannot review their own verification record');
    if (record.status !== 'pending') throw new ApiError(409, 'Verification was already reviewed', 'verification_already_reviewed');
    if (!record.evidence_accessed_at) throw new ApiError(409, 'Reviewer must open the private evidence before deciding', 'verification_evidence_not_reviewed');

    await client.query(
      `UPDATE verification_records SET status=$2,reviewer_id=$3,review_note=$4,reviewed_at=now() WHERE id=$1`,
      [record.id, decision, req.userId, typeof note === 'string' ? note.trim() || null : null],
    );
    if (decision === 'rejected' && record.vehicle_id) {
      const siblings = await client.query<{ id: string; verification_type: string }>(
        `UPDATE verification_records SET status='rejected',reviewer_id=$3,review_note=$4,reviewed_at=now()
          WHERE user_id=$1 AND vehicle_id=$2 AND status='pending' AND id<>$5
            AND verification_type IN ('vehicle','driver_license')
          RETURNING id,verification_type`,
        [record.user_id, record.vehicle_id, req.userId, typeof note === 'string' ? note.trim() : null, record.id],
      );
      for (const sibling of siblings.rows) {
        await client.query(
          `INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details)
           VALUES ($1,'verification.rejected','verification',$2,jsonb_build_object('verificationType',$3::text,'reason','paired_document_rejected'))`,
          [req.userId, sibling.id, sibling.verification_type],
        );
      }
    }
    let vehicleStatus: string | null = null;
    if (record.vehicle_id) {
      const statuses = await client.query<{ vehicle_document: string | null; driver_license: string | null }>(
        `SELECT
          (SELECT status FROM verification_records WHERE user_id=$1 AND vehicle_id=$2 AND verification_type='vehicle' ORDER BY created_at DESC,id DESC LIMIT 1) AS vehicle_document,
          (SELECT status FROM verification_records WHERE user_id=$1 AND vehicle_id=$2 AND verification_type='driver_license' ORDER BY created_at DESC,id DESC LIMIT 1) AS driver_license`,
        [record.user_id, record.vehicle_id],
      );
      const { vehicle_document, driver_license } = statuses.rows[0];
      vehicleStatus = vehicle_document === 'approved' && driver_license === 'approved' ? 'verified'
        : vehicle_document === 'rejected' || driver_license === 'rejected' ? 'rejected' : 'pending';
      await client.query('UPDATE vehicles SET verification_status=$2 WHERE id=$1', [record.vehicle_id, vehicleStatus]);
      if (driver_license === 'approved') {
        await client.query(
          `INSERT INTO driver_profiles(user_id,verification_level,profile_status)
           VALUES ($1,'identity','active')
           ON CONFLICT (user_id) DO UPDATE SET verification_level='identity',profile_status='active',updated_at=now()`, [record.user_id],
        );
      }
    }
    await client.query(
      `INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details)
       VALUES ($1,$2,'verification',$3,jsonb_build_object('decision',$4::text,'verificationType',$5::text))`,
      [req.userId, `verification.${decision}`, record.id, decision, record.verification_type],
    );
    await client.query('COMMIT');
    res.json({ data: { id: record.id, status: decision, vehicleStatus } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/v1/vehicles', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { make, model, modelYear, seats } = req.body ?? {};
  if (typeof make !== 'string' || make.trim().length < 1 || make.length > 80 ||
      typeof model !== 'string' || model.trim().length < 1 || model.length > 100 ||
      !Number.isInteger(modelYear) || modelYear < 1950 || modelYear > new Date().getUTCFullYear() + 1 ||
      !Number.isInteger(seats) || seats < 1 || seats > 20) {
    throw new ApiError(400, 'invalid vehicle fields');
  }
  const client = await pool.connect();
  let rows;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [req.userId]);
    const active = await client.query('SELECT 1 FROM vehicles WHERE owner_id=$1 AND is_active AND archived_at IS NULL', [req.userId]);
    ({ rows } = await client.query(
      `INSERT INTO vehicles(owner_id,make,model,model_year,seat_count,is_active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,make,model,model_year,seat_count,verification_status,is_active,created_at`,
      [req.userId, make.trim(), model.trim(), modelYear, seats, active.rowCount === 0],
    ));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await pool.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'vehicle.created', 'vehicle', rows[0].id]);
  res.status(201).json({ data: rows[0] });
}));

app.patch('/api/v1/vehicles/:id', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { make, model, modelYear, seats } = req.body ?? {};
  if ((make !== undefined && (typeof make !== 'string' || make.trim().length < 1 || make.trim().length > 80)) ||
      (model !== undefined && (typeof model !== 'string' || model.trim().length < 1 || model.trim().length > 100)) ||
      (modelYear !== undefined && (!Number.isInteger(modelYear) || modelYear < 1950 || modelYear > new Date().getUTCFullYear() + 1)) ||
      (seats !== undefined && (!Number.isInteger(seats) || seats < 1 || seats > 20))) {
    throw new ApiError(400, 'invalid vehicle fields');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query('SELECT id FROM vehicles WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL FOR UPDATE', [req.params.id, req.userId]);
    if (!owned.rows[0]) throw new ApiError(404, 'vehicle unavailable');
    if (seats !== undefined) {
      const incompatible = await client.query(
        "SELECT 1 FROM offers WHERE vehicle_id=$1 AND departure_at>now() AND status='published' AND total_seats>$2 LIMIT 1", [req.params.id, seats],
      );
      if (incompatible.rows[0]) throw new ApiError(409, 'Vehicle capacity cannot be reduced below an upcoming published trip', 'vehicle_capacity_in_use');
    }
    const { rows } = await client.query(
      `UPDATE vehicles SET make=COALESCE($3,make),model=COALESCE($4,model),model_year=COALESCE($5,model_year),seat_count=COALESCE($6,seat_count)
        WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL
        RETURNING id,make,model,model_year,seat_count,verification_status,is_active,created_at`,
      [req.params.id, req.userId, make?.trim() ?? null, model?.trim() ?? null, modelYear ?? null, seats ?? null],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'vehicle.updated', 'vehicle', req.params.id]);
    await client.query('COMMIT');
    res.json({ data: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/v1/vehicles/:id/activate', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [req.userId]);
    const target = await client.query('SELECT id FROM vehicles WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL FOR UPDATE', [req.params.id, req.userId]);
    if (!target.rows[0]) throw new ApiError(404, 'vehicle unavailable');
    await client.query('UPDATE vehicles SET is_active=false WHERE owner_id=$1 AND is_active', [req.userId]);
    const { rows } = await client.query(
      `UPDATE vehicles SET is_active=true WHERE id=$1 AND owner_id=$2
       RETURNING id,make,model,model_year,seat_count,verification_status,is_active,created_at`, [req.params.id, req.userId],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'vehicle.activated', 'vehicle', req.params.id]);
    await client.query('COMMIT');
    res.json({ data: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.delete('/api/v1/vehicles/:id', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vehicle = await client.query('SELECT id FROM vehicles WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL FOR UPDATE', [req.params.id, req.userId]);
    if (!vehicle.rows[0]) throw new ApiError(404, 'vehicle unavailable');
    const activeTrips = await client.query(
      `SELECT 1 FROM offers o WHERE o.vehicle_id=$1 AND o.departure_at>now() AND o.status='published' LIMIT 1`, [req.params.id],
    );
    if (activeTrips.rows[0]) throw new ApiError(409, 'Vehicle has upcoming trips and cannot be archived', 'vehicle_has_upcoming_trips');
    await client.query('UPDATE vehicles SET is_active=false,archived_at=now() WHERE id=$1', [req.params.id]);
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'vehicle.archived', 'vehicle', req.params.id]);
    await client.query('COMMIT');
    res.json({ data: { id: req.params.id, archived: true } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/v1/vehicles/:id/photos/upload-url', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const contentType = req.body?.contentType;
  if (!isAllowedPhotoType(contentType)) throw new ApiError(400, 'Only JPEG, PNG, and WebP vehicle photos are allowed');
  const { rows } = await pool.query('SELECT 1 FROM vehicles WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL', [req.params.id, req.userId]);
  if (!rows[0]) throw new ApiError(404, 'vehicle unavailable');
  const key = `vehicle-photos/${req.userId}/${req.params.id}/${crypto.randomUUID()}`;
  try {
    const upload = await createVehiclePhotoUpload(key, contentType);
    res.json({ data: { key, ...upload } });
  } catch (error) {
    if (error instanceof ObjectStorageUnavailableError || (error instanceof Error && error.name === 'CredentialsProviderError')) {
      throw new ApiError(503, 'Vehicle photo storage is not configured', 'object_storage_unavailable');
    }
    throw error;
  }
}));

app.post('/api/v1/vehicles/:id/photos', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const key = req.body?.key;
  const contentType = req.body?.contentType;
  const prefix = `vehicle-photos/${req.userId}/${req.params.id}/`;
  if (typeof key !== 'string' || !key.startsWith(prefix) || !/^[0-9a-f-]{36}$/i.test(key.slice(prefix.length)) || !isAllowedPhotoType(contentType)) {
    throw new ApiError(400, 'invalid vehicle photo reference');
  }
  const { rows: vehicle } = await pool.query('SELECT 1 FROM vehicles WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL', [req.params.id, req.userId]);
  if (!vehicle[0]) throw new ApiError(404, 'vehicle unavailable');
  let valid: boolean;
  let photoUrl: string;
  try {
    valid = await verifyVehiclePhotoObject(key, contentType);
    if (!valid) {
      await deleteStoredVehiclePhoto(key).catch(() => undefined);
      throw new ApiError(400, 'Uploaded file does not match the required image type or size', 'invalid_vehicle_photo');
    }
    photoUrl = await getVehiclePhotoUrl(key);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof ObjectStorageUnavailableError || (error instanceof Error && error.name === 'CredentialsProviderError')) {
      throw new ApiError(503, 'Vehicle photo storage is not configured', 'object_storage_unavailable');
    }
    throw new ApiError(503, 'Uploaded photo could not be verified', 'vehicle_photo_verification_failed');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM vehicles WHERE id=$1 AND owner_id=$2 FOR UPDATE', [req.params.id, req.userId]);
    const existing = await client.query('SELECT 1 FROM vehicle_photos WHERE vehicle_id=$1 LIMIT 1', [req.params.id]);
    const { rows } = await client.query(
      'INSERT INTO vehicle_photos(vehicle_id,object_key,is_primary) VALUES ($1,$2,$3) RETURNING id,vehicle_id,is_primary,created_at',
      [req.params.id, key, existing.rowCount === 0],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'vehicle.photo.added', 'vehicle', req.params.id]);
    await client.query('COMMIT');
    res.status(201).json({ data: { ...rows[0], url: photoUrl } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/v1/vehicles/:id/photos', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id,p.is_primary,p.created_at,p.object_key FROM vehicle_photos p JOIN vehicles v ON v.id=p.vehicle_id
      WHERE p.vehicle_id=$1 AND v.owner_id=$2 AND v.archived_at IS NULL ORDER BY p.is_primary DESC,p.created_at`, [req.params.id, req.userId],
  );
  if (!rows.length) {
    const owned = await pool.query('SELECT 1 FROM vehicles WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL', [req.params.id, req.userId]);
    if (!owned.rows[0]) throw new ApiError(404, 'vehicle unavailable');
    res.json({ data: [] });
    return;
  }
  try {
    res.json({ data: await Promise.all(rows.map(async ({ object_key, ...photo }) => ({ ...photo, url: await getVehiclePhotoUrl(object_key) }))) });
  } catch (error) {
    if (error instanceof ObjectStorageUnavailableError || (error instanceof Error && error.name === 'CredentialsProviderError')) {
      throw new ApiError(503, 'Vehicle photo storage is not configured', 'object_storage_unavailable');
    }
    throw error;
  }
}));

app.patch('/api/v1/vehicles/:id/photos/:photoId/primary', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const photo = await client.query(
      `SELECT p.id FROM vehicle_photos p JOIN vehicles v ON v.id=p.vehicle_id
        WHERE p.id=$1 AND p.vehicle_id=$2 AND v.owner_id=$3 AND v.archived_at IS NULL FOR UPDATE OF v,p`, [req.params.photoId, req.params.id, req.userId],
    );
    if (!photo.rows[0]) throw new ApiError(404, 'vehicle photo unavailable');
    await client.query('UPDATE vehicle_photos SET is_primary=false WHERE vehicle_id=$1', [req.params.id]);
    const { rows } = await client.query(
      'UPDATE vehicle_photos SET is_primary=true WHERE id=$1 RETURNING id,vehicle_id,is_primary,created_at', [req.params.photoId],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'vehicle.photo.primary_changed', 'vehicle', req.params.id]);
    await client.query('COMMIT');
    res.json({ data: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.delete('/api/v1/vehicles/:id/photos/:photoId', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const found = await pool.query<{ object_key: string; is_primary: boolean }>(
    `SELECT p.object_key,p.is_primary FROM vehicle_photos p JOIN vehicles v ON v.id=p.vehicle_id
      WHERE p.id=$1 AND p.vehicle_id=$2 AND v.owner_id=$3 AND v.archived_at IS NULL`, [req.params.photoId, req.params.id, req.userId],
  );
  if (!found.rows[0]) throw new ApiError(404, 'vehicle photo unavailable');
  try { await deleteStoredVehiclePhoto(found.rows[0].object_key); }
  catch (error) {
    if (error instanceof ObjectStorageUnavailableError || (error instanceof Error && error.name === 'CredentialsProviderError')) {
      throw new ApiError(503, 'Vehicle photo storage is not configured', 'object_storage_unavailable');
    }
    throw new ApiError(503, 'Vehicle photo could not be deleted', 'vehicle_photo_delete_failed');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM vehicles WHERE id=$1 AND owner_id=$2 FOR UPDATE', [req.params.id, req.userId]);
    const removed = await client.query(
      'DELETE FROM vehicle_photos WHERE id=$1 AND vehicle_id=$2 RETURNING is_primary', [req.params.photoId, req.params.id],
    );
    if (!removed.rows[0]) throw new ApiError(404, 'vehicle photo unavailable');
    if (removed.rows[0].is_primary) {
      await client.query(
        'UPDATE vehicle_photos SET is_primary=true WHERE id=(SELECT id FROM vehicle_photos WHERE vehicle_id=$1 ORDER BY created_at,id LIMIT 1)', [req.params.id],
      );
    }
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'vehicle.photo.deleted', 'vehicle', req.params.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.json({ data: { id: req.params.photoId, deleted: true } });
}));

app.post('/api/v1/offers', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const { vehicleId, originName, destinationName, origin, destination, departureAt, pricePerSeatMinor, seats } = body;
  const pointValid = (point: unknown) => Array.isArray(point) && point.length === 2 &&
    typeof point[0] === 'number' && typeof point[1] === 'number' &&
    Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
  const departure = new Date(departureAt);
  if (typeof vehicleId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(vehicleId) ||
      typeof originName !== 'string' || originName.trim().length < 1 || originName.length > 120 ||
      typeof destinationName !== 'string' || destinationName.trim().length < 1 || destinationName.length > 120 ||
      !pointValid(origin) || !pointValid(destination) || !Number.isFinite(departure.getTime()) || departure <= new Date() ||
      !Number.isInteger(pricePerSeatMinor) || pricePerSeatMinor < 1 || pricePerSeatMinor > 100_000_000 ||
      !Number.isInteger(seats) || seats < 1 || seats > 20) {
    throw new ApiError(400, 'invalid offer fields');
  }
  let roadRoute: Awaited<ReturnType<typeof getRoadRoute>> | undefined;
  if (process.env.NODE_ENV === 'production' || process.env.ROUTING_ENGINE_URL) {
    try { roadRoute = await getRoadRoute(origin as [number, number], destination as [number, number]); }
    catch (error) {
      if (error instanceof RoutingUnavailableError) throw new ApiError(503, error.message, 'routing_unavailable');
      throw error;
    }
  }
  const arrivalAt = roadRoute ? new Date(departure.getTime() + roadRoute.durationSeconds * 1000) : null;
  const routeGeoJson = roadRoute ? JSON.stringify({ type: 'LineString', coordinates: roadRoute.geometry }) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vehicle = await client.query<{ seat_count: number; has_photo: boolean }>(
      `SELECT v.seat_count,EXISTS(SELECT 1 FROM vehicle_photos p WHERE p.vehicle_id=v.id) AS has_photo
         FROM vehicles v WHERE v.id=$1 AND v.owner_id=$2 AND v.verification_status='verified' FOR SHARE`,
      [vehicleId, req.userId],
    );
    if (!vehicle.rows[0]) throw new ApiError(404, 'verified vehicle unavailable');
    if (!vehicle.rows[0].has_photo) throw new ApiError(409, 'A verified vehicle photo is required before publishing', 'vehicle_photo_required');
    if (seats > Number(vehicle.rows[0].seat_count)) throw new ApiError(400, 'offer exceeds vehicle capacity');
    const { rows } = await client.query(
      `INSERT INTO offers(driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats)
       VALUES ($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,ST_SetSRID(ST_MakePoint($7,$8),4326)::geography,
         CASE WHEN $9::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($9),4326) END,$10,$11,$12,$13,$14,$15,$16,$16)
       RETURNING id,origin_name,destination_name,departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,currency,total_seats,available_seats,status`,
      [req.userId, vehicleId, originName.trim(), destinationName.trim(), origin[0], origin[1], destination[0], destination[1], routeGeoJson,
        departure.toISOString(), arrivalAt?.toISOString() ?? null, roadRoute ? Math.round(roadRoute.distanceMeters) : null,
        roadRoute ? Math.round(roadRoute.durationSeconds) : null, roadRoute ? 'osrm' : (process.env.NODE_ENV === 'production' ? null : 'development_unrouted'), pricePerSeatMinor, seats],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'offer.created', 'offer', rows[0].id]);
    await client.query('COMMIT');
    res.status(201).json({ data: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/v1/bookings', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.offer_id, b.seat_count, b.total_price_minor, b.currency, b.fee_class, b.platform_fee_minor, b.fee_rule_version, b.status, b.created_at,
            o.origin_name, o.destination_name, o.departure_at, u.display_name AS driver_name, p.display_name AS passenger_name,
            (o.driver_id=$1) AS current_user_is_driver,
            (SELECT count(*)::int FROM booking_completion_confirmations cc WHERE cc.booking_id=b.id) AS completion_confirmation_count,
            EXISTS(SELECT 1 FROM booking_completion_confirmations cc WHERE cc.booking_id=b.id AND cc.user_id=$1) AS current_user_confirmed_completion
       FROM bookings b JOIN offers o ON o.id = b.offer_id JOIN users u ON u.id = o.driver_id
       JOIN users p ON p.id=b.passenger_id
      WHERE b.passenger_id = $1 OR o.driver_id=$1 ORDER BY b.created_at DESC LIMIT 100`, [req.userId],
  );
  res.json({ data: rows });
}));

app.get('/api/v1/bookings/:id/events', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.id,e.from_status,e.to_status,e.actor_id,e.reason,e.created_at
       FROM booking_events e JOIN bookings b ON b.id=e.booking_id JOIN offers o ON o.id=b.offer_id
      WHERE b.id=$1 AND (b.passenger_id=$2 OR o.driver_id=$2) ORDER BY e.created_at,e.id`, [req.params.id, req.userId],
  );
  if (!rows.length) {
    const booking = await pool.query('SELECT 1 FROM bookings WHERE id=$1 AND passenger_id=$2', [req.params.id, req.userId]);
    if (!booking.rows[0]) throw new ApiError(404, 'booking unavailable');
  }
  res.json({ data: rows });
}));

app.post('/api/v1/bookings', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const offerId = req.body?.offerId;
  const seats = req.body?.seats;
  const key = req.get('idempotency-key');
  if (typeof offerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(offerId)) throw new ApiError(400, 'valid offerId is required');
  if (!Number.isInteger(seats) || seats < 1 || seats > 20) throw new ApiError(400, 'seats must be an integer from 1 to 20');
  if (!key || key.length < 16 || key.length > 128) throw new ApiError(400, 'Idempotency-Key must be 16–128 characters');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const offer = await client.query<{ price_per_seat_minor: number; currency: string; available_seats: number; driver_id: string; status: string; departure_at: Date }>(
      'SELECT price_per_seat_minor, currency, available_seats, driver_id, status, departure_at FROM offers WHERE id = $1 FOR UPDATE', [offerId],
    );
    const currentOffer = offer.rows[0];
    if (!currentOffer || currentOffer.status !== 'published') throw new ApiError(404, 'offer unavailable');

    const prior = await client.query(
      'SELECT id, offer_id, seat_count, total_price_minor, currency, fee_class, platform_fee_minor, fee_rule_version, status FROM bookings WHERE passenger_id = $1 AND idempotency_key = $2',
      [userId, key],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].offer_id !== offerId || Number(prior.rows[0].seat_count) !== seats) throw new ApiError(409, 'idempotency key already used for another request');
      await client.query('COMMIT');
      res.status(200).json({ data: prior.rows[0], replayed: true });
      return;
    }
    if (new Date(currentOffer.departure_at).getTime() <= Date.now()) {
      throw new ApiError(409, 'offer departure has passed', 'offer_expired');
    }
    if (currentOffer.driver_id === userId) throw new ApiError(400, 'drivers cannot book their own offer');
    if (Number(currentOffer.available_seats) < seats) throw new ApiError(409, 'not enough available seats');

    const total = Number(currentOffer.price_per_seat_minor) * seats;
    const fee = calculatePlatformFee(total, 'community');
    await client.query('UPDATE offers SET available_seats = available_seats - $2 WHERE id = $1', [offerId, seats]);
    const booking = await client.query(
      `INSERT INTO bookings(offer_id, passenger_id, seat_count, unit_price_minor, total_price_minor, currency, fee_class, platform_fee_minor, fee_rule_version, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, offer_id, seat_count, unit_price_minor, total_price_minor, currency, fee_class, platform_fee_minor, fee_rule_version, status, created_at`,
      [offerId, userId, seats, currentOffer.price_per_seat_minor, total, currentOffer.currency, fee.feeClass, fee.platformFeeMinor, fee.ruleVersion, key],
    );
    await client.query('INSERT INTO conversations(booking_id) VALUES ($1)', [booking.rows[0].id]);
    await client.query("INSERT INTO booking_events(booking_id,from_status,to_status,actor_id) VALUES ($1,NULL,'confirmed',$2)", [booking.rows[0].id, userId]);
    await client.query('INSERT INTO conversation_members(conversation_id,user_id) SELECT id,$2 FROM conversations WHERE booking_id=$1', [booking.rows[0].id, currentOffer.driver_id]);
    await client.query('INSERT INTO conversation_members(conversation_id,user_id) SELECT id,$2 FROM conversations WHERE booking_id=$1', [booking.rows[0].id, userId]);
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [userId, 'booking.created', 'booking', booking.rows[0].id]);
    await insertRealtimeOutbox(client, 'booking.confirmed', `booking.confirmed:${booking.rows[0].id}`,
      [userId, currentOffer.driver_id], {
        booking_id: booking.rows[0].id, offer_id: offerId, status: 'confirmed', seat_count: seats,
        available_seats: Number(currentOffer.available_seats) - seats,
      });
    await client.query('COMMIT');
    res.status(201).json({ data: booking.rows[0], replayed: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/v1/bookings/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<{ id: string; offer_id: string; seat_count: number; status: string; driver_id: string; passenger_id: string }>(
      'SELECT b.id,b.offer_id,b.seat_count,b.status,o.driver_id,b.passenger_id FROM bookings b JOIN offers o ON o.id=b.offer_id WHERE b.id=$1 AND (b.passenger_id=$2 OR o.driver_id=$2) FOR UPDATE OF b', [req.params.id, req.userId],
    );
    const booking = locked.rows[0];
    if (!booking) throw new ApiError(404, 'booking unavailable');
    if (booking.status === 'cancelled') {
      await client.query('COMMIT');
      res.json({ data: { id: booking.id, status: 'cancelled' }, replayed: true });
      return;
    }
    if (booking.status !== 'confirmed') throw new ApiError(409, 'booking cannot be cancelled');
    await client.query("UPDATE bookings SET status='cancelled', cancelled_at=now() WHERE id=$1", [booking.id]);
    await client.query("INSERT INTO booking_events(booking_id,from_status,to_status,actor_id) VALUES ($1,'confirmed','cancelled',$2)", [booking.id, req.userId]);
    const inventory = await client.query<{ available_seats: number }>("UPDATE offers SET available_seats=LEAST(total_seats,available_seats+$2) WHERE id=$1 AND status <> 'cancelled' RETURNING available_seats", [booking.offer_id, booking.seat_count]);
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'booking.cancelled', 'booking', booking.id]);
    await insertRealtimeOutbox(client, 'booking.cancelled', `booking.cancelled:${booking.id}`,
      [req.userId!, booking.driver_id], {
        booking_id: booking.id, offer_id: booking.offer_id, status: 'cancelled', seat_count: booking.seat_count,
        available_seats: inventory.rows[0]?.available_seats ?? null,
      });
    await client.query('COMMIT');
    res.json({ data: { id: booking.id, status: 'cancelled' }, replayed: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/v1/bookings/:id/rescue', requireAuth, asyncHandler(async (req, res) => {
  const { rows: bookings } = await pool.query<{
    id: string; passenger_id: string; status: string; seat_count: number; departure_at: Date;
    origin_name: string; destination_name: string; origin_lon: number; origin_lat: number;
    destination_lon: number; destination_lat: number; offer_id: string;
  }>(
    `SELECT b.id,b.passenger_id,b.status,b.seat_count,o.departure_at,o.origin_name,o.destination_name,
            ST_X(o.origin::geometry) AS origin_lon,ST_Y(o.origin::geometry) AS origin_lat,
            ST_X(o.destination::geometry) AS destination_lon,ST_Y(o.destination::geometry) AS destination_lat,o.id AS offer_id
       FROM bookings b JOIN offers o ON o.id=b.offer_id
      WHERE b.id=$1 AND b.passenger_id=$2`, [req.params.id, req.userId],
  );
  const booking = bookings[0];
  if (!booking) throw new ApiError(404, 'booking unavailable');
  if (booking.status !== 'cancelled') throw new ApiError(409, 'rescue search is available only after cancellation');
  const { rows } = await pool.query(
    `SELECT o.id,o.origin_name,o.destination_name,o.departure_at,o.arrival_at,o.distance_m,o.duration_s,o.route_source,
            o.price_per_seat_minor,o.currency,o.available_seats,o.total_seats,u.display_name AS driver_name,
            ratings.average_rating,ratings.review_count,photo.object_key AS vehicle_photo_key,
            round(ST_Distance(o.origin,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography))::int AS origin_distance_m,
            round(ST_Distance(o.destination,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography))::int AS destination_distance_m,
            'MARSHGO Community'::text AS source
       FROM offers o JOIN users u ON u.id=o.driver_id
       LEFT JOIN vehicle_photos photo ON photo.vehicle_id=o.vehicle_id AND photo.is_primary=true
       LEFT JOIN LATERAL (SELECT round(avg(r.rating)::numeric,2) AS average_rating,count(*)::int AS review_count
                            FROM reviews r WHERE r.target_id=o.driver_id) ratings ON true
      WHERE o.status='published' AND o.departure_at>now() AND o.id<>$5 AND o.driver_id<>$6
        AND o.available_seats >= $7
        AND o.departure_at >= GREATEST(now(),$8::timestamptz-interval '2 hours')
        AND o.departure_at <= $8::timestamptz+interval '4 hours'
        AND ST_DWithin(o.origin,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,20000)
        AND ST_DWithin(o.destination,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,20000)
        AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=o.driver_id AND b.blocked_id=$6) OR (b.blocker_id=$6 AND b.blocked_id=o.driver_id))
      ORDER BY ST_Distance(o.origin,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)+ST_Distance(o.destination,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography),ABS(extract(epoch FROM (o.departure_at-$8::timestamptz)))
      LIMIT 20`, [booking.origin_lon, booking.origin_lat, booking.destination_lon, booking.destination_lat,
      booking.offer_id, req.userId, booking.seat_count, booking.departure_at],
  );
  res.json({ data: {
    booking_id: booking.id,
    checked_at: new Date().toISOString(),
    radius_m: 20_000,
    alternatives: await Promise.all(rows.map(async ({ vehicle_photo_key, ...offer }) => ({
      ...offer,
      vehicle_photo_url: vehicle_photo_key ? await getVehiclePhotoUrl(vehicle_photo_key).catch(() => null) : null,
    }))),
  } });
}));

app.get('/api/v1/bookings/:id/ticket', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query<{ id: string; status: string; departure_at: Date }>(
    `SELECT b.id,b.status,o.departure_at FROM bookings b JOIN offers o ON o.id=b.offer_id
      WHERE b.id=$1 AND (b.passenger_id=$2 OR o.driver_id=$2)`, [req.params.id, req.userId],
  );
  const booking = rows[0];
  if (!booking) throw new ApiError(404, 'booking unavailable');
  if (!['confirmed','boarding'].includes(booking.status)) throw new ApiError(409, 'ticket is no longer valid');
  res.json({ data: { format: 'MARSHGO-HMAC-SHA256-V1', ...createBookingTicket(booking.id, new Date(booking.departure_at)) } });
}));

app.post('/api/v1/bookings/:id/boarding', requireAuth, asyncHandler(async (req, res) => {
  if (!validBookingTicket(req.body?.ticket, req.params.id)) throw new ApiError(400, 'booking ticket is invalid or expired', 'ticket_invalid');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; driver_id: string; passenger_id: string; status: string }>(
      `SELECT b.id,o.driver_id,b.passenger_id,b.status FROM bookings b JOIN offers o ON o.id=b.offer_id WHERE b.id=$1 FOR UPDATE OF b,o`, [req.params.id],
    );
    const booking = rows[0];
    if (!booking || booking.driver_id !== req.userId) throw new ApiError(404, 'booking unavailable');
    if (booking.status === 'boarding') {
      await client.query('COMMIT');
      res.json({ data: { id: booking.id, status: 'boarding' }, replayed: true });
      return;
    }
    if (booking.status !== 'confirmed') throw new ApiError(409, 'booking cannot enter boarding');
    await client.query("UPDATE bookings SET status='boarding' WHERE id=$1", [booking.id]);
    await client.query("INSERT INTO booking_events(booking_id,from_status,to_status,actor_id) VALUES ($1,'confirmed','boarding',$2)", [booking.id, req.userId]);
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'booking.boarding', 'booking', booking.id]);
    await insertRealtimeOutbox(client, 'booking.changed', `booking.changed:${booking.id}:boarding`,
      [booking.driver_id, booking.passenger_id], { booking_id: booking.id, status: 'boarding' });
    await client.query('COMMIT');
    res.json({ data: { id: booking.id, status: 'boarding' }, replayed: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.post('/api/v1/bookings/:id/start', requireAuth, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; driver_id: string; passenger_id: string; status: string }>(
      'SELECT b.id,o.driver_id,b.passenger_id,b.status FROM bookings b JOIN offers o ON o.id=b.offer_id WHERE b.id=$1 FOR UPDATE OF b,o', [req.params.id],
    );
    const booking = rows[0];
    if (!booking || booking.driver_id !== req.userId) throw new ApiError(404, 'booking unavailable');
    if (booking.status !== 'boarding') throw new ApiError(409, 'booking must be boarding before trip start');
    await client.query("UPDATE bookings SET status='in_progress' WHERE id=$1", [booking.id]);
    await client.query("INSERT INTO booking_events(booking_id,from_status,to_status,actor_id) VALUES ($1,'boarding','in_progress',$2)", [booking.id, req.userId]);
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'booking.started', 'booking', booking.id]);
    await insertRealtimeOutbox(client, 'booking.changed', `booking.changed:${booking.id}:in_progress`,
      [booking.driver_id, booking.passenger_id], { booking_id: booking.id, status: 'in_progress' });
    await client.query('COMMIT');
    res.json({ data: { id: booking.id, status: 'in_progress' } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.post('/api/v1/bookings/:id/complete', requireAuth, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; driver_id: string; passenger_id: string; status: string }>(
      `SELECT b.id,o.driver_id,b.passenger_id,b.status FROM bookings b JOIN offers o ON o.id=b.offer_id WHERE b.id=$1 FOR UPDATE OF b,o`, [req.params.id],
    );
    const booking = rows[0];
    if (!booking || (booking.driver_id !== req.userId && booking.passenger_id !== req.userId)) throw new ApiError(404, 'booking unavailable');
    if (booking.status === 'completed') {
      await client.query('COMMIT');
      res.json({ data: { id: booking.id, status: 'completed', confirmations: 2 }, replayed: true });
      return;
    }
    if (booking.status !== 'in_progress') throw new ApiError(409, 'only an in-progress trip can be completed');
    await client.query('INSERT INTO booking_completion_confirmations(booking_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [booking.id, req.userId]);
    const confirmations = await client.query('SELECT count(*)::int AS count FROM booking_completion_confirmations WHERE booking_id=$1', [booking.id]);
    const count = Number(confirmations.rows[0].count);
    let status = 'in_progress';
    if (count >= 2) {
      status = 'completed';
      await client.query("UPDATE bookings SET status='completed',completed_at=now() WHERE id=$1 AND status='in_progress'", [booking.id]);
      await client.query("INSERT INTO booking_events(booking_id,from_status,to_status,actor_id) VALUES ($1,'in_progress','completed',$2)", [booking.id, req.userId]);
      await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'booking.completed', 'booking', booking.id]);
      await insertRealtimeOutbox(client, 'booking.changed', `booking.changed:${booking.id}:completed`,
        [booking.driver_id, booking.passenger_id], { booking_id: booking.id, status: 'completed' });
    } else {
      await insertRealtimeOutbox(client, 'booking.changed', `booking.changed:${booking.id}:completion-confirmed:${req.userId}`,
        [booking.driver_id, booking.passenger_id], { booking_id: booking.id, status: 'in_progress', completion_confirmation_count: count });
    }
    await client.query('COMMIT');
    res.json({ data: { id: booking.id, status, confirmations: count, requiredConfirmations: 2 } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.post('/api/v1/bookings/:id/reviews', requireAuth, asyncHandler(async (req, res) => {
  const rating = req.body?.rating;
  const comment = req.body?.comment;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || (comment !== undefined && comment !== null && (typeof comment !== 'string' || comment.trim().length > 1000))) {
    throw new ApiError(400, 'rating must be 1–5 and comment must be at most 1000 characters');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: bookings } = await client.query<{ status: string; passenger_id: string; driver_id: string }>(
      `SELECT b.status,b.passenger_id,o.driver_id FROM bookings b JOIN offers o ON o.id=b.offer_id WHERE b.id=$1 FOR SHARE OF b`, [req.params.id],
    );
    const booking = bookings[0];
    if (!booking || (booking.passenger_id !== req.userId && booking.driver_id !== req.userId)) throw new ApiError(404, 'booking unavailable');
    if (booking.status !== 'completed') throw new ApiError(409, 'reviews are available only after both users confirm trip completion');
    const targetId = booking.passenger_id === req.userId ? booking.driver_id : booking.passenger_id;
    const { rows } = await client.query(
      `INSERT INTO reviews(booking_id,author_id,target_id,rating,comment) VALUES ($1,$2,$3,$4,$5)
       RETURNING id,booking_id,author_id,target_id,rating,comment,created_at`,
      [req.params.id, req.userId, targetId, rating, typeof comment === 'string' ? comment.trim() || null : null],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'review.created', 'booking', req.params.id]);
    await client.query('COMMIT');
    res.status(201).json({ data: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') throw new ApiError(409, 'you already reviewed this trip', 'review_already_exists');
    throw error;
  } finally { client.release(); }
}));

app.post('/api/v1/demands', requireAuth, requireRole('passenger'), asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const { originName, destinationName, origin, destination, earliestDeparture, latestDeparture, passengers, budgetMinor, budgetType, notes, requirements } = body;
  const validPoint = (point: unknown) => Array.isArray(point) && point.length === 2 &&
    typeof point[0] === 'number' && typeof point[1] === 'number' && Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
    Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
  const earliest = new Date(earliestDeparture);
  const latest = new Date(latestDeparture);
  if (typeof originName !== 'string' || !originName.trim() || originName.length > 120 ||
      typeof destinationName !== 'string' || !destinationName.trim() || destinationName.length > 120 ||
      !validPoint(origin) || !validPoint(destination) || !Number.isFinite(earliest.getTime()) || !Number.isFinite(latest.getTime()) ||
      earliest <= new Date() || latest < earliest || latest.getTime() - earliest.getTime() > 7 * 86400_000 ||
      !Number.isInteger(passengers) || passengers < 1 || passengers > 20 ||
      (budgetMinor !== undefined && (!Number.isInteger(budgetMinor) || budgetMinor < 0 || budgetMinor > 100_000_000)) ||
      (budgetType !== undefined && budgetType !== 'total_all' && budgetType !== 'per_seat') ||
      (notes !== undefined && (typeof notes !== 'string' || notes.trim().length > 1000)) ||
      (requirements !== undefined && (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)))) {
    throw new ApiError(400, 'invalid passenger demand');
  }
  const { rows } = await pool.query(
    `INSERT INTO passenger_demands(passenger_id,origin_name,destination_name,origin,destination,earliest_departure,latest_departure,passenger_count,budget_minor,budget_type,notes,requirements)
     VALUES ($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,ST_SetSRID(ST_MakePoint($6,$7),4326)::geography,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id,origin_name,destination_name,earliest_departure,latest_departure,passenger_count,budget_minor,budget_type,notes,requirements,status,created_at`,
    [req.userId, originName.trim(), destinationName.trim(), origin[0], origin[1], destination[0], destination[1], earliest.toISOString(), latest.toISOString(), passengers, budgetMinor ?? null, budgetType ?? 'total_all', notes?.trim() || null, JSON.stringify(requirements ?? {})],
  );
  await pool.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'demand.created', 'demand', rows[0].id]);
  res.status(201).json({ data: rows[0] });
}));

app.get('/api/v1/demands/mine', requireAuth, requireRole('passenger'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id,d.origin_name,d.destination_name,d.earliest_departure,d.latest_departure,d.passenger_count,d.budget_minor,d.budget_type,d.notes,d.requirements,d.status,d.created_at,
            (SELECT count(*)::int FROM proposals p WHERE p.demand_id=d.id AND p.status='pending') AS proposal_count
       FROM passenger_demands d WHERE d.passenger_id=$1 ORDER BY d.created_at DESC LIMIT 100`, [req.userId],
  );
  res.json({ data: rows });
}));

app.post('/api/v1/demands/:id/cancel', requireAuth, requireRole('passenger'), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; status: string }>(
      'SELECT id,status FROM passenger_demands WHERE id=$1 AND passenger_id=$2 FOR UPDATE', [req.params.id, req.userId],
    );
    const demand = rows[0];
    if (!demand) throw new ApiError(404, 'demand unavailable');
    if (demand.status === 'cancelled') {
      await client.query('COMMIT');
      res.json({ data: demand, replayed: true });
      return;
    }
    if (demand.status !== 'open') throw new ApiError(409, 'only an open demand can be cancelled');
    await client.query("UPDATE passenger_demands SET status='cancelled' WHERE id=$1", [demand.id]);
    const closedProposals = await client.query<{ id: string; driver_id: string }>(
      "UPDATE proposals SET status='rejected' WHERE demand_id=$1 AND status='pending' RETURNING id,driver_id", [demand.id],
    );
    for (const proposal of closedProposals.rows) {
      await insertRealtimeOutbox(client, 'proposal.closed', `proposal.closed:${proposal.id}:demand_cancelled`,
        [req.userId!, proposal.driver_id], {
          proposal_id: proposal.id, demand_id: demand.id, status: 'rejected', reason: 'demand_cancelled',
        });
    }
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'demand.cancelled', 'demand', demand.id]);
    await client.query('COMMIT');
    res.json({ data: { id: demand.id, status: 'cancelled' }, replayed: false });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.get('/api/v1/demands', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,origin_name,destination_name,earliest_departure,latest_departure,passenger_count,budget_minor,budget_type,notes,requirements,created_at
       FROM passenger_demands d WHERE status='open' AND latest_departure>now() AND passenger_id<>$1
         AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=d.passenger_id AND b.blocked_id=$1) OR (b.blocker_id=$1 AND b.blocked_id=d.passenger_id))
      ORDER BY earliest_departure LIMIT 100`, [req.userId],
  );
  res.json({ data: rows });
}));

app.get('/api/v1/demands/:id/proposals', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id,p.demand_id,p.driver_id,u.display_name AS driver_name,p.vehicle_id,p.navigation_candidate_id,v.make,v.model,v.model_year,
            p.price_minor,p.currency,p.departure_at,p.comment,p.status,p.expires_at,p.revision_number,
            latest.actor_role AS last_actor_role,latest.comment AS last_comment
       FROM passenger_demands d JOIN proposals p ON p.demand_id=d.id
       JOIN users u ON u.id=p.driver_id LEFT JOIN vehicles v ON v.id=p.vehicle_id
       LEFT JOIN LATERAL (SELECT actor_role,comment FROM proposal_revisions r WHERE r.proposal_id=p.id ORDER BY revision_number DESC LIMIT 1) latest ON true
      WHERE d.id=$1 AND (d.passenger_id=$2 OR p.driver_id=$2)
        AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE (b.blocker_id=d.passenger_id AND b.blocked_id=p.driver_id) OR (b.blocker_id=p.driver_id AND b.blocked_id=d.passenger_id))
      ORDER BY p.created_at DESC`, [req.params.id, req.userId],
  );
  if (!rows.length) {
    const demand = await pool.query<{ passenger_id: string; status: string }>('SELECT passenger_id,status FROM passenger_demands WHERE id=$1', [req.params.id]);
    const driver = await pool.query<{ allowed: boolean }>('SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role=\'driver\') AS allowed', [req.userId]);
    if (!demand.rows[0] || (demand.rows[0].passenger_id !== req.userId && !(driver.rows[0]?.allowed && demand.rows[0].status === 'open'))) {
      throw new ApiError(404, 'demand unavailable');
    }
  }
  res.json({ data: rows });
}));

app.post('/api/v1/demands/:id/proposals', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const { vehicleId, priceMinor, departureAt, comment, navigationCandidateId } = req.body ?? {};
  const departure = new Date(departureAt);
  if (typeof vehicleId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(vehicleId) ||
      !Number.isInteger(priceMinor) || priceMinor < 1 || priceMinor > 100_000_000 || !Number.isFinite(departure.getTime()) ||
      (comment !== undefined && (typeof comment !== 'string' || comment.length > 1000)) ||
      (navigationCandidateId !== undefined && (typeof navigationCandidateId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(navigationCandidateId)))) throw new ApiError(400, 'invalid proposal');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: demands } = await client.query<{ passenger_id: string; earliest_departure: Date; latest_departure: Date; passenger_count: number; status: string }>(
      'SELECT passenger_id,earliest_departure,latest_departure,passenger_count,status FROM passenger_demands WHERE id=$1 FOR UPDATE', [req.params.id],
    );
    const demand = demands[0];
    if (!demand || demand.status !== 'open') throw new ApiError(404, 'demand unavailable');
    if (demand.passenger_id === req.userId) throw new ApiError(403, 'cannot propose to your own demand');
    if (await usersBlockEachOther(req.userId!, demand.passenger_id, client)) throw new ApiError(404, 'demand unavailable');
    if (departure < new Date(demand.earliest_departure) || departure > new Date(demand.latest_departure)) throw new ApiError(400, 'departure is outside the demand time window');
    if (navigationCandidateId) {
      const { rows: candidates } = await client.query<{ id: string; vehicle_id: string | null; vehicle_seat_count: number | null; seat_count: number; route_version: number; candidate_route_version: number }>(
        `SELECT c.id,s.vehicle_id,s.vehicle_seat_count,v.seat_count,s.route_version,c.route_version AS candidate_route_version
           FROM navigation_match_candidates c
           JOIN navigation_sessions s ON s.id=c.navigation_session_id
           LEFT JOIN vehicles v ON v.id=s.vehicle_id AND v.owner_id=s.driver_id AND v.verification_status='verified'
          WHERE c.id=$1 AND c.demand_id=$2 AND s.driver_id=$3 AND s.state='paused' AND s.opt_in=true
            AND s.current_location_at>now()-interval '2 minutes' AND c.status='passenger_confirmed' AND c.expires_at>now()
          FOR UPDATE OF c,s`, [navigationCandidateId, req.params.id, req.userId],
      );
      const candidate = candidates[0];
      if (!candidate || candidate.vehicle_id !== vehicleId || Number(candidate.seat_count ?? 0) < Number(demand.passenger_count) ||
          Number(candidate.vehicle_seat_count ?? 0) < Number(demand.passenger_count) || Number(candidate.route_version) !== Number(candidate.candidate_route_version)) {
        throw new ApiError(409, 'navigation match is no longer current; refresh the route before proposing', 'navigation_candidate_unavailable');
      }
      const existing = await client.query('SELECT 1 FROM proposals WHERE navigation_candidate_id=$1', [navigationCandidateId]);
      if (existing.rowCount) throw new ApiError(409, 'a proposal already exists for this navigation match', 'navigation_proposal_exists');
    }
    const { rows: vehicles } = await client.query<{ seat_count: number }>(
      "SELECT seat_count FROM vehicles WHERE id=$1 AND owner_id=$2 AND verification_status='verified' FOR SHARE", [vehicleId, req.userId],
    );
    if (!vehicles[0]) throw new ApiError(404, 'verified vehicle unavailable');
    if (Number(vehicles[0].seat_count) < Number(demand.passenger_count)) throw new ApiError(400, 'vehicle has too few passenger seats');
    const { rows } = await client.query(
      `INSERT INTO proposals(demand_id,driver_id,vehicle_id,price_minor,departure_at,comment,expires_at,navigation_candidate_id)
       VALUES ($1,$2,$3,$4,$5,$6,LEAST(now()+interval '24 hours',$7::timestamptz),$8)
       RETURNING id,demand_id,driver_id,vehicle_id,price_minor,departure_at,status,expires_at,created_at,navigation_candidate_id`,
      [req.params.id, req.userId, vehicleId, priceMinor, departure.toISOString(), comment?.trim() || null, demand.latest_departure, navigationCandidateId ?? null],
    );
    await client.query(
      `INSERT INTO proposal_revisions(proposal_id,revision_number,actor_id,actor_role,price_minor,departure_at,comment)
       VALUES ($1,1,$2,'driver',$3,$4,$5)`, [rows[0].id, req.userId, priceMinor, departure.toISOString(), comment?.trim() || null],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'proposal.created', 'proposal', rows[0].id]);
    await insertRealtimeOutbox(client, 'proposal.created', `proposal.created:${rows[0].id}`,
      [req.userId!, demand.passenger_id], {
        proposal_id: rows[0].id, demand_id: req.params.id, status: 'pending', revision_number: 1,
        price_minor: priceMinor, departure_at: departure.toISOString(), navigation_candidate_id: navigationCandidateId ?? null,
      });
    await client.query('COMMIT');
    res.status(201).json({ data: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/v1/proposals/:id/counter', requireAuth, asyncHandler(async (req, res) => {
  const { priceMinor, departureAt, comment } = req.body ?? {};
  const departure = new Date(departureAt);
  if (!Number.isInteger(priceMinor) || priceMinor < 1 || priceMinor > 100_000_000 || !Number.isFinite(departure.getTime()) ||
      (comment !== undefined && (typeof comment !== 'string' || comment.length > 1000))) throw new ApiError(400, 'invalid counter-offer');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string; demand_id: string; driver_id: string; passenger_id: string; price_minor: number; departure_at: Date;
      revision_number: number; expires_at: Date; demand_status: string; earliest_departure: Date; latest_departure: Date;
    }>(
      `SELECT p.id,p.demand_id,p.driver_id,d.passenger_id,p.price_minor,p.departure_at,p.revision_number,p.expires_at,
              d.status AS demand_status,d.earliest_departure,d.latest_departure
         FROM proposals p JOIN passenger_demands d ON d.id=p.demand_id
        WHERE p.id=$1 AND p.status='pending' FOR UPDATE OF p,d`, [req.params.id],
    );
    const proposal = rows[0];
    if (!proposal || proposal.demand_status !== 'open' || new Date(proposal.expires_at) <= new Date()) throw new ApiError(404, 'proposal unavailable');
    if (await usersBlockEachOther(proposal.passenger_id, proposal.driver_id, client)) throw new ApiError(404, 'proposal unavailable');
    const role = proposal.passenger_id === req.userId ? 'passenger' : proposal.driver_id === req.userId ? 'driver' : null;
    if (!role) throw new ApiError(403, 'not a negotiation participant');
    const { rows: latestRevision } = await client.query<{ actor_role: string }>(
      'SELECT actor_role FROM proposal_revisions WHERE proposal_id=$1 ORDER BY revision_number DESC LIMIT 1', [proposal.id],
    );
    if (latestRevision[0]?.actor_role === role) throw new ApiError(409, 'wait for the other participant to respond');
    if (departure < new Date(proposal.earliest_departure) || departure > new Date(proposal.latest_departure)) throw new ApiError(400, 'departure is outside the demand time window');
    if (Number(proposal.price_minor) === priceMinor && new Date(proposal.departure_at).getTime() === departure.getTime()) throw new ApiError(400, 'counter-offer must change price or time');
    const revision = Number(proposal.revision_number) + 1;
    await client.query('UPDATE proposals SET price_minor=$2,departure_at=$3,comment=$4,revision_number=$5 WHERE id=$1',
      [proposal.id, priceMinor, departure.toISOString(), comment?.trim() || null, revision]);
    await client.query(
      `INSERT INTO proposal_revisions(proposal_id,revision_number,actor_id,actor_role,price_minor,departure_at,comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [proposal.id, revision, req.userId, role, priceMinor, departure.toISOString(), comment?.trim() || null],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'proposal.countered', 'proposal', proposal.id]);
    await insertRealtimeOutbox(client, 'proposal.countered', `proposal.countered:${proposal.id}:${revision}`,
      [proposal.driver_id, proposal.passenger_id], {
        proposal_id: proposal.id, demand_id: proposal.demand_id, revision_number: revision,
        price_minor: priceMinor, departure_at: departure.toISOString(),
      });
    await client.query('COMMIT');
    res.json({ data: { id: proposal.id, price_minor: priceMinor, departure_at: departure.toISOString(), revision_number: revision } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/v1/proposals/:id/agree', requireAuth, requireRole('driver'), asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string; demand_id: string; driver_id: string; passenger_id: string; price_minor: number; departure_at: Date;
      revision_number: number; expires_at: Date; demand_status: string;
    }>(
      `SELECT p.id,p.demand_id,p.driver_id,d.passenger_id,p.price_minor,p.departure_at,p.revision_number,p.expires_at,d.status AS demand_status
         FROM proposals p JOIN passenger_demands d ON d.id=p.demand_id
        WHERE p.id=$1 AND p.status='pending' FOR UPDATE OF p,d`, [req.params.id],
    );
    const proposal = rows[0];
    if (!proposal || proposal.demand_status !== 'open' || new Date(proposal.expires_at) <= new Date()) throw new ApiError(404, 'proposal unavailable');
    if (proposal.driver_id !== req.userId) throw new ApiError(403, 'only the proposing driver can agree');
    if (await usersBlockEachOther(proposal.passenger_id, proposal.driver_id, client)) throw new ApiError(404, 'proposal unavailable');
    const { rows: latest } = await client.query<{ actor_id: string; actor_role: string }>(
      'SELECT actor_id,actor_role FROM proposal_revisions WHERE proposal_id=$1 ORDER BY revision_number DESC LIMIT 1', [proposal.id],
    );
    if (!latest[0] || latest[0].actor_role !== 'passenger') throw new ApiError(409, 'there is no passenger counter-offer to accept');
    const revision = Number(proposal.revision_number) + 1;
    await client.query('UPDATE proposals SET revision_number=$2 WHERE id=$1', [proposal.id, revision]);
    await client.query(
      `INSERT INTO proposal_revisions(proposal_id,revision_number,actor_id,actor_role,price_minor,departure_at,comment)
       VALUES ($1,$2,$3,'driver',$4,$5,'Водій погодив умови')`,
      [proposal.id, revision, req.userId, proposal.price_minor, new Date(proposal.departure_at).toISOString()],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'proposal.agreed', 'proposal', proposal.id]);
    await insertRealtimeOutbox(client, 'proposal.updated', `proposal.updated:${proposal.id}:${revision}`,
      [proposal.passenger_id, proposal.driver_id], {
        proposal_id: proposal.id, demand_id: proposal.demand_id, status: 'awaiting_passenger_confirmation',
        revision_number: revision, price_minor: proposal.price_minor, departure_at: new Date(proposal.departure_at).toISOString(),
      });
    await client.query('COMMIT');
    res.json({ data: { id: proposal.id, price_minor: proposal.price_minor, departure_at: proposal.departure_at, revision_number: revision, status: 'awaiting_passenger_confirmation' } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.post('/api/v1/proposals/:id/accept', requireAuth, asyncHandler(async (req, res) => {
  let navigationPlan: {
    candidateId: string; sessionId: string; routeVersion: number; currentLocation: [number, number]; originalDestination: [number, number];
    origin: [number, number]; destination: [number, number]; originName: string; destinationName: string;
    navigationRoute: Awaited<ReturnType<typeof getRoadRouteThroughPoints>>; passengerRoute: Awaited<ReturnType<typeof getRoadRoute>>;
  } | null = null;
  const proposalLink = await pool.query<{ navigation_candidate_id: string | null }>(
    'SELECT navigation_candidate_id FROM proposals WHERE id=$1', [req.params.id],
  );
  if (proposalLink.rows[0]?.navigation_candidate_id) {
    const { rows: plans } = await pool.query<{
      candidate_id: string; session_id: string; route_version: number; current_location: [number, number]; original_destination: [number, number];
      origin: [number, number]; destination: [number, number]; origin_name: string; destination_name: string;
    }>(
      `SELECT c.id AS candidate_id,s.id AS session_id,s.route_version,
          ARRAY[ST_X(s.current_location::geometry),ST_Y(s.current_location::geometry)] AS current_location,
          ARRAY[ST_X(s.destination::geometry),ST_Y(s.destination::geometry)] AS original_destination,
          ARRAY[ST_X(d.origin::geometry),ST_Y(d.origin::geometry)] AS origin,
          ARRAY[ST_X(d.destination::geometry),ST_Y(d.destination::geometry)] AS destination,
          d.origin_name,d.destination_name
       FROM proposals p JOIN navigation_match_candidates c ON c.id=p.navigation_candidate_id
       JOIN navigation_sessions s ON s.id=c.navigation_session_id
       JOIN passenger_demands d ON d.id=c.demand_id
       JOIN vehicles v ON v.id=s.vehicle_id AND v.owner_id=s.driver_id AND v.verification_status='verified'
       WHERE p.id=$1 AND d.passenger_id=$2 AND p.vehicle_id=s.vehicle_id
         AND d.status='open' AND c.status='passenger_confirmed' AND c.expires_at>now()
         AND c.route_version=s.route_version AND s.state='paused' AND s.opt_in=true
         AND s.current_location_at>now()-interval '2 minutes'
         AND NOT EXISTS(SELECT 1 FROM navigation_waypoints w WHERE w.navigation_session_id=s.id)`,
      [req.params.id, req.userId],
    );
    const plan = plans[0];
    if (!plan) throw new ApiError(409, 'navigation match consent or route is no longer current', 'navigation_candidate_unavailable');
    try {
      const [navigationRoute, passengerRoute] = await Promise.all([
        getRoadRouteThroughPoints([plan.current_location, plan.origin, plan.destination, plan.original_destination]),
        getRoadRoute(plan.origin, plan.destination),
      ]);
      navigationPlan = {
        candidateId: plan.candidate_id, sessionId: plan.session_id, routeVersion: Number(plan.route_version),
        currentLocation: plan.current_location, originalDestination: plan.original_destination, origin: plan.origin,
        destination: plan.destination, originName: plan.origin_name, destinationName: plan.destination_name,
        navigationRoute, passengerRoute,
      };
    } catch (error) {
      if (error instanceof RoutingUnavailableError) throw new ApiError(503, error.message, 'routing_unavailable');
      throw error;
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: demandRows } = await client.query<{
      id: string; passenger_id: string; origin_name: string; destination_name: string; passenger_count: number;
      status: string; earliest_departure: Date; latest_departure: Date;
    }>(
      `SELECT d.id,d.passenger_id,d.origin_name,d.destination_name,d.passenger_count,d.status,d.earliest_departure,d.latest_departure
         FROM passenger_demands d JOIN proposals p ON p.demand_id=d.id WHERE p.id=$1 FOR UPDATE OF d`, [req.params.id],
    );
    const demand = demandRows[0];
    if (!demand || demand.passenger_id !== req.userId) throw new ApiError(404, 'demand unavailable');
    if (demand.status !== 'open') throw new ApiError(409, 'demand has already been resolved');
    const { rows: proposalRows } = await client.query<{
      id: string; driver_id: string; vehicle_id: string; price_minor: number; departure_at: Date; status: string; expires_at: Date; navigation_candidate_id: string | null;
    }>('SELECT id,driver_id,vehicle_id,price_minor,departure_at,status,expires_at,navigation_candidate_id FROM proposals WHERE id=$1 AND demand_id=$2 FOR UPDATE', [req.params.id, demand.id]);
    const proposal = proposalRows[0];
    if (!proposal || proposal.status !== 'pending' || new Date(proposal.expires_at) <= new Date()) throw new ApiError(409, 'proposal is no longer available');
    if (await usersBlockEachOther(proposal.driver_id, demand.passenger_id, client)) throw new ApiError(404, 'proposal unavailable');
    if (proposal.navigation_candidate_id) {
      if (!navigationPlan || navigationPlan.candidateId !== proposal.navigation_candidate_id) {
        throw new ApiError(409, 'navigation route could not be prepared', 'navigation_candidate_unavailable');
      }
      const { rows: candidates } = await client.query<{ id: string; session_id: string; driver_id: string; vehicle_id: string | null; vehicle_seat_count: number | null; seat_count: number; route_version: number; candidate_route_version: number; movement_m: number }>(
        `SELECT c.id,s.id AS session_id,s.driver_id,s.vehicle_id,s.vehicle_seat_count,v.seat_count,s.route_version,c.route_version AS candidate_route_version,
                ST_Distance(s.current_location,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography) AS movement_m
           FROM navigation_match_candidates c
           JOIN navigation_sessions s ON s.id=c.navigation_session_id
           LEFT JOIN vehicles v ON v.id=s.vehicle_id AND v.owner_id=s.driver_id AND v.verification_status='verified'
          WHERE c.id=$1 AND c.demand_id=$2 AND s.state='paused' AND s.opt_in=true
            AND s.current_location_at>now()-interval '2 minutes' AND c.status='passenger_confirmed' AND c.expires_at>now()
             AND s.route_version=$5 AND NOT EXISTS(SELECT 1 FROM navigation_waypoints w WHERE w.navigation_session_id=s.id)
           FOR UPDATE OF c,s`, [proposal.navigation_candidate_id, demand.id, navigationPlan.currentLocation[0], navigationPlan.currentLocation[1], navigationPlan.routeVersion],
      );
      const candidate = candidates[0];
      if (!candidate || candidate.driver_id !== proposal.driver_id || candidate.vehicle_id !== proposal.vehicle_id ||
          Number(candidate.seat_count ?? 0) < Number(demand.passenger_count) || Number(candidate.vehicle_seat_count ?? 0) < Number(demand.passenger_count) ||
          Number(candidate.route_version) !== Number(candidate.candidate_route_version) || Number(candidate.movement_m) > 150) {
        throw new ApiError(409, 'navigation match consent or route is no longer current', 'navigation_candidate_unavailable');
      }
    }
    const { rows: latestRevisions } = await client.query<{ actor_role: string }>(
      'SELECT actor_role FROM proposal_revisions WHERE proposal_id=$1 ORDER BY revision_number DESC LIMIT 1', [proposal.id],
    );
    if (latestRevisions[0]?.actor_role !== 'driver') throw new ApiError(409, 'driver must agree to the passenger counter-offer before final confirmation');
    const departure = new Date(proposal.departure_at);
    if (departure < new Date(demand.earliest_departure) || departure > new Date(demand.latest_departure)) throw new ApiError(409, 'proposal time is outside the demand window');
    const { rows: vehicles } = await client.query(
      "SELECT id FROM vehicles WHERE id=$1 AND owner_id=$2 AND verification_status='verified' FOR SHARE", [proposal.vehicle_id, proposal.driver_id],
    );
    if (!vehicles[0]) throw new ApiError(409, 'driver vehicle is no longer verified');
    const { rows: offers } = await client.query(
      `INSERT INTO offers(driver_id,vehicle_id,origin_name,destination_name,origin,destination,route,departure_at,arrival_at,distance_m,duration_s,route_source,price_per_seat_minor,total_seats,available_seats)
       SELECT $1,$2,d.origin_name,d.destination_name,d.origin,d.destination,
              CASE WHEN $6::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($6),4326) END,
              $3,CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE $7::timestamptz END,$8,$9,CASE WHEN $6::text IS NULL THEN NULL ELSE 'osrm' END,
              $4,d.passenger_count,d.passenger_count
         FROM passenger_demands d WHERE d.id=$5 RETURNING id`,
      [proposal.driver_id, proposal.vehicle_id, departure.toISOString(), Math.floor(Number(proposal.price_minor) / Number(demand.passenger_count)), demand.id,
        navigationPlan ? JSON.stringify({ type: 'LineString', coordinates: navigationPlan.passengerRoute.geometry }) : null,
        navigationPlan ? new Date(departure.getTime() + navigationPlan.passengerRoute.durationSeconds * 1000).toISOString() : null,
        navigationPlan ? Math.round(navigationPlan.passengerRoute.distanceMeters) : null,
        navigationPlan ? Math.round(navigationPlan.passengerRoute.durationSeconds) : null],
    );
    const agreedTotal = Number(proposal.price_minor);
    const fee = calculatePlatformFee(agreedTotal, 'community');
    const { rows: bookings } = await client.query(
      `INSERT INTO bookings(offer_id,passenger_id,seat_count,unit_price_minor,total_price_minor,currency,fee_class,platform_fee_minor,fee_rule_version,idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'UAH',$6,$7,$8,$9)
       RETURNING id,offer_id,seat_count,unit_price_minor,total_price_minor,currency,fee_class,platform_fee_minor,fee_rule_version,status,created_at`,
      [offers[0].id, req.userId, demand.passenger_count, Math.floor(agreedTotal / Number(demand.passenger_count)), agreedTotal,
        fee.feeClass, fee.platformFeeMinor, fee.ruleVersion, `proposal-accept:${proposal.id}`],
    );
    await client.query("INSERT INTO booking_events(booking_id,from_status,to_status,actor_id) VALUES ($1,NULL,'confirmed',$2)", [bookings[0].id, req.userId]);
    const { rows: remainingInventory } = await client.query<{ available_seats: number }>(
      'UPDATE offers SET available_seats=available_seats-$2 WHERE id=$1 RETURNING available_seats', [offers[0].id, demand.passenger_count],
    );
    await client.query("UPDATE proposals SET status='accepted' WHERE id=$1", [proposal.id]);
    const competing = await client.query<{ id: string; driver_id: string }>(
      "UPDATE proposals SET status='rejected' WHERE demand_id=$1 AND id<>$2 AND status='pending' RETURNING id,driver_id", [demand.id, proposal.id],
    );
    await client.query("UPDATE passenger_demands SET status='matched' WHERE id=$1 AND status='open'", [demand.id]);
    await client.query('INSERT INTO conversations(booking_id) VALUES ($1)', [bookings[0].id]);
    await client.query('INSERT INTO conversation_members(conversation_id,user_id) SELECT id,$2 FROM conversations WHERE booking_id=$1', [bookings[0].id, proposal.driver_id]);
    await client.query('INSERT INTO conversation_members(conversation_id,user_id) SELECT id,$2 FROM conversations WHERE booking_id=$1', [bookings[0].id, req.userId]);
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES ($1,$2,$3,$4)', [req.userId, 'proposal.accepted', 'proposal', proposal.id]);
    if (navigationPlan) {
      const updatedSession = await client.query<{ route_version: number }>(
        `UPDATE navigation_sessions SET route=ST_SetSRID(ST_GeomFromGeoJSON($3),4326),route_distance_m=$4,route_duration_s=$5,
            route_version=route_version+1,opt_in=false
          WHERE id=$1 AND driver_id=$2 AND state='paused' AND opt_in=true AND route_version=$6
          RETURNING route_version`,
        [navigationPlan.sessionId, proposal.driver_id,
          JSON.stringify({ type: 'LineString', coordinates: navigationPlan.navigationRoute.geometry }),
          Math.round(navigationPlan.navigationRoute.distanceMeters), Math.round(navigationPlan.navigationRoute.durationSeconds), navigationPlan.routeVersion],
      );
      if (!updatedSession.rows[0]) throw new ApiError(409, 'navigation session changed before route update', 'navigation_session_changed');
      await client.query(
        `INSERT INTO navigation_waypoints(navigation_session_id,booking_id,candidate_id,ordinal,kind,place_name,location)
         VALUES($1,$2,$3,1,'pickup',$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography),
               ($1,$2,$3,2,'dropoff',$7,ST_SetSRID(ST_MakePoint($8,$9),4326)::geography)`,
        [navigationPlan.sessionId, bookings[0].id, navigationPlan.candidateId, navigationPlan.originName,
          navigationPlan.origin[0], navigationPlan.origin[1], navigationPlan.destinationName, navigationPlan.destination[0], navigationPlan.destination[1]],
      );
      await client.query(
        `UPDATE navigation_match_candidates SET status='expired'
          WHERE navigation_session_id=$1 AND status IN ('suggested','driver_interested','passenger_confirmed')`, [navigationPlan.sessionId],
      );
      await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4)',
        [req.userId, 'navigation.route.waypoints_added', 'booking', bookings[0].id]);
      await insertRealtimeOutbox(client, 'navigation.route-updated', `navigation.route-updated:${bookings[0].id}`,
        [proposal.driver_id], { navigation_session_id: navigationPlan.sessionId, booking_id: bookings[0].id, route_version: updatedSession.rows[0].route_version });
    }
    await insertRealtimeOutbox(client, 'booking.confirmed', `booking.confirmed:${bookings[0].id}`,
      [req.userId!, proposal.driver_id], {
        booking_id: bookings[0].id, offer_id: offers[0].id, status: 'confirmed',
        seat_count: demand.passenger_count, available_seats: remainingInventory[0]?.available_seats ?? null,
      });
    await insertRealtimeOutbox(client, 'proposal.accepted', `proposal.accepted:${proposal.id}`,
      [req.userId!, proposal.driver_id], {
        proposal_id: proposal.id, demand_id: demand.id, booking_id: bookings[0].id, status: 'accepted',
        price_minor: agreedTotal, departure_at: departure.toISOString(),
      });
    for (const closed of competing.rows) {
      await insertRealtimeOutbox(client, 'proposal.closed', `proposal.closed:${closed.id}:accepted:${proposal.id}`,
        [req.userId!, closed.driver_id], { proposal_id: closed.id, demand_id: demand.id, status: 'rejected', reason: 'another_proposal_accepted' });
    }
    await client.query('COMMIT');
    res.status(201).json({ data: bookings[0], proposalId: proposal.id, agreedTotalMinor: agreedTotal });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.get('/api/v1/proposals/:id/revisions', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.revision_number,r.actor_id,r.actor_role,r.price_minor,r.departure_at,r.comment,r.created_at
       FROM proposal_revisions r JOIN proposals p ON p.id=r.proposal_id
       JOIN passenger_demands d ON d.id=p.demand_id
      WHERE p.id=$1 AND (p.driver_id=$2 OR d.passenger_id=$2) ORDER BY r.revision_number`, [req.params.id, req.userId],
  );
  if (!rows.length) throw new ApiError(404, 'proposal unavailable');
  res.json({ data: rows });
}));

app.get('/api/v1/bookings/:id/conversation', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id,c.booking_id,c.created_at FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id=c.id
     WHERE c.booking_id=$1 AND cm.user_id=$2`, [req.params.id, req.userId],
  );
  if (!rows[0]) throw new ApiError(404, 'conversation unavailable');
  res.json({ data: rows[0] });
}));

app.post('/api/v1/bookings/:id/block-other', requireAuth, asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ passenger_id: string; driver_id: string }>(
      `SELECT b.passenger_id,o.driver_id FROM bookings b JOIN offers o ON o.id=b.offer_id
        WHERE b.id=$1 AND (b.passenger_id=$2 OR o.driver_id=$2) FOR UPDATE OF b`, [req.params.id, req.userId],
    );
    const booking = rows[0];
    if (!booking) throw new ApiError(404, 'booking unavailable');
    const otherUserId = booking.passenger_id === req.userId ? booking.driver_id : booking.passenger_id;
    await client.query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.userId, otherUserId]);
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4)', [req.userId, 'user.blocked', 'user', otherUserId]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.post('/api/v1/reports', requireAuth, asyncHandler(async (req, res) => {
  const { bookingId, category, details } = req.body ?? {};
  const categories = ['safety', 'harassment', 'fraud', 'service', 'other'];
  if (typeof bookingId !== 'string' || !/^[0-9a-f-]{36}$/i.test(bookingId) ||
      typeof category !== 'string' || !categories.includes(category) ||
      typeof details !== 'string' || details.trim().length < 10 || details.trim().length > 2000) {
    throw new ApiError(400, 'Booking, report category, and 10–2000 character details are required');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.userId]);
    const { rows } = await client.query<{ passenger_id: string; driver_id: string }>(
      `SELECT b.passenger_id,o.driver_id FROM bookings b JOIN offers o ON o.id=b.offer_id
        WHERE b.id=$1 AND (b.passenger_id=$2 OR o.driver_id=$2) FOR UPDATE OF b`, [bookingId, req.userId],
    );
    const booking = rows[0];
    if (!booking) throw new ApiError(404, 'booking unavailable');
    const reportedUserId = booking.passenger_id === req.userId ? booking.driver_id : booking.passenger_id;
    const limit = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM moderation_cases WHERE reporter_id=$1 AND created_at>now()-interval \'24 hours\'', [req.userId],
    );
    if (Number(limit.rows[0]?.count ?? 0) >= 10) throw new ApiError(429, 'Daily report limit reached', 'report_rate_limit');
    const report = await client.query<{ id: string; status: string }>(
      `INSERT INTO moderation_cases(reporter_id,reported_user_id,booking_id,category,details)
       VALUES($1,$2,$3,$4,$5) RETURNING id,status`, [req.userId, reportedUserId, bookingId, category, details.trim()],
    );
    await client.query('INSERT INTO audit_events(actor_id,action,entity_type,entity_id) VALUES($1,\'moderation.report.created\',\'moderation_case\',$2)', [req.userId, report.rows[0].id]);
    await client.query('COMMIT');
    res.status(201).json({ data: report.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new ApiError(409, 'An open report already exists for this booking', 'report_already_open');
    }
    throw error;
  } finally { client.release(); }
}));

app.get('/api/v1/admin/moderation', requireAuth, requireStaff, asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'open';
  if (!['open', 'in_review', 'resolved', 'dismissed', 'all'].includes(status)) throw new ApiError(400, 'Invalid moderation queue status');
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  const { rows } = await pool.query(
    `SELECT c.id,c.booking_id,c.category,c.details,c.status,c.resolution_action,c.resolution_note,
            c.created_at,c.updated_at,c.resolved_at,reporter.display_name AS reporter_name,
            reported.display_name AS reported_user_name,o.origin_name,o.destination_name
       FROM moderation_cases c
       JOIN users reporter ON reporter.id=c.reporter_id
       JOIN users reported ON reported.id=c.reported_user_id
       LEFT JOIN bookings b ON b.id=c.booking_id
       LEFT JOIN offers o ON o.id=b.offer_id
      WHERE ($1='all' OR c.status=$1)
        AND c.reporter_id<>$2 AND c.reported_user_id<>$2
      ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END,c.created_at,c.id
      LIMIT $3`, [status, req.userId, limit],
  );
  res.json({ data: rows });
}));

app.post('/api/v1/admin/moderation/:id/decision', requireAuth, requireStaff, asyncHandler(async (req, res) => {
  const nextStatus = req.body?.status;
  const action = req.body?.action;
  const note = req.body?.note;
  if (!['in_review', 'resolved', 'dismissed'].includes(nextStatus) ||
      (nextStatus === 'in_review' && (action !== undefined || note !== undefined)) ||
      (nextStatus !== 'in_review' && (!['no_action', 'suspend_account'].includes(action) || typeof note !== 'string' || note.trim().length < 3 || note.trim().length > 1000)) ||
      (nextStatus === 'dismissed' && action === 'suspend_account')) {
    throw new ApiError(400, 'Use in_review without a decision, or resolve/dismiss with an action and a 3–1000 character note');
  }
  const client = await pool.connect();
  let suspendedUserId: string | null = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string; reporter_id: string; reported_user_id: string; status: string; reviewer_id: string | null;
    }>('SELECT id,reporter_id,reported_user_id,status,reviewer_id FROM moderation_cases WHERE id=$1 FOR UPDATE', [req.params.id]);
    const report = rows[0];
    if (!report) throw new ApiError(404, 'moderation case unavailable');
    if (report.reporter_id === req.userId || report.reported_user_id === req.userId) throw new ApiError(403, 'Conflicted staff cannot review this case');
    if (report.status === 'resolved' || report.status === 'dismissed') throw new ApiError(409, 'Moderation case is already closed', 'moderation_case_closed');
    if (nextStatus === 'in_review' && report.status !== 'open') throw new ApiError(409, 'Moderation case is already under review');
    const staffRole = await client.query<{ is_admin: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role='admin') AS is_admin`, [req.userId],
    );
    if (report.status === 'in_review' && report.reviewer_id !== req.userId && !staffRole.rows[0]?.is_admin) {
      throw new ApiError(403, 'Only the assigned reviewer or an administrator can update this case');
    }
    if (action === 'suspend_account' && !staffRole.rows[0]?.is_admin) throw new ApiError(403, 'Only administrators can suspend an account');
    if (action === 'suspend_account') {
      const target = await client.query<{ roles: string[]; account_status: string }>('SELECT roles,account_status FROM users WHERE id=$1 FOR UPDATE', [report.reported_user_id]);
      if (target.rows[0]?.roles.includes('admin') || target.rows[0]?.roles.includes('moderator')) throw new ApiError(403, 'Staff accounts cannot be suspended through user reports');
      await client.query(`UPDATE users SET account_status='suspended',updated_at=now() WHERE id=$1 AND account_status='active'`, [report.reported_user_id]);
      await client.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1', [report.reported_user_id]);
      suspendedUserId = report.reported_user_id;
    }
    const { rows: updated } = await client.query(
      `UPDATE moderation_cases SET status=$2,reviewer_id=$3,resolution_action=$4,resolution_note=$5,
         updated_at=now(),resolved_at=CASE WHEN $2 IN ('resolved','dismissed') THEN now() ELSE NULL END
        WHERE id=$1 RETURNING id,status,resolution_action,resolution_note,updated_at,resolved_at`,
      [report.id, nextStatus, req.userId, action ?? null, typeof note === 'string' ? note.trim() : null],
    );
    await client.query(
      `INSERT INTO audit_events(actor_id,action,entity_type,entity_id,details)
       VALUES($1,$2,'moderation_case',$3,jsonb_build_object('action',$4::text))`,
      [req.userId, `moderation.${nextStatus}`, report.id, action ?? 'review_started'],
    );
    await client.query('COMMIT');
    if (suspendedUserId) closeRealtimeConnections(suspendedUserId);
    res.json({ data: updated[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.post('/api/v1/realtime/ticket', requireAuth, asyncHandler(async (req, res) => {
  if (!req.sessionId || !req.userId) throw new ApiError(401, 'A server session is required for realtime chat', 'realtime_session_required');
  const now = Date.now();
  const value = token();
  const ticket = { userId: req.userId, sessionId: req.sessionId, expiresAt: now + 30_000 };
  if (process.env.REDIS_URL) {
    if (!realtimeRedis?.isReady) throw new ApiError(503, 'Realtime is temporarily unavailable', 'realtime_unavailable');
    const stored = await realtimeRedis.set(realtimeTicketKey(sha256(value)), JSON.stringify(ticket), { EX: 30, NX: true });
    if (stored !== 'OK') throw new ApiError(503, 'Realtime is at capacity; retry shortly', 'realtime_capacity');
  } else {
    for (const [hash, current] of realtimeTickets) if (current.expiresAt <= now) realtimeTickets.delete(hash);
    if (realtimeTickets.size >= 10_000) throw new ApiError(503, 'Realtime is at capacity; retry shortly', 'realtime_capacity');
    realtimeTickets.set(sha256(value), ticket);
  }
  res.status(201).json({ data: { ticket: value, expiresInSeconds: 30 } });
}));

app.get('/api/v1/conversations/:id/messages', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  const { rows } = await pool.query(
    `SELECT m.id,m.sender_id,u.display_name AS sender_name,m.body,m.created_at
       FROM messages m JOIN users u ON u.id=m.sender_id
      WHERE m.conversation_id=$1 AND EXISTS (
        SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=m.conversation_id AND cm.user_id=$2
      )
      ORDER BY m.created_at DESC,m.id DESC LIMIT $3`, [req.params.id, req.userId, limit],
  );
  const { rows: membership } = await pool.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [req.params.id, req.userId],
  );
  if (!membership[0]) throw new ApiError(404, 'conversation unavailable');
  const { rows: peers } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id<>$2 LIMIT 1', [req.params.id, req.userId],
  );
  if (peers[0] && await usersBlockEachOther(req.userId!, peers[0].user_id)) throw new ApiError(404, 'conversation unavailable');
  res.json({ data: rows.reverse() });
}));

app.post('/api/v1/conversations/:id/messages', requireAuth, asyncHandler(async (req, res) => {
  const body = req.body?.body;
  if (typeof body !== 'string' || body.trim().length < 1 || body.trim().length > 4000) throw new ApiError(400, 'message body must contain 1–4000 characters');
  const client = await pool.connect();
  let message: RealtimeMessage;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,sender_id,body)
       SELECT $1,$2,$3 WHERE EXISTS (
         SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2
       ) AND NOT EXISTS (
         SELECT 1 FROM conversation_members peer JOIN user_blocks b
           ON (b.blocker_id=$2 AND b.blocked_id=peer.user_id) OR (b.blocker_id=peer.user_id AND b.blocked_id=$2)
          WHERE peer.conversation_id=$1 AND peer.user_id<>$2
       ) RETURNING id`, [req.params.id, req.userId, body.trim()],
    );
    if (!rows[0]) throw new ApiError(404, 'conversation unavailable');
    const { rows: messageRows } = await client.query<RealtimeMessage>(
      `SELECT m.id,m.conversation_id,m.sender_id,u.display_name AS sender_name,m.body,m.created_at
         FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, [rows[0].id],
    );
    message = messageRows[0];
    const { rows: members } = await client.query<{ user_id: string }>(
      'SELECT user_id FROM conversation_members WHERE conversation_id=$1', [message.conversation_id],
    );
    await insertRealtimeOutbox(client, 'conversation.message.created', `conversation.message.created:${message.id}`,
      members.map((member) => member.user_id), message);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  res.status(201).json({ data: message });
}));

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Route not found', requestId: res.locals.requestId } }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ApiError) return res.status(error.status).json({ error: { code: error.code, message: error.message, requestId: res.locals.requestId } });
  const message = error instanceof Error ? error.message : 'unknown_error';
  console.error(JSON.stringify({ level: 'error', requestId: res.locals.requestId, message }));
  return res.status(500).json({ error: { code: 'internal_error', message: 'An unexpected error occurred', requestId: res.locals.requestId } });
});

let server: ReturnType<typeof app.listen>;
function rejectRealtimeUpgrade(socket: Duplex, status: number, phrase: string) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
function attachRealtimeUpgradeHandler() {
  server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) { rejectRealtimeUpgrade(socket, 403, 'Forbidden'); return; }
  let url: URL;
  try { url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`); }
  catch { rejectRealtimeUpgrade(socket, 400, 'Bad Request'); return; }
  if (url.pathname !== '/api/v1/realtime') { rejectRealtimeUpgrade(socket, 404, 'Not Found'); return; }
  const ticketValue = url.searchParams.get('ticket');
  if (!ticketValue) { rejectRealtimeUpgrade(socket, 401, 'Unauthorized'); return; }
  const ticketHash = sha256(ticketValue);
  void (async () => {
    let ticket: RealtimeTicket | undefined;
    if (process.env.REDIS_URL) {
      if (!realtimeRedis?.isReady) { rejectRealtimeUpgrade(socket, 503, 'Service Unavailable'); return; }
      const stored = await realtimeRedis.getDel(realtimeTicketKey(ticketHash));
      if (stored) {
        try { ticket = JSON.parse(stored) as RealtimeTicket; }
        catch { ticket = undefined; }
      }
    } else {
      ticket = realtimeTickets.get(ticketHash);
      realtimeTickets.delete(ticketHash);
    }
    if (!ticket || ticket.expiresAt <= Date.now()) { rejectRealtimeUpgrade(socket, 401, 'Unauthorized'); return; }
    const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()`,
    [ticket.sessionId, ticket.userId],
    );
    if (!rows[0] || socket.destroyed) { rejectRealtimeUpgrade(socket, 401, 'Unauthorized'); return; }
    realtimeServer.handleUpgrade(request, socket, head, (client) => {
      let userSockets = realtimeClients.get(ticket.userId);
      if (!userSockets) { userSockets = new Set(); realtimeClients.set(ticket.userId, userSockets); }
      if (userSockets.size >= 5) userSockets.values().next().value?.close(1013, 'connection limit');
      userSockets.add(client);
      realtimeSessionBySocket.set(client, ticket.sessionId);
      client.send(JSON.stringify({ type: 'connection.ready', data: { connectedAt: new Date().toISOString() } }));
      client.on('message', () => client.close(1008, 'server-to-client connection only'));
      client.on('close', () => {
        userSockets?.delete(client);
        if (!userSockets?.size && realtimeClients.get(ticket.userId) === userSockets) realtimeClients.delete(ticket.userId);
      });
      realtimeServer.emit('connection', client, request);
    });
  })().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', event: 'realtime.upgrade_failed', message: error instanceof Error ? error.message : 'unknown_error' }));
    rejectRealtimeUpgrade(socket, 503, 'Service Unavailable');
  });
  });
}
const realtimeHeartbeat = setInterval(() => {
  for (const client of realtimeServer.clients) {
    if (!aliveRealtimeSockets.has(client)) { client.terminate(); continue; }
    aliveRealtimeSockets.delete(client);
    client.ping();
  }
}, 30_000);
realtimeHeartbeat.unref();
realtimeServer.on('connection', (client) => {
  aliveRealtimeSockets.add(client);
  client.on('pong', () => { aliveRealtimeSockets.add(client); });
});
void expireStaleNavigationSessions().catch((error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'navigation.expiry_failed', message: error instanceof Error ? error.message : 'unknown_error' })));
const navigationExpiryTimer = setInterval(() => {
  void expireStaleNavigationSessions().catch((error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'navigation.expiry_failed', message: error instanceof Error ? error.message : 'unknown_error' })));
}, 15_000);
navigationExpiryTimer.unref();
async function startServer() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl && process.env.NODE_ENV === 'production') throw new Error('REDIS_URL is required in production');
  if (redisUrl) {
    realtimeRedis = createClient({ url: redisUrl });
    realtimeRedis.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'realtime.redis_error', message: error.message })));
    await realtimeRedis.connect();
    realtimeSubscriber = realtimeRedis.duplicate();
    realtimeSubscriber.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'realtime.redis_subscriber_error', message: error.message })));
    await realtimeSubscriber.connect();
    await realtimeSubscriber.subscribe(realtimeChannel, (payload) => {
      try {
        const message = JSON.parse(payload) as { instanceId?: unknown; kind?: unknown; userIds?: unknown; event?: unknown; userId?: unknown; sessionId?: unknown };
        if (message.instanceId === realtimeInstanceId) return;
        if (message.kind === 'session.revoke' && typeof message.userId === 'string') {
          closeRealtimeConnectionsLocally(message.userId, typeof message.sessionId === 'string' ? message.sessionId : undefined);
          return;
        }
        if (message.kind !== 'event' || !Array.isArray(message.userIds) || typeof message.event !== 'string') return;
        deliverRealtime(message.userIds.filter((id): id is string => typeof id === 'string'), message.event);
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', event: 'realtime.invalid_pubsub_message', message: error instanceof Error ? error.message : 'unknown_error' }));
      }
    });
  }
  server = app.listen(port, host, () => console.log(JSON.stringify({ level: 'info', event: 'api.started', host, port, realtime: realtimeRedis ? 'redis' : 'single_process_dev' })));
  attachRealtimeUpgradeHandler();
  const dispatch = () => {
    if (realtimeOutboxDispatch) return;
    realtimeOutboxDispatch = dispatchRealtimeOutbox()
      .catch((error: unknown) => console.error(JSON.stringify({ level: 'error', event: 'realtime.outbox_dispatch_failed', message: error instanceof Error ? error.message : 'unknown_error' })))
      .finally(() => { realtimeOutboxDispatch = undefined; });
  };
  dispatch();
  realtimeOutboxTimer = setInterval(dispatch, 500);
  realtimeOutboxTimer.unref();
}
void startServer().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'error', event: 'api.start_failed', message: error instanceof Error ? error.message : 'unknown_error' }));
  process.exitCode = 1;
  void closeResources();
});
async function closeResources() {
  const tasks: Promise<unknown>[] = [pool.end()];
  if (realtimeSubscriber) tasks.push(realtimeSubscriber.quit());
  if (realtimeRedis) tasks.push(realtimeRedis.quit());
  await Promise.allSettled(tasks);
}
async function shutdown() {
  clearInterval(navigationExpiryTimer);
  clearInterval(realtimeHeartbeat);
  if (realtimeOutboxTimer) clearInterval(realtimeOutboxTimer);
  if (realtimeOutboxDispatch) await realtimeOutboxDispatch;
  realtimeServer.close();
  if (!server) { await closeResources(); process.exit(0); return; }
  server.close(() => {
    void closeResources().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
