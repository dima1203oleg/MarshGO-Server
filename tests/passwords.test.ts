import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  validatePassword,
  validateEmail,
  generateResetToken,
} from '../server/auth/passwords';

describe('Password & Auth Validation Module', () => {
  it('validates email correctly', () => {
    assert.equal(validateEmail('test@example.com').valid, true);
    assert.equal(validateEmail('test@example.com').normalized, 'test@example.com');
    assert.equal(validateEmail('  USER.Name+tag@sub.domain.ua  ').normalized, 'user.name+tag@sub.domain.ua');
    assert.equal(validateEmail('invalid-email').valid, false);
    assert.equal(validateEmail('').valid, false);
    assert.equal(validateEmail(null).valid, false);
  });

  it('validates password requirements correctly', () => {
    assert.equal(validatePassword('Short1!').valid, false, 'rejects < 8 chars');
    assert.equal(validatePassword('alllowercase123!').valid, true, 'accepts valid password');
    assert.equal(validatePassword('1234567890').valid, false, 'rejects numbers only');
    assert.equal(validatePassword('abcdefghij').valid, false, 'rejects letters only');
    assert.equal(validatePassword('MyPassword2026').valid, true, 'accepts letter and number');
    assert.equal(validatePassword('ПарольДляВходу1').valid, true, 'accepts Cyrillic and number');
  });

  it('hashes and verifies passwords with timingSafe scrypt', async () => {
    const raw = 'SecretPassword123!';
    const hash = await hashPassword(raw);
    assert.match(hash, /^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);

    const match = await verifyPassword(raw, hash);
    assert.equal(match, true);

    const wrong = await verifyPassword('WrongPassword123!', hash);
    assert.equal(wrong, false);

    const invalidHash = await verifyPassword(raw, 'malformed-hash');
    assert.equal(invalidHash, false);
  });

  it('generates secure 32-byte reset tokens', () => {
    const { token, tokenHash } = generateResetToken();
    assert.equal(typeof token, 'string');
    assert.ok(token.length >= 40);
    assert.equal(typeof tokenHash, 'string');
    assert.equal(tokenHash.length, 64);
  });
});
