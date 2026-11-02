import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { MAX_PLACE_NAME_LENGTH, parseJourneySearchRequest } from '../server/journey/search';

// The address picker returns full postal strings, and one search sends the same
// string to journey planning, carpool offer matching, demands and navigation.
// When those endpoints disagreed on the maximum length, a trip the passenger was
// allowed to search for was rejected by the other endpoints.
const BORISPIL_ADDRESS = 'Міжнародний аеропорт «Бориспіль», Щаслива вулиця, Гора, Гірська сільська громада, Бориспільський район, Київська область, 08324, Україна';

const request = {
  origin: { name: 'Хрещатик, вулиця Хрещатик, Графська Гора, Бессарабка, Печерський район, Київ, 01001, Україна', coordinates: [30.5229456, 50.4471871] },
  destination: { name: BORISPIL_ADDRESS, coordinates: [30.8915573, 50.3401779] },
  departureAt: '2026-11-01T08:00:00+03:00',
  passengers: 1,
  strategy: 'BALANCED',
};

describe('place name length contract', () => {
  it('accepts the full geocoder address used by the journey search form', () => {
    assert.ok(BORISPIL_ADDRESS.length > 120 && BORISPIL_ADDRESS.length < MAX_PLACE_NAME_LENGTH);
    const parsed = parseJourneySearchRequest(request, new Date('2026-10-31T08:00:00.000Z'));
    assert.equal(parsed.destination.name, BORISPIL_ADDRESS);
  });

  it('bounds every place-name guard with the shared limit', () => {
    const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    const guards = [...source.matchAll(/\b(?:origin|destination|originName|destinationName)(?:\.trim\(\))?\.length\s*>\s*([\w]+)/g)].map((match) => match[1]);
    assert.ok(guards.length >= 6, `expected the shared guard on offers, demands, navigation and search, found ${guards.length}`);
    assert.deepEqual([...new Set(guards)], ['MAX_PLACE_NAME_LENGTH']);
  });
});
