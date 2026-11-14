import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeStations, normalizeVehicles, pointIsInsideUkraine } from '../server/mobility/gbfs';
import { routeTypeLabel } from '../server/mobility/gtfs';
import { classifyLvivTransport } from '../server/mobility/lvivTransportClassifier';
import { selectNearby } from '../server/mobility/nearby';

// Rows as published by the live Lviv GTFS feed (Львівавтодор v6.507) measured 2026-11-10.
const lvivRoute = (shortName: string, longName: string) =>
  `${shortName} ${longName} `;

describe('Lviv GTFS route classification keeps its evidence boundary', () => {
  it('does not turn a generic bus-typed Lviv route into a marshrutka', () => {
    const name = lvivRoute('А25', 'ТЦ Кінг Кросс - вул. Заклинських');
    const classification = classifyLvivTransport({ routeType: 3, routeName: name });
    assert.equal(classification?.classifiedType, 'bus_unspecified');
    assert.equal(classification?.serviceClass, 'UNRESOLVED');
    assert.equal(classification?.reviewStatus, 'REVIEW_REQUIRED');
    assert.equal(routeTypeLabel(3, name), 'bus');
  });

  it('keeps every А-prefixed Lviv agency route out of the marshrutka label', () => {
    const measured = [['А01', 'м. Дубляни - пл. Галицька'], ['А99', 'площа Галицька – Музей народної архітектури'],
      ['А08а', 'вул. Зернова - смт. Брюховичі'], ['А47', 'Санта Барбара - Рясне-2'], ['А63', 'вул. Під дубом - с. Воля-Гамулецька']];
    for (const [shortName, longName] of measured) {
      assert.notEqual(routeTypeLabel(3, lvivRoute(shortName, longName)), 'marshrutka', shortName);
      assert.equal(classifyLvivTransport({ routeType: 3, routeName: lvivRoute(shortName, longName) })?.classifiedType, 'bus_unspecified', shortName);
    }
  });

  it('resolves the trolleybus routes the feed mis-types as route_type=3', () => {
    for (const shortName of ['Тр22', 'Тр23', 'Тр24', 'Тр25', 'Тр27', 'Тр30', 'Тр31', 'Тр32', 'Тр38']) {
      assert.equal(routeTypeLabel(3, lvivRoute(shortName, 'Університет - вул. Суботівська')), 'trolleybus', shortName);
      assert.equal(classifyLvivTransport({ routeType: 3, routeName: lvivRoute(shortName, 'Університет - вул. Суботівська') }), null, shortName);
    }
  });

  it('labels the tram routes carried as route_type=0', () => {
    for (const shortName of ['Т01', 'Т04', 'Т07', 'Т09']) {
      assert.equal(routeTypeLabel(0, lvivRoute(shortName, 'Залізничний вокзал - Погулянка')), 'tram', shortName);
    }
  });

  it('requires an explicit communal-taxi type before claiming a marshrutka', () => {
    assert.equal(routeTypeLabel(1501, lvivRoute('5', 'пл. Ринок - вул. Нагірна')), 'marshrutka');
    assert.equal(classifyLvivTransport({ routeType: 1501, routeName: '5 пл. Ринок - вул. Нагірна' })?.reviewStatus, 'REVIEW_REQUIRED');
    assert.equal(routeTypeLabel(3, lvivRoute('5', 'Маршрутка № 5 - пл. Ринок')), 'marshrutka');
  });
});

