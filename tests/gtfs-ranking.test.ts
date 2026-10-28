import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toRankedGtfsItinerary } from '../server/journey/gtfsRanking';
import type { GtfsItinerary } from '../server/journey/gtfsTimetable';

function itinerary(overrides: Partial<GtfsItinerary> = {}): GtfsItinerary {
  return {
    id: 'lviv:trip-a>trip-b',
    providerId: 'lviv-open-data',
    providerName: 'Lviv public transit',
    departureAt: new Date('2026-10-23T05:03:00Z'),
    arrivalAt: new Date('2026-10-23T06:07:00Z'),
    durationSeconds: 4_020,
    waitingSeconds: 180,
    transfers: 1,
    walkingMeters: 989,
    transferWalkingMeters: [0],
    transferWalkingSeconds: [0],
    transferWalkingGeometries: [null],
    transferInSeat: [false],
    transferMinimumBufferSeconds: [180],
    transferRuleMinimumSeconds: [null],
    fare: { currency: 'UAH', priceMinor: 2_300 } as GtfsItinerary['fare'],
    segments: [
      { providerId: 'lviv-open-data', routeId: 'a09', mode: 'BUS', distanceToOriginStopMeters: 154,
        distanceFromDestinationStopMeters: 0 } as GtfsItinerary['segments'][number],
      { providerId: 'lviv-open-data', routeId: 'a08a', mode: 'BUS', distanceToOriginStopMeters: 0,
        distanceFromDestinationStopMeters: 835 } as GtfsItinerary['segments'][number],
    ],
    ...overrides,
  };
}

describe('GTFS journey ranking projection', () => {
  it('preserves production ranking metrics and access, transfer, and egress modes', () => {
    const ranked = toRankedGtfsItinerary(itinerary());

    assert.equal(ranked.durationSeconds, 4_020);
    assert.equal(ranked.priceMinor, 2_300);
    assert.equal(ranked.transfers, 1);
    assert.equal(ranked.walkingMeters, 989);
    assert.equal(ranked.transferRisk, 0.3);
    assert.equal(ranked.diversityKey, 'transit:lviv-open-data:a09>lviv-open-data:a08a');
    assert.deepEqual(ranked.legs, [
      { mode: 'WALK' }, { mode: 'BUS', providerId: 'lviv-open-data' },
      { mode: 'BUS', providerId: 'lviv-open-data' }, { mode: 'WALK' },
    ]);
    assert.equal(ranked.itinerary.id, 'lviv:trip-a>trip-b');
  });

  it('keeps missing fares incomparable and does not create a walking leg for zero distance', () => {
    const ranked = toRankedGtfsItinerary(itinerary({
      fare: null,
      transfers: 0,
      walkingMeters: 0,
      transferWalkingMeters: [],
      segments: [{ providerId: 'lviv-open-data', routeId: 'a09', mode: 'BUS',
        distanceToOriginStopMeters: 0, distanceFromDestinationStopMeters: 0 } as GtfsItinerary['segments'][number]],
    }));

    assert.equal(ranked.priceMinor, null);
    assert.equal(ranked.transferRisk, 0);
    assert.deepEqual(ranked.legs, [{ mode: 'BUS', providerId: 'lviv-open-data' }]);
  });
});
