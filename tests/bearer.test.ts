import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBearerToken } from '../server/auth/bearer';

const validToken = 'a'.repeat(43);

describe('Bearer authorization parsing', () => {
  it('accepts the generated base64url access token format', () => {
    assert.equal(parseBearerToken(`Bearer ${validToken}`), validToken);
    assert.equal(parseBearerToken(`bEaReR\t ${validToken}`), validToken);
  });

  it('rejects malformed, oversized, and non-bearer authorization headers', () => {
    assert.equal(parseBearerToken(undefined), undefined);
    assert.equal(parseBearerToken('Basic credentials'), undefined);
    assert.equal(parseBearerToken('Bearer'), undefined);
    assert.equal(parseBearerToken('Bearer ' + ' '.repeat(8000)), undefined);
    assert.equal(parseBearerToken(`Bearer ${'a'.repeat(42)}`), undefined);
    assert.equal(parseBearerToken(`Bearer ${'a'.repeat(42)}!`), undefined);
  });
});