describe('GBFS inventory is rejected outside the provider’s declared country', () => {
  const types = { data: { vehicle_types: [{ vehicle_type_id: 's1', form_factor: 'scooter', propulsion_type: 'electric' }] } };
  // The catalogued Zelectra discovery URL mixes Kyiv and Lima vehicles (measured bbox -77.06,-12.05 … 30.56,50.47).
  const status = { last_updated: 1_794_294_856, data: { vehicles: [
    { vehicle_id: 'kyiv-1', vehicle_type_id: 's1', lon: 30.5234, lat: 50.4501 },
    { vehicle_id: 'lima-1', vehicle_type_id: 's1', lon: -77.042, lat: -12.046 },
    { vehicle_id: 'lviv-none', vehicle_type_id: 's1', lon: 24.031, lat: 49.842 },
  ] } };

  it('drops non-Ukrainian vehicles and keeps Ukrainian ones', () => {
    const ua = normalizeVehicles('zelectra', types, status, 'UA');
    assert.deepEqual(ua.assets.map((asset) => asset.id).sort(), ['kyiv-1', 'lviv-none']);
    assert.equal(ua.rejected, 1);
    const unfiltered = normalizeVehicles('zelectra', types, status);
    assert.equal(unfiltered.assets.length, 3);
  });

  it('serves neither Kyiv nor Lima coordinates as Lviv supply', () => {
    // Shape measured from the catalogued Zelectra URL on 2026-11-10: only foreign and Kyiv points, none in Lviv.
    const zelectraLike = { last_updated: 1_794_294_856, data: { vehicles: [
      { vehicle_id: 'kyiv-1', vehicle_type_id: 's1', lon: 30.5234, lat: 50.4501 },
      { vehicle_id: 'lima-1', vehicle_type_id: 's1', lon: -77.042, lat: -12.046 },
    ] } };
    const lvivBox: [number, number, number, number] = [23.85, 49.70, 24.35, 49.90];
    const inLviv = (point: [number, number]) => point[0] >= lvivBox[0] && point[0] <= lvivBox[2]
      && point[1] >= lvivBox[1] && point[1] <= lvivBox[3];
    const assets = normalizeVehicles('zelectra', types, zelectraLike, 'UA').assets;
    assert.equal(assets.length, 1, 'the Lima vehicle must be rejected before it can be mapped');
    for (const asset of assets) assert.equal(inLviv(asset.location), false, asset.id);
    const nearby = selectNearby([{
      providerId: 'zelectra', providerName: 'Zelectra', snapshot: {
        assets, stations: [], fetchedAt: Date.now(), lastUpdated: Date.now(), staleAfterSeconds: 60,
      },
    }], [24.031, 49.842], 3_000, ['SCOOTER']);
    assert.equal(nearby.totalAssets, 0, 'Kyiv inventory must not appear as a Lviv scooter');
    // A Lviv coordinate, if a Lviv system ever publishes one, is inside the box; the gate is the box, not the provider name.
    assert.equal(inLviv([24.031, 49.842]), true);
  });

  it('rejects stations outside Ukraine instead of counting them as local docks', () => {
    const info = { data: { stations: [
      { station_id: 'lv', name: 'Lviv dock', lon: 24.031, lat: 49.842, capacity: 10 },
      { station_id: 'riga', name: 'Riga dock', lon: 24.1, lat: 56.95, capacity: 10 },
    ] } };
    const statusStations = { data: { stations: [{ station_id: 'lv', num_bikes_available: 4 }, { station_id: 'riga', num_bikes_available: 9 }] } };
    const result = normalizeStations('nextbike', info, statusStations, 'UA');
    assert.deepEqual(result.stations.map((station) => station.id), ['lv']);
    assert.equal(result.rejected, 1);
  });

  it('keeps the Ukraine boundary decision that both gates rely on', () => {
    assert.equal(pointIsInsideUkraine([30.5234, 50.4501]), true);
    assert.equal(pointIsInsideUkraine([-77.042, -12.046]), false);
    assert.equal(pointIsInsideUkraine([24.031, 49.842]), true);
  });
});

describe('an unusable feed payload degrades instead of producing inventory', () => {
  it('counts malformed vehicles as rejected and never throws', () => {
    const types = { data: { vehicle_types: [{ vehicle_type_id: 'b1', form_factor: 'bicycle' }] } };
    const status = { data: { vehicles: [
      { vehicle_id: 'ok', vehicle_type_id: 'b1', lon: 24.031, lat: 49.842 },
      { vehicle_id: 'no-coords', vehicle_type_id: 'b1' },
      { vehicle_id: 'ocean', vehicle_type_id: 'b1', lon: 0, lat: 0 },
      { vehicle_id: 'unknown-type', vehicle_type_id: 'zz', lon: 24.031, lat: 49.842 },
      'not-an-object',
    ] } };
    const result = normalizeVehicles('nextbike', types, status, 'UA');
    assert.deepEqual(result.assets.map((asset) => asset.id), ['ok']);
    assert.equal(result.rejected, 4);
    assert.equal(result.assets[0]?.available, true);
  });

  it('treats a disabled or reserved vehicle as unavailable rather than dropping the feed', () => {
    const types = { data: { vehicle_types: [{ vehicle_type_id: 'b1', form_factor: 'bicycle' }] } };
    const result = normalizeVehicles('nextbike', types, { data: { vehicles: [
      { vehicle_id: 'r', vehicle_type_id: 'b1', lon: 24.031, lat: 49.842, is_reserved: true },
      { vehicle_id: 'd', vehicle_type_id: 'b1', lon: 24.032, lat: 49.843, is_disabled: true },
    ] } }, 'UA');
    assert.equal(result.assets.length, 2);
    assert.deepEqual(result.assets.map((asset) => asset.available), [false, false]);
  });
});
