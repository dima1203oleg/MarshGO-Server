import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeTripInstanceLegs, visitTripInstanceLegs } from '../server/journey/gtfsTimetable';
import type { EligibleTripInstanceStopEvent } from '../server/journey/gtfsTimetable';

// The graph materializer now consumes legs through the push-based visitor while other callers
// keep the lazy generator. These tests are the guard that the two twins of the stop-pair window
// rule cannot drift apart.
type EventSeed = {
  stopId?: string;
  arrivalSeconds?: number;
  departureSeconds?: number;
  canBoard?: boolean;
  canAlight?: boolean;
};

function events(count: number, seeds: (index: number) => EventSeed = () => ({})): EligibleTripInstanceStopEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const seed = seeds(index);
    const stopIndex = index * 3;
    const arrivalSeconds = 28_800 + index * 120;
    const departureSeconds = arrivalSeconds + 30;
    return {
      stopIndex,
      stopTime: {
        stopId: seed.stopId ?? `s${index}`,
        arrivalSeconds: seed.arrivalSeconds ?? arrivalSeconds,
        departureSeconds: seed.departureSeconds ?? departureSeconds,
        pickupType: 0,
        dropOffType: 0,
      } as EligibleTripInstanceStopEvent['stopTime'],
      scheduledArrivalAt: new Date(Date.UTC(2026, 10, 1, 8, 0, 0) + arrivalSeconds * 1000),
      scheduledDepartureAt: new Date(Date.UTC(2026, 10, 1, 8, 0, 0) + departureSeconds * 1000),
      arrivalAt: seed.arrivalSeconds === undefined
        ? new Date(Date.UTC(2026, 10, 1, 8, 0, 0) + arrivalSeconds * 1000)
        : new Date(Date.UTC(2026, 10, 1, 8, 0, 0) + seed.arrivalSeconds * 1000),
      departureAt: new Date(Date.UTC(2026, 10, 1, 8, 0, 0) + departureSeconds * 1000),
      skipped: false,
      updated: false,
      canBoard: seed.canBoard ?? true,
      canAlight: seed.canAlight ?? true,
    };
  });
}

function collect(visit: EligibleTripInstanceStopEvent[], options: Parameters<typeof materializeTripInstanceLegs>[1]) {
  const generated: string[] = [];
  for (const projection of materializeTripInstanceLegs(visit, options)) {
    generated.push(projection.kind === 'leg'
      ? `leg ${projection.fromCursor}->${projection.toCursor} ${projection.fromEvent.stopTime.stopId}->${projection.toEvent.stopTime.stopId} ${projection.fromEvent.departureAt?.getTime()}`
      : projection.kind);
  }
  const visited: string[] = [];
  visitTripInstanceLegs(visit, options,
    (fromCursor, toCursor, fromEvent, toEvent) => visited.push(
      `leg ${fromCursor}->${toCursor} ${fromEvent.stopTime.stopId}->${toEvent.stopTime.stopId} ${fromEvent.departureAt?.getTime()}`),
    () => visited.push('omitted-beyond-window'));
  return { generated, visited };
}

const window = {
  earliestDeparture: new Date(Date.UTC(2026, 10, 1, 0, 0, 0)),
  journeyEnd: new Date(Date.UTC(2026, 10, 2, 0, 0, 0)),
  destinationStopIds: new Set<string>(['target']),
  canBelongToDirectOnlyJourney: () => true,
};

test('the push-based leg visitor yields exactly what the lazy generator yields', () => {
  const visit = events(26);
  const { generated, visited } = collect(visit, { ...window, maximumTransfers: 4 });
  // A dense trip must actually exercise the local-window rule, otherwise this is a vacuous pass.
  assert.ok(visited.includes('omitted-beyond-window'), 'expected omitted-beyond-window signals');
  assert.ok(generated.length > 100, `expected a dense projection, got ${generated.length}`);
  assert.deepEqual(visited, generated);
});

test('the twins agree with no transfer window, one boarding stop, and unboardable stops', () => {
  const cases: Array<{ name: string; visit: EligibleTripInstanceStopEvent[]; options: Parameters<typeof materializeTripInstanceLegs>[1] }> = [
    { name: 'maximumTransfers 0 disables the window', visit: events(24), options: { ...window, maximumTransfers: 0 } },
    { name: 'a query destination past the window stays eligible', visit: events(30, (index) => (index === 27 ? { stopId: 'target' } : {})), options: { ...window, maximumTransfers: 2 } },
    { name: 'boarding restricted to one stop index', visit: events(22), options: { ...window, maximumTransfers: 4, boardingStopIndex: 12 } },
    { name: 'boarding index absent from the event vector', visit: events(22), options: { ...window, maximumTransfers: 4, boardingStopIndex: 999 } },
    { name: 'stops that cannot be boarded or alighted', visit: events(20, (index) => (index % 3 === 0 ? { canBoard: false } : index % 4 === 0 ? { canAlight: false } : {})), options: { ...window, maximumTransfers: 4 } },
    { name: 'two events only', visit: events(2), options: { ...window, maximumTransfers: 4 } },
    { name: 'one event', visit: events(1), options: { ...window, maximumTransfers: 4 } },
  ];
  for (const testCase of cases) {
    const { generated, visited } = collect(testCase.visit, testCase.options);
    assert.ok(generated.length > 0 || /absent|one event/.test(testCase.name), `no projection produced for ${testCase.name}`);
    assert.deepEqual(visited, generated, testCase.name);
  }
});
