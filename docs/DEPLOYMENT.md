# Deployment runbook (local foundation only)

## Local database and cache

1. Copy `.env.example` to `.env`; replace the local sample password.
2. Start only local dependencies: `docker compose up -d db redis`.
3. Apply additive migrations: `npm run db:migrate`.
4. Start the API in a second terminal: `npm run api`.
5. Check `curl http://127.0.0.1:3002/readyz`.
6. Start the PWA with `npm run dev`; Vite proxies `/api`, `/healthz`, and `/readyz` to the local API.

The API binds to loopback by default. Set `API_HOST` explicitly for a private container/network binding in a deployment; do not expose the development bypass on a public interface.

The example environment configures `REDIS_URL` for the local Redis container. Production API processes require a reachable shared Redis instance and the same managed `SESSION_SECRET`; keep both outside source control. Redis Pub/Sub provides transient WebSocket fan-out and Redis `GETDEL` coordinates one-use socket tickets. PostgreSQL stores the durable messages, so clients reload from REST after reconnect.

The compose ports bind to loopback. Volumes persist across container restarts. Do not use `docker compose down -v` if you need to retain local data.

## Production status

There is no production deployment target configured. Several first-party flows now use the API, PostgreSQL/PostGIS, and local Redis, including phone OTP in development, offer creation/search, transactional booking, passenger demand negotiation, booking chat, and foreground navigation/matching APIs. Real SMS, production geocoding/routing, private S3-compatible storage and bucket CORS, vehicle/staff operations, push notifications, partner integrations, CI deployment, TLS/domain, backups/restore, monitoring, and rollback remain unfinished. Before staging, choose a host and domain, provision private PostgreSQL/PostGIS and Redis, configure managed secrets, SMS, S3, routing and tiles, and validate same-site HTTPS routing for the API refresh cookie. Apply migrations only to a reviewed staging database first.

No public deployment or production database operation has been performed.
