import test from 'node:test';
import assert from 'node:assert/strict';
import { canRent, type RentalLocation, type RentalNetworkRule } from '../server/mobility/rentalCompatibility';
import { geofenceRulesAt, normalizeGeofencingZones } from '../server/mobility/gbfsGeofences';
import { normalizeVehicles, pointIsInsideUkraine, type GbfsSnapshot } from '../server/mobility/gbfs';
import { buildMicromobilityGeofenceFeatures, buildMicromobilityPointFeatures, buildStaticRentalPointFeature } from '../server/mobility/micromobilityFeatures';
import { normalizeOsmBikeRental, parseOsmGeoJsonSequence } from '../server/mobility/osmBikeRentals';
import { kiwitaxiConfigured, parseKiwitaxiTsv } from '../server/mobility/kiwitaxiTsv';
import { buildKiwitaxiAffiliateUrl, intuiTravelStatus, kiwitaxiStatus } from '../server/mobility/transferAdapters';
import { buildOsmBikeAudit, renderOsmBikeAuditCsv, renderOsmBikeAuditMarkdown } from '../server/mobility/osmAudit';

const now = new Date('2026-10-13T12:00:00Z');
const location = (id: string, providerId = 'operator-a'): RentalLocation => ({
  id, providerId, networkId: 'network-a', mode: 'BICYCLE', rentalModel: 'STATION_BASED', name: id,
  pickupAllowed: true, dropoffAllowed: true, availability: 'AVAILABLE', availableVehicles: 4, availableDocks: 2,
  vehicleTypes: ['city-bike'], availabilityCheckedAt: now, openingAtPickup: true, openingAtDropoff: true,
  geofenceAllowsPickup: true, geofenceAllowsDropoff: true,
});
const network: RentalNetworkRule = { networkId: 'network-a', providerIds: ['operator-a'], status: 'CONFIRMED', returnRule: 'ANY_NETWORK_LOCATION', crossProviderReturnConfirmed: false, maximumSnapshotAgeSeconds: 300 };
const attempt = (pickup = location('A'), dropoff = location('B'), networkRule: RentalNetworkRule | null = network) => canRent({
  pickup, dropoff, vehicleType: 'city-bike', departureAt: now, arrivalAt: new Date(now.getTime() + 20 * 60_000), networkRule, now,
});

test('rental compatibility requires one confirmed provider network and current pickup/dropoff inventory', () => {
  const allowed = attempt();
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.confirmationLevel, 'VERIFIED');
  assert.equal(attempt(location('A', 'bikenow'), location('B', 'veliki_ua'), network).allowed, false);
  assert.equal(attempt(location('A'), location('B'), null).allowed, false);
});

test('unknown, stale, forbidden, or full return locations are not guaranteed rental legs', () => {
  const stale = location('B'); stale.availabilityCheckedAt = new Date(now.getTime() - 301_000);
  const noDocks = location('B'); noDocks.availableDocks = 0;
  const unknownDocks = location('B'); unknownDocks.availableDocks = null;
  const denied = location('B'); denied.dropoffAllowed = false;
  const unknown = location('B'); unknown.availability = 'UNKNOWN';
  assert.equal(attempt(location('A'), stale).confirmationLevel, 'UNKNOWN');
  assert.equal(attempt(location('A'), noDocks).allowed, false);
  assert.equal(attempt(location('A'), unknownDocks).confirmationLevel, 'UNKNOWN');
  assert.equal(attempt(location('A'), denied).allowed, false);
  assert.equal(attempt(location('A'), unknown).allowed, false);
});

test('different operators share a rental only with explicit cross-provider confirmation', () => {
  const one = location('A', 'operator-a'), two = location('B', 'operator-b');
  const withoutAgreement = attempt(one, two, { ...network, providerIds: ['operator-a', 'operator-b'] });
  assert.equal(withoutAgreement.allowed, false);
  const withAgreement = attempt(one, two, { ...network, providerIds: ['operator-a', 'operator-b'], crossProviderReturnConfirmed: true });
  assert.equal(withAgreement.allowed, true);
});

test('free-floating return requires an explicitly allowed operator geofence', () => {
  const pickup = location('A'); pickup.rentalModel = 'FREE_FLOATING'; pickup.mode = 'SCOOTER'; pickup.vehicleTypes = ['zelectra-1073'];
  const dropoff = location('B'); dropoff.rentalModel = 'FREE_FLOATING'; dropoff.mode = 'SCOOTER'; dropoff.vehicleTypes = ['zelectra-1073'];
  pickup.geofenceAllowsPickup = true; dropoff.geofenceAllowsDropoff = false;
  const result = canRent({ pickup, dropoff, vehicleType: 'zelectra-1073', departureAt: now, arrivalAt: new Date(now.getTime() + 600_000), networkRule: { ...network, networkId: 'network-a', providerIds: ['operator-a'], returnRule: 'FREE_FLOATING_ZONE' }, now });
  assert.equal(result.allowed, false);
});

