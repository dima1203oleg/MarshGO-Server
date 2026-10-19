# Cache and routing performance report

Date: 2026-10-14

## Controlled local fixture benchmark

Method: `npm run benchmark:routing-cache` starts a local OSRM-compatible HTTP fixture with a 10 ms response delay, then runs 100 concurrent identical route requests in three modes: direct uncached provider calls, cold Smart Cache requests, and warm Smart Cache reads. The fixture uses synthetic geometry and does not contact public routing services.

Results are recorded after running the benchmark on this feature worktree:

| Mode | Requests | Upstream calls | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|
| Direct / uncached baseline | 100 | 100 | 432.64 ms | 454.64 ms | 455.21 ms |
| Smart Cache, cold | 100 | 1 | 57.09 ms | 139.31 ms | 213.83 ms |
| Smart Cache, warm | 100 | 0 | 7.94 ms | 10.12 ms | 10.49 ms |

The measured upstream call reduction for the cold identical-request burst was 99%. The 100-request unit contract test also confirmed 1 upstream call and 100 distinct response IDs with a versioned route key. These measurements use a local fixture with a fixed 10 ms delay on Node v25.4.0; they are comparative local evidence, not a production latency SLO.

The fixture timings vary across local runs because process scheduling and request setup dominate the synthetic 10 ms upstream delay. The upstream request counts are deterministic and are the useful comparison; the reported latency is one actual recorded run, not an SLO.

Static GTFS and GeoJSON map-network payloads also use schema-validated L2 entries, keyed by provider, feed URL, mode, and SHA-256 of the last validated source payload. The provider health report stores this digest. When an existing provider has no digest yet, that feed is intentionally limited to a 60-second per-process cache until its next successful validation. Journey timetable objects and Kyiv schedules remain L1-only.

## Redis and staging load

| Scenario | Status | Evidence / limit |
|---|---|---|
| Two independent cache services, fake shared Redis contract | PASS | 100 equivalent requests invoke one loader; lock, L2 read/write, and fail-open are covered by unit test. |
| Two Node.js processes against actual Redis | PASS | Isolated `redis-cache` service on loopback; two processes each issued 50 equivalent calls; shared Redis counter recorded exactly one loader execution. This tests cache process isolation, not full API deployment. |
| Full Server/PostGIS/Redis integration | PASS | Fresh loopback `marshgo_e2e_cache_verify` database; 28 checks passed (2 Journey schema, 21 booking/trip-editing, 2 navigation, 1 realtime cluster, 1 process restart, 1 rate-limit). API tests ran with both critical Redis and isolated cache Redis configured. |
| k6 at 5 / 10 / 30 / 50 searches/sec | NOT_TESTED | k6 binary and dedicated API test credentials/staging target are not configured in this environment. Script is committed for controlled use. |
| 1000 realtime WebSocket clients / two or more API replicas | NOT_TESTED | Requires isolated multi-process deployment and load generator. |
| Redis memory / eviction under 10,000 unique route keys | NOT_TESTED | Need isolated Redis and measured production-equivalent graph sizes. |
| Full before/after product latency SLO | NOT_TESTED | Local fixture does not represent production OSRM, PostGIS, provider latency or mobile network. |

No claim of production throughput, p95 SLO, cache memory efficiency under real graph data, or production readiness is made from the local fixture.
