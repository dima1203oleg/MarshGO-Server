# Local API Development Stack

Isolated, repeatable local runtime for the MarshGO Server API. It exists to
eliminate the class of failures where the site proxies (`:3103`, `:4178`) and
the HTTPS proxy host return **502** simply because no API process is listening
on `127.0.0.1:3002`.

## Isolation guarantees

| Concern | Acceptance stack (`docker-compose.yml`) | Local API stack (`docker-compose.local-api.yml`) |
| --- | --- | --- |
| Compose project | default (`marshgo-server`) | `marshgo-local-api` |
| Postgres volume | `marshgo-postgres` | `marshgo-local-api-postgres` |
| Redis volume | `marshgo-redis` | `marshgo-local-api-redis` |
| Postgres DB name | `marshgo` | `marshgo_local` |
| Host ports | 5434 / 6380 / 6381 | 5444 / 6390 / 3002 (configurable) |

* The two stacks never share containers, networks, or volumes. This stack does
  not read, stop, recreate, or delete any acceptance/staging/production data.
* All host port binds are loopback-only (`127.0.0.1`).
* `stop` and `down` are data-preserving: the script never passes `-v`,
  `--volumes`, or `--rmi`. Named volumes survive every lifecycle operation.
* The API image is built from this repository's exact code (`Dockerfile`,
  `server/`, `shared/`), so the running build always matches a git SHA.

## One-time setup (no secrets in git)

```bash
cp .env.local-api.example .env.local-api
openssl rand -hex 16   # paste as LOCAL_API_POSTGRES_PASSWORD (URL-safe hex, required)
openssl rand -hex 32   # paste as LOCAL_API_SESSION_SECRET
```

`.env.local-api` is gitignored. `scripts/local-api.sh` **fails closed**
(nonzero exit, actionable message) if the file is missing, a placeholder
secret is still present, `LOCAL_API_SESSION_SECRET` is shorter than 32 bytes,
or `LOCAL_API_POSTGRES_PASSWORD` is not 32-64 lowercase hex characters — the
password is interpolated into `DATABASE_URL` unescaped, so only URL-safe hex
is accepted. Secrets are parsed inside the script and never printed.

## Commands

| Command | npm script | Behavior |
| --- | --- | --- |
| `bash scripts/local-api.sh start` | `npm run local:api:start` | Idempotent. Verifies Docker + env file, refuses to touch foreign processes on the API port, builds the image with build identity from git, starts `db`+`redis`, waits for healthy, runs schema migrations (`server/migrate.ts`), starts `api`, waits for `/readyz` 200, prints `/version`. |
| `bash scripts/local-api.sh stop` | `npm run local:api:stop` | Stops containers; volumes and containers preserved. Works even if `.env.local-api` is lost (inert interpolation placeholders, never real secrets). |
| `bash scripts/local-api.sh down` | `npm run local:api:down` | Removes containers/network; **volumes preserved** (never `-v`). Also works without `.env.local-api`. |
| `bash scripts/local-api.sh status` | `npm run local:api:status` | Container states + live `/healthz`, `/readyz`, `/version`; nonzero if not healthy. |
| `bash scripts/local-api.sh smoke` | `npm run local:api:smoke` | Asserts `/healthz`, `/api/v1/health`, `/readyz` (`status: ready`), `/version` (`service: MarshGO-Server`) and requires **exact full-SHA equality** between the running `commitSha` and current git HEAD (a short prefix never passes); nonzero on any mismatch. |
| `bash scripts/local-api.sh version` | `npm run local:api:version` | Pretty-prints the build identity JSON. |

Every failure path exits nonzero. On readiness timeout, `start` dumps the last
50 API log lines before failing.

## Startup sequencing

1. Host ports for `db`, `redis`, and `api` are checked first, closed by
   default. A busy port is accepted **only** when Docker reports that this
   project's container for that service is running and actually publishes
   that exact host port — a stale `LOCAL_API_*_PORT` edit never legitimizes
   an unrelated listener, and missing/malformed inspect output is a
   rejection. Any other occupant fails the whole start nonzero before
   anything is built or started; the script never kills other processes.
2. The API image is built **exactly once** (`compose build api`) before
   anything else, so migrations and the running API always come from the same
   built image; no second build happens later.
3. `db` (PostGIS) and `redis` start next; the script waits for Docker
   healthchecks to report `healthy`.
4. Migrations run once per `start` via a disposable container from that
   pre-built image (`compose run --rm --no-deps api node --import=tsx
   server/migrate.ts`); `server/migrate.ts` is idempotent and itself retries
   transient connection errors.
5. `api` starts from the same already-built image (`compose up -d api`, no
   `--build`) only after both dependencies are healthy (`depends_on:
   service_healthy`) and migrations succeeded.
6. The script polls `/readyz` (Postgres `SELECT 1` + Redis readiness) and only
   then reports success.

## Security posture (development)

* `NODE_ENV=development` — production env validation is not bypassed, it is
  simply not triggered; no production configuration is changed anywhere.
