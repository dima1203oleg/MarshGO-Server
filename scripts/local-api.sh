#!/usr/bin/env bash
# Local API development stack lifecycle manager.
#
# Safety contract (enforced by tests/local-api-stack.test.ts):
#   * Isolated Compose project `marshgo-local-api` with its own volumes; the
#     acceptance stack (docker-compose.yml: marshgo-postgres/marshgo-redis) is
#     never referenced, stopped, or deleted by this script.
#   * stop/down NEVER pass -v/--volumes/--rmi: named volumes always survive.
#   * All host binds are loopback-only (see docker-compose.local-api.yml).
#   * Secrets are read from the gitignored .env.local-api and never printed.
#   * Every failure path exits nonzero with an actionable message.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.local-api.yml"
ENV_FILE="$ROOT_DIR/.env.local-api"
ENV_EXAMPLE="$ROOT_DIR/.env.local-api.example"
PROJECT_NAME="marshgo-local-api"

fail() { echo "local-api: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: bash scripts/local-api.sh <command>

  start    Build if needed, start db+redis, wait healthy, run migrations,
           start api, wait for /readyz, print /version identity.
  stop     Stop containers, preserving containers and volumes (restartable).
  down     Remove containers and network, preserving volumes (never -v).
  status   Show container state plus live /healthz, /readyz, /version.
  smoke    Assert /healthz, /api/v1/health, /readyz, /version and that the
           running build SHA matches the current git HEAD.
  version  Print the running API build identity JSON.

Env file: .env.local-api (gitignored). Create it once:
  cp .env.local-api.example .env.local-api
  then set LOCAL_API_POSTGRES_PASSWORD and LOCAL_API_SESSION_SECRET
  (openssl rand -hex 32). The script refuses to run without it.
USAGE
}

