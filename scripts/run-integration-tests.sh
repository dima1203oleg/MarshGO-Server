#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${API_TEST_DATABASE_URL:-${E2E_DATABASE_URL:-postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e}}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6380}"
RATE_LIMIT_TEST_PREFIX="marshgo:integration:rate-limit:$$:$RANDOM:"
export API_RATE_LIMIT_PREFIX="$RATE_LIMIT_TEST_PREFIX"
DATABASE_HOST="$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$DATABASE_URL")"
DATABASE_NAME="$(node -e 'process.stdout.write(new URL(process.argv[1]).pathname)' "$DATABASE_URL")"
if [[ ! "$DATABASE_HOST" =~ ^(127\.0\.0\.1|localhost|::1)$ || ! "$DATABASE_NAME" =~ ^/marshgo_e2e(_[a-z0-9_]+)?$ ]]; then
  echo "Refusing integration tests outside loopback marshgo_e2e-prefixed database." >&2
  exit 2
fi
REDIS_HOST="$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$REDIS_URL")"
if [[ ! "$REDIS_HOST" =~ ^(127\.0\.0\.1|localhost|::1|\[::1\])$ ]]; then
  echo "Refusing integration tests with a non-loopback Redis URL." >&2
  exit 2
fi
DATABASE_URL="$DATABASE_URL" npm run db:migrate