test('GBFS v3 GeoJSON zones override global defaults in spec order; [] vehicle types do not match', () => {
  const feature = (id: string, endAllowed: boolean, vehicleTypeIds?: string[]) => ({
    type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [[[0,0],[2,0],[2,2],[0,2],[0,0]]] },
    properties: { rules: [{ ride_end_allowed: endAllowed, ...(vehicleTypeIds === undefined ? {} : { vehicle_type_ids: vehicleTypeIds }) }] },
  });
  const normalized = normalizeGeofencingZones({ data: {
    global_rules: [{ ride_start_allowed: false, ride_end_allowed: false }],
    geofencing_zones: { type: 'FeatureCollection', features: [feature('first-allow', true, ['type-a']), feature('later-deny', false, ['type-a']), feature('type-b-allow', true, ['type-b']), feature('empty', false, [])] },
  } });
  assert.equal(normalized.geofences.length, 4);
  assert.equal(geofenceRulesAt(normalized, [1,1], 'type-a').rideEndAllowed, true);
  assert.equal(geofenceRulesAt(normalized, [1,1], 'type-b').rideEndAllowed, true);
  assert.equal(geofenceRulesAt(normalized, [3,3], 'type-a').rideEndAllowed, false);
});

test('OSM parser includes rental services but excludes ordinary bicycle parking and never invents returns', () => {
  const unknown = normalizeOsmBikeRental({ type: 'Feature', id: 'way/42', properties: { amenity: 'bicycle_rental', name: 'Local Bikes', capacity: '8' }, geometry: { type: 'Polygon', coordinates: [[[1,1],[2,1],[2,2],[1,2],[1,1]]] } });
  assert.equal(unknown?.providerId, 'bicycle_operator_unknown');
  assert.equal(unknown?.networkId, null);
  assert.equal(unknown?.pickupAllowed, null);
  assert.equal(unknown?.dropoffAllowed, null);
  assert.equal(unknown?.rentalModel, 'UNKNOWN');
  assert.equal(normalizeOsmBikeRental({ type: 'Feature', id: 'node/43', properties: { amenity: 'bicycle_parking' }, geometry: { type: 'Point', coordinates: [1,1] } }), null);
  assert.equal(normalizeOsmBikeRental({ type: 'Feature', id: 'node/45', properties: { bicycle_rental: 'dropoff_point', 'ref:gbfs': 'feed:station:1' }, geometry: { type: 'Point', coordinates: [1,1] } })?.refGbfs, 'feed:station:1');
  const seq = '\u001e' + JSON.stringify({ type: 'Feature', id: 'node/44', properties: { shop: 'rental', rental: 'bicycle' }, geometry: { type: 'Point', coordinates: [1,1] } });
  assert.equal(parseOsmGeoJsonSequence(seq).length, 1);
  assert.equal(normalizeOsmBikeRental({ type:'Feature', id:'node/46', properties:{ amenity:'bicycle_rental', operator:'BikeNow' }, geometry:{ type:'Point', coordinates:[1,1] } })?.providerId, 'bikenow');
  assert.equal(normalizeOsmBikeRental({ type:'Feature', id:'node/47', properties:{ amenity:'bicycle_rental', website:'https://rent.veliki.ua/locations' }, geometry:{ type:'Point', coordinates:[1,1] } })?.providerId, 'veliki_ua');
  assert.equal(normalizeOsmBikeRental({ type:'Feature', id:'node/48', properties:{ amenity:'bicycle_rental', name:'BikeNow City Bikes' }, geometry:{ type:'Point', coordinates:[1,1] } })?.providerId, 'bicycle_operator_unknown');
  assert.equal(normalizeOsmBikeRental({ type:'Feature', id:'node/50', properties:{ amenity:'bicycle_rental', operator:'ТОВ "Некстбайк Україна"', network:'nextbike' }, geometry:{ type:'Point', coordinates:[1,1] } })?.providerId, 'nextbike_ua');
  const osmiumId = normalizeOsmBikeRental({ type:'Feature', id:'n49', properties:{ amenity:'bicycle_rental' }, geometry:{ type:'Point', coordinates:[1,1] } });
  assert.equal(osmiumId?.externalId, 'node/49');
  assert.equal(osmiumId?.objectType, 'node');
});

