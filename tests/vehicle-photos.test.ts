import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isExactVehiclePhotoOrder } from '../server/vehiclePhotos';

const photoA = '00000000-0000-4000-8000-000000000001';
const photoB = '00000000-0000-4000-8000-000000000002';

describe('vehicle photo ordering', () => {
  it('accepts any exact permutation and preserves the supplied order', () => {
    assert.equal(isExactVehiclePhotoOrder([photoB, photoA], [photoA, photoB], 10), true);
  });
  it('rejects missing, foreign, duplicate, malformed, and over-limit ids', () => {
    for (const requested of [[], [photoA], [photoA, photoA], [photoA, 'not-a-uuid'], [photoA, photoB, photoA]]) {
      assert.equal(isExactVehiclePhotoOrder(requested, [photoA, photoB], 2), false);
    }
  });
});
