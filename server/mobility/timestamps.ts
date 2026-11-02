type LocalDateTimeParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export const LIVE_MOBILITY_MAX_AGE_MS = 90_000;
export const LIVE_MOBILITY_MAX_FUTURE_SKEW_MS = 30_000;

/** Live map telemetry is usable only for 90 seconds, with 30 seconds of clock skew. */
export function isFreshMobilityTimestamp(
  timestamp: Date | null,
  nowMs = Date.now(),
  maxAgeMs = LIVE_MOBILITY_MAX_AGE_MS,
  maxFutureSkewMs = LIVE_MOBILITY_MAX_FUTURE_SKEW_MS,
): boolean {
  if (!timestamp || !Number.isFinite(timestamp.getTime())) return false;
  const ageMs = nowMs - timestamp.getTime();
  return ageMs >= -maxFutureSkewMs && ageMs <= maxAgeMs;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatter.format(0);
    formatters.set(timeZone, formatter);
    return formatter;
  } catch { return null; }
}

function zonedPartsAt(timestampMs: number, formatter: Intl.DateTimeFormat): LocalDateTimeParts | null {
  const parts = formatter.formatToParts(new Date(timestampMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const result = { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
  return Object.values(result).every(Number.isInteger) ? result : null;
}

function sameParts(a: LocalDateTimeParts, b: LocalDateTimeParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
    && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

/** Convert a naive local timestamp without relying on the machine/container TZ. */
function parseLocalDateTimeInZone(value: string, timeZone: string, nowMs: number): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText] = match;
  const target: LocalDateTimeParts = {
    year: Number(yearText), month: Number(monthText), day: Number(dayText), hour: Number(hourText),
    minute: Number(minuteText), second: Number(secondText),
  };
  const fractionMs = Number((fractionText ?? '').padEnd(3, '0'));
  const localEpoch = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second, fractionMs);
  const check = new Date(localEpoch);
  if (check.getUTCFullYear() !== target.year || check.getUTCMonth() + 1 !== target.month || check.getUTCDate() !== target.day
    || target.hour > 23 || target.minute > 59 || target.second > 59) return null;
  const formatter = formatterFor(timeZone);
  if (!formatter) return null;

  // Sample offsets around the requested wall time. This finds both offsets in
  // an autumn DST fold and naturally rejects nonexistent spring-forward times.
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = localEpoch + hours * 3_600_000;
    const parts = zonedPartsAt(sample, formatter);
    if (!parts) continue;
    const sampleWholeSeconds = Math.floor(sample / 1000) * 1000;
    offsets.add(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - sampleWholeSeconds);
  }

  const candidates = [...offsets].map((offset) => localEpoch - offset)
    .filter((candidate) => {
      const parts = zonedPartsAt(candidate, formatter);
      return parts !== null && sameParts(parts, target);
    });
  if (candidates.length === 0) return null;
  const selected = candidates.sort((a, b) => Math.abs(a - nowMs) - Math.abs(b - nowMs))[0];
  return selected === undefined ? null : new Date(selected);
}

/** Parse provider timestamps, interpreting timezone-free Ukrainian feed times as Europe/Kyiv wall time. */
export function parseMobilityTimestamp(value: unknown, timeZone = 'Europe/Kyiv', nowMs = Date.now()): Date | null {
  let milliseconds: number;
  if (typeof value === 'number' && Number.isFinite(value)) milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
  else if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    const numeric = Number(text);
    if (Number.isFinite(numeric)) milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    else {
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(text)) {
        const local = parseLocalDateTimeInZone(text, timeZone, nowMs);
        if (!local) return null;
        milliseconds = local.getTime();
      } else milliseconds = Date.parse(text);
    }
  } else if (value && typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') {
    const numeric = value.toNumber();
    if (!Number.isFinite(numeric)) return null;
    milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  } else return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}
