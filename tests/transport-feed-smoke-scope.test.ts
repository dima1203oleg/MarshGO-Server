import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTransportFeedSmokeScope, routeSmokeAcceptancePassed, selectTransportFeedSmokeEntries } from '../scripts/transport-feed-smoke-scope';
import type { CatalogEntry } from '../server/mobility/ukraineCatalog';

const lvivStatic = {
  name: 'Lviv GTFS', city: 'Львів', providerType: 'public_transit', sourceType: 'gtfs',
  feedUrl: 'https://track.ua-gis.com/gtfs/lviv/static.zip', access: 'open', sourceRef: 'lviv-static', coverage: 'schedule',
} satisfies CatalogEntry;
const lvivVehiclePositions = {
  name: 'Lviv GTFS-RT', city: 'Львів', providerType: 'public_transit', sourceType: 'gtfs_rt',
  feedUrl: 'https://track.ua-gis.com/gtfs/lviv/vehicle_position', access: 'open', sourceRef: 'lviv-vehicles', coverage: 'positions',
} satisfies CatalogEntry;
const lvivTripUpdates = {
  ...lvivVehiclePositions, name: 'Lviv trip updates', feedUrl: 'https://track.ua-gis.com/gtfs/lviv/trip_updates', sourceRef: 'lviv-trip-updates',
};
const kyivStatic = { ...lvivStatic, name: 'Kyiv GTFS', city: 'Київ', sourceRef: 'kyiv-static' };
const ukraineRail = {
  ...lvivStatic, name: 'Ukraine rail GTFS', city: 'Україна',
  feedUrl: 'https://jbb.ghsq.de/gtfs/ua-ukrzaliznytsya.gtfs.zip', sourceRef: 'ukraine-rail',
};

test('transport feed smoke defaults to the complete catalog and accepts focused Lviv route scope', () => {
  assert.equal(parseTransportFeedSmokeScope([]), 'all');
  assert.equal(parseTransportFeedSmokeScope(['--scope=lviv-route']), 'lviv-route');
  assert.equal(parseTransportFeedSmokeScope(['--scope=lviv-budget-diagnostic']), 'lviv-budget-diagnostic');
  assert.equal(parseTransportFeedSmokeScope(['--scope=lviv-north-baseline-diagnostic']), 'lviv-north-baseline-diagnostic');
  assert.equal(parseTransportFeedSmokeScope(['--scope=lviv-north-trip-fairness-diagnostic']), 'lviv-north-trip-fairness-diagnostic');
  assert.equal(parseTransportFeedSmokeScope(['--scope=lviv-north-final-arrival-diagnostic']), 'lviv-north-final-arrival-diagnostic');
  assert.equal(parseTransportFeedSmokeScope(['--scope=ukraine-rail-route']), 'ukraine-rail-route');
  assert.throws(() => parseTransportFeedSmokeScope(['--scope=unknown']), /Unsupported/);
  assert.throws(() => parseTransportFeedSmokeScope(['--scope=all', '--scope=lviv-route']), /only once/);
});

test('focused Lviv route scope selects only static schedule and vehicle positions', () => {
  const catalog = [kyivStatic, lvivStatic, lvivTripUpdates, lvivVehiclePositions];
  assert.deepEqual(selectTransportFeedSmokeEntries(catalog, 'all'), catalog);
  assert.deepEqual(selectTransportFeedSmokeEntries(catalog, 'lviv-route'), [lvivStatic, lvivVehiclePositions]);
  assert.deepEqual(selectTransportFeedSmokeEntries(catalog, 'lviv-budget-diagnostic'), [lvivStatic, lvivVehiclePositions]);
  assert.deepEqual(selectTransportFeedSmokeEntries(catalog, 'lviv-north-baseline-diagnostic'), [lvivStatic, lvivVehiclePositions]);
  assert.deepEqual(selectTransportFeedSmokeEntries(catalog, 'lviv-north-trip-fairness-diagnostic'), [lvivStatic, lvivVehiclePositions]);
  assert.deepEqual(selectTransportFeedSmokeEntries(catalog, 'lviv-north-final-arrival-diagnostic'), [lvivStatic, lvivVehiclePositions]);
  assert.throws(() => selectTransportFeedSmokeEntries([kyivStatic], 'lviv-route'), /required/);
});

test('Ukraine rail route scope selects only the cataloged ODbL rail GTFS', () => {
  const catalog = [kyivStatic, ukraineRail, lvivStatic];
  assert.deepEqual(selectTransportFeedSmokeEntries(catalog, 'ukraine-rail-route'), [ukraineRail]);
  assert.throws(() => selectTransportFeedSmokeEntries([kyivStatic], 'ukraine-rail-route'), /required/);
});

test('focused route acceptance fails without an untruncated route and promised geometry evidence', () => {
  assert.equal(routeSmokeAcceptancePassed('ukraine-rail-route', []), false);
  assert.equal(routeSmokeAcceptancePassed('ukraine-rail-route', [{
    count: 1, searchTruncated: false, resultLimitReached: false, confirmedShapeGeometry: false,
  }]), false);
  assert.equal(routeSmokeAcceptancePassed('ukraine-rail-route', [{
    count: 1, searchTruncated: true, resultLimitReached: false, confirmedShapeGeometry: true,
  }]), false);
  assert.equal(routeSmokeAcceptancePassed('ukraine-rail-route', [{
    count: 1, searchTruncated: false, resultLimitReached: true, confirmedShapeGeometry: true,
  }]), false);
  assert.equal(routeSmokeAcceptancePassed('ukraine-rail-route', [{
    count: 1, searchTruncated: false, resultLimitReached: false, confirmedShapeGeometry: true,
  }]), true);
  assert.equal(routeSmokeAcceptancePassed('lviv-route', [{
    count: 1, searchTruncated: false,
  }]), true);
  assert.equal(routeSmokeAcceptancePassed('lviv-route', [{
    count: 1, searchTruncated: true,
  }]), false);
  assert.equal(routeSmokeAcceptancePassed('lviv-north-final-arrival-diagnostic', []), true,
    'diagnostic sweeps must remain evidence gathering, not be treated as acceptance gates');
});
