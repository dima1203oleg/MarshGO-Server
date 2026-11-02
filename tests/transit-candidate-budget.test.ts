// ТЗ-M5-P2: the transit candidate pool must be a configurable budget, not a hardcoded early cut.
// The default and the ceiling come from the measured preview benchmark of 2026-11-02.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HARD_MAX_GTFS_SEARCH_LIMIT,
  MAX_GTFS_SEARCH_LIMIT,
  resolveTransitCandidateBudget,
} from '../server/journey/gtfsTimetable';

describe('transit candidate budget', () => {
  it('keeps the measured default when the operator sets nothing', () => {
    assert.equal(resolveTransitCandidateBudget(undefined), MAX_GTFS_SEARCH_LIMIT);
    assert.equal(resolveTransitCandidateBudget(''), MAX_GTFS_SEARCH_LIMIT);
  });

  it('honours a configured budget up to the measured ceiling', () => {
    assert.equal(resolveTransitCandidateBudget('150'), 150);
    assert.equal(resolveTransitCandidateBudget(String(HARD_MAX_GTFS_SEARCH_LIMIT)), HARD_MAX_GTFS_SEARCH_LIMIT);
  });

  it('clamps an unmeasured budget instead of letting the search throw on every request', () => {
    assert.equal(resolveTransitCandidateBudget('100000'), HARD_MAX_GTFS_SEARCH_LIMIT);
    assert.equal(resolveTransitCandidateBudget('0'), 1);
    assert.equal(resolveTransitCandidateBudget('-5'), 1);
  });

  it('falls back to the default for values that are not whole numbers', () => {
    assert.equal(resolveTransitCandidateBudget('many'), MAX_GTFS_SEARCH_LIMIT);
    assert.equal(resolveTransitCandidateBudget('Infinity'), MAX_GTFS_SEARCH_LIMIT);
  });
});
