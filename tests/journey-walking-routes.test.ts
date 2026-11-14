import assert from 'node:assert/strict';
import test from 'node:test';
import type { GtfsItinerary } from '../server/journey/gtfsTimetable';
import { DEFAULT_MAX_ACCESS_WALKING_METERS, DEFAULT_MAX_EGRESS_WALKING_METERS } from '../server/journey/gtfsTimetable';
import {
  applyRoutedWalkingPaths, createWalkingRejectionReasons, createWalkingRouteBudget, MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH, routePedestrianPath,
  STREET_WALKING_DETOUR_ALLOWANCE, walkingEndpointFor, walkingRouteCandidateBatchSize, walkingRouteRequestLimit,
  walkingRoutingEnabled, walkingRoutingConfiguredFor, type WalkingRoutePath,
} from '../server/journey/walkingRoutes';

const start = Date.parse('2026-10-01T08:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000);
const path = (distanceMeters: number, durationSeconds: number): WalkingRoutePath => ({
  distanceMeters, durationSeconds, geometry: [[24, 49], [24.01, 49.01]],
});

function itinerary(): GtfsItinerary {
  return {
    id: 'trip-1|trip-2', providerId: 'provider', providerName: 'Fixture',
    departureAt: at(0), arrivalAt: at(3240), durationSeconds: 3240, waitingSeconds: 420,
    transfers: 1, walkingMeters: 650,
    transferWalkingMeters: [250], transferWalkingSeconds: [200], transferWalkingGeometries: [null],
    transferInSeat: [false], transferMinimumBufferSeconds: [180], transferRuleMinimumSeconds: [null],
    fare: null, cashFare: null,
    segments: [
      {
        departureAt: at(600), arrivalAt: at(1800),
        originStop: { coordinates: [24, 49] }, destinationStop: { coordinates: [24.01, 49] },
        distanceToOriginStopMeters: 100, distanceFromDestinationStopMeters: 0,
      },
      {
        departureAt: at(2400), arrivalAt: at(3000),
        originStop: { coordinates: [24.02, 49] }, destinationStop: { coordinates: [24.03, 49] },
        distanceToOriginStopMeters: 0, distanceFromDestinationStopMeters: 300,
      },
    ],
  } as unknown as GtfsItinerary;
}

const limits = { maximumAccessMeters: 800, maximumEgressMeters: 800, maximumTransferMeters: 800 };

function geometryForRequest(input: RequestInfo | URL) {
  const routeCoordinates = new URL(String(input)).pathname.split('/').at(-1)!;
  return { coordinates: routeCoordinates.split(';').map((point) => point.split(',').map(Number)) };
}

test('replaces straight-line walking with routed distance, geometry, time, and waiting', () => {
  const routed = applyRoutedWalkingPaths(itinerary(), {
    access: path(500, 480), egress: path(600, 500), transfers: [path(350, 240)],
  }, limits);

  assert.ok(routed);
  assert.equal(routed.walkingRoutesVerified, true);
  assert.equal(routed.walkingMeters, 1450);
  assert.equal(routed.durationSeconds, 3500);
  assert.deepEqual(routed.transferWalkingMeters, [350]);
  assert.deepEqual(routed.transferWalkingGeometries[0], path(350, 240).geometry);
  assert.equal(routed.waitingSeconds, 480);
});

test('rejects a connection when the routed walking time makes its transfer impossible', () => {
  const routed = applyRoutedWalkingPaths(itinerary(), {
    access: path(200, 120), egress: path(200, 120), transfers: [path(500, 480)],
  }, limits);
  assert.equal(routed, null);
});

test('rejects a route when routed access cannot reach the scheduled departure or exceeds the walk shed', () => {
  const tooLate = applyRoutedWalkingPaths(itinerary(), {
    access: path(400, 700), egress: path(100, 90), transfers: [path(100, 90)],
  }, limits);
  assert.equal(tooLate, null);

  const beyondWalkShed = applyRoutedWalkingPaths(itinerary(), {
    access: path(801, 500), egress: path(100, 90), transfers: [path(100, 90)],
  }, limits);
  assert.equal(beyondWalkShed, null);
});

test('does not fabricate a route when the pedestrian provider is unconfigured', async () => {
  assert.equal(await routePedestrianPath([24, 49], [24.01, 49.01], ''), null);
});

test('keeps a journey whose access walk the router could not confirm and labels it unverified', () => {
  const degraded = applyRoutedWalkingPaths(itinerary(), {
    access: null, egress: path(600, 500), transfers: [path(350, 240)],
  }, limits);

  assert.ok(degraded);
  assert.equal(degraded.walkingRoutesVerified, false);
  assert.equal(degraded.walkingRoutesUnconfirmed, true);
  assert.equal(degraded.accessWalk, null);
  assert.equal(degraded.walkingMeters, 1050);
  assert.equal(degraded.durationSeconds, 3500);
});

test('keeps an unconfirmed transfer walk as the timetable estimate instead of dropping the journey', () => {
  const degraded = applyRoutedWalkingPaths(itinerary(), {
    access: path(500, 480), egress: path(600, 500), transfers: [null],
  }, limits);

  assert.ok(degraded);
  assert.equal(degraded.walkingRoutesUnconfirmed, true);
  assert.deepEqual(degraded.transferWalkingMeters, [250]);
  assert.deepEqual(degraded.transferWalkingSeconds, [200]);
  assert.deepEqual(degraded.transferWalkingGeometries, [null]);
});

test('still drops an itinerary when its unconfirmed walk estimate exceeds the passenger limit', () => {
  const wide = itinerary();
  (wide.segments[0] as unknown as { distanceToOriginStopMeters: number}).distanceToOriginStopMeters = 900;
  assert.equal(applyRoutedWalkingPaths(wide, {
    access: null, egress: path(100, 90), transfers: [path(100, 90)],
  }, limits), null);
});

test('uses the configured OSRM foot profile and preserves its routed geometry', async (t) => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      code: 'Ok',
      routes: [{ distance: 1480.2, duration: 500.1, geometry: { coordinates: [[24, 49], [24.01, 49.01]] }, legs: [] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const routed = await routePedestrianPath([24, 49], [24.01, 49.01], 'https://walking.example');
  assert.match(requestedUrl, /\/route\/v1\/foot\//);
  assert.deepEqual(routed, {
    distanceMeters: 1481, durationSeconds: 501, geometry: [[24, 49], [24.01, 49.01]],
  });
});

test('caps external foot-route requests per search without caching a budget miss', async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (input) => {
    fetchCount++;
    return new Response(JSON.stringify({
      code: 'Ok', routes: [{ distance: 100, duration: 80, geometry: geometryForRequest(input), legs: [] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const budget = createWalkingRouteBudget(1);
  const endpoint = 'https://walking-budget.example/route/v1/foot';
  assert.ok(await routePedestrianPath([25, 49], [25.01, 49.01], endpoint, budget));
  assert.equal(await routePedestrianPath([25.02, 49], [25.03, 49.01], endpoint, budget), null);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.exhausted, true);
  assert.equal(budget.spent, 1, 'only a request that reached a router is charged to the budget');
  assert.equal(fetchCount, 1);
});

test('the foot-route budget covers a real candidate pool and stays hard-bounded', (t) => {
  t.diagnostic('regression: a live Lviv search generated 73 candidates; a 32-request budget left displayed journeys with estimated walks');
  const original = process.env.WALKING_ROUTE_MAX_REQUESTS_PER_SEARCH;
  const restore = () => {
    if (original === undefined) delete process.env.WALKING_ROUTE_MAX_REQUESTS_PER_SEARCH;
    else process.env.WALKING_ROUTE_MAX_REQUESTS_PER_SEARCH = original;
  };
  t.after(restore);

  delete process.env.WALKING_ROUTE_MAX_REQUESTS_PER_SEARCH;
  const fallback = walkingRouteRequestLimit();
  assert.ok(fallback >= 96, `an ordinary corridor must not be starved: got ${fallback}`);
  assert.ok(fallback <= MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH);
  assert.equal(createWalkingRouteBudget().limit, fallback, 'a search uses the configured budget by default');

  process.env.WALKING_ROUTE_MAX_REQUESTS_PER_SEARCH = '500';
  assert.equal(walkingRouteRequestLimit(), MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH, 'no search may fan out without a ceiling');
  process.env.WALKING_ROUTE_MAX_REQUESTS_PER_SEARCH = '4';
  assert.equal(walkingRouteRequestLimit(), 16, 'an override too small to price one corridor is not trusted');
  process.env.WALKING_ROUTE_MAX_REQUESTS_PER_SEARCH = 'not-a-number';
  assert.equal(walkingRouteRequestLimit(), fallback, 'an unreadable override falls back to the default');
  restore();

  assert.equal(createWalkingRouteBudget(24).limit, 24, 'a per-stage sub-budget stays below the ceiling');
  assert.equal(createWalkingRouteBudget(100_000).limit, MAX_WALKING_ROUTE_REQUESTS_PER_SEARCH);
  assert.equal(createWalkingRouteBudget(-1).limit, 0, 'a negative budget requests nothing');
  assert.equal(createWalkingRouteBudget(1.5).limit, 0, 'a non-integer budget is not trusted');
});

test('candidate waves stay inside the routing queue capacity', (t) => {
  const original = process.env.WALKING_ROUTE_CANDIDATES_PER_BATCH;
  t.after(() => {
    if (original === undefined) delete process.env.WALKING_ROUTE_CANDIDATES_PER_BATCH;
    else process.env.WALKING_ROUTE_CANDIDATES_PER_BATCH = original;
  });
  // ROUTING_MAX_CONCURRENCY(12) + ROUTING_MAX_QUEUE(24) accept 36 requests; beyond that the
  // gateway rejects them and the rejected request still paid its budget.
  delete process.env.WALKING_ROUTE_CANDIDATES_PER_BATCH;
  const wave = walkingRouteCandidateBatchSize();
  assert.ok(wave >= 1 && wave * 3 <= 36, `a wave of ${wave} candidates must fit the default queue`);
  process.env.WALKING_ROUTE_CANDIDATES_PER_BATCH = '99';
  assert.equal(walkingRouteCandidateBatchSize(), 12, 'wave size stays bounded');
  process.env.WALKING_ROUTE_CANDIDATES_PER_BATCH = '0';
  assert.equal(walkingRouteCandidateBatchSize(), 1, 'a wave of zero candidates would stall the search');
});

test('bounds concurrent provider work and drops excess queued walking paths', async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let active = 0;
  let peakActive = 0;
  globalThis.fetch = async (input) => {
    fetchCount++;
    active++;
    peakActive = Math.max(peakActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return new Response(JSON.stringify({
      code: 'Ok', routes: [{ distance: 100, duration: 80, geometry: geometryForRequest(input), legs: [] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const endpoint = 'https://walking-capacity.example/route/v1/foot';
  const attempts = Array.from({ length: 40 }, (_, index) => routePedestrianPath(
    [26 + index / 1000, 49], [26 + index / 1000, 49.01], endpoint,
  ));
  const routes = await Promise.all(attempts);
  assert.equal(routes.filter(Boolean).length, 36);
  assert.equal(fetchCount, 36);
  assert.equal(peakActive, 12);
});

test('selects the foot graph that covers both endpoints and refuses cross-city or unknown pairs', (t) => {
  const originalUrl = process.env.WALKING_ROUTING_URL;
  const originalUrls = process.env.WALKING_ROUTING_URLS;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.WALKING_ROUTING_URL; else process.env.WALKING_ROUTING_URL = originalUrl;
    if (originalUrls === undefined) delete process.env.WALKING_ROUTING_URLS; else process.env.WALKING_ROUTING_URLS = originalUrls;
  });

  process.env.WALKING_ROUTING_URL = 'http://single:5000/route/v1/foot';
  delete process.env.WALKING_ROUTING_URLS;
  assert.equal(walkingEndpointFor([24.03, 49.84], [24.02, 49.89]), 'http://single:5000/route/v1/foot');

  process.env.WALKING_ROUTING_URLS = JSON.stringify([
    { bbox: [23.9, 49.75, 24.2, 49.95], url: 'http://lviv:5000/route/v1/foot' },
    { bbox: [30.2, 50.25, 30.8, 50.62], url: 'http://kyiv:5000/route/v1/foot' },
  ]);
  assert.equal(walkingEndpointFor([24.03, 49.84], [24.02, 49.89]), 'http://lviv:5000/route/v1/foot');
  assert.equal(walkingEndpointFor([30.52, 50.45], [30.48, 50.44]), 'http://kyiv:5000/route/v1/foot');
  assert.equal(walkingEndpointFor([24.03, 49.84], [30.48, 50.44]), undefined);
  assert.equal(walkingEndpointFor([31.2, 49.4], [31.21, 49.41]), undefined);

  process.env.WALKING_ROUTING_URLS = 'not-json';
  assert.equal(walkingEndpointFor([24.03, 49.84], [24.02, 49.89]), 'http://single:5000/route/v1/foot');
});

test('normalizes OSRM service-root configuration to its pedestrian profile endpoint', (t) => {
  const originalUrl = process.env.WALKING_ROUTING_URL;
  const originalUrls = process.env.WALKING_ROUTING_URLS;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.WALKING_ROUTING_URL; else process.env.WALKING_ROUTING_URL = originalUrl;
    if (originalUrls === undefined) delete process.env.WALKING_ROUTING_URLS; else process.env.WALKING_ROUTING_URLS = originalUrls;
  });

  delete process.env.WALKING_ROUTING_URLS;
  process.env.WALKING_ROUTING_URL = 'http://walking-router:5000';
  assert.equal(walkingEndpointFor([24.03, 49.84], [24.02, 49.89]), 'http://walking-router:5000/route/v1/foot');
  process.env.WALKING_ROUTING_URL = 'http://walking-router:5000/route/v1';
  assert.equal(walkingEndpointFor([24.03, 49.84], [24.02, 49.89]), 'http://walking-router:5000/route/v1/foot');
  process.env.WALKING_ROUTING_URL = 'http://walking-router:5000/route/v1/foot';
  assert.equal(walkingEndpointFor([24.03, 49.84], [24.02, 49.89]), 'http://walking-router:5000/route/v1/foot');

  process.env.WALKING_ROUTING_URLS = JSON.stringify([
    { bbox: [23.9, 49.75, 24.2, 49.95], url: 'http://lviv-walking:5000' },
  ]);
  assert.equal(walkingEndpointFor([24.03, 49.84], [24.02, 49.89]), 'http://lviv-walking:5000/route/v1/foot');
});

// The pipeline gate has to open for a per-area graph set even when no single WALKING_ROUTING_URL
// exists: that was the acceptance-Lviv configuration where every foot leg stayed an estimate.
test('opens the walking pipeline for a per-area graph set and keeps it closed for uncovered pairs', (t) => {
  const originalUrl = process.env.WALKING_ROUTING_URL;
  const originalUrls = process.env.WALKING_ROUTING_URLS;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.WALKING_ROUTING_URL; else process.env.WALKING_ROUTING_URL = originalUrl;
    if (originalUrls === undefined) delete process.env.WALKING_ROUTING_URLS; else process.env.WALKING_ROUTING_URLS = originalUrls;
  });

  delete process.env.WALKING_ROUTING_URL;
  delete process.env.WALKING_ROUTING_URLS;
  assert.equal(walkingRoutingEnabled(), false);
  assert.equal(walkingRoutingConfiguredFor([24.03, 49.84], [24.02, 49.89]), false);

  process.env.WALKING_ROUTING_URLS = JSON.stringify([
    { bbox: [23.9, 49.75, 24.2, 49.95], url: 'http://lviv:5000/route/v1/foot' },
    { bbox: [30.2, 50.25, 30.8, 50.62], url: 'http://kyiv:5000/route/v1/foot' },
  ]);
  assert.equal(walkingRoutingEnabled(), true);
  assert.equal(walkingRoutingConfiguredFor([24.03, 49.84], [24.02, 49.89]), true);
  // A pair no graph covers must stay unroutable rather than reach the wrong city's graph.
  assert.equal(walkingRoutingConfiguredFor([24.03, 49.84], [30.48, 50.44]), false);

  process.env.WALKING_ROUTING_URL = 'http://single:5000/route/v1/foot';
  delete process.env.WALKING_ROUTING_URLS;
  assert.equal(walkingRoutingConfiguredFor([30.52, 50.45], [30.48, 50.44]), true);
});

/**
 * The Lviv numbers measured on the live feed at 2026-11-03, rebuilt as fixtures: the destination
 * stop lies 1 243 m from the pin in a straight line and 1 594 m along the foot graph, and the old
 * comparison of those two numbers dropped all 100 itineraries the engine had built. Fixtures, not
 * live evidence — the live proof is the search run after this change.
 */
function farEgressItinerary(straightLineMeters: number): GtfsItinerary {
  const base = itinerary();
  return {
    ...base,
    segments: [base.segments[0], { ...base.segments[1], distanceFromDestinationStopMeters: straightLineMeters }],
  } as unknown as GtfsItinerary;
}

const walkTo = (egressMeters: number) => ({
  access: path(200, 180),
  egress: path(egressMeters, Math.ceil(egressMeters / 1.25)),
  transfers: [path(100, 90)],
});

/** Mirrors how server/index.ts builds them: a straight-line radius, a street allowance over it, and
 *  the walk ceiling as the budget of the last-resort nearest stop. */
const defaultWalkLimits = {
  maximumAccessMeters: DEFAULT_MAX_ACCESS_WALKING_METERS,
  maximumEgressMeters: DEFAULT_MAX_EGRESS_WALKING_METERS,
  maximumTransferMeters: 400,
  streetDetourAllowance: STREET_WALKING_DETOUR_ALLOWANCE,
  extendedMaximumAccessMeters: 2_000,
  extendedMaximumEgressMeters: 2_000,
};

test('keeps a journey whose confirmed street walk overshoots the straight-line radius that selected its stop', () => {
  const reasons = createWalkingRejectionReasons();
  const routed = applyRoutedWalkingPaths(farEgressItinerary(1_243), walkTo(1_594), defaultWalkLimits, reasons);
  assert.ok(routed, '1 594 m of pavement against a 1 000 m crow-flight radius is a street detour, not an unreachable stop');
  assert.equal(routed.walkReachExtended, true, 'the walk is longer than the search planned for, and the passenger is told');
  assert.equal(routed.walkingMeters, 200 + 1_594 + 100);
  assert.equal(reasons.egressOverCap, 0);
  assert.equal(reasons.minimumRejectedEgressMeters, null);
});

test('a walk inside the detour allowance is an ordinary journey, not an extended reach', () => {
  const routed = applyRoutedWalkingPaths(farEgressItinerary(900), walkTo(1_250), defaultWalkLimits);
  assert.ok(routed);
  assert.equal(routed.walkReachExtended, false, 'flagging every journey as a long walk would train the passenger to ignore it');
});

test('an unconfirmed walk estimate gets no street slack but still reaches the closest stop', () => {
  const degraded = applyRoutedWalkingPaths(farEgressItinerary(1_594),
    { access: path(200, 180), egress: null, transfers: [path(100, 90)] }, defaultWalkLimits);
  assert.ok(degraded, 'a stop 1 594 m away in a straight line is inside the walk ceiling the search may fall back to');
  assert.equal(degraded.walkReachExtended, true);
  assert.equal(degraded.walkingRoutesUnconfirmed, true, 'the leg stays labelled as an estimate');
});

test('a walk beyond even the fallback ceiling is rejected with its measured distance kept', () => {
  const reasons = createWalkingRejectionReasons();
  assert.equal(applyRoutedWalkingPaths(farEgressItinerary(1_243), walkTo(2_400), defaultWalkLimits, reasons), null);
  assert.equal(reasons.egressOverCap, 1);
  assert.equal(reasons.minimumRejectedEgressMeters, 2_400);
});

test('an explicit walk limit stays a hard street cap and the shortfall is measured, not guessed', () => {
  // With maxWalkingMeters the caller passes no allowance and no fallback budget: the number the
  // passenger typed means street metres, so 1 594 m of walking is refused — honestly, and with the
  // distance named so the interface can say how far it missed by.
  const explicit = { maximumAccessMeters: 1_500, maximumEgressMeters: 1_500, maximumTransferMeters: 400 };
  const reasons = createWalkingRejectionReasons();
  assert.equal(applyRoutedWalkingPaths(farEgressItinerary(1_243), walkTo(1_594), explicit, reasons), null);
  assert.equal(reasons.egressOverCap, 1);
  assert.equal(reasons.minimumRejectedEgressMeters, 1_594, '94 m short is a different answer for the passenger than 1 400 m');
});