env_value() {
  # Parse a KEY=VALUE from the env file without sourcing it and without ever
  # echoing the value; only presence/length checks happen in this script.
  # A missing file or missing key yields empty output and exit 0, so optional
  # keys fall back to safe defaults instead of tripping pipefail under set -e.
  [[ -f "$ENV_FILE" ]] || return 0
  { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n 1 | cut -d= -f2-
}

compose_no_env() {
  # Data-preserving lifecycle commands (stop/down/ps) must work even when
  # .env.local-api is lost or incomplete: inert fallbacks satisfy Compose's
  # `:?` interpolation only. They never reach running containers, and real
  # secret values are never required or printed here.
  LOCAL_API_POSTGRES_PASSWORD="${LOCAL_API_POSTGRES_PASSWORD:-inert-lifecycle-placeholder}" \
  LOCAL_API_SESSION_SECRET="${LOCAL_API_SESSION_SECRET:-inert-lifecycle-placeholder}" \
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

require_env_file() {
  [[ -f "$ENV_FILE" ]] || fail "missing $ENV_FILE — run: cp .env.local-api.example .env.local-api and fill in the two secrets (see $ENV_EXAMPLE)"
  local password secret
  password="$(env_value LOCAL_API_POSTGRES_PASSWORD)"
  secret="$(env_value LOCAL_API_SESSION_SECRET)"
  [[ "$password" != "replace-with-openssl-rand-hex-16" ]] \
    || fail "LOCAL_API_POSTGRES_PASSWORD is still the placeholder in .env.local-api"
  # DATABASE_URL interpolates this password into a URL unescaped, so only
  # URL-safe lowercase hex is accepted (openssl rand -hex 16).
  [[ "$password" =~ ^[0-9a-f]{32,64}$ ]] \
    || fail "LOCAL_API_POSTGRES_PASSWORD must be 32-64 lowercase hex characters (openssl rand -hex 16); it is interpolated into DATABASE_URL unescaped"
  [[ "$secret" != "replace-with-openssl-rand-hex-32" ]] \
    || fail "LOCAL_API_SESSION_SECRET is still the placeholder in .env.local-api"
  [[ "$(printf '%s' "$secret" | wc -c | tr -d ' ')" -ge 32 ]] \
    || fail "LOCAL_API_SESSION_SECRET must be at least 32 bytes (openssl rand -hex 32)"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "docker CLI not found"
  docker info >/dev/null 2>&1 || fail "docker daemon is not reachable; start Docker Desktop first"
}

compose() {
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

api_port() {
  host_port LOCAL_API_PORT 3002
}

api_url() { echo "http://127.0.0.1:$(api_port)$1"; }

export_build_identity() {
  # Exported vars win over --env-file interpolation, so the image and the
  # running /version always carry the identity of the checkout being started.
  local build_id build_sha build_time source_state
  build_id="${MARSHGO_BUILD_ID:-local-$(date -u +%Y%m%dT%H%M%SZ)}"
  build_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    source_state="clean"
  else
    source_state="dirty"
  fi
  export MARSHGO_BUILD_ID="$build_id"
  export MARSHGO_BUILD_SHA="$build_sha"
  export MARSHGO_BUILD_TIME="$build_time"
  export MARSHGO_SOURCE_STATE="$source_state"
}

port_is_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

service_publishes_port() {
  # Closed by default: success only when THIS project has a container for the
  # service, it is actually running, and Docker reports a published binding to
  # exactly this host port. A running container bound to a different port
  # (stale LOCAL_API_*_PORT edit) never legitimizes a listener on the new one,
  # and missing or malformed inspect output is a rejection.
  local service="$1" port="$2" container state mapping
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || return 1
  container="$(compose ps -q "$service" 2>/dev/null | head -n 1 || true)"
  [[ -n "$container" ]] || return 1
  state="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)"
  [[ "$state" == "true" ]] || return 1
  mapping="$(docker inspect --format '{{range $p, $bs := .NetworkSettings.Ports}}{{range $bs}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$container" 2>/dev/null || true)"
  [[ -n "$mapping" ]] || return 1
  # This stack publishes loopback-only mappings ("127.0.0.1:PORT:3002"), so a
  # binding on 0.0.0.0 or any other address is not ours; Compose here never
  # publishes ::1, so IPv6 loopback is deliberately not accepted either.
  printf '%s\n' "$mapping" | grep -qE "(^| )127\.0\.0\.1:${port}( |$)"
}

check_port_free_or_ours() {
  # A busy port is acceptable only when it is provably our own published
  # mapping; anything else fails closed before build/start. Foreign processes
  # are never killed.
  local port="$1" service="$2"
  port_is_listening "$port" || return 0
  service_publishes_port "$service" "$port" && return 0
  fail "port $port (for $service) is busy and is not a published host port of a running $service container in project $PROJECT_NAME; free it or fix LOCAL_API_*_PORT in .env.local-api (this script never kills foreign processes)"
}

host_port() {
  local value
  value="$(env_value "$1")"
  value="${value:-$2}"
  [[ "$value" =~ ^[0-9]{1,5}$ ]] || fail "$1 must be a numeric port in .env.local-api; refusing to continue with a malformed value"
  # 10# forces decimal so a leading zero can never be read as octal.
  (( 10#$value >= 1 && 10#$value <= 65535 )) || fail "$1 must be a valid TCP port in 1..65535 in .env.local-api; got $value"
  echo "$value"
}

wait_healthy() {
  local service="$1" timeout="${2:-180}" container status
  container="$(compose ps -q "$service")"
  [[ -n "$container" ]] || fail "$service container did not start"
  local deadline=$(( $(date +%s) + timeout ))
  while true; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo missing)"
    case "$status" in
      healthy|running) return 0 ;;
      missing|exited|dead) fail "$service container is '$status'; inspect with: docker logs $container" ;;
    esac
    [[ "$(date +%s)" -lt "$deadline" ]] || fail "$service did not become healthy within ${timeout}s (last status: $status)"
    sleep 2
  done
}

wait_readyz() {
  local timeout="${1:-90}" code deadline
  deadline=$(( $(date +%s) + timeout ))
  while true; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$(api_url /readyz)" || echo 000)"
    [[ "$code" == "200" ]] && return 0
    if [[ "$(date +%s)" -ge "$deadline" ]]; then
      echo "local-api: /readyz never returned 200 (last HTTP $code); last 50 api log lines:" >&2
      compose logs --tail 50 api >&2 || true
      return 1
    fi
    sleep 2
  done
}

fetch_json() {
  local path="$1" code body
  body="$(curl -s --max-time 5 -w '\n%{http_code}' "$(api_url "$path")")" || fail "API unreachable at $(api_url "$path") — is the stack started?"
  code="$(printf '%s' "$body" | tail -n 1)"
  body="$(printf '%s' "$body" | sed '$d')"
  [[ "$code" == "200" ]] || fail "GET $path returned HTTP $code, expected 200"
  printf '%s' "$body"
}

json_field() {
  node -e '
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      let value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      for (const key of process.argv[1].split(".")) {
        if (value == null) break;
        value = value[key];
      }
      process.stdout.write(value == null ? "" : String(value));
    });' "$1"
}

