import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canOfferStaticBikeEstimate, providerServices, selectTileProviders, transportTileDefinitions, type TransportTileDefinition, type TransportTileProviderRow } from '../server/mobility/transportTileAvailability';

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
  it('only advertises static bike estimates when the operator is enabled and commercial data use is permitted', () => {
    const nextbike = { enabled: true, integration_status: 'ACTIVE_STATIC', commercial_permissions: 'ATTRIBUTION_REQUIRED' };
    assert.equal(canOfferStaticBikeEstimate(nextbike), true);
    assert.equal(canOfferStaticBikeEstimate({ ...nextbike, enabled: false }), false, 'disabled BikeNow cannot appear in trip search');
    assert.equal(canOfferStaticBikeEstimate({ ...nextbike, commercial_permissions: 'UNKNOWN' }), false, 'unverified Veliki rights cannot appear in trip search');
    assert.equal(canOfferStaticBikeEstimate({ ...nextbike, commercial_permissions: 'PARTNER_ONLY' }), false);
    assert.equal(canOfferStaticBikeEstimate({ ...nextbike, integration_status: 'AWAITING_AGREEMENT' }), false);
  });

  it('reports metro for a city whose metro feed has been observed to contain metro routes', () => {
    const metroFeed = row({ last_report: { counts: { routes_metro: 3, stops_metro: 52 }, bbox: kyivBox } });
    const providers = selectTileProviders({ tile: tileOf('metro'), rows: [metroFeed], ...kyiv });
    assert.deepEqual(providers, [{ id: 'metro:Київ', name: 'Київ', available: true, cities: ['Київ'], sources: ['geojson'], services: ['metro'] }]);
  });

  it('lets live vehicle evidence enrich a route-backed provider entry', () => {
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

  it('does not expose a live-only transit feed as a journey-search route option', () => {
    const liveOnly = row({ name: 'Ужгород — позиції (Dozor JSON)', city: 'Ужгород', source_type: 'json',
      last_report: { counts: { vehicles_bus: 51 }, bbox: [-23.9, 45.2, 34.9, 51.5] } });
    assert.deepEqual(selectTileProviders({ tile: tileOf('bus'), rows: [liveOnly], lat: 49.84, lon: 24.02 }), []);
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
    for (const empty of ['carpool', 'carsharing', 'taxi', 'ferry', 'moped', 'plane', 'city_train', 'funicular', 'transfer', 'walk', 'train', 'intercity_bus']) {
      assert.deepEqual(selectTileProviders({ tile: tileOf(empty), rows, ...kyiv }), [], `${empty} must not be advertised without a source that evidences it`);
    }
    assert.equal(selectTileProviders({ tile: tileOf('bus'), rows, ...kyiv }).length, 1);
    assert.equal(selectTileProviders({ tile: tileOf('tram'), rows, ...kyiv }).length, 1);
  });

  it('does not invent enabled commercial or long-distance providers when the registry has no connected source', () => {
    for (const empty of ['carpool', 'taxi', 'carsharing', 'transfer', 'train', 'intercity_bus']) {
      assert.deepEqual(selectTileProviders({ tile: tileOf(empty), rows: [], ...kyiv }), [], `${empty} remains unavailable without a registry-backed source`);
    }
  });

  it('does not advertise placeholder non-transit rows when no mode-specific offer or availability was observed', () => {
    const placeholders = [
      row({ name: 'Uklon', city: 'Україна', provider_type: 'taxi', source_type: 'taxi-ridehailing-api', last_report: { counts: {}, bbox: kyivBox } }),
      row({ name: 'Getmancar', city: 'Київ', provider_type: 'carsharing', source_type: 'carsharing-api', last_report: { counts: {}, bbox: kyivBox } }),
      row({ name: 'Kiwitaxi Ukraine', city: 'Україна', provider_type: 'transfer', source_type: 'transfer-api', last_report: { counts: {}, bbox: kyivBox } }),
      row({ name: 'MARSHGO Community', city: 'Україна', provider_type: 'carpool', source_type: 'marshgo', last_report: { counts: {}, bbox: kyivBox } }),
    ];
    for (const [mode, candidate] of [['taxi', placeholders[0]!], ['carsharing', placeholders[1]!], ['transfer', placeholders[2]!], ['carpool', placeholders[3]!]] as const) {
      assert.deepEqual(selectTileProviders({ tile: tileOf(mode), rows: [candidate], ...kyiv }), [], `${mode} requires mode-specific positive evidence`);
    }
  });

  it('accepts non-transit availability only after a positive mode-specific result', () => {
    const quote = row({ name: 'Authorized Taxi', city: 'Львів', provider_type: 'taxi', source_type: 'rest', last_report: { counts: { quotes_taxi: 2 }, bbox: [23.9, 49.7, 24.2, 49.95] } });
    assert.equal(selectTileProviders({ tile: tileOf('taxi'), rows: [quote], lat: 49.84, lon: 24.02 }).length, 1);
  });

  it('scopes a city tile to the search point and keeps nationwide sources out of city tiles', () => {
    const metroFeed = row({ last_report: { counts: { routes_metro: 3 }, bbox: kyivBox } });
    const lviv = { lat: 49.8397, lon: 24.0297 };
    assert.deepEqual(selectTileProviders({ tile: tileOf('metro'), rows: [metroFeed], ...lviv }), [], 'Kyiv metro must not appear for a Lviv search');
    assert.equal(selectTileProviders({ tile: tileOf('metro'), rows: [metroFeed], lat: null, lon: null }).length, 1, 'the global registry call has no point filter');
    const rail = row({ name: 'Укрзалізниця — розклад (GTFS)', city: 'Україна', source_type: 'gtfs', last_report: { counts: { routes_train: 115, routes_metro: 3 }, bbox: kyivBox } });
    assert.deepEqual(selectTileProviders({ tile: tileOf('metro'), rows: [rail], ...kyiv }), [], 'a nationwide source never serves a city tile');
    assert.equal(selectTileProviders({ tile: tileOf('train'), rows: [rail], ...kyiv }).length, 1);
  });

  it('requires confirmed geographic coverage for a nationwide source when the search point is known', () => {
    const railWithoutCoverage = row({ name: 'Укрзалізниця — розклад (GTFS)', city: 'Україна', source_type: 'gtfs', last_report: { counts: { routes_train: 115 } } });
    assert.deepEqual(selectTileProviders({ tile: tileOf('train'), rows: [railWithoutCoverage], ...kyiv }), []);
    assert.equal(selectTileProviders({ tile: tileOf('train'), rows: [railWithoutCoverage], lat: null, lon: null }).length, 1,
      'a national provider can remain listed when the query has no location yet');
  });

  it('counts only positive, mode-suffixed probe counts as a service', () => {
    assert.deepEqual([...providerServices({ counts: { routes_metro: 3, vehicles_metro: 0, routes_intercity_bus: 9, stops_metro: 52, features: 52 } })], ['metro']);
    assert.equal(providerServices(null).size, 0);
    assert.equal(providerServices({}).size, 0);
  });
});
