import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizePlate } from '../server/vehiclePlate';

describe('licence plate normalisation', () => {
  it('accepts standard Ukrainian plates in Latin or Cyrillic', () => {
    assert.equal(normalizePlate('AA 1234 BB'), 'AA1234BB');
    assert.equal(normalizePlate('ВС-7777-КА'), 'BC7777KA');
    assert.equal(normalizePlate('ка1234ах'), 'KA1234AX');
  });
  it('accepts personalised plates', () => {
    assert.equal(normalizePlate('MARSHGO'), 'MARSHGO');
    assert.equal(normalizePlate('Dima 1'), 'DIMA1');
  });
  it('rejects implausible input', () => {
    for (const bad of ['', '12', '1234', 'A', '<script>', 'A'.repeat(20), null, undefined, 42]) assert.equal(normalizePlate(bad as never), null, String(bad));
  });
});
