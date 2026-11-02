# Redis Smart Cache

## Isolation

`REDIS_URL` remains the critical Redis used for sessions/revocation, rate limiting, realtime pub/sub and expiring rendezvous data. CacheService connects only to optional `REDIS_CACHE_URL`; it never falls back to `REDIS_URL`. The local Compose cache is a disposable Redis instance on `127.0.0.1:6381`, with `maxmemory 256mb` and `allkeys-lru`. It has no persistent volume. Production can point `REDIS_CACHE_URL` to a separately provisioned cache Redis with an eviction policy. If it is missing or unavailable, routing continues using the bounded process L1 and upstream gateway.

## Key and value contract

Keys use `marshgo:cache:v1:<category>:<sha256>`. The digest covers canonical JSON with recursively sorted object keys. Road geometry keys include exact WGS84 coordinates, ordered waypoints, provider endpoint identity, profile/constraints/options, and immutable graph version. Random request IDs are excluded; the provider creates a response ID for each caller. Personal data must use an explicit authorization scope or remain outside this service.

Every L1/L2 read is parsed against the category's Zod schema. Invalid Redis entries are deleted and treated as misses. L1 is process-local, LRU-ordered and bounded by `CACHE_L1_MAX_ENTRIES` (default 5,000) and `CACHE_L1_MAX_BYTES` (16 MiB). A single entry larger than the bound is returned to its caller but not retained. L2 entries are capped by `CACHE_L2_MAX_ENTRY_BYTES` (2 MiB default). TTL jitter is ±10%.

## Cache policies

| Category | L1 | L2 | Freshness / version rule |
|---|---:|---:|---|
| Car OSRM geometry | 10 min | 6 h default, configurable 1–24 h | Disabled unless `OSRM_GRAPH_VERSION` is set; version is part of the key. |
| Walking OSRM geometry | 5 min | 3 h default, configurable 1–6 h | Disabled unless `WALKING_GRAPH_VERSION` or `OSRM_GRAPH_VERSION` is set. Existing 5 min local success and 15 sec failure behavior remains. |
| GBFS snapshot | ≤15 sec | min(source TTL, freshness bound, 15 sec) | Provider + URL; current status is rechecked against the source timestamp. TTL=0 uses a 3 sec refresh window. |
| GTFS Realtime | 15 sec | 15 sec | Provider + URL; complete feed only, max source age 5 min. Cache hits that cross that age boundary return `fresh:false`. |
| Static GTFS timetable | Existing 6 h local cache | Not yet shared | Map-based timetable parsing remains local; import-version invalidation is a follow-up. |
| Static GTFS / GeoJSON map network | 10 min | Up to 6 h (8 MiB entry cap) | Provider + URL + source mode + SHA-256 of last validated payload. A changed feed hash selects a new cache key. When no hash is available, only a 60 sec process-local cache is used. |
| Booking, identity, payment, user location | None | None | Authoritative transaction/provider state only. |

The OSRM graph version must identify the immutable deployed graph artifact, not a deploy date typed by habit. Changing the graph version automatically moves requests to a new namespace; explicit `smartCache.invalidate(category, parameters)` is available for point invalidation. Do not purge a whole Redis database because the cache instance may be shared by unrelated cache categories.

## Single-flight and routing control

Each process coalesces identical misses. When L2 is ready, a caller acquires a Redis lock using `SET key owner NX PX ttl`, rechecks L2 after acquiring it, and releases the lock with compare-and-delete. Wait is bounded and jittered. On Redis failure or wait timeout, the caller computes without blocking the API indefinitely. Locks expire after crashes.

All server `fetchOsrmRoute` calls now go through `requestOsrmRoute`. Per-process defaults are 12 active requests, 24 waiting, a 2.5 sec queue budget and a 10 sec provider timeout. `navigation` outranks `interactive`, which outranks `background`; the multi-stop optimizer submits its baseline and candidate calculations as background work. Queue saturation rejects the optional calculation with a controlled routing error instead of growing unbounded work. Exact route duplicates can be shared across processes through L2 only when the graph version is configured.

## Environment

Copy the cache-specific settings from `.env.example` into the local environment. Start `docker compose up -d redis-cache` when using the local shared cache. Production must provision the cache instance separately, set `REDIS_CACHE_URL`, and set graph version variables to real immutable dataset identifiers. Do not put credentials into route parameters or logs.

`GET /metrics` is disabled (404) unless `METRICS_BEARER_TOKEN` is set. When enabled, it requires `Authorization: Bearer <token>` and exposes Prometheus text for cache hit/miss/coalescing/error/size/latency, routing upstream requests/queue/rejections, process memory/CPU, event-loop delay and PostgreSQL pool counts. Protect the token with the deployment secret manager and scrape over the trusted network.

## Verification commands

```sh
npm run typecheck
npm run lint:all
npm test
npm run benchmark:routing-cache
npm run test:load:routing -- --vus 100 --iterations 100
```

The k6 script is local-only unless `LOAD_TEST_ALLOW_REMOTE=1` is explicitly set, requires a dedicated test account, and should target an isolated staging copy. Run it once per target rate (`TARGET_RPS=5`, `10`, `30`, `50`) and separately with `LOAD_SCENARIO=same-100`. Do not run it against public production. It does not create bookings.
