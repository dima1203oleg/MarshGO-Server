import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeIntervalViolation, WHOLE_ROUTE_ALIGHTING } from '../server/bookings/seatInventory';

// Carpool 5.0 CP5-A01 / gates G10/G15 — functional proof of the route-bound ordinal
// validator. Executes the REAL exported implementation (not a regex). Ordinals are
// directed segment occurrences: N route vertices ⇒ N−1 segments, so a partial interval
// is realizable only when alighting <= N; an unrouted offer admits only the whole route.

test('routeIntervalViolation: an unrouted offer rejects any partial interval', () => {
  const violation = routeIntervalViolation(null, 5);
  assert.equal(violation?.code, 'ordinals_require_route');
  assert.match(violation!.message, /whole route/);
});

test('routeIntervalViolation: alighting beyond the route point count is out of route', () => {
  assert.equal(routeIntervalViolation(2, 5)?.code, 'ordinal_out_of_route');
  assert.equal(routeIntervalViolation(16, 17)?.code, 'ordinal_out_of_route');
  assert.equal(routeIntervalViolation(16, 32766)?.code, 'ordinal_out_of_route');
});

test('routeIntervalViolation: alighting at or below the point count is realizable', () => {
  assert.equal(routeIntervalViolation(2, 2), null, 'a two-point route admits [1,2)');
  assert.equal(routeIntervalViolation(16, 16), null, 'the boundary alighting == N books the final segment');
  assert.equal(routeIntervalViolation(16, 12), null);
  assert.equal(routeIntervalViolation(16, 2), null);
});

test('routeIntervalViolation: the whole-route sentinel exceeds any real route (partial-only validator)', () => {
  // The handler skips this validator for whole-route requests; if the sentinel were
  // passed it would (correctly) be flagged, proving whole-route must bypass partial validation.
  assert.equal(routeIntervalViolation(16, WHOLE_ROUTE_ALIGHTING)?.code, 'ordinal_out_of_route');
  assert.equal(WHOLE_ROUTE_ALIGHTING, 32767);
});