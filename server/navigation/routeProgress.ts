// Loop-safe route progress (spec VIII.4 / XXXIX.1, G03/T17). A route LineString is split into
// ordered directed segment occurrences; a self-crossing route revisits the same coordinates at
// different ordinals, so raw ST_LineLocatePoint (a single geometric fraction) is unsafe. Progress
// is matched to an occurrence using distance, heading and the previous ordinal, and ambiguity is
// surfaced as UNCERTAIN instead of a confident wrong fraction. Dependency-free for plain-node tests.

export type LonLat = [number, number];

export interface SegmentOccurrence {
  ordinal: number;
  start: LonLat;
  end: LonLat;
  lengthM: number;
  cumulativeStartM: number;
  bearingDeg: number;
}

export interface ProgressFix {
  coordinates: LonLat;
  accuracyM: number;
  headingDeg?: number;
}

export interface PreviousProgress {
  ordinal: number;
  cumulativeM: number;
}

export type ProgressStatus = 'RELIABLE' | 'UNCERTAIN' | 'OFF_ROUTE';

export interface ProgressMatch {
  status: ProgressStatus;
  ordinal: number | null;
  offsetM: number | null;
  cumulativeM: number | null;
  fraction: number | null;
  distanceFromRouteM: number;
  uncertaintyM: number;
}

export interface ProgressOptions {
  maxOffRouteM?: number;
  maxAdvanceM?: number;
  headingToleranceDeg?: number;
}

const EARTH_RADIUS_M = 6_371_000;
const M_PER_DEG_LAT = 110_574;
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function haversineM(a: LonLat, b: LonLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDeg(a: LonLat, b: LonLat): number {
  const dLon = rad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function angularDifference(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// Local equirectangular metre frame anchored at `origin`; accurate for short segments.
function localMeters(point: LonLat, origin: LonLat): { x: number; y: number } {
  return {
    x: (point[0] - origin[0]) * 111_320 * Math.cos(rad(origin[1])),
    y: (point[1] - origin[1]) * M_PER_DEG_LAT,
  };
}

export function deriveSegmentOccurrences(route: LonLat[]): SegmentOccurrence[] {
  const occurrences: SegmentOccurrence[] = [];
  let cumulative = 0;
  for (let i = 1; i < route.length; i += 1) {
    const start = route[i - 1];
    const end = route[i];
    const lengthM = haversineM(start, end);
    occurrences.push({ ordinal: i, start, end, lengthM, cumulativeStartM: cumulative, bearingDeg: bearingDeg(start, end) });
    cumulative += lengthM;
  }
  return occurrences;
}

interface Candidate {
  occurrence: SegmentOccurrence;
  distanceM: number;
  offsetM: number;
  cumulativeM: number;
  score: number;
}

function projectFix(occurrence: SegmentOccurrence, fix: ProgressFix): { distanceM: number; offsetM: number } {
  const start = localMeters(occurrence.start, occurrence.start);
  const end = localMeters(occurrence.end, occurrence.start);
  const point = localMeters(fix.coordinates, occurrence.start);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq));
  const projX = start.x + t * dx;
  const projY = start.y + t * dy;
  const distanceM = Math.hypot(point.x - projX, point.y - projY);
  return { distanceM, offsetM: t * occurrence.lengthM };
}

export function matchRouteProgress(
  route: LonLat[],
  fix: ProgressFix,
  previous: PreviousProgress | null,
  options: ProgressOptions = {},
): ProgressMatch {
  const maxOffRouteM = options.maxOffRouteM ?? 60;
  const maxAdvanceM = options.maxAdvanceM ?? 5_000;
  const headingToleranceDeg = options.headingToleranceDeg ?? 45;
  const occurrences = deriveSegmentOccurrences(route);
  const totalM = occurrences.reduce((sum, occ) => sum + occ.lengthM, 0);
  const accuracyM = Math.max(0, fix.accuracyM);
  if (occurrences.length === 0 || totalM === 0) {
    return { status: 'OFF_ROUTE', ordinal: null, offsetM: null, cumulativeM: null, fraction: null, distanceFromRouteM: Infinity, uncertaintyM: accuracyM };
  }

  const toleranceM = maxOffRouteM + accuracyM;
  const backwardToleranceM = accuracyM + 5;
  let nearestDistanceM = Infinity;
  const candidates: Candidate[] = [];
  for (const occurrence of occurrences) {
    const { distanceM, offsetM } = projectFix(occurrence, fix);
    nearestDistanceM = Math.min(nearestDistanceM, distanceM);
    if (distanceM > toleranceM) continue;
    const cumulativeM = occurrence.cumulativeStartM + offsetM;
    let score = distanceM;
    if (fix.headingDeg !== undefined && occurrence.lengthM > 0) {
      score += angularDifference(fix.headingDeg, occurrence.bearingDeg) <= headingToleranceDeg ? -10 : 30;
    }
    if (previous) {
      if (cumulativeM < previous.cumulativeM - backwardToleranceM) score += 1_000;
      else if (cumulativeM - previous.cumulativeM > maxAdvanceM) score += 1_000;
    }
    candidates.push({ occurrence, distanceM, offsetM, cumulativeM, score });
  }

  if (candidates.length === 0) {
    return { status: 'OFF_ROUTE', ordinal: null, offsetM: null, cumulativeM: null, fraction: null, distanceFromRouteM: nearestDistanceM, uncertaintyM: accuracyM };
  }

  candidates.sort((a, b) => a.score - b.score || a.distanceM - b.distanceM || a.occurrence.ordinal - b.occurrence.ordinal);
  const best = candidates[0];
  const runnerUp = candidates[1];
  const ambiguous = Boolean(runnerUp && runnerUp.occurrence.ordinal !== best.occurrence.ordinal && Math.abs(runnerUp.score - best.score) <= 2);
  const backward = Boolean(previous && best.cumulativeM < previous.cumulativeM - backwardToleranceM);
  const implausibleJump = Boolean(previous && best.cumulativeM - previous.cumulativeM > maxAdvanceM);
  const status: ProgressStatus = ambiguous || backward || implausibleJump ? 'UNCERTAIN' : 'RELIABLE';
  const fraction = Math.max(0, Math.min(1, best.cumulativeM / totalM));
  return {
    status,
    ordinal: best.occurrence.ordinal,
    offsetM: best.offsetM,
    cumulativeM: best.cumulativeM,
    fraction,
    distanceFromRouteM: best.distanceM,
    uncertaintyM: accuracyM + (status === 'UNCERTAIN' ? toleranceM : 0),
  };
}