* `AUTH_DEV_BYPASS=false`, `AUTH_DEV_OTP=false` — real auth flow only.
* `MARSHGO_API_TEST_FIXTURE_MODE=0` — GTFS test fixtures and fake route
  estimates are disabled; routing results come only from configured real
  upstreams.
* `OSRM_URL` / `WALKING_ROUTING_URL` / `WALKING_ROUTING_URLS` / geocoding URLs are **empty by default**. For city-specific pedestrian graphs, set `LOCAL_API_WALKING_ROUTING_URLS` to a compact JSON array of `{ "bbox": [minLon, minLat, maxLon, maxLat], "url": "https://..." }` entries; those endpoints must be reachable from inside the API container. The server chooses a graph only when its bbox covers both ends of the walk.
  Without them the API degrades honestly (labelled estimates or
  `RoutingUnavailableError`), never inventing data. Point them at real
  engines you operate via `.env.local-api` if needed.
* Place autocomplete supports the Nominatim JSON contract and Photon GeoJSON
  when `LOCAL_API_GEOCODING_PROVIDER` is set to `nominatim` or `photon`.
  Public Nominatim autocomplete is rejected because its usage policy forbids
  it. Photon’s public demo may be used only for low-volume manual evaluation;
  production requires an approved contracted or self-hosted endpoint with
  suitable availability and capacity.
* Session/realtime/rate-limit Redis is the stack's own instance; no shared
  infrastructure is touched.

## Build identity

`start` exports `MARSHGO_BUILD_ID`, `MARSHGO_BUILD_SHA` (current git HEAD),
`MARSHGO_BUILD_TIME`, and `MARSHGO_SOURCE_STATE` (`clean`/`dirty`) into the
image build args, so `GET /version` / `GET /api/v1/version` always identify
the exact checkout that is running. `smoke` enforces exact full-SHA equality
between the running `commitSha` and HEAD — prefix matches are rejected.

## Verifying the 502 is gone

After `start` succeeds:

```bash
curl -sS http://127.0.0.1:3002/healthz    # {"status":"ok"}
curl -sS http://127.0.0.1:3002/readyz     # {"status":"ready",...}
curl -sS http://127.0.0.1:3002/version    # build identity JSON
```

Then re-check the site proxies (`:3103`, `:4178`) and the HTTPS proxy host —
their 502s were caused by the absent upstream and should clear while this
stack is running.

## Optional: owner-approved HTTPS tunnel origin (mobile/tunnel testing)

To test from mobile apps or through the owner-approved HTTPS tunnel
`https://marshgo-dima.shares.zrok.io`, opt in **locally** by appending that
origin to `LOCAL_API_CORS_ORIGINS` in your gitignored `.env.local-api`:

```
LOCAL_API_CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:3103,http://127.0.0.1:3103,http://localhost:4178,http://127.0.0.1:4178,capacitor://localhost,https://marshgo-dima.shares.zrok.io
```

Then rerun `bash scripts/local-api.sh start` so the API container is
recreated with the new value. The public origin is deliberately **not** part
of the compose default or `.env.local-api.example`: committed defaults stay
local-only, and only your ignored env file can widen CORS.

## CI runtime contract

The `verify` job in `.github/workflows/ci.yml` exercises this stack
end-to-end on the ubuntu runner, as the step `Exercise local API Compose
lifecycle end-to-end` right after the production image smoke:

* A disposable `.env.local-api` is written inside the runner (`umask 077`)
  with `openssl rand -hex` secrets that are never printed, on isolated ports
  **5444 / 6390 / 3012** — guarded fail-closed against collision with the CI
  service ports (postgres `5434`, redis `6380`) and the image smoke port
  (`3002`).
* It runs `npm run local:api:start` (build once → healthy db/redis →
  migrations from the same image → api → `/readyz`) and then
  `npm run local:api:smoke`, which enforces exact full-SHA build identity
  against the CI checkout.
* A trap always runs `npm run local:api:down` — containers/network removed,
  named volumes preserved, never `-v` — deletes the disposable env file, and
  re-exits with the original failure status, so no start/smoke failure can be
  masked by cleanup.
* Fixture mode, dev OTP, and auth bypass are never enabled by this step; the
  compose file pins `AUTH_DEV_BYPASS=false`, `AUTH_DEV_OTP=false`, and
  `MARSHGO_API_TEST_FIXTURE_MODE=0`.
* Only GitHub CI can prove the actual runner behavior (image build, PostGIS
  start, migrations, readiness timing); locally this contract is covered by
  the static checks in `tests/local-api-stack.test.ts`.

## Known limits

* The PostGIS image runs under `linux/amd64` emulation on Apple Silicon
  (same as the acceptance stack); first start is slow and CPU-heavy.
* The stack intentionally has no `redis-cache` (L2) service; the API falls
  back to in-process L1 caching, which is fine for local development.
* Automated static checks live in `tests/local-api-stack.test.ts`
  (`npm test` includes them). Runtime verification requires Docker and is a
  separate, explicitly scheduled gate on this 8 GB host.
