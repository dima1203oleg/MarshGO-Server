import test from 'node:test';
import assert from 'node:assert/strict';
import { boardingDepartureBounds, serviceDateDepartureWindow, tripInstanceCannotDepartInWindow, visitTripInstanceLegs } from '../server/journey/gtfsTimetable';
import type { EligibleTripInstanceStopEvent } from '../server/journey/gtfsTimetable';

type Stop = { pickupType: number; departureSeconds: number };

const utc = (date: string, seconds: number) => new Date(Date.parse(`${date}T00:00:00.000Z`) + seconds * 1000);

test('boarding bounds ignore the last eligible stop and non-boarding stops', () => {
  const stops: Stop[] = [
    { pickupType: 0, departureSeconds: 36_000 },
    { pickupType: 2, departureSeconds: 42_000 },
    { pickupType: 0, departureSeconds: 48_000 },
    { pickupType: 0, departureSeconds: 54_000 },
  ];
  // Index 3 is the final eligible stop: visitTripInstanceLegs never boards there, and index 1 needs a phone call.
  assert.deepEqual(boardingDepartureBounds(stops, [0, 1, 2, 3]), { firstDepartureSeconds: 36_000, lastDepartureSeconds: 48_000 });
});

test('boarding bounds take the extremes, not the order, so loop routes stay correct', () => {
  const stops: Stop[] = [
    { pickupType: 0, departureSeconds: 7_200 },
    { pickupType: 0, departureSeconds: 5_400 },
    { pickupType: 0, departureSeconds: 9_000 },
    { pickupType: 0, departureSeconds: 600 },
  ];
  assert.deepEqual(boardingDepartureBounds(stops, [0, 1, 2, 3]), { firstDepartureSeconds: 5_400, lastDepartureSeconds: 9_000 });
});

test('an instance with nothing to board has no bounds at all', () => {
  const stops: Stop[] = [
    { pickupType: 1, departureSeconds: 36_000 },
    { pickupType: 0, departureSeconds: 42_000 },
  ];
  assert.equal(boardingDepartureBounds(stops, [0, 1]), null);
  assert.equal(tripInstanceCannotDepartInWindow(null, serviceDateDepartureWindow('2026-11-05', utc,
    new Date('2026-11-05T00:00:00Z'), new Date('2026-11-05T23:59:59Z'))), true);
});

test('window pruning compares the instance extremes against the journey window', () => {
  const bounds = { firstDepartureSeconds: 36_000, lastDepartureSeconds: 48_000 };
  const day = '2026-11-05';
  assert.equal(tripInstanceCannotDepartInWindow(bounds, serviceDateDepartureWindow(day, utc,
    new Date(`${day}T14:00:00Z`), new Date(`${day}T20:00:00Z`))), true, 'departs before the window opens');
  assert.equal(tripInstanceCannotDepartInWindow(bounds, serviceDateDepartureWindow(day, utc,
    new Date(`${day}T06:00:00Z`), new Date(`${day}T08:00:00Z`))), true, 'departs after the window closes');
  assert.equal(tripInstanceCannotDepartInWindow(bounds, serviceDateDepartureWindow(day, utc,
    new Date(`${day}T09:00:00Z`), new Date(`${day}T11:00:00Z`))), false, 'straddles the window');
  assert.equal(tripInstanceCannotDepartInWindow(bounds, serviceDateDepartureWindow(day, utc,
    new Date(`${day}T10:00:00Z`), new Date(`${day}T11:00:00Z`))), false, 'touches the opening edge');
});

test('a service date whose offset is not constant is never pruned', () => {
  const bounds = { firstDepartureSeconds: 36_000, lastDepartureSeconds: 48_000 };
  const day = '2026-11-05';
  const earliest = new Date(`${day}T14:00:00Z`);
  const latest = new Date(`${day}T20:00:00Z`);
  assert.equal(serviceDateDepartureWindow(day, () => null, earliest, latest), null, 'no convertible midnight');

  // A shift that only appears past the first day must still be detected: comparing the extremes of the
  // GTFS range against midnight is what proves the seconds-to-UTC mapping is linear.
  const shifting = (serviceDate: string, seconds: number) =>
    new Date(Date.parse(`${serviceDate}T00:00:00.000Z`) + (seconds + (seconds >= 48 * 3600 ? 3600 : 0)) * 1000);
  assert.equal(serviceDateDepartureWindow(day, shifting, earliest, latest), null);
  assert.equal(tripInstanceCannotDepartInWindow(bounds, null), false, 'an unverified date falls through to the normal path');
});

