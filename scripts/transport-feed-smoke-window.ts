import type { GtfsTimetableFeed } from '../server/journey/gtfsTimetable';

export interface SmokeServiceWindow {
  earliestDeparture: Date;
  latestDeparture: Date;
  serviceDate: string;
}

export interface SmokeServiceWindowOptions {
  timezone?: string;
  localHour?: number;
  windowMinutes?: number;
  minimumLeadMinutes?: number;
  horizonDays?: number;
}

function dateParts(date: Date, timezone: string): { date: string; year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const year = Number(value('year'));
  const month = Number(value('month'));
  const day = Number(value('day'));
  return { date: `${year}${value('month')}${value('day')}`, year, month, day };
}

function addDays(date: string, amount: number): string {
  const value = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)) + amount));
  return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}`;
}

function activeService(feed: GtfsTimetableFeed, serviceId: string, date: string): boolean {
  const exception = feed.exceptions.get(serviceId)?.get(date);
  if (exception !== undefined) return exception === 1;
  const calendar = feed.calendars.get(serviceId);
  if (!calendar || date < calendar.start || date > calendar.end) return false;
  const [year, month, day] = [Number(date.slice(0, 4)), Number(date.slice(4, 6)), Number(date.slice(6, 8))];
  const mondayFirst = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return calendar.weekdays[mondayFirst] === true;
}

function localWallTimeToUtc(date: string, hour: number, timezone: string): Date | null {
  const [year, month, day] = [Number(date.slice(0, 4)), Number(date.slice(4, 6)), Number(date.slice(6, 8))];
  const target = Date.UTC(year, month - 1, day, hour);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = formatter.formatToParts(new Date(guess));
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
    guess += target - represented;
  }
  const result = new Date(guess);
  const parts = formatter.formatToParts(result);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  if (value('year') !== year || value('month') !== month || value('day') !== day || value('hour') !== hour
    || value('minute') !== 0 || value('second') !== 0) return null;
  return result;
}

/** Select a deterministic daylight query window on the next active GTFS service date. */
export function selectUpcomingSmokeServiceWindow(
  feed: GtfsTimetableFeed,
  now = new Date(),
  options: SmokeServiceWindowOptions = {},
): SmokeServiceWindow {
  const timezone = options.timezone ?? feed.timezone;
  const localHour = options.localHour ?? 15;
  const windowMinutes = options.windowMinutes ?? 90;
  const minimumLeadMinutes = options.minimumLeadMinutes ?? 120;
  const horizonDays = options.horizonDays ?? 14;
  if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23
    || !Number.isInteger(windowMinutes) || windowMinutes < 1
    || !Number.isInteger(minimumLeadMinutes) || minimumLeadMinutes < 0
    || !Number.isInteger(horizonDays) || horizonDays < 1) {
    throw new TypeError('Smoke service-window options are invalid');
  }
  const serviceIds = new Set([...feed.trips.values()].map((trip) => trip.serviceId));
  const today = dateParts(now, timezone).date;
  const earliestAllowed = now.getTime() + minimumLeadMinutes * 60_000;
  for (let offset = 0; offset < horizonDays; offset++) {
    const serviceDate = addDays(today, offset);
    if (![...serviceIds].some((serviceId) => activeService(feed, serviceId, serviceDate))) continue;
    const earliestDeparture = localWallTimeToUtc(serviceDate, localHour, timezone);
    if (!earliestDeparture || earliestDeparture.getTime() < earliestAllowed) continue;
    return {
      earliestDeparture,
      latestDeparture: new Date(earliestDeparture.getTime() + windowMinutes * 60_000),
      serviceDate,
    };
  }
  throw new Error(`No active GTFS service date found within ${horizonDays} days for ${timezone}`);
}
