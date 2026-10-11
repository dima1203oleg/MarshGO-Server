import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { transitModeAllowed } from '../server/journey/search';

describe('Transit mode selection', () => {
  it('does not let the legacy bus toggle disable tram, trolleybus, metro, ferry, or funicular', () => {
    const preferences = { allowPublicTransport: true, allowBus: false };

    assert.equal(transitModeAllowed('BUS', preferences), false);
    assert.equal(transitModeAllowed('TRAM', preferences), true);
    assert.equal(transitModeAllowed('TROLLEYBUS', preferences), true);
    assert.equal(transitModeAllowed('METRO', preferences), true);
    assert.equal(transitModeAllowed('FERRY', preferences), true);
    assert.equal(transitModeAllowed('FUNICULAR', preferences), true);
  });

  it('applies category-specific legacy toggles to buses, minibuses, and rail only', () => {
    const preferences = { allowPublicTransport: true, allowBus: true, allowMinibus: false, allowRail: false };

    assert.equal(transitModeAllowed('BUS', preferences), true);
    assert.equal(transitModeAllowed('MINIBUS', preferences), false);
    assert.equal(transitModeAllowed('RAIL', preferences), false);
    assert.equal(transitModeAllowed('TRAM', preferences), true);
  });

  it('uses exact transport selections when present and honors the public-transport hard constraint', () => {
    assert.equal(transitModeAllowed('TRAM', { allowedTransportTypes: ['tram'] }), true);
    assert.equal(transitModeAllowed('BUS', { allowedTransportTypes: ['tram'] }), false);
    assert.equal(transitModeAllowed('RAIL', { allowedTransportTypes: ['train'] }), true);
    assert.equal(transitModeAllowed('MINIBUS', { allowedTransportTypes: [] }), false);
    assert.equal(transitModeAllowed('TRAM', { allowPublicTransport: false, allowedTransportTypes: ['tram'] }), false);
  });
});
