import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveGtfsSourceFreshAt } from '../server/journey/gtfsTimetable';

test('static journey freshness comes from the parsed feed, not a registry validation timestamp', () => {
  const parsedFeedAt = new Date('2026-11-14T00:06:54.000Z');
  const validatedLaterAt = new Date('2026-11-14T01:00:00.000Z');

  const usedFreshAt = effectiveGtfsSourceFreshAt({ sourceFreshAt: parsedFeedAt }).getTime();
  assert.equal(usedFreshAt, parsedFeedAt.getTime());
  assert.notEqual(usedFreshAt, validatedLaterAt.getTime());
});

test('realtime journey freshness prefers the matched trip update timestamp', () => {
  const parsedFeedAt = new Date('2026-11-14T00:06:54.000Z');
  const realtimeUpdatedAt = new Date('2026-11-14T00:07:15.000Z');

  assert.equal(effectiveGtfsSourceFreshAt({ sourceFreshAt: parsedFeedAt, realtimeUpdatedAt }).getTime(), realtimeUpdatedAt.getTime());
});
