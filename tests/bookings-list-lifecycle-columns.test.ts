import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(import.meta.dirname, '../server/index.ts'), 'utf8');

function routeBody(route: string): string {
  const start = source.indexOf(route);
  assert.ok(start >= 0, `${route} not found in server/index.ts`);
  const next = source.indexOf('\napp.', start + route.length);
  return source.slice(start, next < 0 ? undefined : next);
}

describe('Bookings list read and lifecycle timestamps', () => {
  it('selects completed_at and cancelled_at in the bookings list read', () => {
    const body = routeBody("app.get('/api/v1/bookings', requireAuth");
    assert.match(body, /b\.completed_at/, 'bookings list must read b.completed_at');
    assert.match(body, /b\.cancelled_at/, 'bookings list must read b.cancelled_at');
  });

  it('stamps the timestamp columns on the completion and cancellation writes', () => {
    assert.match(source, /status\s*=\s*'completed'\s*,\s*completed_at\s*=\s*now\(\)/, 'completion write must stamp completed_at');
    assert.match(source, /status\s*=\s*'cancelled'\s*,\s*cancelled_at\s*=\s*now\(\)/, 'cancellation write must stamp cancelled_at');
  });
});
