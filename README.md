# MARSHGO Server

Standalone TypeScript API for MARSHGO. The service owns authentication/session handling, PostgreSQL/PostGIS migrations, Redis-backed WebSocket fanout, route/geocoding adapters, S3-compatible uploads, offers, demands, negotiations, bookings and moderation APIs.

## Local development

Requirements: Node 24.21.0, Docker Compose.

```sh
cp .env.example .env
docker compose up -d db redis
npm ci
npm run db:migrate
npm run api
```

API health endpoints: `GET /healthz` and `GET /readyz`. The versioned REST API is documented in [`docs/API.md`](docs/API.md). Apply only additive migrations to reviewed databases.

## Verification

```sh
npm run typecheck
npm test
npm run test:integration
```

Integration tests require only the isolated loopback database `marshgo_e2e` and local Redis from Compose. They never send SMS, charge cards, or call external production providers. Use `npm run test:integration:bookings` for the transaction/authorization slice after setting `API_TEST_DATABASE_URL` and `API_TEST_URL`.

## Production status

This repository is application code, not a deployed service. A real SMS sender, production geocoding/routing provider, private object storage, HTTPS host, managed PostgreSQL/PostGIS and Redis, monitoring, backups and recovery drills are required before public release. No secret belongs in this repository. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) and [`docs/SECURITY.md`](docs/SECURITY.md).
