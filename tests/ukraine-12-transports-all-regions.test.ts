import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getAllRegions,
  findRegion,
  findRegionByCoordinates,
  getTransportCatalogForCity,
  canonicalTransportTypes,
  type CanonicalTransportTypeId,
} from '../server/mobility/ukraineRegionalCatalog';
import { composeUkraineMultimodalChains } from '../server/journey/multimodalChainEngine';

describe('Ukraine regional transport catalog metadata', () => {
  it('covers exactly all 26 regions: 24 Oblasts + Kyiv City + Crimea', () => {
    const regions = getAllRegions();
    assert.equal(regions.length, 26, 'Must contain exactly 26 administrative units');

    const expectedRegionIds = [
      'kyiv',
      'lviv-oblast',
      'vinnytsia-oblast',
      'dnipropetrovsk-oblast',
      'kharkiv-oblast',
      'odesa-oblast',
      'ivano-frankivsk-oblast',
      'rivne-oblast',
      'zakarpattia-oblast',
      'khmelnytskyi-oblast',
      'kyiv-oblast',
      'poltava-oblast',
      'sumy-oblast',
      'kirovohrad-oblast',
      'zaporizhzhia-oblast',
      'volyn-oblast',
      'zhytomyr-oblast',
      'ternopil-oblast',
      'chernihiv-oblast',
      'cherkasy-oblast',
      'chernivtsi-oblast',
      'mykolaiv-oblast',
      'kherson-oblast',
      'donetsk-oblast',
      'luhansk-oblast',
      'crimea',
    ];

    const actualIds = regions.map((r) => r.id);
    for (const expectedId of expectedRegionIds) {
      assert.ok(actualIds.includes(expectedId), `Missing region: ${expectedId}`);
    }
  });

  it('lists the 12 canonical transport IDs with regional status metadata (not feed activation)', () => {
    const regions = getAllRegions();
    const expectedModes: CanonicalTransportTypeId[] = [
      'bus',
      'marshrutka',
      'trolleybus',
      'tram',
      'metro',
      'carpool',
      'taxi',
      'train',
      'bike',
      'scooter',
      'carsharing',
      'transfer',
    ];

    assert.deepEqual([...canonicalTransportTypes], expectedModes);

    for (const region of regions) {
      assert.ok(region.name, `Region ${region.id} must have a name`);
      assert.ok(region.capital, `Region ${region.id} must have a capital`);
      assert.ok(region.bbox && region.bbox.length === 4, `Region ${region.id} must have a 4-point bbox`);
      assert.ok(region.majorCities.length > 0, `Region ${region.id} must have major cities`);

      for (const modeId of expectedModes) {
        const mode = region.transportModes[modeId];
        assert.ok(mode, `Region ${region.name} (${region.id}) is missing mode: ${modeId}`);
        assert.ok(typeof mode.available === 'boolean', `Region ${region.id} mode ${modeId} must have boolean available`);
        assert.ok(
          ['AVAILABLE', 'LIMITED', 'REQUIRES_CONTRACT', 'NOT_AVAILABLE_IN_CITY'].includes(mode.status),
          `Region ${region.id} mode ${modeId} has invalid status: ${mode.status}`,
        );
        assert.ok(Array.isArray(mode.capabilities), `Region ${region.id} mode ${modeId} must have capabilities array`);
        assert.ok(Array.isArray(mode.sources), `Region ${region.id} mode ${modeId} must have sources array`);
      }
    }
  });

  it('correctly resolves region by coordinates across Ukraine', () => {
    // Kyiv
    const kyiv = findRegionByCoordinates(30.5234, 50.4501);
    assert.ok(kyiv, 'Kyiv coordinates should resolve');
    assert.equal(kyiv.id, 'kyiv');

    // Lviv
    const lviv = findRegionByCoordinates(24.0315, 49.8418);
    assert.ok(lviv, 'Lviv coordinates should resolve');
    assert.equal(lviv.id, 'lviv-oblast');

    // Odesa
    const odesa = findRegionByCoordinates(30.7412, 46.4674);
    assert.ok(odesa, 'Odesa coordinates should resolve');
    assert.equal(odesa.id, 'odesa-oblast');

    // Kharkiv
    const kharkiv = findRegionByCoordinates(36.2325, 49.9928);
    assert.ok(kharkiv, 'Kharkiv coordinates should resolve');
    assert.equal(kharkiv.id, 'kharkiv-oblast');

    // Dnipro
    const dnipro = findRegionByCoordinates(35.0485, 48.4645);
    assert.ok(dnipro, 'Dnipro coordinates should resolve');
    assert.equal(dnipro.id, 'dnipropetrovsk-oblast');

    // Vinnytsia
    const vinnytsia = findRegionByCoordinates(28.4682, 49.2330);
    assert.ok(vinnytsia, 'Vinnytsia coordinates should resolve');
    assert.equal(vinnytsia.id, 'vinnytsia-oblast');

    // Chernivtsi
    const chernivtsi = findRegionByCoordinates(25.9390, 48.3000);
    assert.ok(chernivtsi, 'Chernivtsi coordinates should resolve');
    assert.equal(chernivtsi.id, 'chernivtsi-oblast');

    // Crimea (Simferopol)
    const crimea = findRegionByCoordinates(34.1025, 44.9521);
    assert.ok(crimea, 'Simferopol coordinates should resolve to Crimea');
    assert.equal(crimea.id, 'crimea');
  });

  it('guarantees carpool availability nationwide across all 26 regions', () => {
    for (const region of getAllRegions()) {
      const carpool = region.transportModes.carpool;
      assert.equal(carpool.available, true, `Carpool must be available in ${region.name}`);
      assert.equal(carpool.status, 'AVAILABLE');
      assert.ok(carpool.sources.some((s) => s.type === 'INTERNAL'));
    }
  });

  it('records the UZ source in the regional catalog without claiming loaded route coverage', () => {
    for (const region of getAllRegions()) {
      const train = region.transportModes.train;
      assert.ok(train.sources.some((s) => s.name.includes('Укрзалізниця')), `Train in ${region.name} must reference Укрзалізниця`);
    }
  });

  it('provides honest status for rail transit: Metro present in Kyiv, Kharkiv, Dnipro, absent in others', () => {
    const kyivMetro = findRegion('kyiv')?.transportModes.metro;
    assert.equal(kyivMetro?.available, true);
    assert.ok(kyivMetro?.capabilities.includes('TRANSIT_STOPS') || kyivMetro?.capabilities.includes('SCHEDULE'));

    const kharkivMetro = findRegion('kharkiv-oblast')?.transportModes.metro;
    assert.equal(kharkivMetro?.available, true);

    const dniproMetro = findRegion('dnipropetrovsk-oblast')?.transportModes.metro;
    assert.equal(dniproMetro?.available, true);

    const lvivMetro = findRegion('lviv-oblast')?.transportModes.metro;
    assert.equal(lvivMetro?.available, false);
    assert.equal(lvivMetro?.status, 'NOT_AVAILABLE_IN_CITY');
    assert.match(lvivMetro?.reason ?? '', /Метрополітен відсутній/);
  });

  it('provides honest status for electric tram networks', () => {
    const lvivTram = findRegion('lviv-oblast')?.transportModes.tram;
    assert.equal(lvivTram?.available, true);
    assert.ok(lvivTram?.sources.some((s) => s.name.includes('Львівавтодор') || s.name.includes('Львівелектротранс')));

    const odesaTram = findRegion('odesa-oblast')?.transportModes.tram;
    assert.equal(odesaTram?.available, true);

    const vinnytsiaTram = findRegion('vinnytsia-oblast')?.transportModes.tram;
    assert.equal(vinnytsiaTram?.available, true);
  });

  it('returns 12 catalog DTOs for supported cities without asserting live provider availability', () => {
    for (const city of ['Київ', 'Львів', 'Одеса', 'Харків', 'Дніпро', 'Полтава', 'Вінниця', 'Чернівці']) {
      const catalog = getTransportCatalogForCity(city);
      assert.equal(catalog.length, 12, `City ${city} catalog must have 12 entries`);
      assert.deepEqual(catalog.map((m) => m.id), canonicalTransportTypes);
      assert.equal(catalog.find((m) => m.id === 'carpool')?.enabled, true);
    }
  });

  it('does not present static intercity corridor estimates as scheduled trains', async () => {
    // Intercity departures, availability, fares, stops and track geometry must come from
    // eligible dated GTFS/API data. The static corridor catalog is not a timetable.
    const lvivToKyiv = await composeUkraineMultimodalChains({
      origin: { name: 'пл. Ринок (Львів)', coordinates: [24.0315, 49.8418] },
      destination: { name: 'Майдан Незалежності (Київ)', coordinates: [30.5234, 50.4501] },
      departureAt: new Date(Date.now() + 3600_000),
      passengers: 1,
      strategy: 'BALANCED',
      preferences: { allowPublicTransport: true, allowTaxi: true, allowedTransportTypes: ['train', 'tram', 'taxi'] },
    });

    assert.equal(lvivToKyiv.some((candidate) => candidate.legs.some((leg) => leg.mode === 'RAIL')), false,
      'a real rail candidate must be supplied by the scheduled-feed search, not the static corridor table');

    // Lviv → Odesa composes two rail corridors through Kyiv. The 30-minute connection is
    // represented by the schedule gap; no synthetic 200 m walk may be drawn at one coordinate.
    const lvivToOdesa = await composeUkraineMultimodalChains({
      origin: { name: 'центр Львова', coordinates: [24.0315, 49.8418] },
      destination: { name: 'центр Одеси', coordinates: [30.7233, 46.4825] },
      departureAt: new Date(Date.now() + 3600_000),
      passengers: 1,
      strategy: 'BALANCED',
      preferences: { allowPublicTransport: true, allowTaxi: true, allowedTransportTypes: ['train', 'tram', 'taxi'] },
    });
    assert.equal(lvivToOdesa.some((candidate) => candidate.legs.some((leg) => leg.mode === 'RAIL')), false,
      'two static corridors must not be composed into a date-independent rail itinerary');
  });

  it('does not emit regional city transit from an unconnected static station list', async () => {
    const point = (name: string, coordinates: [number, number]) => ({ name, coordinates });
    const cityPairs = [
      {
        origin: point('Сихів, Львів', [24.0560, 49.7942]),
        destination: point('Львів-Головний', [23.9950, 49.8358]),
      },
      {
        origin: point('центр Одеси', [30.7675, 46.4298]),
        destination: point('вокзал Одеса', [30.7412, 46.4674]),
      },
      {
        origin: point('центр Харкова', [36.3245, 50.0245]),
        destination: point('вокзал Харків', [36.2050, 49.9880]),
      },
      {
        origin: point('центр Дніпра', [34.9255, 48.4835]),
        destination: point('вокзал Дніпро', [35.0165, 48.4760]),
      },
    ];

    for (const pair of cityPairs) {
      const journeys = await composeUkraineMultimodalChains({
        ...pair,
        departureAt: new Date('2026-11-15T08:00:00.000Z'),
        passengers: 1,
        strategy: 'FASTEST',
        preferences: { allowPublicTransport: true, allowedTransportTypes: ['bus', 'tram', 'trolleybus', 'metro'] },
      });
      assert.equal(journeys.some((journey) => journey.source === 'ukraine-city-data'
        || journey.legs.some((leg) => leg.source === 'ukraine-city-data')), false,
        `${pair.origin.name} to ${pair.destination.name} must come from a connected dated feed, not nearest static station pairing`);
    }
  });
});
