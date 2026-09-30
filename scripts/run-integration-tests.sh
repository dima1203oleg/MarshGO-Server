#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${API_TEST_DATABASE_URL:-${E2E_DATABASE_URL:-postgres://marshgo:local_only_change_me@127.0.0.1:5434/marshgo_e2e}}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6380}"
RATE_LIMIT_TEST_PREFIX="marshgo:integration:rate-limit:$$:$RANDOM:"
export API_RATE_LIMIT_PREFIX="$RATE_LIMIT_TEST_PREFIX"
DATABASE_HOST="$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$DATABASE_URL")"
DATABASE_NAME="$(node -e 'process.stdout.write(new URL(process.argv[1]).pathname)' "$DATABASE_URL")"
if [[ ! "$DATABASE_HOST" =~ ^(127\.0\.0\.1|localhost|::1)$ || "$DATABASE_NAME" != "/marshgo_e2e" ]]; then
  echo "Refusing integration tests outside loopback marshgo_e2e database." >&2
  exit 2
fi

API_PORT="${API_TEST_PORT:-3306}"
SECONDARY_API_PORT="${API_TEST_SECONDARY_PORT:-3307}"
API_URL="http://127.0.0.1:${API_PORT}"
SECONDARY_API_URL="http://127.0.0.1:${SECONDARY_API_PORT}"
API_PID=""
SECONDARY_API_PID=""
OSRM_PID=""
cleanup() {
  if [[ -n "$API_PID" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi
  if [[ -n "$SECONDARY_API_PID" ]]; then kill "$SECONDARY_API_PID" 2>/dev/null || true; wait "$SECONDARY_API_PID" 2>/dev/null || true; fi
  if [[ -n "$OSRM_PID" ]]; then kill "$OSRM_PID" 2>/dev/null || true; wait "$OSRM_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

start_api() {
  local routing_url="${1:-}"
  env NODE_ENV=development AUTH_DEV_BYPASS=true AUTH_DEV_OTP=true \
    DATABASE_URL="$DATABASE_URL" API_HOST=127.0.0.1 API_PORT="$API_PORT" \
    REDIS_URL="$REDIS_URL" API_RATE_LIMIT_PREFIX="${API_TEST_RATE_LIMIT_PREFIX_OVERRIDE:-$RATE_LIMIT_TEST_PREFIX}" \
    API_RATE_LIMIT_LIMIT="${API_TEST_RATE_LIMIT_LIMIT:-300}" \
    API_RATE_LIMIT_WINDOW_MS="${API_TEST_RATE_LIMIT_WINDOW_MS:-900000}" SESSION_SECRET="integration-test-session-secret-32chars" \
    ROUTING_ENGINE_URL="$routing_url" ./node_modules/.bin/tsx server/index.ts &
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
  env NODE_ENV=development AUTH_DEV_OTP=true DATABASE_URL="$DATABASE_URL" \
    API_HOST=127.0.0.1 API_PORT="$SECONDARY_API_PORT" REDIS_URL="$REDIS_URL" \
    API_RATE_LIMIT_PREFIX="${API_TEST_RATE_LIMIT_PREFIX_OVERRIDE:-$RATE_LIMIT_TEST_PREFIX}" \
    API_RATE_LIMIT_LIMIT="${API_TEST_RATE_LIMIT_LIMIT:-300}" API_RATE_LIMIT_WINDOW_MS="${API_TEST_RATE_LIMIT_WINDOW_MS:-900000}" \
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
API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:bookings
stop_api

OSRM_STUB_PORT=3304 node tests/fixtures/osrm-stub.mjs &
OSRM_PID=$!
start_api "http://127.0.0.1:3304/route/v1/driving"
API_TEST_URL="$API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" API_TEST_NAVIGATION=true \
  npm run test:integration:navigation
stop_api

start_api
start_secondary_api
API_TEST_URL="$API_URL" API_TEST_SECONDARY_URL="$SECONDARY_API_URL" API_TEST_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:realtime
stop_secondary_api
stop_api
API_TEST_DATABASE_URL="$DATABASE_URL" API_TEST_RESTART=true API_TEST_RESTART_PORT=3308 \
  npm run test:integration:restart

API_TEST_RATE_LIMIT_PREFIX_OVERRIDE="${RATE_LIMIT_TEST_PREFIX}strict:" \
  API_TEST_RATE_LIMIT_LIMIT=3 API_TEST_RATE_LIMIT_WINDOW_MS=60000 start_api
API_TEST_RATE_LIMIT_PREFIX_OVERRIDE="${RATE_LIMIT_TEST_PREFIX}strict:" \
  API_TEST_RATE_LIMIT_LIMIT=3 API_TEST_RATE_LIMIT_WINDOW_MS=60000 start_secondary_api
API_TEST_URL="$API_URL" API_TEST_SECONDARY_URL="$SECONDARY_API_URL" \
  npm run test:integration:rate-limit
stop_secondary_api
stop_api
