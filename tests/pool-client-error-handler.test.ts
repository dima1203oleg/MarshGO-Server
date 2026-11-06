import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observePgPoolClientErrors } from '../server/database/poolClientErrors';

class FakePool extends EventEmitter {
  connectClient(client: EventEmitter): void {
    this.emit('connect', client);
  }
}

test('checked-out PostgreSQL client errors are handled without exposing connection details', () => {
  const pool = new FakePool();
  const events: Array<{ level: 'error'; event: 'database.client_error'; name: string }> = [];
  observePgPoolClientErrors(pool, (event) => events.push(event));

  const client = new EventEmitter();
  pool.connectClient(client);

  assert.doesNotThrow(() => client.emit('error', new Error('Connection terminated unexpectedly')));
  assert.deepEqual(events, [{
    level: 'error',
    event: 'database.client_error',
    name: 'Error',
  }]);
  assert.equal(JSON.stringify(events).includes('Connection terminated unexpectedly'), false);
});

test('each physical PostgreSQL client gets one error listener when it connects', () => {
  const pool = new FakePool();
  observePgPoolClientErrors(pool, () => undefined);

  const first = new EventEmitter();
  const second = new EventEmitter();
  pool.connectClient(first);
  pool.connectClient(second);

  assert.equal(first.listenerCount('error'), 1);
  assert.equal(second.listenerCount('error'), 1);
});

test('negative control: an unobserved checked-out client error would throw', () => {
  const client = new EventEmitter();
  const connectionError = new Error('Connection terminated unexpectedly');

  assert.throws(() => client.emit('error', connectionError), connectionError);
});
