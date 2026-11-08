import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const repoFile = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const repoHas = (relative: string) => existsSync(new URL(`../${relative}`, import.meta.url));
const repoPath = (relative: string) => new URL(`../${relative}`, import.meta.url);

const compose = repoFile('docker-compose.local-api.yml');
const script = repoFile('scripts/local-api.sh');
const envExample = repoFile('.env.local-api.example');
const packageJson = JSON.parse(repoFile('package.json')) as { scripts: Record<string, string> };

/** Script lines that execute: comment-only lines stripped so prose about flags cannot satisfy or break assertions. */
const scriptCode = script
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

/** Same stripping for compose so the isolation header comment cannot trip substring assertions. */
const composeCode = compose
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

/** Extract one top-level bash function verbatim so tests can execute the real implementation. */
const bashFunction = (name: string) => {
  const start = script.indexOf(`${name}() {`);
  assert.ok(start > -1, `bash function ${name}() not found in scripts/local-api.sh`);
  const lineEnd = script.indexOf('\n', start);
  if (script.slice(start, lineEnd).trimEnd().endsWith('}')) return script.slice(start, lineEnd);
  const end = script.indexOf('\n}\n', start);
  assert.ok(end > -1, `bash function ${name}() has no top-level closing brace`);
  return script.slice(start, end + 3);
};

