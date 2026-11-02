import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleGtfsRouteChainCandidates } from '../server/journey/gtfsTimetable';
import { scoreJourneys } from '../server/journey/scoring';
import type { GtfsItinerary } from '../server/journey/gtfsTimetable';

function makeCandidate(
  id: string,
  durationSeconds: number,
  transfers: number,
  walkingMeters: number,
  priceMinor: number,
): GtfsItinerary {
  return {
    id,
    providerId: 'provider-test',
    providerName: 'Test Transit',
    segments: [],
    departureAt: new Date('2026-10-12T08:00:00Z'),
    arrivalAt: new Date(Date.parse('2026-10-12T08:00:00Z') + durationSeconds * 1000),
    durationSeconds,
    waitingSeconds: 0,
    transfers,
    walkingMeters,
    transferWalkingMeters: [],
    transferWalkingSeconds: [],
    transferWalkingGeometries: [],
    transferInSeat: [],
    transferMinimumBufferSeconds: [],
    transferRuleMinimumSeconds: [],
    fare: {
      priceMinor,
      currency: 'UAH',
      allocations: [],
      source: 'gtfs-v1' as const,
    },
  };
}

test('adversarial route-chain candidate sampling preserves objective witnesses across batch and incremental selection', () => {
  // Construct a deterministic candidate set with five distinct objective witnesses
  // and near-competitive decoys so all eight sample slots are contested.
  const candidates: GtfsItinerary[] = [
    makeCandidate('witness-fastest', 900, 3, 1500, 800),
    makeCandidate('decoy-fastest', 950, 3, 1500, 820),
    makeCandidate('witness-cheapest', 4000, 2, 800, 50),
    makeCandidate('decoy-cheapest', 4050, 2, 800, 60),
    makeCandidate('witness-transfers', 3500, 0, 1200, 900),
    makeCandidate('decoy-transfers', 3600, 0, 1250, 920),
    makeCandidate('witness-walking', 3800, 3, 0, 950),
    makeCandidate('decoy-walking', 3850, 3, 15, 960),
    makeCandidate('witness-balanced', 1600, 1, 200, 250),
    makeCandidate('decoy-balanced', 1650, 1, 220, 270),
    makeCandidate('decoy-duration-2', 1000, 2, 1400, 750),
    makeCandidate('decoy-fare-2', 4100, 2, 700, 80),
    makeCandidate('decoy-transfers-2', 3700, 0, 1300, 880),
    makeCandidate('decoy-walking-2', 3900, 3, 30, 900),
    makeCandidate('decoy-balanced-2', 1700, 1, 250, 290),
    makeCandidate('filler-high-extreme', 5000, 4, 2000, 1200),
  ];

  // Evaluate candidate scores on the full set
  const scored = candidates.map((item) => ({
    id: item.id,
    durationSeconds: item.durationSeconds,
    priceMinor: item.fare?.currency === 'UAH' ? item.fare.priceMinor : null,
    transfers: item.transfers,
    walkingMeters: item.walkingMeters,
    reliability: null,
    transferRisk: item.transfers > 0 ? 0.3 : 0,
    comfort: null,
    legs: [],
  }));

  const fastestWinner = scoreJourneys(scored, 'FASTEST')[0]!.journey.id;
  const cheapestWinner = scoreJourneys(scored, 'CHEAPEST')[0]!.journey.id;
  const balancedWinner = scoreJourneys(scored, 'BALANCED')[0]!.journey.id;
  const fewestTransfersWinner = [...candidates].sort(
    (a, b) => a.transfers - b.transfers || a.durationSeconds - b.durationSeconds || a.id.localeCompare(b.id),
  )[0]!.id;
  const leastWalkingWinner = [...candidates].sort(
    (a, b) => a.walkingMeters - b.walkingMeters || a.durationSeconds - b.durationSeconds || a.id.localeCompare(b.id),
  )[0]!.id;

  // Ensure the fixture proves the five objective winners are distinct before sampling
  assert.equal(fastestWinner, 'witness-fastest');
  assert.equal(cheapestWinner, 'witness-cheapest');
  assert.equal(balancedWinner, 'witness-balanced');
  assert.equal(fewestTransfersWinner, 'witness-transfers');
  assert.equal(leastWalkingWinner, 'witness-walking');

  const objectiveWitnesses = new Set([
    fastestWinner,
    cheapestWinner,
    balancedWinner,
    fewestTransfersWinner,
    leastWalkingWinner,
  ]);
  assert.equal(objectiveWitnesses.size, 5, 'the fixture must prove five distinct objective winners before sampling');

  // Verify batch selection fills all 8 slots and retains all five witnesses
  const batchSelected = sampleGtfsRouteChainCandidates(candidates, 8);
  assert.equal(batchSelected.length, 8, 'batch selection must contest and fill all eight sample slots');
  for (const witnessId of objectiveWitnesses) {
    assert.ok(
      batchSelected.some((item) => item.id === witnessId),
      `batch selection must retain objective witness ${witnessId}`,
    );
  }

  // Incremental streaming selection helper
  const runIncremental = (order: readonly GtfsItinerary[]): GtfsItinerary[] => {
    let retained: GtfsItinerary[] = [];
    for (const item of order) {
      retained = sampleGtfsRouteChainCandidates([...retained, item], 8);
    }
    return retained;
  };

  // Small bounded set of deterministic arrival orders:
  // 1. Natural forward order
  // 2. Reversed order
  // 3. Cyclic shifts across candidate offsets
  // 4. Adversarial order: witnesses first, followed by near-competitive decoys and extremes
  // 5. Adversarial order: decoys first, followed by witnesses and extremes
  const arrivalOrders: Array<{ label: string; order: GtfsItinerary[] }> = [
    { label: 'natural order', order: [...candidates] },
    { label: 'reversed order', order: [...candidates].reverse() },
    ...Array.from({ length: candidates.length }, (_, offset) => ({
      label: `cyclic shift offset ${offset}`,
      order: candidates.map((_, i) => candidates[(i + offset) % candidates.length]!),
    })),
    {
      label: 'witnesses first, then decoys, then extremes',
      order: [
        ...candidates.filter((c) => objectiveWitnesses.has(c.id)),
        ...candidates.filter((c) => !objectiveWitnesses.has(c.id)),
      ],
    },
    {
      label: 'decoys first, then witnesses, then extremes',
      order: [
        ...candidates.filter((c) => !objectiveWitnesses.has(c.id) && c.id !== 'filler-high-extreme'),
        ...candidates.filter((c) => objectiveWitnesses.has(c.id)),
        candidates.find((c) => c.id === 'filler-high-extreme')!,
      ],
    },
  ];

  for (const { label, order } of arrivalOrders) {
    const incrementalRetained = runIncremental(order);
    assert.equal(incrementalRetained.length, 8, `${label} must retain 8 candidates`);
    for (const witnessId of objectiveWitnesses) {
      assert.ok(
        incrementalRetained.some((item) => item.id === witnessId),
        `incremental selection under ${label} must retain objective witness ${witnessId}`,
      );
    }
  }
});
