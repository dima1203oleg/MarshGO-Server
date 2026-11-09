import assert from 'node:assert/strict';
import test from 'node:test';
import type { GtfsTimetableFeed } from '../server/journey/gtfsTimetable';
import { selectUpcomingSmokeServiceWindow } from '../scripts/transport-feed-smoke-window';

function feed(options: {
  timezone?: string;
  weekdays?: boolean[];
  start?: string;
  end?: string;
  exceptions?: Map<string, Map<string, number>>;
} = {}): GtfsTimetableFeed {
  return {
    fetchedAt: new Date('2026-01-01T00:00:00Z'),
    timezone: options.timezone ?? 'Europe/Kyiv',
    routes: new Map(),
    stops: new Map(),
    trips: new Map([['trip', { routeId: 'route', serviceId: 'service', headsign: 'City' }]]),
    stopTimes: new Map(),
    stopTimesByStop: new Map(),
    calendars: new Map([['service', {
      start: options.start ?? '20260101',
      end: options.end ?? '20261231',
      weekdays: options.weekdays ?? [true, true, true, true, true, true, true],
    }]]),
    exceptions: options.exceptions ?? new Map(),
  };
}

test('smoke query chooses next active weekday at daylight hour, not an off-hours wall-clock window', () => {
  const result = selectUpcomingSmokeServiceWindow(
    feed({ weekdays: [true, true, true, true, true, false, false] }),
    new Date('2026-06-06T07:00:00Z'), // Saturday, 10:00 in Kyiv
  );

  assert.equal(result.serviceDate, '20260608'); // Monday
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(result.earliestDeparture), '15');
  assert.equal(result.latestDeparture.getTime() - result.earliestDeparture.getTime(), 90 * 60_000);
});

test('calendar exceptions can add service on a non-service day', () => {
  const addedService = feed({
    weekdays: [false, false, false, false, false, false, false],
    exceptions: new Map([['service', new Map([['20260607', 1]])]]),
  });
  const result = selectUpcomingSmokeServiceWindow(addedService, new Date('2026-06-06T07:00:00Z'));
  assert.equal(result.serviceDate, '20260607');
});

test('calendar exceptions can remove a weekly service day', () => {
  const removedService = feed({
    weekdays: [true, true, true, true, true, true, true],
    exceptions: new Map([['service', new Map([['20260607', 2]])]]),
  });
  const result = selectUpcomingSmokeServiceWindow(removedService, new Date('2026-06-07T07:00:00Z'));
  assert.equal(result.serviceDate, '20260608');
});

test('local daylight time remains correct across the Europe/Kyiv spring DST change', () => {
  const candidate = feed({
    weekdays: [false, false, false, false, false, false, true],
    start: '20260301',
    end: '20260430',
  });
  const result = selectUpcomingSmokeServiceWindow(candidate, new Date('2026-03-28T08:00:00Z'));
  assert.equal(result.serviceDate, '20260329');
  assert.equal(result.earliestDeparture.toISOString(), '2026-03-29T12:00:00.000Z');
  assert.equal(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(result.earliestDeparture), '15:00');
});

test('minimum lead skips a same-day service window too close to now', () => {
  const result = selectUpcomingSmokeServiceWindow(feed(), new Date('2026-06-06T11:00:00Z'));
  assert.equal(result.serviceDate, '20260607');
});

test('does not invent a service date when no active service exists in the horizon', () => {
  const candidate = feed({ start: '20200101', end: '20200102' });
  assert.throws(
    () => selectUpcomingSmokeServiceWindow(candidate, new Date('2026-06-06T07:00:00Z'), { horizonDays: 3 }),
    /No active GTFS service date found/,
  );
});
