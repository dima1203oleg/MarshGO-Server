import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSegmentOccurrences, matchRouteProgress, type LonLat } from '../server/navigation/routeProgress';

// Carpool 5.0 P0.2-B — loop-safe ordered segment occurrences (spec VIII.4 / XXXIX.1, G03/T17).
const line: LonLat[] = [[24.0, 49.0], [24.01, 49.0], [24.02, 49.0]];
// A square loop that returns to its start: v0 and v4 are the SAME coordinate at different ordinals.
const loop: LonLat[] = [[24.0, 49.0], [24.01, 49.0], [24.01, 49.01], [24.0, 49.01], [24.0, 49.0]];

describe('route progress: ordered segment occurrences', () => {
  it('derives one directed occurrence per segment with monotonic cumulative distance', () => {
    const occ = deriveSegmentOccurrences(loop);
    assert.equal(occ.length, 4);
    assert.deepEqual(occ.map((o) => o.ordinal), [1, 2, 3, 4]);
    for (let i = 1; i < occ.length; i += 1) {
      assert.ok(occ[i].cumulativeStartM > occ[i - 1].cumulativeStartM, 'cumulative distance must increase');
      assert.ok(Math.abs(occ[i].cumulativeStartM - (occ[i - 1].cumulativeStartM + occ[i - 1].lengthM)) < 1e-6);
    }
    // The closing segment ends exactly where the first segment starts (the self-crossing).
    assert.deepEqual(occ[3].end, occ[0].start);
    assert.ok(occ[0].lengthM > 0);
  });

  it('matches a fix on a simple line to the right occurrence and fraction', () => {
    const match = matchRouteProgress(line, { coordinates: [24.005, 49.0], accuracyM: 5 }, null);
    assert.equal(match.status, 'RELIABLE');
    assert.equal(match.ordinal, 1);
    assert.ok(match.fraction !== null && match.fraction > 0.2 && match.fraction < 0.3);
    assert.ok(match.distanceFromRouteM < 5);
  });

  it('advances monotonically forward along the route', () => {
    const first = matchRouteProgress(line, { coordinates: [24.005, 49.0], accuracyM: 5 }, null);
    const previous = { ordinal: first.ordinal!, cumulativeM: first.cumulativeM! };
    const second = matchRouteProgress(line, { coordinates: [24.015, 49.0], accuracyM: 5 }, previous);
    assert.equal(second.status, 'RELIABLE');
    assert.equal(second.ordinal, 2);
    assert.ok(second.cumulativeM! > previous.cumulativeM, 'progress must move forward');
    assert.ok(second.fraction! > first.fraction!);
  });

  it('T17: on a self-crossing loop, a fix at the crossing resolves to the FORWARD occurrence, not the first', () => {
    const occ = deriveSegmentOccurrences(loop);
    // Previous progress is mid-way through segment 3 (approaching the crossing from the north).
    const previous = { ordinal: 3, cumulativeM: occ[2].cumulativeStartM + occ[2].lengthM * 0.5 };
    const match = matchRouteProgress(loop, { coordinates: [24.0, 49.0], accuracyM: 5 }, previous);
    assert.equal(match.status, 'RELIABLE');
    assert.equal(match.ordinal, 4, 'must take the closing occurrence, not jump back to occurrence 1');
    assert.ok(match.fraction! > 0.9, 'fraction must be near the end of the loop, not near 0');
  });

  it('T17: the same crossing fix with no history is ambiguous -> UNCERTAIN (raw fraction would be unsafe)', () => {
    const match = matchRouteProgress(loop, { coordinates: [24.0, 49.0], accuracyM: 5 }, null);
    assert.equal(match.status, 'UNCERTAIN');
    assert.ok(match.uncertaintyM > 5, 'uncertainty must widen when the occurrence is ambiguous');
  });

  it('T17: heading disambiguates the crossing toward the aligned occurrence', () => {
    // Heading south (180deg) aligns with the closing segment, not the eastbound first segment.
    const match = matchRouteProgress(loop, { coordinates: [24.0, 49.0], accuracyM: 5, headingDeg: 180 }, null);
    assert.equal(match.status, 'RELIABLE');
    assert.equal(match.ordinal, 4);
  });

  it('flags a fix behind the previous progress as UNCERTAIN instead of confidently reversing', () => {
    const ahead = matchRouteProgress(line, { coordinates: [24.018, 49.0], accuracyM: 5 }, null);
    const previous = { ordinal: ahead.ordinal!, cumulativeM: ahead.cumulativeM! };
    const behind = matchRouteProgress(line, { coordinates: [24.001, 49.0], accuracyM: 5 }, previous);
    assert.equal(behind.status, 'UNCERTAIN');
  });

  it('returns OFF_ROUTE for a fix far from the route', () => {
    const match = matchRouteProgress(line, { coordinates: [24.5, 49.5], accuracyM: 5 }, null);
    assert.equal(match.status, 'OFF_ROUTE');
    assert.equal(match.ordinal, null);
    assert.ok(match.distanceFromRouteM > 1000);
  });

  it('handles a degenerate route without throwing', () => {
    const match = matchRouteProgress([[24.0, 49.0]], { coordinates: [24.0, 49.0], accuracyM: 5 }, null);
    assert.equal(match.status, 'OFF_ROUTE');
  });
});