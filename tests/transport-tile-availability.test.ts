import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { providerServices, selectTileProviders, transportTileDefinitions, type TransportTileDefinition, type TransportTileProviderRow } from '../server/mobility/transportTileAvailability';

const serverSource = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');

/**
 * These rows are test inputs, not production evidence. They mirror the exact shapes the registry
 * stores in `mobility_providers.last_report`: a validated probe writes `routes_<mode>`/`vehicles_<mode>`
 * counts plus a coverage bbox; an unreachable feed keeps `counts: {}` and no bbox (measured for every
 * Kyiv metro source on 2026-11-04). Availability must follow only the first shape.
 */
const tileOf = (id: string): TransportTileDefinition => {
  const tile = transportTileDefinitions.find((item) => item.id === id);
  if (!tile) throw new Error(`transport tile ${id} must stay in the registry list so the client can keep it visible`);
  return tile;
};

const row = (overrides: Partial<TransportTileProviderRow>): TransportTileProviderRow => ({
  name: 'Київ — метро (геометрія ліній)', city: 'Київ', provider_type: 'public_transit', source_type: 'geojson',
  last_report: { counts: {} }, ...overrides,
});

const kyiv = { lat: 50.4501, lon: 30.5234 };
const kyivBox: [number, number, number, number] = [30.28, 50.22, 30.77, 50.57];

describe('transport tile availability is decided by validated feed counts', () => {
  it('reports metro for a city whose metro feed has been observed to contain metro routes', () => {
    const metroFeed = row({ last_report: { counts: { routes_metro: 3, stops_metro: 52 }, bbox: kyivBox } });
    const providers = selectTileProviders({ tile: tileOf('metro'), rows: [metroFeed], ...kyiv });
    assert.deepEqual(providers, [{ id: 'metro:Київ', name: 'Київ', available: true, cities: ['Київ'], sources: ['geojson'], services: ['metro'] }]);
  });

  it('reports metro from realtime vehicle counts too, and keeps every observed service on the operator entry', () => {
    const providers = selectTileProviders({
      tile: tileOf('metro'),
      rows: [
        row({ name: 'Київ — метро (геометрія ліній)', last_report: { counts: { routes_metro: 3 }, bbox: kyivBox } }),
        row({ name: 'Київ — метро (позиції)', source_type: 'gtfs_rt', last_report: { counts: { vehicles_metro: 96 }, bbox: kyivBox } }),
      ], ...kyiv,
    });
    assert.equal(providers.length, 1, 'feeds of one operator stay a single registry entry');
    assert.deepEqual([...providers[0]!.sources].sort(), ['geojson', 'gtfs_rt']);
    assert.deepEqual([...providers[0]!.services].sort(), ['metro']);
  });

  it('does not report metro when the registered metro sources are unreachable or never probed (live Kyiv state)', () => {
    // Exact shape measured in mobility_providers for all six Київ — метро rows: enabled, health=offline,
    // "Host cannot be resolved", counts {} and no bbox. A registered URL is not availability.
    const unprobed = [
      row({ name: 'Київ — метро (геометрія ліній)' }),
      row({ name: 'Київ — метро (станції)', last_report: { counts: { features: 52, stops_metro: 52 } } }),
      row({ name: 'Київ — метро (інтервали руху)', source_type: 'rest', last_report: { counts: { schedule_records: 480 } } }),
    ];
    assert.deepEqual(selectTileProviders({ tile: tileOf('metro'), rows: unprobed, ...kyiv }), []);
  });

  it('negative control: a mode with no data at all stays empty while other modes of the same feed still report', () => {
    const rows = [
      row({ name: 'Київпастранс — розклад (GTFS)', source_type: 'gtfs', last_report: { counts: { routes: 165, routes_bus: 104, routes_tram: 17, routes_trolleybus: 44 }, bbox: kyivBox } }),
    ];
    for (const empty of ['carsharing', 'taxi', 'ferry', 'moped', 'plane', 'city_train', 'funicular', 'transfer', 'walk', 'train', 'intercity_bus']) {
      assert.deepEqual(selectTileProviders({ tile: tileOf(empty), rows, ...kyiv }), [], `${empty} must not be advertised without a source that evidences it`);
    }
    assert.equal(selectTileProviders({ tile: tileOf('bus'), rows, ...kyiv }).length, 1);
    assert.equal(selectTileProviders({ tile: tileOf('tram'), rows, ...kyiv }).length, 1);
  });

  it('does not replace empty nationwide tiles with unverified hard-coded providers', () => {
    assert.deepEqual(selectTileProviders({ tile: tileOf('train'), rows: [], ...kyiv }), []);
    assert.deepEqual(selectTileProviders({ tile: tileOf('intercity_bus'), rows: [], ...kyiv }), []);
    assert.doesNotMatch(serverSource, /tile\.id === '(?:train|intercity_bus)' && tileProviders\.length === 0/);
  });

  it('scopes a city tile to the search point and keeps nationwide sources out of city tiles', () => {
    const metroFeed = row({ last_report: { counts: { routes_metro: 3 }, bbox: kyivBox } });
    const lviv = { lat: 49.8397, lon: 24.0297 };
    assert.deepEqual(selectTileProviders({ tile: tileOf('metro'), rows: [metroFeed], ...lviv }), [], 'Kyiv metro must not appear for a Lviv search');
    assert.equal(selectTileProviders({ tile: tileOf('metro'), rows: [metroFeed], lat: null, lon: null }).length, 1, 'the global registry call has no point filter');
    const rail = row({ name: 'Укрзалізниця — розклад (GTFS)', city: 'Україна', source_type: 'gtfs', last_report: { counts: { routes_train: 115, routes_metro: 3 } } });
    assert.deepEqual(selectTileProviders({ tile: tileOf('metro'), rows: [rail], ...kyiv }), [], 'a nationwide source never serves a city tile');
    assert.equal(selectTileProviders({ tile: tileOf('train'), rows: [rail], ...kyiv }).length, 1);
  });

  it('counts only positive, mode-suffixed probe counts as a service', () => {
    assert.deepEqual([...providerServices({ counts: { routes_metro: 3, vehicles_metro: 0, routes_intercity_bus: 9, stops_metro: 52, features: 52 } })], ['metro']);
    assert.equal(providerServices(null).size, 0);
    assert.equal(providerServices({}).size, 0);
  });
});
