# Redis Smart Cache: baseline audit

Checked 2026-10-14 on Server branch `codex/sync-mobility-registry`, HEAD `7dda315fa5a60b3e78ba284da98a94e129cbff1b`. The feature worktree starts at that exact revision. The original Server checkout had user-owned dirty edits (`server/index.ts`, `server/mobility/transportLayerAvailability.ts`, `tests/transport-layer-availability.test.ts`, `.tmp-route-bench.mts`); none were copied over, staged, or edited.

## Baseline cache inventory

| Area | Baseline behavior | Level / bound | Status before change |
|---|---|---|---|
| OSRM road routes | No route cache. `getRoadRouteThroughPoints` constructed a provider per call; provider called OSRM directly. | None; no shared request limit. | MISSING |
| Walking routes | Coordinate-keyed Promise cache; 5 min successes, 15 sec failures; max 20,000 keys. Queue bounded to 12 active + 24 waiting; 32 new paths per search; 1.5 sec OSRM timeout. | Per-process L1 only. | IMPLEMENTED, no shared layer / no graph version in key |
| GTFS Realtime | Per-provider Promise cache, 15 sec; complete snapshots are checked against a 5 min source age and 30 sec future skew; differential snapshots are rejected. | Per-process L1, unbounded by count. | PARTIAL |
| GTFS static timetable | Parsed `Map`-based feed cached for 6 hours by provider ID; failed fetch removes the entry. | Per-process L1; source version/invalidation not part of key. | PARTIAL |
| GBFS nearby snapshots | Per-provider Promise cache; source TTL capped by freshness and 60 sec; TTL=0 receives a 3 sec poll window. | Per-process L1; no entry bound; no shared L2. | PARTIAL |
| Kyiv schedule REST rows | 5 min by source ID, up to 20,000 rows. Concurrent cold calls can duplicate fetches. | Per-process L1. | PARTIAL |
| Kyiv metro timetable | Promise cache, 5 min refresh. | Per-process L1. | PARTIAL |
| Transport layers | Static network about 6 hours; vehicle snapshots about 10 sec. Static GTFS/GeoJSON map networks use bounded L1 and versioned Redis L2; live vehicle Maps remain process-local. | Catalogs are shared when health validation persisted a payload SHA-256; unversioned catalogs are L1-only for 60 sec. | PARTIAL (vehicle cache remains local) |
| Critical Redis | `REDIS_URL` serves realtime pub/sub, one-time tickets, ephemeral rendezvous locations and shared rate limits. Realtime and rate-limit paths can fail closed when unavailable. | Shared critical store. | IMPLEMENTED; must not host evictable data |

## Feature branch changes

| Area | Feature implementation | Status |
|---|---|---|
| CacheService | Bounded LRU-style L1 by entry count and serialized bytes; schema validation; versioned SHA-256 keys; TTL jitter; invalidation; hit/miss/error/latency counters; local single-flight; optional isolated Redis L2. | IMPLEMENTED |
| Redis lock | `SET NX PX` owner token, bounded wait with jitter, cache re-check after lock, compare-and-delete release, fail-open to bounded L1/upstream. | IMPLEMENTED; real Redis verification recorded in performance report |
| OSRM | All server OSRM calls route through a bounded, priority-aware gateway. Route geometry is cached only when `OSRM_GRAPH_VERSION` (or `WALKING_GRAPH_VERSION`) is supplied. Exact coordinates and route parameters are hashed; request IDs are excluded from the key and restored per response. | IMPLEMENTED |
| Stop optimizer | Its baseline and shortlisted candidate routes use the gateway with background priority; the gateway caps active and waiting work for each process. | IMPLEMENTED |
| GBFS | Validated normalized snapshot uses shared cache with a TTL bounded by the source TTL, source freshness, and 15 seconds. | IMPLEMENTED |
| GTFS Realtime | Map/Date values are serialized into a validated JSON contract and shared for at most 15 seconds; stale snapshots are returned as stale, never LIVE. | IMPLEMENTED |
| Static GTFS / Kyiv schedule / transport-layer catalog | Static map GTFS/GeoJSON network uses a normalized Zod-validated L2 payload keyed by provider, URL, mode, and SHA-256 of the last validated payload. A new hash changes the key. Journey timetable `Map` instances and Kyiv schedule caches remain L1-only. | PARTIAL |
| Compression | Not enabled. OSRM responses are bounded by L2 entry size; GBFS/GTFS-RT payloads are small. Zip GTFS is already compressed and no benchmark justified another compression pass. | NOT_NEEDED_FOR_CURRENT_PAYLOADS |

## Privacy / correctness boundaries

Current shared cache integrations contain public route geometry, public feed snapshots, or provider-scoped GBFS data. Personal sessions, tokens, booking state, user GPS, rider prices and payment confirmations are not passed to this cache. L2 is optional and separate from `REDIS_URL`; without `REDIS_CACHE_URL`, the server continues with bounded local behavior. Without an explicit road-graph version, road geometry caching is bypassed rather than reusing potentially stale geometry.

## Baseline verification

On Node `v25.4.0` / npm `11.7.0` (the Server package declares Node `24.21.0`): baseline Server typecheck and lint passed; unit tests reported 194 passed, 0 failed, 1 opt-in integration skip. Baseline Site typecheck/lint/build/bundle check passed and 80/80 tests passed. Baseline umbrella typecheck/lint/build passed and 231 tests passed, 0 failed, 1 opt-in skip. Baseline output includes the pre-existing dirty Server test file from the user's primary checkout.

The local runtime differs from the declared Server Node engine, so hosted CI on the exact supported runtime remains the authoritative engine verification. The feature-branch integration suite also passed against disposable loopback PostGIS + critical Redis + cache Redis services, covering migrations, bookings, navigation, realtime across API instances, restart durability, and rate limiting.