test('OSM audit reports real region tags and does not label a location name as its operator', () => {
  const point = normalizeOsmBikeRental({ type: 'Feature', id: 'node/77', properties: { amenity: 'bicycle_rental', name: 'Central Rental', 'addr:state': 'Kyiv Region' }, geometry: { type: 'Point', coordinates: [30.5, 50.4] } });
  assert.ok(point);
  const audit = buildOsmBikeAudit([point], now);
  assert.deepEqual(audit.byRegion, [{ region: 'Kyiv Region', count: 1 }]);
  assert.equal(audit.byOperatorNetworkCity[0]?.operator, 'оператор не вказаний');
  const report = renderOsmBikeAuditMarkdown(audit, 'ukraine-261012.osm.pbf');
  assert.match(report, /Counts by oblast or region/);
  assert.match(report, /Pickup rights confirmed: \*\*0\*\*/);
  assert.match(renderOsmBikeAuditCsv(audit), /© OpenStreetMap contributors, ODbL 1.0/);
  const untagged = normalizeOsmBikeRental({ type:'Feature', id:'node/78', properties:{ amenity:'bicycle_rental' }, geometry:{ type:'Point', coordinates:[30.5,50.4] } });
  assert.ok(untagged);
  const cityBoundary = { type:'Feature' as const, id:'r/10', properties:{ boundary:'administrative', admin_level:'8', place:'city', name:'Львів' }, geometry:{ type:'MultiPolygon', coordinates:[[[[30.4,50.3],[30.6,50.3],[30.6,50.5],[30.4,50.5],[30.4,50.3]]]] } };
  const regionBoundary = { type:'Feature' as const, id:'r/11', properties:{ boundary:'administrative', admin_level:'4', name:'Львівська область' }, geometry:{ type:'Polygon', coordinates:[[[30,50],[31,50],[31,51],[30,51],[30,50]]] } };
  const spatialAudit = buildOsmBikeAudit([untagged], now, [cityBoundary,regionBoundary]);
  assert.deepEqual(spatialAudit.byCity, [{ city:'Львів', count:1 }]);
  assert.deepEqual(spatialAudit.byRegion, [{ region:'Львівська область', count:1 }]);
  assert.equal(spatialAudit.features[0]?.properties.cityAssignmentMethod, 'OSM_SETTLEMENT_BOUNDARY');
});

test('GBFS normalization preserves only approved Zelectra links, current battery, and pricing identity', () => {
  const status = { last_updated: '2026-10-13T12:00:00Z', data: { vehicles: [{
    vehicle_id: 'scooter-1', vehicle_type_id: 'type-1073', lon: 30.52, lat: 50.45, is_reserved: false, is_disabled: false,
    current_fuel_percent: 76, current_range_meters: 12_000, pricing_plan_id: 'plan-1',
    rental_uris: { web: 'https://zelectra.app.link/rent', ios: 'https://evil.example/rent' },
  }] } };
  const types = { data: { vehicle_types: [{ vehicle_type_id: 'type-1073', form_factor: 'scooter_standing', propulsion_type: 'electric' }] } };
  const result = normalizeVehicles('zelectra', types, status);
  assert.equal(result.assets[0]?.type, 'SCOOTER');
  assert.equal(result.assets[0]?.batteryPercent, 76);
  assert.equal(result.assets[0]?.vehicleTypeId, 'type-1073');
  assert.equal(result.assets[0]?.rentalUris?.web, 'https://zelectra.app.link/rent');
  assert.equal(result.assets[0]?.rentalUris?.ios, undefined);
});

test('Ukrainian GBFS coverage rejects live records outside the declared country', () => {
  assert.equal(pointIsInsideUkraine([30.52,50.45]), true);
  assert.equal(pointIsInsideUkraine([-77.04,-12.04]), false);
  assert.equal([
    [-77.04,-12.04] as [number,number], [-77.05,-12.03] as [number,number],
  ].filter(pointIsInsideUkraine).length, 0);
});

