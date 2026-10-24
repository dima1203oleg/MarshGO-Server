import test from 'node:test';
import assert from 'node:assert/strict';
import { memoizeRequestSearch } from '../server/journey/requestSearchMemo';

test('request search memo reuses an identical result within its scope', () => {
  let calls = 0;
  const search = memoizeRequestSearch((from: string, to: string) => `${from}>${to}`, (from, to) => {
    calls++;
    return { route: `${from}>${to}` };
  });

  const first = search('A', 'B');
  const second = search('A', 'B');

  assert.equal(calls, 1);
  assert.equal(first, second);
});

test('request search memo keeps different keys independent and bounds retained results', () => {
  let calls = 0;
  const search = memoizeRequestSearch((key: string) => key, (key) => {
    calls++;
    return key;
  }, 2);

  assert.equal(search('A'), 'A');
  assert.equal(search('B'), 'B');
  assert.equal(search('C'), 'C');
  assert.equal(search('A'), 'A');
  assert.equal(calls, 4);
});
