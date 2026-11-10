import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleGtfsRouteChainCandidates, selectGtfsCandidatesForCrossProviderSearch } from '../server/journey/gtfsTimetable';
import { scoreJourneys } from '../server/journey/scoring';
import type { GtfsDirectJourney, GtfsItinerary, GtfsTransportType } from '../server/journey/gtfsTimetable';

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
    cashFare: null,
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

test('cross-provider sampling keeps canonical mode coverage and mixed-mode chain witnesses beside the three strategy winners', () => {
  const typed = (id: string, duration: number, price: number, types: GtfsTransportType[], transfers = 0, walking = 0) => {
    const itinerary = makeCandidate(id, duration, transfers, walking, price);
    // This sampler only reads transportType; a focused cast keeps the fixture small
    // without manufacturing irrelevant timetable stop/shape data.
    itinerary.segments = types.map((transportType) => ({ transportType } as GtfsDirectJourney));
    return itinerary;
  };
  const modeWitnesses: GtfsItinerary[] = [
    typed('mode-marshrutka', 5_000, 21_400, ['marshrutka'], 1, 500),
    typed('mode-trolleybus', 5_100, 21_500, ['trolleybus'], 1, 520),
    typed('mode-tram', 5_200, 21_600, ['tram'], 1, 540),
    typed('mode-metro', 5_300, 21_700, ['metro'], 1, 560),
    typed('mode-train', 5_400, 21_800, ['train'], 1, 580),
    typed('mode-mixed-bus-tram', 4_900, 21_300, ['bus', 'tram'], 1, 450),
    typed('mode-mixed-tram-trolley', 4_850, 21_250, ['tram', 'trolleybus'], 1, 440),
  ];
  const busCrowd = Array.from({ length: 45 }, (_, index) =>
    typed(`bus-crowd-${String(index).padStart(2, '0')}`, 1_000 + index * 80, 2_000 + index * 30,
      ['bus'], index % 3, (index % 7) * 100));
  const all = [...modeWitnesses, ...busCrowd];
  const toJourneyOption = (itinerary: GtfsItinerary) => ({
    id: itinerary.id,
    durationSeconds: itinerary.durationSeconds,
    priceMinor: itinerary.fare?.currency === 'UAH' ? itinerary.fare.priceMinor : null,
    transfers: itinerary.transfers,
    walkingMeters: itinerary.walkingMeters,
    reliability: null,
    transferRisk: itinerary.transfers > 0 ? 0.3 : 0,
    comfort: null,
    legs: [],
  });
  const scored = all.map(toJourneyOption);
  const winners = new Set((['FASTEST', 'CHEAPEST', 'BALANCED'] as const)
    .map((strategy) => scoreJourneys(scored, strategy)[0]!.journey.id));

  const sampled = selectGtfsCandidatesForCrossProviderSearch(all, 30).map((item) => item.id);
  assert.equal(sampled.length, 30, 'the sampler must stay within the configured request budget');
  for (const winner of winners) {
    assert.ok(sampled.includes(winner), `${winner} must survive the bounded pool for its strategy`);
  }
  for (const category of ['bus', 'marshrutka', 'trolleybus', 'tram', 'metro', 'train'] as const) {
    assert.ok(all.some((item) => item.segments.some((segment) => segment.transportType === category)
      && sampled.includes(item.id)), `${category} must retain a candidate when its source supplied one`);
  }
  assert.ok(sampled.includes('mode-mixed-bus-tram') || sampled.includes('mode-mixed-tram-trolley'),
    'a distinct multimodal category chain must survive when the bounded sample has capacity');
});
