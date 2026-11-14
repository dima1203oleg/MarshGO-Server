import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('./qr-attestation-characterization.integration.test.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

async function inspectGuard(env: Record<string, string | undefined>) {
  const requests: string[] = [];
  const suites: { skip: boolean | string }[] = [];
  await runInNewContext(`(async () => { ${compiled} })()`, {
    exports: {}, process: { env }, URL, AbortSignal,
    fetch: async (url: string) => { requests.push(url); return { ok: true }; },
    require: (id: string) => {
      if (id === 'node:test') return { describe: (_name: string, options: { skip: boolean | string }) => suites.push(options) };
      if (id === 'pg') return { Pool: class { constructor() { throw new Error('No database work permitted'); } } };
      return require(id);
    },
  });
  return { requests, suites };
}

for (const env of [{}, { API_TEST_URL: 'http://127.0.0.1:3302' }, { API_TEST_DATABASE_URL: 'postgres://127.0.0.1/marshgo_e2e_fixture' }]) {
  test(`QR integration stays offline without both explicit targets: ${Object.keys(env).join(',') || 'empty environment'}`, async () => {
    const result = await inspectGuard(env);
    assert.deepEqual(result.requests, []);
    assert.equal(result.suites.length, 1);
    assert.ok(result.suites[0].skip);
  });
}

test('QR integration probes only its explicitly supplied disposable target', async () => {
  const result = await inspectGuard({ API_TEST_URL: 'http://127.0.0.1:3302', API_TEST_DATABASE_URL: 'postgres://127.0.0.1/marshgo_e2e_fixture' });
  assert.deepEqual(result.requests, ['http://127.0.0.1:3302/healthz']);
  assert.equal(result.suites[0].skip, false);
});

test('QR integration rejects a non-disposable database and non-loopback API before probing', async () => {
  await assert.rejects(inspectGuard({ API_TEST_URL: 'http://127.0.0.1:3302', API_TEST_DATABASE_URL: 'postgres://127.0.0.1/marshgo' }), /disposable/);
  await assert.rejects(inspectGuard({ API_TEST_URL: 'https://example.test', API_TEST_DATABASE_URL: 'postgres://127.0.0.1/marshgo_e2e_fixture' }), /loopback/);
});