commit_sha_matches() {
  # Smoke requires exact full-SHA equality; a short (e.g. 7-char) prefix must
  # never pass, otherwise a stale image can impersonate the current checkout.
  [[ -n "$1" && "$1" == "$2" ]]
}

cmd_start() {
  require_docker
  require_env_file
  [[ -f "$COMPOSE_FILE" ]] || fail "missing $COMPOSE_FILE"
  # Port pre-flight: db, redis and api host ports are checked before anything
  # is built or started; occupied-by-foreign-process always fails closed.
  check_port_free_or_ours "$(host_port LOCAL_API_DB_PORT 5444)" db
  check_port_free_or_ours "$(host_port LOCAL_API_REDIS_PORT 6390)" redis
  check_port_free_or_ours "$(api_port)" api
  export_build_identity
  # Deterministic first run: build the api image exactly once, up front, so
  # migrations and the running api always come from the same built image.
  echo "local-api: building api image (project $PROJECT_NAME, build $MARSHGO_BUILD_SHA ${MARSHGO_SOURCE_STATE})"
  compose build api
  echo "local-api: starting db+redis"
  compose up -d db redis
  wait_healthy db 180
  wait_healthy redis 120
  echo "local-api: applying schema migrations from the built image"
  compose run --rm --no-deps -T api node --import=tsx server/migrate.ts
  echo "local-api: starting api on 127.0.0.1:$(api_port)"
  compose up -d api
  wait_readyz 90 || fail "api did not reach ready state"
  echo "local-api: ready. Identity:"
  fetch_json /version
  echo
}

cmd_stop() {
  require_docker
  # Data-preserving: containers and named volumes stay intact. Never -v.
  # Works even if .env.local-api was deleted (compose_no_env fallbacks).
  compose_no_env stop
  echo "local-api: stopped (volumes preserved; 'start' restarts quickly)"
}

cmd_down() {
  require_docker
  # Data-preserving teardown: removes containers/network only. Never -v/--volumes/--rmi.
  compose_no_env down --remove-orphans
  echo "local-api: containers removed; volumes marshgo-local-api-postgres and marshgo-local-api-redis preserved"
}

cmd_status() {
  require_docker
  compose_no_env ps
  local code
  for path in /healthz /readyz; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$(api_url "$path")" || echo 000)"
    echo "local-api: GET $path -> HTTP $code"
    [[ "$code" == "200" ]] || exit 1
  done
  fetch_json /version
  echo
}

cmd_smoke() {
  require_env_file
  local body expected_sha actual_sha service
  body="$(fetch_json /healthz)"
  [[ "$(printf '%s' "$body" | json_field status)" == "ok" ]] || fail "/healthz did not report status ok"
  body="$(fetch_json /api/v1/health)"
  [[ "$(printf '%s' "$body" | json_field status)" == "ok" ]] || fail "/api/v1/health did not report status ok"
  body="$(fetch_json /readyz)"
  [[ "$(printf '%s' "$body" | json_field status)" == "ready" ]] || fail "/readyz did not report ready: $body"
  body="$(fetch_json /version)"
  service="$(printf '%s' "$body" | json_field service)"
  [[ "$service" == "MarshGO-Server" ]] || fail "/version service is '$service', expected MarshGO-Server"
  actual_sha="$(printf '%s' "$body" | json_field commitSha)"
  expected_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  commit_sha_matches "$actual_sha" "$expected_sha" \
    || fail "/version commitSha '${actual_sha:-<empty>}' does not exactly match git HEAD $expected_sha; rebuild via: bash scripts/local-api.sh start"
  echo "local-api: smoke OK (health, readiness, version identity $actual_sha)"
}

cmd_version() {
  fetch_json /version | node -e '
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify(JSON.parse(Buffer.concat(chunks).toString("utf8")), null, 2) + "\n");
    });'
}

command_name="${1:-}"
case "$command_name" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  down) cmd_down ;;
  status) cmd_status ;;
  smoke) cmd_smoke ;;
  version) cmd_version ;;
  ""|-h|--help|help) usage ;;
  *) usage; fail "unknown command: $command_name" ;;
esac
