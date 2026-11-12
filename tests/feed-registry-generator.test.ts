import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ukraineCatalog } from '../server/mobility/ukraineCatalog';

const require = createRequire(import.meta.url);
interface GeneratedRegistry {
  databaseSnapshot: null;
  inventory: { probeResultRows: number; datedMeasurementRows: number; feedsWithLivePositions: number; verifiedRouting: string };
  sources: { provenance: string; artifactReportedAt: string };
  feeds: { name: string; capabilities: Record<string, string>; productUse: { routing: string; runtimeEligibility: string };
    probe: { state: string; measurementAt: string | null; skipReason: string | null; reportedCounts: Record<string, number> } }[];
}
const liveName = ukraineCatalog.find((entry) => entry.sourceType === 'gtfs_rt')!.name;
const staticName = ukraineCatalog.find((entry) => entry.sourceType === 'gtfs')!.name;
const measuredAt = '2026-11-11T19:00:00Z';

function generate(raw: object, source?: string) {
  const script = source ?? readFileSync(new URL('../scripts/build-transport-registry.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(script.replace('import.meta.dirname!', '__dirname'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const outputs = new Map<string, string>();
  runInNewContext(compiled, {
    exports: {}, __dirname: '/fixture/scripts', process: { argv: ['node', 'generator', '--probe', '/fixture/probe.json'] },
    console: { log: () => undefined },
    require: (id: string) => id === 'node:fs' ? {
      readFileSync: () => JSON.stringify(raw), mkdirSync: () => undefined,
      writeFileSync: (path: string, content: string) => outputs.set(path, content),
    } : require(id),
  });
  return {
    registry: JSON.parse(outputs.get('/fixture/TRANSPORT_PROVIDER_REGISTRY.json')!) as GeneratedRegistry,
    matrix: outputs.get('/fixture/docs/TRANSPORT_COVERAGE_MATRIX.md')!,
    audit: outputs.get('/fixture/docs/TRANSPORT_FEED_AUDIT.md')!,
  };
}

function liveProbe(counts: Record<string, number | undefined>, state = 'HEALTHY') {
  return { checkedAt: measuredAt, catalog: [{ name: liveName, state, counts }] };
}

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

  it('exposes a canonical full-catalog probe and does not describe the legacy subset as acceptance', () => {
    const packageJson = JSON.parse(readFileSync(resolve(currentDir, '../package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const smokeScript = readFileSync(resolve(currentDir, '../scripts/transport-feed-smoke.ts'), 'utf8');
    assert.equal(packageJson.scripts?.['acceptance:transport-feeds'], 'tsx scripts/transport-feed-smoke.ts --scope=all');
    assert.ok(smokeScript.includes('ukraineCatalogWave3'), 'full-catalog smoke must include the latest provider wave');
    assert.ok(smokeScript.includes('kyivOpenDataCatalog'), 'full-catalog smoke must include Kyiv open-data feeds');
    assert.match(smokeScript, /const checkedResults = results\.filter\(\(row\) => row\.state !== 'SKIPPED'\)/);
    assert.match(smokeScript, /providerSourcesProbed: checkedResults\.length/,
      'the probe count must exclude policy-skipped sources');
    assert.ok(scriptContent.includes('npm run acceptance:transport-feeds'));
    assert.ok(!scriptContent.includes('silently misses 9 canonical ones'));
  });

  it('does not count policy-skipped or absent rows as probes', () => {
    const { registry } = generate({ checkedAt: measuredAt, catalog: [{ name: liveName, state: 'SKIPPED', reason: 'license_unverified' }] });
    assert.equal(registry.inventory.probeResultRows, 0);
    assert.equal(registry.inventory.datedMeasurementRows, 0);
    const feed = registry.feeds.find((row) => row.name === liveName)!;
    assert.equal(feed.probe.skipReason, 'license_unverified');
    assert.equal(feed.capabilities.livePositions, 'NOT_MEASURED');
  });

  it('keeps undated database reports diagnostic despite a recent monitor timestamp', () => {
    const raw = { ...liveProbe({ vehicles: 3, freshVehiclePositions: 3, ageSeconds: 1 }), source: 'SELECT-only mobility_providers.last_report after mobility:seed' };
    const { registry } = generate(raw);
    assert.equal(registry.sources.provenance, raw.source);
    assert.equal(registry.inventory.probeResultRows, 1);
    assert.equal(registry.inventory.datedMeasurementRows, 0);
    assert.equal(registry.inventory.feedsWithLivePositions, 0);
    assert.equal(registry.feeds.find((row) => row.name === liveName)!.probe.reportedCounts.vehicles, 3);
    assert.equal(registry.databaseSnapshot, null);
  });

  it('never infers fresh positions from stale, future or missing timestamps', () => {
    for (const counts of [
      { vehicles: 3, freshVehiclePositions: 0, ageSeconds: 300 },
      { vehicles: 3, freshVehiclePositions: 3, ageSeconds: -600 },
      { vehicles: 3, ageSeconds: 1 },
      { vehicles: 3, freshVehiclePositions: 3 },
    ]) {
      const { registry } = generate(liveProbe(counts));
      assert.equal(registry.inventory.feedsWithLivePositions, 0);
    }
  });

  it('keeps positive and empty measurements distinct from unavailable or missing evidence', () => {
    assert.equal(generate(liveProbe({ vehicles: 3, freshVehiclePositions: 2, ageSeconds: 1 })).registry.inventory.feedsWithLivePositions, 1);
    const offline = generate(liveProbe({ vehicles: 3, freshVehiclePositions: 3, ageSeconds: 1 }, 'OFFLINE')).registry;
    assert.equal(offline.feeds.find((row) => row.name === liveName)!.capabilities.livePositions, 'UNAVAILABLE');
    const empty = generate(liveProbe({ vehicles: 0, ageSeconds: 1 })).registry;
    assert.equal(empty.feeds.find((row) => row.name === liveName)!.capabilities.livePositions, 'EMPTY');
    const missing = generate({ catalog: [] }).registry;
    assert.equal(missing.feeds.find((row) => row.name === liveName)!.capabilities.livePositions, 'NOT_MEASURED');
  });

  it('does not infer current timetables, product activation or routes from a parsed archive', () => {
    const { registry } = generate({ checkedAt: measuredAt, catalog: [{ name: staticName, state: 'DEGRADED', counts: { stops: 3, routes: 1, trips: 2 }, checks: [{ name: 'Scheduled service in next 7 days', ok: false }] }] });
    const feed = registry.feeds.find((row) => row.name === staticName)!;
    assert.equal(feed.capabilities.staticNetwork, 'VERIFIED');
    assert.equal(feed.capabilities.timetables, 'NOT_MEASURED');
    assert.equal(feed.productUse.runtimeEligibility, 'NOT_MEASURED');
    assert.equal(feed.productUse.routing, 'NOT_MEASURED');
  });

  it('does not classify unknown vehicles as buses or mixed-freshness counts by mode', () => {
    const unknown = generate(liveProbe({ vehicles: 3, freshVehiclePositions: 3, ageSeconds: 1 }));
    assert.match(unknown.matrix, /Автобуси \| NOT_MEASURED \| NOT_MEASURED \| NOT_MEASURED/);
    const typed = generate(liveProbe({ vehicles: 3, vehicles_trolleybus: 3, freshVehiclePositions: 3, ageSeconds: 1 }));
    assert.match(typed.matrix, /Тролейбуси \| NOT_MEASURED \| NOT_MEASURED \| Львів/);
    assert.match(typed.matrix, /Автобуси \| NOT_MEASURED \| NOT_MEASURED \| NOT_MEASURED/);
    const mixed = generate(liveProbe({ vehicles: 3, vehicles_trolleybus: 3, freshVehiclePositions: 1, ageSeconds: 1 }));
    assert.match(mixed.matrix, /Тролейбуси \| NOT_MEASURED \| NOT_MEASURED \| NOT_MEASURED/);
  });

  it('does not invent DB counts, route successes or nationwide coverage for empty input', () => {
    const output = generate({ catalog: [] });
    assert.equal(output.registry.inventory.feedsWithLivePositions, 0);
    assert.equal(output.registry.databaseSnapshot, null);
    assert.doesNotMatch(output.audit + output.matrix, /14 vehicles|998 vehicles|6 of 12|А47→Т08|317/);
    assert.ok(output.registry.feeds.every((feed) => Object.values(feed.capabilities).every((value) => !value.startsWith('VERIFIED'))));
  });

  it('negative control catches the former positive-count live classification', () => {
    const mutant = scriptContent.replace("freshHeader && (counts.freshVehiclePositions ?? 0) > 0 ? 'VERIFIED_LIVE'", "(counts.vehicles ?? 0) > 0 ? 'VERIFIED_LIVE'");
    assert.notEqual(mutant, scriptContent);
    const { registry } = generate(liveProbe({ vehicles: 3, freshVehiclePositions: 0, ageSeconds: -600 }), mutant);
    assert.throws(() => assert.equal(registry.inventory.feedsWithLivePositions, 0));
  });
});
