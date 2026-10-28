import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectScheduledGtfsCandidatePool, type ScheduledGtfsProjectionInput } from '../server/journey/scheduledGtfsCandidatePool';
import { scoreJourneys, selectStrategyRecommendations, strategiesWithComparablePrices } from '../server/journey/scoring';

function itinerary(input: {
  id: string;
  providerId: string;
  routeId: string;
  departureAt: string;
  arrivalAt: string;
  durationSeconds: number;
  priceMinor: number | null;
  currency?: string;
}): ScheduledGtfsProjectionInput {
  return {
    id: input.id,
    durationSeconds: input.durationSeconds,
    fare: input.priceMinor === null ? null : {
      priceMinor: input.priceMinor,
      currency: input.currency ?? 'UAH',
      allocations: [],
      source: 'gtfs-v1',
    },
    transfers: 0,
    walkingMeters: 0,
    transferWalkingMeters: [],
    departureAt: new Date(input.departureAt),
    arrivalAt: new Date(input.arrivalAt),
    segments: [{
      providerId: input.providerId,
      routeId: input.routeId,
      mode: 'BUS',
      distanceToOriginStopMeters: 0,
      distanceFromDestinationStopMeters: 0,
    }],
  };
}

describe('scheduled GTFS API candidate projection', () => {
  it('projects aggregated provider itineraries before the cap and retains strategy winners', () => {
    const kyivTrips = Array.from({ length: 100 }, (_, index) => {
      const arrival = new Date(Date.parse('2026-10-28T08:40:00Z') + index * 10_000);
      return itinerary({
        id: `kyiv-${index}`, providerId: 'provider-ua', routeId: 'urban-1',
        departureAt: new Date(arrival.getTime() - 2_400_000).toISOString(),
        arrivalAt: arrival.toISOString(), durationSeconds: 2400, priceMinor: 2500,
      });
    });
    const warsawTrips = [
      itinerary({
        id: 'warsaw-express', providerId: 'provider-pl', routeId: 'express-7',
        departureAt: '2026-10-28T08:50:00Z', arrivalAt: '2026-10-28T09:00:00Z',
        durationSeconds: 600, priceMinor: 1500,
      }),
      itinerary({
        id: 'warsaw-cheap', providerId: 'provider-pl', routeId: 'regional-2',
        departureAt: '2026-10-28T08:00:00Z', arrivalAt: '2026-10-28T09:05:00Z',
        durationSeconds: 3900, priceMinor: 300,
      }),
      itinerary({
        id: 'warsaw-unpriced', providerId: 'provider-pl', routeId: 'regional-3',
        departureAt: '2026-10-28T08:00:00Z', arrivalAt: '2026-10-28T09:06:00Z',
        durationSeconds: 3960, priceMinor: null,
      }),
    ];
    // The GTFS timetable engine has already converted each provider's local timezone
    // to absolute Date values; this is the same merged array passed by the API.
    const mergedProviderGroups = new Map<string, ScheduledGtfsProjectionInput[]>([
      ['Europe/Kyiv', kyivTrips],
      ['Europe/Warsaw', warsawTrips],
    ]);
    const merged = [...mergedProviderGroups.values()].flat();
    const priced = merged.filter((candidate) => candidate.fare !== null);
    const pool = projectScheduledGtfsCandidatePool(merged, 100, ['BALANCED', 'FASTEST', 'CHEAPEST']);
    const pricedPool = projectScheduledGtfsCandidatePool(priced, 100, ['BALANCED', 'FASTEST', 'CHEAPEST']);
    const completePool = projectScheduledGtfsCandidatePool(merged, merged.length, ['BALANCED', 'FASTEST', 'CHEAPEST']);
    const completePricedPool = projectScheduledGtfsCandidatePool(priced, priced.length, ['BALANCED', 'FASTEST', 'CHEAPEST']);

    assert.equal(merged.length, 103);
    assert.equal(pool.truncated, true);
    assert.equal(pool.candidates.length, 100);
    assert.equal(pool.candidates[0].id, 'kyiv-0', 'the bounded result is ordered by absolute UTC arrival');
    assert.ok(pool.candidates.some(({ id }) => id === 'warsaw-express'));
    assert.ok(pricedPool.candidates.some(({ id }) => id === 'warsaw-cheap'));
    assert.equal(pool.hasUnknownFare, true);
    assert.deepEqual(
      strategiesWithComparablePrices(pool.candidates, ['BALANCED', 'FASTEST', 'CHEAPEST'])
        .filter((strategy) => strategy !== 'CHEAPEST' || !pool.hasUnknownFare),
      ['BALANCED', 'FASTEST'],
    );

    for (const strategy of ['BALANCED', 'FASTEST'] as const) {
      assert.equal(
        scoreJourneys(pool.candidates, strategy)[0]?.journey.id,
        scoreJourneys(completePool.candidates, strategy)[0]?.journey.id,
        `${strategy} winner should match the complete fixture`,
      );
    }
    assert.deepEqual(
      selectStrategyRecommendations(pricedPool.candidates, ['CHEAPEST']).map(({ journey }) => journey.id),
      selectStrategyRecommendations(completePricedPool.candidates, ['CHEAPEST']).map(({ journey }) => journey.id),
      'CHEAPEST winner should match when every fare is known',
    );
    assert.equal(pool.candidates.find(({ id }) => id === 'warsaw-express')?.diversityKey, 'transit:provider-pl:express-7');
  });

  it('treats a non-UAH price as unpriced instead of comparing currencies as if equivalent', () => {
    const nonUah = itinerary({
      id: 'pln-fare', providerId: 'provider-pl', routeId: 'rail-1',
      departureAt: '2026-10-28T08:00:00Z', arrivalAt: '2026-10-28T09:00:00Z',
      durationSeconds: 3600, priceMinor: 500, currency: 'PLN',
    });
    const pool = projectScheduledGtfsCandidatePool([nonUah], 100, ['BALANCED', 'CHEAPEST']);
    assert.equal(pool.candidates[0].priceMinor, null);
    assert.equal(pool.hasUnknownFare, true);
  });

  it('uses a stable id tie-breaker when UTC arrival and departure times collide', () => {
    const sameTime = {
      departureAt: '2026-10-28T08:00:00Z', arrivalAt: '2026-10-28T09:00:00Z',
      durationSeconds: 3600, priceMinor: 1000,
    };
    const pool = projectScheduledGtfsCandidatePool([
      itinerary({ ...sameTime, id: 'z-route', providerId: 'provider-z', routeId: 'z' }),
      itinerary({ ...sameTime, id: 'a-route', providerId: 'provider-a', routeId: 'a' }),
    ], 1, ['BALANCED', 'FASTEST']);

    assert.deepEqual(pool.candidates.map(({ id }) => id), ['a-route']);
    assert.equal(pool.truncated, true);
  });
});
