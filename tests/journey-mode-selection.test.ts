import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JOURNEY_SEARCH_TRANSIT_MODES, journeySearchTransitModeAllowed, transitModeAllowed } from '../server/journey/search';

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

  it('keeps feed-only ferry and funicular modes out of canonical Journey search', () => {
    const defaults = { allowPublicTransport: true };
    assert.deepEqual(JOURNEY_SEARCH_TRANSIT_MODES, ['BUS', 'MINIBUS', 'RAIL', 'TRAM', 'TROLLEYBUS', 'METRO']);
    assert.equal(journeySearchTransitModeAllowed('FERRY', defaults), false);
    assert.equal(journeySearchTransitModeAllowed('FUNICULAR', defaults), false);
    assert.equal(journeySearchTransitModeAllowed('FERRY', { ...defaults, allowedTransportTypes: ['ferry'] }), false);
    assert.equal(journeySearchTransitModeAllowed('FUNICULAR', { ...defaults, allowedTransportTypes: ['funicular'] }), false);
    assert.equal(journeySearchTransitModeAllowed('TRAM', { ...defaults, allowedTransportTypes: ['tram'] }), true);
  });
});
