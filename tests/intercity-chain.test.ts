import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  composeChain,
  createWalkLeg,
  isStationHubName,
  isWithinVerifiedWalkingBounds,
  resolveAccessHub,
  resolveEgressHub,
  type ChainCandidateLeg,
  type ComposeChainBudget,
  MINIMUM_INTERCITY_TRANSFER_BUFFER_SECONDS,
  MAX_ALLOWED_CHAIN_TRANSFERS,
} from '../server/journey/intercityChain';
import type { GtfsTransportType } from '../server/journey/gtfsTimetable';

describe('Intercity Chain Composition & Hub Resolution (ARGON Wave 2)', () => {
  const baseTime = new Date('2026-11-04T08:00:00.000Z');

  const lvivStops = [
    { id: 'stop-lviv-station', name: 'Львів — Головний залізничний вокзал', lon: 23.9950, lat: 49.8357, city: 'Львів' },
    { id: 'stop-lviv-market', name: 'Площа Ринок', lon: 24.0323, lat: 49.8450, city: 'Львів' },
    { id: 'stop-lviv-bus', name: 'Автовокзал Львів (Стрийська)', lon: 24.0180, lat: 49.7865, city: 'Львів' },
  ];

  const kyivStops = [
    { id: 'stop-kyiv-pas', name: 'Київ-Пасажирський (Центральний вокзал)', lon: 30.4883, lat: 50.4417, city: 'Київ' },
    { id: 'stop-kyiv-khreshchatyk', name: 'Хрещатик', lon: 30.5227, lat: 50.4501, city: 'Київ' },
  ];

  it('identifies railway and bus station hub names by regex', () => {
    assert.equal(isStationHubName('Львів Головний вокзал'), true);
    assert.equal(isStationHubName('Київ-Пасажирський'), true);
    assert.equal(isStationHubName('Автостанція №2'), true);
    assert.equal(isStationHubName('Центральний автовокзал'), true);
    assert.equal(isStationHubName('Вул. Шевченка, 12'), false);
    assert.equal(isStationHubName('Площа Ринок'), false);
  });

  it('resolves closest access and egress hubs within corridor tolerance', () => {
    const origin = { name: 'Готель Жорж, Львів', coordinates: [24.0305, 49.8385] as [number, number] };
    const accessHub = resolveAccessHub(origin, lvivStops, 10_000);
    assert.ok(accessHub);
    assert.equal(accessHub.name, 'Львів — Головний залізничний вокзал');
    assert.equal(accessHub.hubType, 'railway_station');

    const destination = { name: 'Майдан Незалежності, Київ', coordinates: [30.5227, 50.4501] as [number, number] };
    const egressHub = resolveEgressHub(destination, kyivStops, 10_000);
    assert.ok(egressHub);
    assert.equal(egressHub.name, 'Київ-Пасажирський (Центральний вокзал)');
  });

  it('honors verified walking bounds: only within Lviv/Kyiv bbox can have osrm-foot-route', () => {
    // Lviv center is inside
    assert.equal(isWithinVerifiedWalkingBounds([24.0323, 49.8450]), true);
    // Kyiv center is inside
    assert.equal(isWithinVerifiedWalkingBounds([30.5227, 50.4501]), true);
    // Zhuliany south 50.2338 is outside Kyiv bbox [30.2, 50.25, 30.8, 50.62]
    assert.equal(isWithinVerifiedWalkingBounds([30.3511, 50.2338]), false);
    // Ivano-Frankivsk is outside
    assert.equal(isWithinVerifiedWalkingBounds([24.7264, 48.9236]), false);
    // Stryi is outside
    assert.equal(isWithinVerifiedWalkingBounds([23.8566, 49.2558]), false);

    // Walking leg inside Lviv with router flag
    const lvivWalk = createWalkLeg(
      { name: 'пл. Ринок', coordinates: [24.0323, 49.8450] },
      { name: 'Вокзал', coordinates: [23.9950, 49.8357] },
      baseTime,
      { hasRouterGeometry: true },
    );
    assert.equal(lvivWalk.geometrySource, 'osrm-foot-route');

    // Walking leg outside (Ivano-Frankivsk) even if requested with router
    const ifWalk = createWalkLeg(
      { name: 'Центр ІФ', coordinates: [24.7111, 48.9228] },
      { name: 'Вокзал ІФ', coordinates: [24.7264, 48.9236] },
      baseTime,
      { hasRouterGeometry: true },
    );
    assert.equal(ifWalk.geometrySource, 'straight-line-estimate');
  });

  it('strictly enforces the minimum 600s intercity transfer buffer', () => {
    const budget: ComposeChainBudget = {
      requestedDepartureAt: baseTime,
      minimumIntercityBufferSeconds: MINIMUM_INTERCITY_TRANSFER_BUFFER_SECONDS,
    };

    const lvivTram: ChainCandidateLeg = {
      id: 'lviv-tram-1',
      mode: 'TRAM',
      transportType: 'tram',
      origin: { name: 'пл. Ринок', coordinates: [24.0323, 49.8450] },
      destination: { name: 'Вокзал', coordinates: [23.9950, 49.8357] },
      departureAt: new Date(baseTime.getTime() + 10 * 60_000), // 08:10
      arrivalAt: new Date(baseTime.getTime() + 25 * 60_000), // 08:25
      durationSeconds: 15 * 60,
      distanceMeters: 3000,
      priceMinor: 2500, // 25 UAH LeoCard
      fareKnown: true,
      currency: 'UAH',
      geometrySource: 'gtfs_shape',
    };

    // Train departs at 08:30 -> buffer is 5 minutes (300s) < 600s requirement -> REJECT
    const tooTightTrain: ChainCandidateLeg = {
      id: 'uz-train-tight',
      mode: 'RAIL',
      transportType: 'train',
      origin: { name: 'Львів Вокзал', coordinates: [23.9950, 49.8357] },
      destination: { name: 'Київ-Пасажирський', coordinates: [30.4883, 50.4417] },
      departureAt: new Date(baseTime.getTime() + 30 * 60_000), // 08:30 (gap = 300s)
      arrivalAt: new Date(baseTime.getTime() + 330 * 60_000), // 13:30
      durationSeconds: 300 * 60,
      distanceMeters: 550_000,
      priceMinor: null, // UZ GTFS has no fares
      fareKnown: false,
      currency: null,
      geometrySource: 'gtfs_shape',
    };

    const rejected = composeChain([lvivTram], tooTightTrain, [], budget);
    assert.equal(rejected, null, 'Chain must be rejected when intercity transfer buffer < 600s');

    // Train departs at 08:40 -> buffer is 15 minutes (900s) >= 600s -> ACCEPT
    const validTrain: ChainCandidateLeg = {
      ...tooTightTrain,
      id: 'uz-train-valid',
      departureAt: new Date(baseTime.getTime() + 40 * 60_000), // 08:40 (gap = 900s)
      arrivalAt: new Date(baseTime.getTime() + 340 * 60_000), // 13:40
    };

    const accepted = composeChain([lvivTram], validTrain, [], budget);
    assert.ok(accepted);
    assert.equal(accepted.legs.length, 2);
    assert.equal(accepted.transfers, 1);
  });

  it('keeps total price as null when any transit leg fare is unknown (Red Line 1)', () => {
    const budget: ComposeChainBudget = {
      requestedDepartureAt: baseTime,
    };

    const lvivBus: ChainCandidateLeg = {
      id: 'lviv-bus-29',
      mode: 'BUS',
      transportType: 'bus',
      origin: { name: 'пл. Ринок', coordinates: [24.0323, 49.8450] },
      destination: { name: 'Вокзал', coordinates: [23.9950, 49.8357] },
      departureAt: new Date(baseTime.getTime() + 10 * 60_000),
      arrivalAt: new Date(baseTime.getTime() + 25 * 60_000),
      durationSeconds: 15 * 60,
      distanceMeters: 3000,
      priceMinor: 2500, // Known 25 грн
      fareKnown: true,
      currency: 'UAH',
      geometrySource: 'gtfs_shape',
    };

    const uzTrainNoFare: ChainCandidateLeg = {
      id: 'uz-train-nofare',
      mode: 'RAIL',
      transportType: 'train',
      origin: { name: 'Львів Вокзал', coordinates: [23.9950, 49.8357] },
      destination: { name: 'Київ-Пасажирський', coordinates: [30.4883, 50.4417] },
      departureAt: new Date(baseTime.getTime() + 45 * 60_000),
      arrivalAt: new Date(baseTime.getTime() + 345 * 60_000),
      durationSeconds: 300 * 60,
      distanceMeters: 550_000,
      priceMinor: null, // Unknown fare
      fareKnown: false,
      currency: null,
      geometrySource: 'gtfs_shape',
    };

    const kyivBus: ChainCandidateLeg = {
      id: 'kyiv-bus-114',
      mode: 'BUS',
      transportType: 'bus',
      origin: { name: 'Київ-Пасажирський', coordinates: [30.4883, 50.4417] },
      destination: { name: 'Хрещатик', coordinates: [30.5227, 50.4501] },
      departureAt: new Date(baseTime.getTime() + 360 * 60_000),
      arrivalAt: new Date(baseTime.getTime() + 375 * 60_000),
      durationSeconds: 15 * 60,
      distanceMeters: 3500,
      priceMinor: 800, // Known 8 грн
      fareKnown: true,
      currency: 'UAH',
      geometrySource: 'gtfs_shape',
    };

    const chain = composeChain([lvivBus], uzTrainNoFare, [kyivBus], budget);
    assert.ok(chain);
    assert.equal(chain.fareKnown, false, 'Chain must be marked fareKnown=false');
    assert.equal(chain.totalPriceMinor, null, 'Total price must be null when one leg fare is unknown');
    assert.equal(chain.transfers, 2);
  });

  it('rejects chains exceeding MAX_ALLOWED_CHAIN_TRANSFERS = 4 (ceiling rule)', () => {
    const budget: ComposeChainBudget = {
      requestedDepartureAt: baseTime,
      maximumTransfers: MAX_ALLOWED_CHAIN_TRANSFERS,
    };

    const leg = (id: string, startMin: number, endMin: number, fromCoord: [number, number], toCoord: [number, number], mode: 'BUS' | 'RAIL' = 'BUS', tType: GtfsTransportType = 'bus'): ChainCandidateLeg => ({
      id,
      mode,
      transportType: tType,
      origin: { name: `A-${id}`, coordinates: fromCoord },
      destination: { name: `B-${id}`, coordinates: toCoord },
      departureAt: new Date(baseTime.getTime() + startMin * 60_000),
      arrivalAt: new Date(baseTime.getTime() + endMin * 60_000),
      durationSeconds: (endMin - startMin) * 60,
      distanceMeters: 1000,
      priceMinor: 1000,
      fareKnown: true,
      currency: 'UAH',
      geometrySource: 'gtfs_shape',
    });

    const p1: [number, number] = [24.00, 49.80];
    const p2: [number, number] = [24.01, 49.81];
    const p3: [number, number] = [24.02, 49.82];
    const p4: [number, number] = [30.48, 50.44];
    const p5: [number, number] = [30.50, 50.45];
    const p6: [number, number] = [30.52, 50.46];

    const access1 = leg('acc1', 0, 10, p1, p2);
    const access2 = leg('acc2', 15, 25, p2, p3);
    const access3 = leg('acc3', 30, 40, p3, p3);
    const intercity = leg('intercity', 55, 120, p3, p4, 'RAIL', 'train');
    const egress1 = leg('egress1', 135, 145, p4, p5);
    const egress2 = leg('egress2', 150, 160, p5, p6);

    // Total transit legs = 3 access + 1 intercity + 2 egress = 6 transit legs -> 5 transfers > 4
    const rejected = composeChain([access1, access2, access3], intercity, [egress1, egress2], budget);
    assert.equal(rejected, null, 'Must reject chains with > 4 transfers');

    // 2 access + 1 intercity + 2 egress = 5 transit legs -> 4 transfers -> ACCEPT
    const accepted = composeChain([access1, access2], intercity, [egress1, egress2], budget);
    assert.ok(accepted);
    assert.equal(accepted.transfers, 4);
  });
});