API_PORT="${API_TEST_PORT:-3306}"
SECONDARY_API_PORT="${API_TEST_SECONDARY_PORT:-3307}"
API_URL="http://127.0.0.1:${API_PORT}"
SECONDARY_API_URL="http://127.0.0.1:${SECONDARY_API_PORT}"
API_PID=""
SECONDARY_API_PID=""
OSRM_PID=""
WALKING_OSRM_PID=""
WALKING_ROUTE_STUB_PID=""
cleanup() {
  if [[ -n "$API_PID" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
  if [[ -n "$SECONDARY_API_PID" ]]; then kill "$SECONDARY_API_PID" 2>/dev/null || true; wait "$SECONDARY_API_PID" 2>/dev/null || true; fi
  if [[ -n "$OSRM_PID" ]]; then kill "$OSRM_PID" 2>/dev/null || true; wait "$OSRM_PID" 2>/dev/null || true; fi
  if [[ -n "$WALKING_OSRM_PID" ]]; then kill "$WALKING_OSRM_PID" 2>/dev/null || true; wait "$WALKING_OSRM_PID" 2>/dev/null || true; fi
  if [[ -n "$WALKING_ROUTE_STUB_PID" ]]; then kill "$WALKING_ROUTE_STUB_PID" 2>/dev/null || true; wait "$WALKING_ROUTE_STUB_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

# Each integration suite is opt-in: without the managed API and a loopback database it prints
# "tests 0" and exits 0. A green CI would then prove nothing, so every phase below has to show
# that its suite actually executed. This keeps mandatory gates (P0 auth, P1 carpool rendezvous,
# QR attestation) from silently degrading into skips if the env wiring is ever refactored away.
run_suite() {
  local label="$1"
  shift
  local log rc ran
  log="$(mktemp)"
  if "$@" 2>&1 | tee "$log"; then rc=0; else rc="${PIPESTATUS[0]}"; fi
  ran="$(grep -oE 'tests [0-9]+$' "$log" | tail -1 | grep -oE '[0-9]+' || true)"
  rm -f "$log"
  if (( rc != 0 )); then
    echo "✗ integration suite '$label' failed (exit $rc)." >&2
    return "$rc"
  fi
  if [[ -z "$ran" || "$ran" == "0" ]]; then
    echo "✗ integration suite '$label' reported no tests — it self-skipped, which is not a pass." >&2
    return 1
  fi
  echo "✓ integration suite '$label' executed $ran test(s)."
}

run_suite journey env JOURNEY_TEST_DATABASE_URL="$DATABASE_URL" npm run test:integration:journey
run_suite pg-socket-failure env PG_SOCKET_FAILURE_TEST=1 API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:pg-socket-failure

start_api() {
  local routing_url="${1:-}"
  local walking_router_urls="${2:-}"
  env NODE_ENV=development AUTH_DEV_BYPASS=true AUTH_DEV_OTP=true MOBILITY_HEALTH_DISABLED=true \
    MARSHGO_GTFS_SEARCH_DEBUG="${API_TEST_GTFS_SEARCH_DEBUG:-0}" \
    DATABASE_URL="$DATABASE_URL" API_HOST=127.0.0.1 API_PORT="$API_PORT" \
    MARSHGO_API_TEST_FIXTURE_MODE=1 MARSHGO_GTFS_TEST_FIXTURE_DIR="$PWD/tests/fixtures/gtfs-http" \
    TRUST_PROXY_HOPS="${API_TEST_TRUST_PROXY_HOPS:-0}" \
    REDIS_URL="$REDIS_URL" API_RATE_LIMIT_PREFIX="${API_TEST_RATE_LIMIT_PREFIX_OVERRIDE:-$RATE_LIMIT_TEST_PREFIX}" \
    API_RATE_LIMIT_LIMIT="${API_TEST_RATE_LIMIT_LIMIT:-5000}" \
    API_RATE_LIMIT_WINDOW_MS="${API_TEST_RATE_LIMIT_WINDOW_MS:-900000}" SESSION_SECRET="integration-test-session-secret-32chars" \
    OSRM_URL="" WALKING_ROUTING_URL="" WALKING_ROUTING_URLS="$walking_router_urls" ROUTING_ENGINE_URL="$routing_url" ./node_modules/.bin/tsx server/index.ts &
  API_PID=$!
  for _ in $(seq 1 60); do
    if curl --fail --silent "$API_URL/healthz" >/dev/null; then return 0; fi
    if ! kill -0 "$API_PID" 2>/dev/null; then wait "$API_PID"; return 1; fi
    sleep 1
  done
  echo "API did not become healthy at $API_URL." >&2
  return 1
}
stop_api() {
  kill "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  API_PID=""
}
stop_secondary_api() {
  if [[ -n "$SECONDARY_API_PID" ]]; then
    kill "$SECONDARY_API_PID" 2>/dev/null || true
    wait "$SECONDARY_API_PID" 2>/dev/null || true
    SECONDARY_API_PID=""
  fi
}
start_secondary_api() {
  env NODE_ENV=development AUTH_DEV_OTP=true MOBILITY_HEALTH_DISABLED=true DATABASE_URL="$DATABASE_URL" \
    API_HOST=127.0.0.1 API_PORT="$SECONDARY_API_PORT" REDIS_URL="$REDIS_URL" \
    TRUST_PROXY_HOPS="${API_TEST_TRUST_PROXY_HOPS:-0}" \
    API_RATE_LIMIT_PREFIX="${API_TEST_RATE_LIMIT_PREFIX_OVERRIDE:-$RATE_LIMIT_TEST_PREFIX}" \
    API_RATE_LIMIT_LIMIT="${API_TEST_RATE_LIMIT_LIMIT:-5000}" API_RATE_LIMIT_WINDOW_MS="${API_TEST_RATE_LIMIT_WINDOW_MS:-900000}" \
    SESSION_SECRET="integration-test-session-secret-32chars" ./node_modules/.bin/tsx server/index.ts &
  SECONDARY_API_PID=$!
  for _ in $(seq 1 60); do
    if curl --fail --silent "$SECONDARY_API_URL/healthz" >/dev/null; then return 0; fi
    if ! kill -0 "$SECONDARY_API_PID" 2>/dev/null; then wait "$SECONDARY_API_PID"; return 1; fi
    sleep 1
  done
  echo "Secondary API did not become healthy at $SECONDARY_API_URL." >&2
  return 1
}

start_api
run_suite journey-activation env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:journey-activation
run_suite live-journey env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:live-journey
run_suite bookings env API_TEST_GTFS_FIXTURE=1 API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:bookings
run_suite partners env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:partners
run_suite interval env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:interval
run_suite live-drivers env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:live-drivers
run_suite route-progress env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:route-progress
# These two suites default to a hand-started dev API, so they were only ever run manually.
# Binding them to the managed API makes the P0 auth and carpool lifecycles real CI coverage.
run_suite auth-security env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:auth-security
run_suite rendezvous env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:rendezvous
run_suite qr-attestation env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:qr-attestation
stop_api

OSRM_STUB_PORT=3304 node tests/fixtures/osrm-stub.mjs &
OSRM_PID=$!
start_api "http://127.0.0.1:3304/route/v1/driving"
run_suite navigation env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" API_TEST_NAVIGATION=true \
  npm run test:integration:navigation
stop_api

start_api
start_secondary_api
run_suite realtime env API_TEST_URL="$API_URL" API_TEST_SECONDARY_URL="$SECONDARY_API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:realtime
stop_secondary_api
stop_api
run_suite restart env API_TEST_DATABASE_URL="$DATABASE_URL" API_TEST_RESTART=true API_TEST_RESTART_PORT=3308 \
  npm run test:integration:restart

API_TEST_TRUST_PROXY_HOPS=1 API_TEST_RATE_LIMIT_PREFIX_OVERRIDE="${RATE_LIMIT_TEST_PREFIX}strict:" \
  API_TEST_RATE_LIMIT_LIMIT=3 API_TEST_RATE_LIMIT_WINDOW_MS=60000 start_api
API_TEST_TRUST_PROXY_HOPS=1 API_TEST_RATE_LIMIT_PREFIX_OVERRIDE="${RATE_LIMIT_TEST_PREFIX}strict:" \
  API_TEST_RATE_LIMIT_LIMIT=3 API_TEST_RATE_LIMIT_WINDOW_MS=60000 start_secondary_api
run_suite rate-limit env API_TEST_URL="$API_URL" API_TEST_SECONDARY_URL="$SECONDARY_API_URL" \
  npm run test:integration:rate-limit
stop_secondary_api
stop_api

# Exercise snapped-away foot geometry through the real route-search endpoint. This dedicated API
# instance gets a test-only OSRM-compatible fixture that deliberately snaps 41 m off the origin.
WALKING_OSRM_STUB_PORT=3305 node tests/fixtures/osrm-foot-snap-stub.mjs &
WALKING_OSRM_PID=$!
walking_stub_ready=false
for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:3305/health" | grep -q '"fixture":true'; then
    walking_stub_ready=true
    break
  fi
  if ! kill -0 "$WALKING_OSRM_PID" 2>/dev/null; then wait "$WALKING_OSRM_PID"; exit 1; fi
  sleep 1
done
if [[ "$walking_stub_ready" != true ]]; then echo "Foot-router fixture did not become ready on 3305." >&2; exit 1; fi
start_api "" '[{"bbox":[23.9,49.7,24.15,49.95],"url":"http://127.0.0.1:3305/route/v1/foot"}]'
run_suite direct-walking env API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:direct-walking
stop_api
kill "$WALKING_OSRM_PID" 2>/dev/null || true
wait "$WALKING_OSRM_PID" 2>/dev/null || true
WALKING_OSRM_PID=""

# Exercise the direct-only adaptive endpoint retry using a dedicated scheduled feed and a
# deterministic foot graph. The baseline trip is close enough to be searched but leaves too soon
# for the measured access walk; a later direct trip sits beyond standard reach and is feasible.
WALKING_ROUTE_STUB_PORT=3308 node tests/fixtures/osrm-foot-route-stub.mjs &
WALKING_ROUTE_STUB_PID=$!
walking_route_stub_ready=false
for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:3308/health" | grep -q '"fixture":true'; then
    walking_route_stub_ready=true
    break
  fi
  if ! kill -0 "$WALKING_ROUTE_STUB_PID" 2>/dev/null; then wait "$WALKING_ROUTE_STUB_PID"; exit 1; fi
  sleep 1
done
if [[ "$walking_route_stub_ready" != true ]]; then echo "Walking route fixture did not become ready on 3308." >&2; exit 1; fi
API_TEST_GTFS_SEARCH_DEBUG=1 start_api "" '[{"bbox":[23.9,49.7,24.15,49.95],"url":"http://127.0.0.1:3308/route/v1/foot"}]'
run_suite direct-only-walking env API_TEST_GTFS_FIXTURE=1 API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  API_TEST_GTFS_SEARCH_DEBUG=1 \
  API_TEST_WALKING_STUB_URL="http://127.0.0.1:3308" npm run test:integration:direct-only-walking
stop_api
kill "$WALKING_ROUTE_STUB_PID" 2>/dev/null || true
wait "$WALKING_ROUTE_STUB_PID" 2>/dev/null || true
WALKING_ROUTE_STUB_PID=""
