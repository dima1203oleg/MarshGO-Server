import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('feed registry generator honesty contract', () => {
  const currentDir = fileURLToPath(new URL('.', import.meta.url));
  const scriptPath = resolve(currentDir, '../scripts/build-transport-registry.ts');
  const scriptContent = readFileSync(scriptPath, 'utf8');

  it('contains zero hardcoded supplementary probe mocks or hardcoded responseMs maps', () => {
    // Assert no hardcoded supplementaryProbe dictionary remains
    assert.ok(!scriptContent.includes('const supplementaryProbe'), 'must not contain supplementaryProbe');
    assert.ok(!scriptContent.includes('supplementaryProbe['), 'must not index supplementaryProbe');

    // Assert no mock/static responseMs values like 19911 or 19686 are hardcoded in the generator
    assert.ok(!/responseMs:\s*19911/.test(scriptContent), 'must not contain mock responseMs 19911');
    assert.ok(!/responseMs:\s*19686/.test(scriptContent), 'must not contain mock responseMs 19686');
    assert.ok(!/responseMs:\s*19675/.test(scriptContent), 'must not contain mock responseMs 19675');
    assert.ok(!/responseMs:\s*19378/.test(scriptContent), 'must not contain mock responseMs 19378');
  });

  it('negative control: detects when hardcoded supplementary mocks are reintroduced', () => {
    const fakeMockScript = 'const supplementaryProbe = { "mock": { responseMs: 19911 } };';
    assert.ok(fakeMockScript.includes('const supplementaryProbe'));
    assert.ok(/responseMs:\s*19911/.test(fakeMockScript));
  });

  it('reads all probe measurements from probe artifact or flags', () => {
    assert.ok(scriptContent.includes('probeFromRun(probePath)'));
    assert.ok(scriptContent.includes('probeRun.byName[entry.name]'));
  });
});
