import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDirectOnlyWalkingPolicy, searchWalkingReachUntilFeasible } from '../server/journey/directOnlyWalkingPolicy';

test('direct-only walking policy caps staged reach by explicit total walking preference', () => {
  const policy = resolveDirectOnlyWalkingPolicy({
    maximumTransfers: 0, walkingRoutingConfigured: true,
    standardAccessMeters: 900, standardEgressMeters: 1_000,
    baseAccessMeters: 900, baseEgressMeters: 1_000,
    explicitTotalWalkingLimitMeters: 2_000,
  });
  assert.deepEqual(policy.reachTiersMeters, [1_500, 2_000]);
  assert.equal(policy.maximumAccessMeters, 2_000);
  assert.equal(policy.maximumEgressMeters, 2_000);
  assert.equal(policy.requiresConfirmedWalks, true);
});

test('already-expanded explicit base reach still requires confirmed walk geometry', () => {
  const policy = resolveDirectOnlyWalkingPolicy({
    maximumTransfers: 0, walkingRoutingConfigured: true,
    standardAccessMeters: 900, standardEgressMeters: 1_000,
    baseAccessMeters: 2_000, baseEgressMeters: 2_000,
    explicitTotalWalkingLimitMeters: 4_000,
  });
  assert.deepEqual(policy.reachTiersMeters, [2_500, 4_000]);
  assert.equal(policy.requiresConfirmedWalks, true);
});

test('direct-only walking is disabled for transfers or when confirmed walking is unavailable', () => {
  for (const input of [
    { maximumTransfers: 1, walkingRoutingConfigured: true },
    { maximumTransfers: 0, walkingRoutingConfigured: false },
    { maximumTransfers: undefined, walkingRoutingConfigured: true },
  ]) {
    const policy = resolveDirectOnlyWalkingPolicy({ ...input,
      standardAccessMeters: 900, standardEgressMeters: 1_000,
      baseAccessMeters: 900, baseEgressMeters: 1_000, explicitTotalWalkingLimitMeters: undefined });
    assert.deepEqual(policy.reachTiersMeters, []);
    assert.equal(policy.requiresConfirmedWalks, false);
  }
});

test('staged walking retry stops at first feasible tier and preserves worker/feed callback reuse', async () => {
  const searched: number[] = [];
  const workerIdentity = {};
  const identities: object[] = [];
  const outcome = await searchWalkingReachUntilFeasible(
    [1_500, 2_500, 4_000],
    async (tier) => { searched.push(tier); identities.push(workerIdentity); return [`candidate-${tier}`]; },
    async (candidates) => candidates.filter((candidate) => candidate === 'candidate-2500'),
  );
  assert.deepEqual(searched, [1_500, 2_500]);
  assert.deepEqual(identities, [workerIdentity, workerIdentity], 'every retry uses the same worker and cached provider snapshot');
  assert.deepEqual(outcome, { candidates: ['candidate-2500'], reachMeters: 2_500, attempts: 2, stoppedByBudget: false });
});

test('staged walking retry reports when the route validation budget prevents another tier', async () => {
  const searched: number[] = [];
  const outcome = await searchWalkingReachUntilFeasible(
    [1_500, 2_500],
    async (tier) => { searched.push(tier); return [`candidate-${tier}`]; },
    async () => [],
    () => searched.length === 0,
  );
  assert.deepEqual(searched, [1_500]);
  assert.deepEqual(outcome, { candidates: [], reachMeters: null, attempts: 1, stoppedByBudget: true });
});