const runBash = (program: string, args: string[] = [], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync('bash', ['-c', program, 'bash', ...args], { encoding: 'utf8', input: options.input, env: options.env ?? process.env });

describe('local API stack compose isolation', () => {
  it('pins an isolated compose project name', () => {
    assert.match(compose, /^name: marshgo-local-api$/m);
  });

  it('binds every published host port to loopback only', () => {
    const bindings = [...compose.matchAll(/- "([^"]+:\d+(?::\d+)?|\d+(?::\d+)?)"\s*$/gm)].map((match) => match[1]);
    assert.ok(bindings.length >= 3, 'expected at least db, redis and api port bindings');
    for (const binding of bindings) {
      assert.ok(binding.startsWith('127.0.0.1:'), `host binding is not loopback-only: ${binding}`);
    }
  });

  it('uses only its own explicitly named volumes and never references acceptance volumes', () => {
    assert.match(composeCode, /^\s{2}marshgo-local-api-postgres:\s*\n\s{4}name: marshgo-local-api-postgres$/m);
    assert.match(composeCode, /^\s{2}marshgo-local-api-redis:\s*\n\s{4}name: marshgo-local-api-redis$/m);
    assert.doesNotMatch(composeCode, /marshgo-postgres/);
    assert.doesNotMatch(composeCode, /marshgo-redis/);
  });

  it('avoids acceptance and system default host ports', () => {
    for (const forbidden of [':5434:', ':6380:', ':6381:']) {
      assert.ok(!compose.includes(forbidden), `compose must not bind acceptance port ${forbidden}`);
    }
    assert.match(compose, /LOCAL_API_DB_PORT:-5444/);
    assert.match(compose, /LOCAL_API_REDIS_PORT:-6390/);
  });

  it('builds the api from this repository Dockerfile with build identity args', () => {
    assert.match(compose, /dockerfile: Dockerfile/);
    for (const arg of ['MARSHGO_BUILD_ID', 'MARSHGO_BUILD_SHA', 'MARSHGO_BUILD_TIME', 'MARSHGO_SOURCE_STATE']) {
      assert.match(compose, new RegExp(`${arg}: \\$\\{${arg}:-`), `missing build arg passthrough ${arg}`);
    }
  });

  it('hardens development auth and disables fixture/fake-estimate mode', () => {
    assert.match(compose, /NODE_ENV: development/);
    assert.match(compose, /AUTH_DEV_BYPASS: "false"/);
    assert.match(compose, /AUTH_DEV_OTP: "false"/);
    assert.match(compose, /MARSHGO_API_TEST_FIXTURE_MODE: "0"/);
    assert.doesNotMatch(compose, /NODE_ENV: production/);
  });

  it('passes the selected local geocoder through without enabling one by default', () => {
    assert.match(compose, /GEOCODING_PROVIDER: \$\{LOCAL_API_GEOCODING_PROVIDER:-nominatim\}/);
    assert.match(envExample, /LOCAL_API_GEOCODING_PROVIDER=nominatim/);
    assert.match(compose, /GEOCODING_ENGINE_URL: \$\{LOCAL_API_GEOCODING_ENGINE_URL:-\}/);
  });

  it('passes bbox-selected foot graph configuration through to the API container', () => {
    assert.match(compose, /WALKING_ROUTING_URLS: \$\{LOCAL_API_WALKING_ROUTING_URLS:-\}/);
    assert.match(envExample, /^LOCAL_API_WALKING_ROUTING_URLS=$/m);
  });

  it('sequences the api behind healthy db and redis', () => {
    assert.match(compose, /pg_isready/);
    assert.match(compose, /redis-cli/, 'redis healthcheck missing');
    const depends = compose.slice(compose.indexOf('depends_on:'));
    assert.match(depends, /db:\s*\n\s*condition: service_healthy/);
    assert.match(depends, /redis:\s*\n\s*condition: service_healthy/);
  });
});

describe('local API lifecycle script safety', () => {
  it('fails fast on any error', () => {
    assert.match(scriptCode, /^set -euo pipefail$/m);
  });

  it('never destroys volumes or images in stop/down paths', () => {
    assert.doesNotMatch(scriptCode, /compose stop .*-/);
    assert.doesNotMatch(scriptCode, /compose[_a-z]* down[^\n]*(-v\b|--volumes|--rmi)/);
    assert.match(scriptCode, /compose_no_env down --remove-orphans/);
  });

  it('parses the env file without sourcing or printing it', () => {
    assert.doesNotMatch(scriptCode, /source "\$ENV_FILE"|\.\s+"\$ENV_FILE"/);
    assert.doesNotMatch(scriptCode, /cat "\$ENV_FILE"/);
    assert.match(scriptCode, /env_value\(\)/);
  });

  it('fails closed on missing env file, placeholder secrets, short secret, or non-hex password', () => {
    assert.match(scriptCode, /missing \$ENV_FILE/);
    assert.match(scriptCode, /replace-with-openssl-rand-hex-16/);
    assert.match(scriptCode, /replace-with-openssl-rand-hex-32/);
    assert.match(scriptCode, /\^\[0-9a-f\]\{32,64\}\$/);
    assert.match(scriptCode, /-ge 32/);
  });

  it('refuses to hijack a foreign process holding the API port', () => {
    assert.match(scriptCode, /port_is_listening/);
    assert.match(scriptCode, /never kills foreign processes/);
    assert.doesNotMatch(scriptCode, /\bkill\b|\bpkill\b|\bkillall\b/);
  });

  it('runs migrations after dependency health and before starting the api', () => {
    const startBody = scriptCode.slice(scriptCode.indexOf('cmd_start()'));
    const healthyAt = startBody.indexOf('wait_healthy db');
    const migrateAt = startBody.indexOf('server/migrate.ts');
    const apiUpAt = startBody.indexOf('compose up -d api');
    const readyAt = startBody.indexOf('wait_readyz');
    assert.ok(healthyAt > -1 && migrateAt > healthyAt, 'migrations must follow db health');
    assert.ok(apiUpAt > migrateAt, 'api must start after migrations');
    assert.ok(readyAt > apiUpAt, 'readiness polling must follow api start');
  });

  it('always targets the isolated project and compose file', () => {
    assert.match(scriptCode, /PROJECT_NAME="marshgo-local-api"/);
    assert.match(scriptCode, /docker compose -p "\$PROJECT_NAME" -f "\$COMPOSE_FILE" --env-file "\$ENV_FILE"/);
  });
});

describe('local API stack packaging', () => {
  it('adds lifecycle scripts without touching canonical ones', () => {
    const expected: Record<string, string> = {
      'local:api:start': 'bash scripts/local-api.sh start',
      'local:api:stop': 'bash scripts/local-api.sh stop',
      'local:api:down': 'bash scripts/local-api.sh down',
      'local:api:status': 'bash scripts/local-api.sh status',
      'local:api:smoke': 'bash scripts/local-api.sh smoke',
      'local:api:version': 'bash scripts/local-api.sh version',
    };
    for (const [name, command] of Object.entries(expected)) {
      assert.equal(packageJson.scripts[name], command);
    }
    assert.equal(packageJson.scripts.api, 'tsx server/index.ts');
    assert.equal(packageJson.scripts['db:migrate'], 'tsx server/migrate.ts');
    assert.equal(packageJson.scripts.test, 'tsx --test tests/*.test.ts');
    assert.equal(packageJson.scripts.typecheck, 'tsc --noEmit');
  });

  it('keeps the filled env file out of git and ships a placeholder-only example', () => {
    assert.match(repoFile('.gitignore'), /^\.env\.local-api$/m);
    assert.match(envExample, /LOCAL_API_POSTGRES_PASSWORD=replace-with-openssl-rand-hex-16/);
    assert.match(envExample, /LOCAL_API_SESSION_SECRET=replace-with-openssl-rand-hex-32/);
    assert.ok(!repoHas('.env.local-api'), '.env.local-api must never be committed');
  });

  it('ships the lifecycle script executable and documents the stack', () => {
    const mode = statSync(repoPath('scripts/local-api.sh')).mode;
    assert.ok(mode & 0o111, 'scripts/local-api.sh must be executable');
    const docs = repoFile('docs/LOCAL_API_DEV_STACK.md');
    assert.match(docs, /Isolation guarantees/);
    assert.match(docs, /openssl rand -hex 16/, 'docs must instruct the URL-safe hex password');
    assert.match(docs, /marshgo-local-api-postgres/);
    assert.match(docs, /marshgo-local-api-redis/);
  });
});

describe('parent-review regressions', () => {
  const validPassword = '0123456789abcdef0123456789abcdef';
  const validSecret = 'a'.repeat(64);

  it('(1) json_field traverses keys with a mutable binding and returns real values', () => {
    assert.match(scriptCode, /let value = JSON\.parse/);
    assert.doesNotMatch(scriptCode, /const value = JSON\.parse/);
    const program = `${bashFunction('json_field')}\njson_field "$1"`;
    const readField = (json: string, key: string) => runBash(program, [key], { input: json }).trim();
    assert.equal(readField('{"status":"ready","database":"connected"}', 'status'), 'ready');
    assert.equal(readField('{"service":"MarshGO-Server","apiContract":"v1"}', 'service'), 'MarshGO-Server');
    assert.equal(readField('{"data":{"field":"deep"}}', 'data.field'), 'deep');
    assert.equal(readField('{"status":"ready"}', 'missing'), '');
  });

  it('(2) smoke requires exact full commitSha equality and rejects a 7-char prefix', () => {
    assert.match(scriptCode, /commit_sha_matches "\$actual_sha" "\$expected_sha"/);
    assert.doesNotMatch(scriptCode, /"\$expected_sha"\*|\$actual_sha"\s*==\s*"\$expected_sha"\*/);
    const program = `${bashFunction('commit_sha_matches')}\ncommit_sha_matches "$1" "$2"`;
    const matches = (a: string, b: string) => {
      try { runBash(program, [a, b]); return true; } catch { return false; }
    };
    const fullSha = 'b767b9363796f9cbd43444f839e52e5b71ac17d4';
    assert.ok(matches(fullSha, fullSha), 'identical full SHAs must match');
    assert.ok(!matches(fullSha.slice(0, 7), fullSha), '7-char prefix must not match the full SHA');
    assert.ok(!matches(fullSha, fullSha.slice(0, 7)), 'full SHA must not match a 7-char expectation');
    assert.ok(!matches('', fullSha), 'empty commitSha must not match');
  });

  it('(3) compose pins exact volume names so docs and runtime agree', () => {
    assert.equal((composeCode.match(/name: marshgo-local-api-(postgres|redis)/g) ?? []).length, 2);
  });

  it('(4) require_env_file accepts only URL-safe hex passwords and fails closed otherwise', () => {
    const program = `${bashFunction('fail')}\n${bashFunction('env_value')}\n${bashFunction('require_env_file')}\nrequire_env_file`;
    const dir = mkdtempSync(path.join(tmpdir(), 'local-api-env-test-'));
    const check = (contents: string) => {
      const file = path.join(dir, `env-${crypto.randomUUID()}`);
      writeFileSync(file, contents);
      try {
        runBash(program, [], { env: { ...process.env, ENV_FILE: file, ENV_EXAMPLE: 'example' } });
        return { ok: true, stderr: '' };
      } catch (error) {
        return { ok: false, stderr: String((error as { stderr?: unknown }).stderr ?? '') };
      }
    };
    const envWith = (password: string, secret: string) =>
      `LOCAL_API_POSTGRES_PASSWORD=${password}\nLOCAL_API_SESSION_SECRET=${secret}\n`;

    assert.ok(check(envWith(validPassword, validSecret)).ok, 'valid hex password and long secret must pass');

    const placeholder = check(envWith('replace-with-openssl-rand-hex-16', validSecret));
    assert.ok(!placeholder.ok && /placeholder/.test(placeholder.stderr), 'placeholder password must be rejected');

    const unsafe = check(envWith("p@ss w/rd:'!", validSecret));
    assert.ok(!unsafe.ok && /hex/.test(unsafe.stderr), 'URL-unsafe password must be rejected with hex guidance');

    const tooShort = check(envWith('0123456789abcdef', validSecret));
    assert.ok(!tooShort.ok && /hex/.test(tooShort.stderr), 'password shorter than 32 hex chars must be rejected');

    const shortSecret = check(envWith(validPassword, 'short'));
    assert.ok(!shortSecret.ok && /32 bytes/.test(shortSecret.stderr), 'short session secret must be rejected');
  });

  it('(5) lifecycle script keeps passing shellcheck-level syntax after the fixes', () => {
    assert.match(scriptCode, /^set -euo pipefail$/m);
    assert.doesNotMatch(scriptCode, /compose down[^\n]*(-v\b|--volumes|--rmi)/);
  });
});

describe('operational-review regressions', () => {
  const docs = repoFile('docs/LOCAL_API_DEV_STACK.md');

  it('builds the api image exactly once, before migrations, and starts api without a second build', () => {
    const startBody = scriptCode.slice(scriptCode.indexOf('cmd_start()'));
    const buildAt = startBody.indexOf('compose build api');
    const migrateAt = startBody.indexOf('compose run --rm --no-deps');
    const apiUpAt = startBody.indexOf('compose up -d api');
    assert.ok(buildAt > -1, 'cmd_start must build the api image explicitly');
    assert.ok(migrateAt > buildAt, 'migrations must run from the pre-built image');
    assert.ok(apiUpAt > migrateAt, 'api must start after migrations');
    assert.doesNotMatch(scriptCode, /--build/, 'no compose command may carry --build anymore');
    const buildCount = (scriptCode.match(/compose build api/g) ?? []).length;
    assert.equal(buildCount, 1, 'the api image must be built exactly once per start');
  });

  it('pre-checks db, redis and api host ports before building or starting anything, without killing', () => {
    const startBody = scriptCode.slice(scriptCode.indexOf('cmd_start()'));
    const buildAt = startBody.indexOf('compose build api');
    for (const call of [
      'check_port_free_or_ours "$(host_port LOCAL_API_DB_PORT 5444)" db',
      'check_port_free_or_ours "$(host_port LOCAL_API_REDIS_PORT 6390)" redis',
      'check_port_free_or_ours "$(api_port)" api',
    ]) {
      const at = startBody.indexOf(call);
      assert.ok(at > -1, `missing port pre-flight: ${call}`);
      assert.ok(at < buildAt, `port pre-flight must precede the build: ${call}`);
    }
    const guard = bashFunction('check_port_free_or_ours');
    assert.match(guard, /service_publishes_port "\$service" "\$port"/, 'a busy port must be validated against the actual published mapping');
    assert.match(guard, /never kills foreign processes/);
    assert.doesNotMatch(guard, /\bkill\b|\bpkill\b|\bkillall\b/);
    assert.doesNotMatch(bashFunction('service_publishes_port'), /\bkill\b|\bpkill\b|\bkillall\b/);
  });

  it('documents the zrok tunnel origin as an ignored-env opt-in and keeps it out of committed defaults', () => {
    assert.match(docs, /https:\/\/marshgo-dima\.shares\.zrok\.io/);
    assert.match(docs, /LOCAL_API_CORS_ORIGINS/, 'docs must show the opt-in variable');
    assert.match(docs, /deliberately \*\*not\*\* part\s+of the compose default/, 'docs must state the origin is not a committed default');
    assert.ok(!compose.includes('zrok'), 'compose defaults must not contain the public tunnel origin');
    assert.ok(!envExample.includes('zrok'), 'env example must not contain the public tunnel origin');
  });
});

describe('safety-edge regressions (stubbed docker/lsof, no daemon)', () => {
  const stubDir = mkdtempSync(path.join(tmpdir(), 'local-api-stub-'));
  const dockerStub = [
    '#!/usr/bin/env bash',
    'set -u',
    'if [[ "${1:-}" == "compose" ]]; then',
    '  if [[ -n "${STUB_CONTAINER_ID:-}" ]]; then echo "$STUB_CONTAINER_ID"; fi',
    '  exit "${STUB_COMPOSE_FAIL:-0}"',
    'fi',
    'if [[ "${1:-}" == "inspect" ]]; then',
    '  if [[ "${STUB_INSPECT_FAIL:-0}" == "1" ]]; then echo "Error: No such object" >&2; exit 1; fi',
    '  case "${3:-}" in',
    "    *'.State.Running'*) echo \"${STUB_RUNNING:-false}\" ;;",
    "    *'.NetworkSettings.Ports'*) printf '%s\\n' \"${STUB_PORTS:-}\" ;;",
    '    *) exit 1 ;;',
    '  esac',
    '  exit 0',
    'fi',
    'echo "stub docker: unexpected invocation: $*" >&2',
    'exit 1',
    '',
  ].join('\n');
  writeFileSync(path.join(stubDir, 'docker'), dockerStub, { mode: 0o755 });
  writeFileSync(path.join(stubDir, 'lsof'), '#!/usr/bin/env bash\nexit "${STUB_LISTENING:-1}"\n', { mode: 0o755 });
  chmodSync(path.join(stubDir, 'docker'), 0o755);
  chmodSync(path.join(stubDir, 'lsof'), 0o755);

  const harness = [
    'set -uo pipefail',
    'PROJECT_NAME="marshgo-local-api"',
    'COMPOSE_FILE="/nonexistent-compose.yml"',
    'ENV_FILE="/nonexistent-env"',
    bashFunction('fail'),
    bashFunction('compose'),
    bashFunction('port_is_listening'),
    bashFunction('service_publishes_port'),
    bashFunction('check_port_free_or_ours'),
    'check_port_free_or_ours "$1" "$2"',
  ].join('\n');

  const runStubbed = (envOverrides: Record<string, string>, port: string, service: string) => {
    try {
      execFileSync('bash', ['-c', harness, 'bash', port, service], {
        encoding: 'utf8',
        env: { PATH: `${stubDir}:${process.env.PATH ?? ''}`, ...envOverrides },
      });
      return { ok: true, stderr: '' };
    } catch (error) {
      return { ok: false, stderr: String((error as { stderr?: unknown }).stderr ?? '') };
    }
  };

  it('accepts a busy port that this project\'s running service actually publishes', () => {
    const result = runStubbed(
      { STUB_LISTENING: '0', STUB_CONTAINER_ID: 'cid1', STUB_RUNNING: 'true', STUB_PORTS: '127.0.0.1:3002 ' },
      '3002', 'api',
    );
    assert.ok(result.ok, `exact own mapping must be accepted: ${result.stderr}`);
  });

  it('rejects a foreign listener when the project has no container', () => {
    const result = runStubbed({ STUB_LISTENING: '0', STUB_CONTAINER_ID: '' }, '3002', 'api');
    assert.ok(!result.ok, 'foreign listener must be rejected');
    assert.match(result.stderr, /never kills foreign processes/);
  });

  it('rejects when own service runs but publishes a different host port', () => {
    const result = runStubbed(
      { STUB_LISTENING: '0', STUB_CONTAINER_ID: 'cid1', STUB_RUNNING: 'true', STUB_PORTS: '127.0.0.1:3002 ' },
      '3005', 'api',
    );
    assert.ok(!result.ok, 'a stale LOCAL_API_*_PORT edit must not legitimize an unrelated listener');
  });

  it('rejects when docker inspect fails', () => {
    const result = runStubbed(
      { STUB_LISTENING: '0', STUB_CONTAINER_ID: 'cid1', STUB_RUNNING: 'true', STUB_PORTS: '127.0.0.1:3002 ', STUB_INSPECT_FAIL: '1' },
      '3002', 'api',
    );
    assert.ok(!result.ok, 'inspect failure must fail closed');
  });

  it('rejects missing published-port output', () => {
    const result = runStubbed(
      { STUB_LISTENING: '0', STUB_CONTAINER_ID: 'cid1', STUB_RUNNING: 'true', STUB_PORTS: '' },
      '3002', 'api',
    );
    assert.ok(!result.ok, 'empty inspect output must fail closed');
  });

  it('rejects malformed published-port output', () => {
    const result = runStubbed(
      { STUB_LISTENING: '0', STUB_CONTAINER_ID: 'cid1', STUB_RUNNING: 'true', STUB_PORTS: 'garbage-output' },
      '3002', 'api',
    );
    assert.ok(!result.ok, 'malformed inspect output must fail closed');
  });

  it('rejects a stopped own container with stale bindings under a foreign listener', () => {
    const result = runStubbed(
      { STUB_LISTENING: '0', STUB_CONTAINER_ID: 'cid1', STUB_RUNNING: 'false', STUB_PORTS: '127.0.0.1:3002 ' },
      '3002', 'api',
    );
    assert.ok(!result.ok, 'a stopped container cannot own a live listener');
  });

  it('accepts a free port without consulting docker', () => {
    const result = runStubbed({ STUB_LISTENING: '1' }, '3002', 'api');
    assert.ok(result.ok, `free port must be accepted: ${result.stderr}`);
    assert.equal(result.stderr, '');
  });

  it('does not accept a listener on a port that merely contains the configured port number', () => {
    const result = runStubbed(
      { STUB_LISTENING: '0', STUB_CONTAINER_ID: 'cid1', STUB_RUNNING: 'true', STUB_PORTS: '127.0.0.1:13002 ' },
      '3002', 'api',
    );
    assert.ok(!result.ok, '13002 must not be mistaken for 3002');
  });

  it('rejects a 0.0.0.0 published binding in the loopback-only stack', () => {
    const result = runStubbed(
      { STUB_LISTENING: '0', STUB_CONTAINER_ID: 'cid1', STUB_RUNNING: 'true', STUB_PORTS: '0.0.0.0:3002 ' },
      '3002', 'api',
    );
    assert.ok(!result.ok, 'a wildcard binding is not ours: the compose file publishes 127.0.0.1 only');
  });

  it('rejects an IPv6 loopback binding Compose never publishes here', () => {
    const result = runStubbed(
      { STUB_LISTENING: '0', STUB_CONTAINER_ID: 'cid1', STUB_RUNNING: 'true', STUB_PORTS: '::1:3002 ' },
      '3002', 'api',
    );
    assert.ok(!result.ok, 'this stack never publishes ::1, so it cannot be ours');
  });

  it('rejects a malformed loopback-prefixed mapping', () => {
    const result = runStubbed(
      { STUB_LISTENING: '0', STUB_CONTAINER_ID: 'cid1', STUB_RUNNING: 'true', STUB_PORTS: '127.0.0.1:3002x ' },
      '3002', 'api',
    );
    assert.ok(!result.ok, 'trailing garbage after the port must not match');
  });
});

describe('bounded-review failure-edge regressions', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'local-api-edge-'));

  it('env_value tolerates missing keys and missing files under set -euo pipefail', () => {
    const program = [
      'set -euo pipefail',
      'ENV_FILE="$1"',
      bashFunction('env_value'),
      'value="$(env_value SOME_KEY)"',
      'printf \'%s\' "$value"',
    ].join('\n');
    assert.equal(runBash(program, [path.join(tempDir, 'absent-env')]), '', 'missing file must yield empty, not crash');
    const envFile = path.join(tempDir, 'edge-env');
    writeFileSync(envFile, 'OTHER_KEY=1\n');
    assert.equal(runBash(program, [envFile]), '', 'missing key must yield empty, not crash (old grep|pipefail bug)');
    writeFileSync(envFile, 'OTHER_KEY=1\nSOME_KEY=abc\n');
    assert.equal(runBash(program, [envFile]), 'abc', 'present key must be returned');
  });

  it('host_port fails closed on malformed values and falls back to defaults', () => {
    const envFile = path.join(tempDir, 'port-env');
    const program = [
      'set -euo pipefail',
      'ENV_FILE="$1"',
      bashFunction('fail'),
      bashFunction('env_value'),
      bashFunction('host_port'),
      'host_port "$2" "$3"',
    ].join('\n');
    writeFileSync(envFile, 'LOCAL_API_DB_PORT=not-a-port\n');
    try {
      runBash(program, [envFile, 'LOCAL_API_DB_PORT', '5444']);
      assert.fail('malformed port value must be rejected');
    } catch (error) {
      assert.match(String((error as { stderr?: unknown }).stderr ?? ''), /numeric port/);
    }
    writeFileSync(envFile, 'LOCAL_API_DB_PORT=5455\n');
    assert.equal(runBash(program, [envFile, 'LOCAL_API_DB_PORT', '5444']).trim(), '5455');
    writeFileSync(envFile, 'OTHER=1\n');
    assert.equal(runBash(program, [envFile, 'LOCAL_API_DB_PORT', '5444']).trim(), '5444', 'absent key must use the default');
    const checkRange = (portValue: string) => {
      writeFileSync(envFile, `LOCAL_API_DB_PORT=${portValue}\n`);
      try {
        return { ok: true, out: runBash(program, [envFile, 'LOCAL_API_DB_PORT', '5444']).trim(), stderr: '' };
      } catch (error) {
        return { ok: false, out: '', stderr: String((error as { stderr?: unknown }).stderr ?? '') };
      }
    };
    const low = checkRange('1');
    assert.ok(low.ok && low.out === '1', 'port 1 is the valid lower boundary');
    const high = checkRange('65535');
    assert.ok(high.ok && high.out === '65535', 'port 65535 is the valid upper boundary');
    const zero = checkRange('0');
    assert.ok(!zero.ok && /1\.\.65535/.test(zero.stderr), 'port 0 must be rejected');
    const above = checkRange('65536');
    assert.ok(!above.ok && /1\.\.65535/.test(above.stderr), 'port 65536 must be rejected');
    const farAbove = checkRange('99999');
    assert.ok(!farAbove.ok && /1\.\.65535/.test(farAbove.stderr), 'port 99999 must be rejected');
  });

  it('stop/down/status survive a lost env file via compose_no_env with inert placeholders', () => {
    const lifecycle = bashFunction('compose_no_env');
    assert.match(lifecycle, /LOCAL_API_POSTGRES_PASSWORD:-inert-lifecycle-placeholder/);
    assert.match(lifecycle, /LOCAL_API_SESSION_SECRET:-inert-lifecycle-placeholder/);
    assert.ok(!lifecycle.includes('--env-file'), 'compose_no_env must not require the env file');
    assert.doesNotMatch(lifecycle, /-v\b|--volumes|--rmi/);
    assert.match(bashFunction('cmd_stop'), /compose_no_env stop/);
    assert.match(bashFunction('cmd_down'), /compose_no_env down --remove-orphans/);
    assert.match(bashFunction('cmd_status'), /compose_no_env ps/);
    assert.ok(!bashFunction('cmd_stop').includes('missing $ENV_FILE'), 'stop must not be held hostage by a lost env file');
    assert.ok(!bashFunction('cmd_down').includes('missing $ENV_FILE'), 'down must not be held hostage by a lost env file');
  });

  it('api_port delegates to the validated host_port helper', () => {
    assert.match(scriptCode, /api_port\(\) \{\s*\n\s*host_port LOCAL_API_PORT 3002/);
  });

  it('cmd_down prints its success echo exactly once', () => {
    const down = bashFunction('cmd_down');
    const echoes = (down.match(/echo "local-api: containers removed/g) ?? []).length;
    assert.equal(echoes, 1, 'cmd_down must not duplicate its success message');
    const stop = bashFunction('cmd_stop');
    assert.equal((stop.match(/echo "local-api: stopped/g) ?? []).length, 1);
  });
});

describe('CI runtime contract (.github/workflows/ci.yml)', () => {
  const workflow = repoFile('.github/workflows/ci.yml');
  const lifecycleAt = workflow.indexOf('Exercise local API Compose lifecycle end-to-end');
  assert.ok(workflow.indexOf('Smoke-test API image') > -1, 'image smoke step must exist');
  assert.ok(lifecycleAt > workflow.indexOf('Smoke-test API image'), 'lifecycle step must run after the image smoke');
  const step = workflow.slice(lifecycleAt);

  it('runs start and exact-SHA smoke, and always tears down via trap without masking failures', () => {
    assert.match(step, /set -euo pipefail/);
    assert.match(step, /npm run local:api:start/);
    assert.match(step, /npm run local:api:smoke/);
    assert.match(step, /cleanup\(\) \{\s*\n\s*local status=\$\?/);
    assert.match(step, /npm run local:api:down \|\| echo "local-api CI: cleanup down failed"/);
    assert.match(step, /rm -f \.env\.local-api/);
    assert.match(step, /exit "\$status"/, 'cleanup must re-exit with the original failure status');
    assert.match(step, /trap cleanup EXIT/);
    assert.doesNotMatch(step, /local:api:down[^\n]*(-v\b|--volumes|--rmi)/);
    assert.doesNotMatch(step, /docker volume rm|docker system prune/);
  });

  it('generates disposable in-runner hex secrets and never prints them', () => {
    assert.match(step, /umask 077/);
    assert.match(step, /openssl rand -hex 16/);
    assert.match(step, /openssl rand -hex 32/);
    assert.match(step, /> \.env\.local-api/);
    assert.match(step, /unset db_password session_secret/);
    assert.doesNotMatch(step, /echo[^\n]*(db_password|session_secret)/);
    assert.doesNotMatch(step, /echo[^\n]*\$(LOCAL_API_POSTGRES_PASSWORD|LOCAL_API_SESSION_SECRET)/);
  });

  it('guards stack ports against CI service and image-smoke ports', () => {
    assert.match(step, /stack_db_port=5444/);
    assert.match(step, /stack_redis_port=6390/);
    assert.match(step, /stack_api_port=3012/);
    assert.match(step, /for reserved in 5434 6380 3002/);
    assert.match(step, /collides with reserved CI port/);
  });

  it('never enables fixture mode, OTP, or auth bypass in the lifecycle step', () => {
    assert.doesNotMatch(step, /AUTH_DEV_BYPASS/);
    assert.doesNotMatch(step, /AUTH_DEV_OTP/);
    assert.doesNotMatch(step, /FIXTURE_MODE/);
  });
});
