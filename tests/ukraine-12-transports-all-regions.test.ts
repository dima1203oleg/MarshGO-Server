import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  UKRAINE_REGIONS,
  getAllRegions,
  findRegion,
  findRegionByCoordinates,
  getTransportCatalogForCity,
  canonicalTransportTypes,
  type CanonicalTransportTypeId,
} from '../server/mobility/ukraineRegionalCatalog';
import { composeUkraineMultimodalChains } from '../server/journey/multimodalChainEngine';
import { planCityTransitJourneys } from '../server/mobility/ukraineTransitGraph';

describe('Ukraine 12 Canonical Transports across all 26 Regions', () => {
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

  it('provides all 12 canonical transport modes in every single region without exception', () => {
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

  it('guarantees railway connectivity across Ukraine through Ukrzaliznytsia', () => {
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

  it('returns exactly 12 catalog DTOs from getTransportCatalogForCity for any city', () => {
    for (const city of ['Київ', 'Львів', 'Одеса', 'Харків', 'Дніпро', 'Полтава', 'Вінниця', 'Чернівці']) {
      const catalog = getTransportCatalogForCity(city);
      assert.equal(catalog.length, 12, `City ${city} catalog must have 12 entries`);
      assert.deepEqual(catalog.map((m) => m.id), canonicalTransportTypes);
      assert.equal(catalog.find((m) => m.id === 'carpool')?.enabled, true);
    }
  });

  it('generates cross-oblast multimodal chains across Ukraine', async () => {
    // Intercity Corridor: Lviv to Kyiv
    const lvivToKyiv = await composeUkraineMultimodalChains({
      origin: { name: 'пл. Ринок (Львів)', coordinates: [24.0315, 49.8418] },
      destination: { name: 'Майдан Незалежності (Київ)', coordinates: [30.5234, 50.4501] },
      departureAt: new Date(Date.now() + 3600_000),
      passengers: 1,
      strategy: 'BALANCED',
      preferences: { allowPublicTransport: true, allowTaxi: true, allowedTransportTypes: ['train', 'tram', 'taxi'] },
    });

    assert.ok(lvivToKyiv.length > 0, 'Should find Lviv to Kyiv multimodal chain');
    const railChain = lvivToKyiv.find((c) => c.legs.some((l) => l.mode === 'RAIL'));
    assert.ok(railChain, 'Should have rail leg for Lviv to Kyiv');
    assert.ok(railChain.legs.length >= 3, 'Must have at least first-mile, rail, last-mile');
  });

  it('generates intra-city transit itineraries across multiple Ukrainian oblast capitals', () => {
    // 1. Lviv (Львівська обл.)
    const lviv = planCityTransitJourneys('Львів', [24.0560, 49.7942], [23.9950, 49.8358], 2500);
    assert.ok(lviv.length > 0);
    assert.equal(lviv[0].segments[0].transportType, 'tram');

    // 2. Odesa (Одеська обл.)
    const odesa = planCityTransitJourneys('Одеса', [30.7675, 46.4298], [30.7412, 46.4674], 2500);
    assert.ok(odesa.length > 0);
    assert.equal(odesa[0].segments[0].transportType, 'tram');

    // 3. Kharkiv (Харківська обл.)
    const kharkiv = planCityTransitJourneys('Харків', [36.3245, 50.0245], [36.2050, 49.9880], 2500);
    assert.ok(kharkiv.length > 0);
    assert.equal(kharkiv[0].segments[0].transportType, 'metro');

    // 4. Dnipro (Дніпропетровська обл.)
    const dnipro = planCityTransitJourneys('Дніпро', [34.9255, 48.4835], [35.0165, 48.4760], 2500);
    assert.ok(dnipro.length > 0);
    assert.equal(dnipro[0].segments[0].transportType, 'metro');
  });
});
