import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTransportFeedSmokeScope, selectTransportFeedSmokeEntries } from '../scripts/transport-feed-smoke-scope';
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

test('transport feed smoke defaults to the complete catalog and accepts focused Lviv route scope', () => {
  assert.equal(parseTransportFeedSmokeScope([]), 'all');
  assert.equal(parseTransportFeedSmokeScope(['--scope=lviv-route']), 'lviv-route');
  assert.throws(() => parseTransportFeedSmokeScope(['--scope=unknown']), /Unsupported/);
  assert.throws(() => parseTransportFeedSmokeScope(['--scope=all', '--scope=lviv-route']), /only once/);
});

test('focused Lviv route scope selects only static schedule and vehicle positions', () => {
  const catalog = [kyivStatic, lvivStatic, lvivTripUpdates, lvivVehiclePositions];
  assert.deepEqual(selectTransportFeedSmokeEntries(catalog, 'all'), catalog);
  assert.deepEqual(selectTransportFeedSmokeEntries(catalog, 'lviv-route'), [lvivStatic, lvivVehiclePositions]);
  assert.throws(() => selectTransportFeedSmokeEntries([kyivStatic], 'lviv-route'), /required/);
});
