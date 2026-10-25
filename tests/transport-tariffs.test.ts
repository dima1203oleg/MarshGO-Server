import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCityTariffFare, getTransportFareCatalog } from '../server/mobility/transportTariffs';

function leg(input: {
  city?: string;
  mode?: string;
  type?: string;
  departure: string;
  arrival: string;
}) {
  return {
    providerCity: input.city,
    mode: input.mode ?? input.type ?? 'BUS',
    transportType: input.type ?? 'bus',
    departureAt: new Date(input.departure),
    arrivalAt: new Date(input.arrival),
  };
}

test('Kyiv combines communal legs under the 90-minute QR product and reports each fare allocation', () => {
  const fare = calculateCityTariffFare([
    leg({ city: 'Київ', departure: '2026-10-13T08:00:00Z', arrival: '2026-10-13T08:15:00Z' }),
    leg({ city: 'Київ', departure: '2026-10-13T08:22:00Z', arrival: '2026-10-13T08:40:00Z', type: 'tram' }),
    leg({ city: 'Київ', departure: '2026-10-13T08:48:00Z', arrival: '2026-10-13T09:00:00Z', type: 'metro' }),
  ]);
  assert.equal(fare?.priceMinor, 6_000);
  assert.equal(fare?.source, 'city-tariff-registry');
  assert.deepEqual(fare?.allocations.map((item) => item.priceMinor), [6_000, 0, 0]);
  assert.deepEqual(fare?.allocations.map((item) => item.includedByPreviousFare), [false, true, true]);
});

test('Kyiv does not apply the city transfer ticket to private marshrutka services', () => {
  const fare = calculateCityTariffFare([
    leg({ city: 'Київ', departure: '2026-10-13T08:00:00Z', arrival: '2026-10-13T08:20:00Z', type: 'marshrutka' }),
  ]);
  assert.equal(fare, null);
});

test('Lviv LeoCard fare estimates apply a 40-minute transfer once, then charge again', () => {
  const fare = calculateCityTariffFare([
    leg({ city: 'Львів', departure: '2026-10-13T08:00:00Z', arrival: '2026-10-13T08:18:00Z' }),
    leg({ city: 'Львів', departure: '2026-10-13T08:25:00Z', arrival: '2026-10-13T08:42:00Z', type: 'tram' }),
    leg({ city: 'Львів', departure: '2026-10-13T08:44:01Z', arrival: '2026-10-13T08:56:00Z', type: 'trolleybus' }),
  ]);
  assert.equal(fare?.priceMinor, 4_600);
  assert.deepEqual(fare?.allocations.map((item) => item.priceMinor), [2_300, 0, 2_300]);
});

test('Lviv does not assign its integrated public transport tariff to a private minibus', () => {
  const fare = calculateCityTariffFare([
    leg({ city: 'Львів', departure: '2026-10-13T08:00:00Z', arrival: '2026-10-13T08:20:00Z', type: 'marshrutka' }),
  ]);
  assert.equal(fare, null);
});

test('Lviv ATP-1 single fares and transfer rule record the current source verification date', () => {
  const records = getTransportFareCatalog({ city: 'Львів' })
    .filter((record) => ['lviv-leocard-adult', 'lviv-bank-card-adult', 'lviv-cash-adult', 'lviv-student-leocard', 'lviv-leocard-40-minute-transfer'].includes(record.id));
  assert.equal(records.length, 5);
  assert.ok(records.every((record) => record.status === 'verified_static' && record.lastVerifiedAt === '2026-10-25'));
});

test('Dnipro metro is priced at 10 UAH and Kharkiv metro at the published free fare', () => {
  const dnipro = calculateCityTariffFare([
    leg({ city: 'Дніпро', type: 'metro', departure: '2026-10-13T08:00:00Z', arrival: '2026-10-13T08:20:00Z' }),
  ]);
  const kharkiv = calculateCityTariffFare([
    leg({ city: 'Харків', type: 'metro', departure: '2026-10-13T08:00:00Z', arrival: '2026-10-13T08:20:00Z' }),
  ]);
  assert.equal(dnipro?.priceMinor, 1_000);
  assert.equal(kharkiv?.priceMinor, 0);
});

test('unknown city, mixed-city, and unsupported modal fares stay unknown', () => {
  assert.equal(calculateCityTariffFare([
    leg({ city: undefined, departure: '2026-10-13T08:00:00Z', arrival: '2026-10-13T08:20:00Z' }),
  ]), null);
  assert.equal(calculateCityTariffFare([
    leg({ city: 'Київ', departure: '2026-10-13T08:00:00Z', arrival: '2026-10-13T08:20:00Z' }),
    leg({ city: 'Львів', type: 'tram', departure: '2026-10-13T08:30:00Z', arrival: '2026-10-13T08:45:00Z' }),
  ]), null);
  assert.equal(calculateCityTariffFare([
    leg({ city: 'Київ', type: 'taxi', mode: 'TAXI', departure: '2026-10-13T08:00:00Z', arrival: '2026-10-13T08:20:00Z' }),
  ]), null);
});

test('fare catalog preserves Kyiv tier ranges and product effective dates', () => {
  const kyiv = getTransportFareCatalog({ city: 'Київ' });
  const middleTier = kyiv.find((record) => record.id === 'kyiv-stored-value-20-29');
  const transfer = kyiv.find((record) => record.id === 'kyiv-90-minute-transfer-ticket');
  assert.equal(middleTier?.minRideCount, 20);
  assert.equal(middleTier?.maxRideCount, 29);
  assert.equal(middleTier?.priceMinor, null);
  assert.equal(middleTier?.pricePerRideMinor, 2_780);
  assert.equal(transfer?.effectiveFrom, '2026-08-01');
  assert.equal(transfer?.priceMinor, 6_000);
});

test('Lviv monthly fare records do not invent an exact validity window', () => {
  const records = getTransportFareCatalog({ city: 'Львів' }).filter((record) => record.kind === 'monthly_pass');
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.validitySeconds === undefined));
  assert.ok(records.every((record) => record.effectiveFrom === undefined));
});
