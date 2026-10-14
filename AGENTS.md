# MarshGO-Server

This is the canonical source for MARSHGO backend/API behavior, authorization, database schema and migrations, Redis/cache, routing, realtime transport data, and provider integrations. Do not implement Web/iOS/Admin/Partner screens here; do not duplicate backend modules in the central `MarshGO` orchestrator.

Before editing, check `git status`, branch, remotes, and the current PR/base. Preserve dirty work. Use a short-lived `feature/*` or `fix/*` branch and PR; do not push to `main`, force-push, or merge without the repository review process.

With Node 24.21.0 and the committed lockfile, run:

```sh
npm ci
npm run typecheck
npm run lint
npm test
```

For database, Redis, migration, booking, routing, or realtime changes, also run the relevant `npm run test:integration:*` target or `npm run test:integration` with the required disposable PostGIS/PostgreSQL and Redis services configured. Never point tests at production data. Follow repository security and migration guidance before changing contracts or schema.

The central `MarshGO` repository pins this repository by full commit SHA for cross-repository builds and integration tests. Update API/OpenAPI/types here first or in a coordinated PR, then verify every consumer against the exact Server SHA. Partner tenant isolation and Admin authorization must be enforced here, regardless of frontend visibility.