/** The gate must never skip an instance that could still emit a leg. Zero legs can also come from
 *  arrival-side rules the gate does not model, so the reverse direction is not a requirement. */
function eventsFrom(stops: readonly Stop[], eligibleIndexes: readonly number[], serviceDate: string): EligibleTripInstanceStopEvent[] {
  return eligibleIndexes.map((stopIndex) => {
    const stopTime = stops[stopIndex]!;
    const at = utc(serviceDate, stopTime.departureSeconds);
    return {
      stopIndex,
      stopTime: { ...stopTime, arrivalSeconds: stopTime.departureSeconds },
      scheduledArrivalAt: at, scheduledDepartureAt: at, arrivalAt: at, departureAt: at,
      skipped: false, updated: false,
      canBoard: stopTime.pickupType === 0, canAlight: true,
    } as EligibleTripInstanceStopEvent;
  });
}

test('the gate never skips an instance that would emit a leg', () => {
  const stops: Stop[] = [
    { pickupType: 0, departureSeconds: 1_800 },
    { pickupType: 0, departureSeconds: 3_600 },
    { pickupType: 0, departureSeconds: 5_400 },
    { pickupType: 0, departureSeconds: 7_200 },
  ];
  const eligibleIndexes = [0, 1, 2, 3];
  const bounds = boardingDepartureBounds(stops, eligibleIndexes)!;
  const serviceDates = ['2026-11-04', '2026-11-05', '2026-11-06'];
  const windows: Array<[string, string]> = [
    ['2026-11-04T00:30:00Z', '2026-11-04T01:00:00Z'],
    ['2026-11-04T02:00:00Z', '2026-11-04T03:00:00Z'],
    ['2026-11-04T02:30:00Z', '2026-11-05T00:15:00Z'],
    ['2026-11-04T04:00:00Z', '2026-11-04T04:30:00Z'],
    ['2026-11-05T09:00:00Z', '2026-11-05T23:00:00Z'],
    ['2026-11-06T00:00:00Z', '2026-11-06T01:00:00Z'],
  ];
  let skippedCount = 0;
  let legsSeen = 0;
  for (const serviceDate of serviceDates) {
    const events = eventsFrom(stops, eligibleIndexes, serviceDate);
    for (const [openAt, closeAt] of windows) {
      const earliestDeparture = new Date(openAt);
      const journeyEnd = new Date(closeAt);
      let legs = 0;
      visitTripInstanceLegs(events, {
        maximumTransfers: 2, earliestDeparture, journeyEnd,
        destinationStopIds: new Set<string>(),
        canBelongToDirectOnlyJourney: () => true,
      }, () => { legs++; });
      legsSeen += legs;
      const skipped = tripInstanceCannotDepartInWindow(bounds,
        serviceDateDepartureWindow(serviceDate, utc, earliestDeparture, journeyEnd));
      if (skipped) {
        skippedCount++;
        assert.equal(legs, 0, `skipped an instance that emitted ${legs} legs (serviceDate=${serviceDate} window=${openAt}..${closeAt})`);
      }
    }
  }
  assert.ok(skippedCount > 0, 'the gate must actually skip the out-of-window instances');
  assert.ok(legsSeen > 0, 'the in-window instances must still produce legs');
});

/** The seconds window must decide exactly what the event path decides per stop: `visitTripInstanceLegs`
 *  keeps a boarding stop whose scheduled departure lies inside [earliestDeparture, journeyEnd]. */
test('the seconds window reproduces the per-stop UTC comparison at every boundary', () => {
  const day = '2026-11-05';
  const windows: Array<[string, string]> = [
    ['2026-11-05T00:00:00.000Z', '2026-11-05T06:00:00.000Z'],
    ['2026-11-04T22:14:37.000Z', '2026-11-05T04:14:37.000Z'],
    ['2026-11-05T05:00:00.000Z', '2026-11-06T11:00:00.000Z'],
  ];
  for (const [openAt, closeAt] of windows) {
    const earliestDeparture = new Date(openAt);
    const journeyEnd = new Date(closeAt);
    const window = serviceDateDepartureWindow(day, utc, earliestDeparture, journeyEnd)!;
    for (let seconds = 0; seconds < 72 * 3600; seconds += 1_837) {
      const scheduled = utc(day, seconds);
      const inWindow = scheduled >= earliestDeparture && scheduled <= journeyEnd;
      const bounds = { firstDepartureSeconds: seconds, lastDepartureSeconds: seconds };
      assert.equal(tripInstanceCannotDepartInWindow(bounds, window), !inWindow,
        `seconds=${seconds} window=${openAt}..${closeAt}`);
    }
  }
});