test('micromobility map features separate fresh inventory, pricing, geofences, and static rental unknowns', () => {
  const freshTime = now.getTime();
  const snapshot: GbfsSnapshot = {
    fetchedAt: freshTime, lastUpdated: freshTime, ttlSeconds: 0, staleAfterSeconds: 30,
    assets: [
      { id: 's1', providerId: 'zelectra', type: 'SCOOTER' as const, location: [30.52, 50.45] as [number, number], available: true, vehicleTypeId: '1073', pricingPlanId: 'p1', lastUpdated: now.toISOString() },
      { id: 'foreign', providerId: 'zelectra', type: 'SCOOTER' as const, location: [-77.04,-12.04] as [number,number], available: true, vehicleTypeId: '1073', lastUpdated: now.toISOString() },
    ],
    stations: [], geofences: [{ id: 'deny', geometry: { type: 'Polygon', coordinates: [[[30.5,50.4],[30.6,50.4],[30.6,50.5],[30.5,50.5],[30.5,50.4]]] }, rules: [{ vehicleTypeIds: ['1073'], rideStartAllowed: true, rideEndAllowed: false, rideThroughAllowed: null, maximumSpeedKph: null, startAt: null, endAt: null }] }],
    globalRules: [], pricingPlans: { p1: { planId: 'p1', name: 'Per minute', currency: 'UAH', price: 0, perMinutePricing: [{ start: 0, rate: 1, interval: 60 }] } },
  };
  const provider = { id: 'feed-1', operatorId: 'zelectra', name: 'Zelectra' };
  const bbox = { west: 30.4, south: 50.3, east: 30.7, north: 50.6 };
  const points = buildMicromobilityPointFeatures(provider, snapshot, bbox, new Set(['SCOOTER']), { now: freshTime });
  assert.equal(points.length, 1);
  assert.equal(points[0]?.properties.id, 's1');
  assert.equal(points[0]?.properties.availabilityStatus, 'LIVE');
  assert.equal((points[0]?.properties.pricing as { currency: string }).currency, 'UAH');
  assert.equal(buildMicromobilityGeofenceFeatures(provider, snapshot, bbox, freshTime)[0]?.properties.rideEndAllowed, false);
  assert.equal(buildMicromobilityPointFeatures(provider, { ...snapshot, lastUpdated: freshTime - 31_000 }, bbox, new Set(['SCOOTER']), { now: freshTime }).length, 0);
  const staticPoint = buildStaticRentalPointFeature({ id: 'loc', providerName: 'Veliki.ua', providerId: 'veliki_ua', source: 'OSM', sourceStatus: 'STATIC', availability: 'UNKNOWN', lon: 30.52, lat: 50.45 });
  assert.equal(staticPoint?.properties.availability, 'UNKNOWN');
  assert.equal(staticPoint?.properties.dropoffAllowed, null);
});

test('transfer adapters expose partner limits and build affiliate links only with a supplied ID', () => {
  assert.equal(kiwitaxiStatus({}).status, 'AWAITING_CREDENTIALS');
  const configuredKiwitaxi = kiwitaxiStatus({ KIWITAXI_SECURITY_TOKEN: 'assigned', KIWITAXI_PAP: 'owner-id' });
  assert.equal(configuredKiwitaxi.status, 'CATALOG_ONLY');
  assert.equal(configuredKiwitaxi.catalogAvailable, false);
  assert.equal(configuredKiwitaxi.affiliateAvailable, true);
  assert.equal(buildKiwitaxiAffiliateUrl('https://www.kiwitaxi.com/en/transfer', { KIWITAXI_PAP: 'owner-id' }), 'https://www.kiwitaxi.com/en/transfer?pap=owner-id');
  assert.throws(() => buildKiwitaxiAffiliateUrl('https://attacker.example/redirect', { KIWITAXI_PAP: 'owner-id' }));
  assert.equal(intuiTravelStatus({ INTUI_API_LIGHT_CREDENTIALS: 'provided' }).status, 'AWAITING_AGREEMENT');
  assert.equal(intuiTravelStatus({}).bookingAvailable, false);
});

test('Kiwitaxi TSV parser handles NULLs, quoted tabs and malformed row counts', () => {
  const parsed = parseKiwitaxiTsv('id\tname\tcomment\n1\tKyiv\t\\N\n2\t"City\tAirport"\t"He said ""go"""\n3\tonly-two');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]?.comment, null);
  assert.equal(parsed.rows[1]?.name, 'City\tAirport');
  assert.equal(parsed.rows[1]?.comment, 'He said "go"');
  assert.equal(parsed.rejectedRows, 1);
  assert.deepEqual(kiwitaxiConfigured({ KIWITAXI_SECURITY_TOKEN: 'token' }), { catalogEnabled: true, affiliateEnabled: false });
  assert.deepEqual(kiwitaxiConfigured({}), { catalogEnabled: false, affiliateEnabled: false });
});
