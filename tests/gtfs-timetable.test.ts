import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_ACCESS_WALKING_METERS, DEFAULT_MAX_EGRESS_WALKING_METERS, DEFAULT_MAX_TRANSFER_WALKING_METERS, DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS, findDirectGtfsJourneys, findGtfsItineraries, findGtfsItinerariesWithStats, findGtfsStopArrivals, mergeGtfsTimetables, parseGtfsTimetable, rankGtfsItinerariesForCandidateSampling, sampleGtfsRouteChainCandidates, sampleGtfsTripChainCandidates } from '../server/journey/gtfsTimetable';
import { scoreJourneys } from '../server/journey/scoring';

function feed(overrides: { monday?: string; exceptionDate?: string; exceptionType?: string; pickup?: string; dropoff?: string; departure?: string; arrival?: string; routeType?: string; routeName?: string; withShape?: boolean; withIntermediate?: boolean; withArrivalAlternatives?: boolean } = {}) {
  const routeRows = [
    'route_id,agency_id,route_short_name,route_long_name,route_type',
    `r,a,7,${overrides.routeName ?? 'Test bus'},${overrides.routeType ?? '3'}`,
    ...(overrides.withArrivalAlternatives ? ['r2,a,8,Other route,3'] : []),
  ];
  const tripRows = [
    `r,weekday,t1,Central station${overrides.withShape ? ',shape-1' : ''}`,
    ...(overrides.withArrivalAlternatives ? ['r2,weekday,t2,Central station', 'r,weekday,t3,Opposite direction'] : []),
  ];
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode(['agency_id,agency_name,agency_url,agency_timezone', 'a,Test,https://example.test,Europe/Kyiv'].join('\n')),
    'routes.txt': new TextEncoder().encode(routeRows.join('\n')),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'origin,Origin stop,49.8400,24.0200',
      ...(overrides.withIntermediate ? ['middle,Middle stop,49.8450,24.0250'] : []),
      'destination,Destination stop,49.8500,24.0300',
    ].join('\n')),
    'trips.txt': new TextEncoder().encode(`route_id,service_id,trip_id,trip_headsign${overrides.withShape ? ',shape_id' : ''}\n${tripRows.join('\n')}`),
    'stop_times.txt': new TextEncoder().encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      `t1,${overrides.departure ?? '08:00:00'},${overrides.departure ?? '08:00:00'},origin,1,${overrides.pickup ?? '0'},0`,
      ...(overrides.withIntermediate ? ['t1,08:20:00,08:20:00,middle,2,0,0'] : []),
      `t1,${overrides.arrival ?? '08:40:00'},${overrides.arrival ?? '08:40:00'},destination,${overrides.withIntermediate ? '3' : '2'},0,${overrides.dropoff ?? '0'}`,
      ...(overrides.withArrivalAlternatives ? ['t2,08:00:00,08:00:00,origin,1,0,0', 't2,08:21:00,08:21:00,destination,2,0,0', 't3,08:00:00,08:00:00,origin,1,0,0', 't3,08:22:00,08:22:00,destination,2,0,0'] : []),
    ].join('\n')),
    'calendar.txt': new TextEncoder().encode(`service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,${overrides.monday ?? '1'},0,0,0,0,0,0,20261001,20261031`),
  };
  if (overrides.withShape) files['shapes.txt'] = new TextEncoder().encode([
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    'shape-1,49.8400,24.0200,1',
    'shape-1,49.8450,24.0240,2',
    'shape-1,49.8500,24.0300,3',
  ].join('\n'));
  if (overrides.exceptionDate) files['calendar_dates.txt'] = new TextEncoder().encode(`service_id,date,exception_type\nweekday,${overrides.exceptionDate},${overrides.exceptionType ?? '1'}`);
  return parseGtfsTimetable(files);
}

function connectingFeed(options: { secondRouteType?: string; secondDeparture?: string; transferType?: string; minimumTransferTime?: string; inSeat?: boolean; withPathway?: boolean } = {}) {
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': new TextEncoder().encode(`route_id,agency_id,route_short_name,route_long_name,route_type\nbus,a,7,City bus,3\nrail,a,IC 743,${options.secondRouteType === '3' ? 'Next city bus' : 'Train'},${options.secondRouteType ?? '2'}`),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'start,Start,49.8400,24.0200',
      'hub,Transfer hub,49.8450,24.0250',
      ...(options.withPathway ? ['walkway,Station walkway,49.8451,24.0251'] : []),
      'finish,Finish,49.8500,24.0300',
    ].join('\n')),
    'trips.txt': new TextEncoder().encode('route_id,service_id,trip_id,trip_headsign\nbus,weekday,b1,Transfer hub\nrail,weekday,r1,Finish'),
    'stop_times.txt': new TextEncoder().encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      'b1,08:00:00,08:00:00,start,1,0,0',
      'b1,08:20:00,08:20:00,hub,2,0,0',
      `r1,${options.secondDeparture ?? '08:35:00'},${options.secondDeparture ?? '08:35:00'},hub,1,0,0`,
      'r1,09:00:00,09:00:00,finish,2,0,0',
    ].join('\n')),
    'calendar.txt': new TextEncoder().encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
  };
  if (options.transferType) files['transfers.txt'] = new TextEncoder().encode(
    `from_stop_id,to_stop_id,transfer_type${options.minimumTransferTime ? ',min_transfer_time' : ''}${options.inSeat ? ',from_trip_id,to_trip_id' : ''}\nhub,hub,${options.transferType}${options.minimumTransferTime ? `,${options.minimumTransferTime}` : ''}${options.inSeat ? ',b1,r1' : ''}`,
  );
  if (options.withPathway) files['pathways.txt'] = new TextEncoder().encode(
    'from_stop_id,to_stop_id,pathway_mode,is_bidirectional,traversal_time,length\nhub,walkway,1,1,180,200',
  );
  return parseGtfsTimetable(files);
}

function platformTransferFeed(secondDeparture: string, connectPathways = true) {
  const transit = connectingFeed({ secondRouteType: '3', secondDeparture });
  transit.stops.delete('hub');
  transit.stops.set('bus-platform', { id: 'bus-platform', name: 'Transfer station', lon: 24.025, lat: 49.845, parentStation: 'shared-station' });
  transit.stops.set('rail-platform', { id: 'rail-platform', name: 'Transfer station', lon: 24.02505, lat: 49.845, parentStation: 'shared-station' });
  transit.stops.set('shared-station', { id: 'shared-station', name: 'Shared station', lon: 24.025025, lat: 49.845, locationType: 1 });
  transit.stops.set('walkway-node', { id: 'walkway-node', name: 'Station walkway node', lon: 24.025025, lat: 49.84502, locationType: 3 });
  transit.stopTimes.get('b1')![1].stopId = 'bus-platform';
  transit.stopTimes.get('b1')![1].sourceStopId = 'bus-platform';
  transit.stopTimes.get('b1')![1].sourceStopName = 'Transfer station';
  transit.stopTimes.get('b1')![1].sourceStopCoordinates = [24.025, 49.845];
  transit.stopTimes.get('b1')![1].sourceParentStationId = 'shared-station';
  transit.stopTimes.get('r1')![0].stopId = 'rail-platform';
  transit.stopTimes.get('r1')![0].sourceStopId = 'rail-platform';
  transit.stopTimes.get('r1')![0].sourceStopName = 'Transfer station';
  transit.stopTimes.get('r1')![0].sourceStopCoordinates = [24.02505, 49.845];
  transit.stopTimes.get('r1')![0].sourceParentStationId = 'shared-station';
  transit.stopTimesByStop = new Map();
  for (const [tripId, entries] of transit.stopTimes) entries.forEach((entry, index) => {
    const atStop = transit.stopTimesByStop.get(entry.stopId) ?? [];
    atStop.push({ tripId, index }); transit.stopTimesByStop.set(entry.stopId, atStop);
  });
  transit.pathways = [
    { fromStopId: 'bus-platform', toStopId: 'walkway-node', fromCoordinates: [24.025, 49.845], toCoordinates: [24.025025, 49.84502], pathwayMode: 1, bidirectional: true, traversalTimeSeconds: 180, lengthMeters: 200 },
    ...(connectPathways ? [{ fromStopId: 'walkway-node', toStopId: 'rail-platform', fromCoordinates: [24.025025, 49.84502] as [number, number], toCoordinates: [24.02505, 49.845] as [number, number], pathwayMode: 1, bidirectional: true, traversalTimeSeconds: 180, lengthMeters: 200 }] : []),
  ];
  return transit;
}

function fourModeTransferFeed() {
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': new TextEncoder().encode([
      'route_id,agency_id,route_short_name,route_long_name,route_type',
      'bus,a,7,City bus,3', 'tram,a,2,City tram,0', 'metro,a,M1,Metro,1', 'rail,a,R1,Regional rail,2',
    ].join('\n')),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'start,Start,49.8400,24.0200', 'bus-mid,Bus intermediate,49.8425,24.0225', 'hub1,Hub 1,49.8450,24.0250',
      'tram-mid,Tram intermediate,49.8475,24.0275', 'hub2,Hub 2,49.8500,24.0300',
      'metro-mid,Metro intermediate,49.8525,24.0325', 'hub3,Hub 3,49.8550,24.0350',
      'rail-mid,Rail intermediate,49.8575,24.0375', 'finish,Finish,49.8600,24.0400',
    ].join('\n')),
    'trips.txt': new TextEncoder().encode([
      'route_id,service_id,trip_id,trip_headsign', 'bus,weekday,b1,Hub 1', 'tram,weekday,t1,Hub 2',
      'metro,weekday,m1,Hub 3', 'rail,weekday,r1,Finish',
    ].join('\n')),
    'stop_times.txt': new TextEncoder().encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      'b1,08:00:00,08:00:00,start,1,0,0', 'b1,08:05:00,08:05:00,bus-mid,2,0,0', 'b1,08:10:00,08:10:00,hub1,3,0,0',
      't1,08:20:00,08:20:00,hub1,1,0,0', 't1,08:25:00,08:25:00,tram-mid,2,0,0', 't1,08:30:00,08:30:00,hub2,3,0,0',
      'm1,08:40:00,08:40:00,hub2,1,0,0', 'm1,08:45:00,08:45:00,metro-mid,2,0,0', 'm1,08:50:00,08:50:00,hub3,3,0,0',
      'r1,09:00:00,09:00:00,hub3,1,0,0', 'r1,09:07:00,09:07:00,rail-mid,2,0,0', 'r1,09:15:00,09:15:00,finish,3,0,0',
    ].join('\n')),
    'calendar.txt': new TextEncoder().encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
  };
  return parseGtfsTimetable(files);
}

function crowdedBusStops() {
  const result = feed();
  result.stops.clear();
  result.trips.clear();
  result.stopTimes.clear();
  result.stopTimesByStop.clear();
  for (let index = 0; index < 25; index++) {
    const originId = `noise-origin-${index}`;
    const destinationId = `noise-destination-${index}`;
    result.stops.set(originId, { id: originId, name: `Bus stop ${index}`, lon: 24.02001 + index * 0.00001, lat: 49.8401 });
    result.stops.set(destinationId, { id: destinationId, name: `Noise endpoint ${index}`, lon: 24.021 + index * 0.00001, lat: 49.841 });
    const tripId = `noise-trip-${index}`;
    result.trips.set(tripId, { routeId: 'r', serviceId: 'weekday', headsign: 'Noise endpoint' });
    result.stopTimes.set(tripId, [
      { stopId: originId, sequence: 1, arrivalSeconds: 8 * 3600, departureSeconds: 8 * 3600, pickupType: 0, dropOffType: 0 },
      { stopId: destinationId, sequence: 2, arrivalSeconds: 8 * 3600 + 10 * 60, departureSeconds: 8 * 3600 + 10 * 60, pickupType: 0, dropOffType: 0 },
    ]);
    result.stopTimesByStop.set(originId, [...(result.stopTimesByStop.get(originId) ?? []), { tripId, index: 0 }]);
    result.stopTimesByStop.set(destinationId, [...(result.stopTimesByStop.get(destinationId) ?? []), { tripId, index: 1 }]);
  }
  return result;
}

function transferFeed(options: { routeType: string; routeName: string; fromId: string; fromName: string; fromLon: string; fromLat: string; toId: string; toName: string; toLon: string; toLat: string; departure: string; arrival: string; timezone?: string }) {
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode(`agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,${options.timezone ?? 'Europe/Kyiv'}`),
    'routes.txt': new TextEncoder().encode(`route_id,agency_id,route_short_name,route_long_name,route_type\nr,a,7,${options.routeName},${options.routeType}`),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      `${options.fromId},${options.fromName},${options.fromLat},${options.fromLon}`,
      `${options.toId},${options.toName},${options.toLat},${options.toLon}`,
    ].join('\n')),
    'trips.txt': new TextEncoder().encode('route_id,service_id,trip_id,trip_headsign\nr,weekday,t1,Finish'),
    'stop_times.txt': new TextEncoder().encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      `t1,${options.departure},${options.departure},${options.fromId},1,0,0`,
      `t1,${options.arrival},${options.arrival},${options.toId},2,0,0`,
    ].join('\n')),
    'calendar.txt': new TextEncoder().encode('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,1,0,0,0,0,0,0,20261001,20261031'),
  };
  return parseGtfsTimetable(files);
}

const request = (earliest: string, latest: string) => ({
  providerId: 'p1', providerName: 'Test Transit', origin: [24.0201, 49.8401] as [number, number], destination: [24.0301, 49.8501] as [number, number],
  earliestDeparture: new Date(earliest), latestDeparture: new Date(latest), now: new Date('2026-10-08T00:00:00Z'),
});

test('finds a scheduled direct bus, preserves route/stops, and converts agency local time to UTC', () => {
  const journeys = findDirectGtfsJourneys(feed(), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'));
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].mode, 'BUS');
  assert.equal(journeys[0].routeName, '7');
  assert.equal(journeys[0].headsign, 'Central station');
  assert.equal(journeys[0].originStop.name, 'Origin stop');
  assert.equal(journeys[0].routeGeometry, undefined, 'a missing source shape must not be replaced with a straight line');
  assert.equal(journeys[0].departureAt.toISOString(), '2026-10-12T05:00:00.000Z');
  assert.equal(journeys[0].arrivalAt.toISOString(), '2026-10-12T05:40:00.000Z');
});

test('returns every source stop and its scheduled times for expandable route details', () => {
  const journey = findDirectGtfsJourneys(feed({ withIntermediate: true }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'))[0];
  assert.deepEqual(journey?.stops?.map(stop => [stop.name, stop.arrivalAt]), [
    ['Origin stop', '2026-10-12T05:00:00.000Z'],
    ['Middle stop', '2026-10-12T05:20:00.000Z'],
    ['Destination stop', '2026-10-12T05:40:00.000Z'],
  ]);
});

test('lists upcoming stop arrivals from the provider-scoped schedule without claiming they are live', () => {
  const arrivals = findGtfsStopArrivals(feed(), 'destination', {
    now: new Date('2026-10-12T05:20:00Z'), limit: 10,
  });
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].routeName, '7');
  assert.equal(arrivals[0].scheduledArrivalAt.toISOString(), '2026-10-12T05:40:00.000Z');
  assert.equal(arrivals[0].predictedArrivalAt.toISOString(), '2026-10-12T05:40:00.000Z');
  assert.equal(arrivals[0].etaSeconds, 1200);
  assert.equal(arrivals[0].source, 'SCHEDULE');
  assert.equal(arrivals[0].confidence, 'LOW');
});

test('filters stop arrivals by the selected route and direction before limiting results', () => {
  const schedule = feed({ withArrivalAlternatives: true });
  const matching = findGtfsStopArrivals(schedule, 'destination', {
    now: new Date('2026-10-12T05:20:00Z'), routeId: 'r', headsign: '  CENTRAL   STATION ', limit: 1,
  });
  assert.equal(matching.length, 1);
  assert.equal(matching[0].routeId, 'r');
  assert.equal(matching[0].tripId, 't1');
  assert.equal(findGtfsStopArrivals(schedule, 'destination', {
    now: new Date('2026-10-12T05:20:00Z'), routeId: 'r', limit: 1,
  })[0].tripId, 't3', 'an earlier opposite-direction departure exists and is excluded by the headsign filter');
  assert.equal(findGtfsStopArrivals(schedule, 'destination', {
    now: new Date('2026-10-12T05:20:00Z'), routeId: 'r2', headsign: 'Central station', limit: 1,
  })[0].tripId, 't2', 'an earlier matching headsign exists on another route and is excluded by the route filter');
});

test('filters skipped, past, and non-service-day stop arrivals', () => {
  const mondayOnly = feed();
  assert.equal(findGtfsStopArrivals(mondayOnly, 'destination', {
    now: new Date('2026-10-13T05:20:00Z'),
  }).length, 0);
  assert.equal(findGtfsStopArrivals(mondayOnly, 'destination', {
    now: new Date('2026-10-12T05:45:00Z'),
  }).length, 0);
  assert.throws(() => findGtfsStopArrivals(feed(), 'destination', { limit: 0 }), /between 1 and 50/);
});

test('carries clipped source GTFS shape geometry on a routed segment', () => {
  const result = findGtfsItinerariesWithStats(feed({ withShape: true }), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  });
  const geometry = result.itineraries[0]?.segments[0]?.routeGeometry;
  assert.ok(geometry);
  assert.deepEqual(geometry[0], [24.02, 49.84]);
  assert.deepEqual(geometry.at(-1), [24.03, 49.85]);
  assert.deepEqual(geometry[1], [24.024, 49.845]);
});

test('preserves shape identifiers and geometry when compatible GTFS providers are merged', () => {
  const merged = mergeGtfsTimetables([{ providerId: 'p1', providerName: 'Test Transit', providerCity: 'Львів', feed: feed({ withShape: true }) }]);
  assert.ok(merged);
  assert.equal(merged.trips.get('p1:t1')?.shapeId, 'p1:shape-1');
  assert.equal(merged.shapes?.get('p1:shape-1')?.length, 3);
  const result = findGtfsItinerariesWithStats(merged, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  });
  assert.equal(result.itineraries[0]?.segments[0]?.routeGeometry?.length, 3);
});

test('reuses a merged timetable briefly and invalidates it when a source snapshot changes', () => {
  const source = { providerId: 'merge-cache-reuse', providerName: 'Test Transit', providerCity: 'Львів', feed: feed({ withShape: true }) };
  const first = mergeGtfsTimetables([source]);
  const reused = mergeGtfsTimetables([source]);
  assert.ok(first);
  assert.strictEqual(reused, first);

  const updated = mergeGtfsTimetables([{ ...source, feed: feed({ withShape: true }) }]);
  assert.ok(updated);
  assert.notStrictEqual(updated, first);
});

test('reports when the itinerary result limit hides additional route chains', () => {
  const timetable = feed();
  timetable.routes.set('r2', { name: 'Tram 2', mode: 'TRAM', transportType: 'tram' });
  timetable.trips.set('t2', { routeId: 'r2', serviceId: 'weekday', headsign: 'Central station' });
  const alternateStops = (timetable.stopTimes.get('t1') ?? []).map((stop) => ({ ...stop }));
  timetable.stopTimes.set('t2', alternateStops);
  for (const [index, stop] of alternateStops.entries()) {
    timetable.stopTimesByStop.set(stop.stopId, [
      ...(timetable.stopTimesByStop.get(stop.stopId) ?? []), { tripId: 't2', index },
    ]);
  }

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), limit: 1,
    maximumTransfers: 0, maximumStopDistanceMeters: 1000,
  });

  assert.equal(result.itineraries.length, 1);
  assert.equal(result.resultLimitReached, true);
  assert.equal(result.searchTruncated, false);
});

test('limits duplicate stop-pair alternatives for the same scheduled trip chain', () => {
  const timetable = feed({ withIntermediate: true });
  const stops = [
    { id: 'origin', name: 'Origin stop', lon: 24.02, lat: 49.84, seconds: 8 * 3600 },
    { id: 'extra-1', name: 'Extra 1', lon: 24.022, lat: 49.842, seconds: 8 * 3600 + 5 * 60 },
    { id: 'extra-2', name: 'Extra 2', lon: 24.024, lat: 49.844, seconds: 8 * 3600 + 10 * 60 },
    { id: 'middle', name: 'Middle stop', lon: 24.025, lat: 49.845, seconds: 8 * 3600 + 20 * 60 },
    { id: 'extra-3', name: 'Extra 3', lon: 24.028, lat: 49.848, seconds: 8 * 3600 + 30 * 60 },
    { id: 'destination', name: 'Destination stop', lon: 24.03, lat: 49.85, seconds: 8 * 3600 + 40 * 60 },
  ];
  for (const stop of stops.filter((item) => item.id.startsWith('extra'))) {
    timetable.stops.set(stop.id, { id: stop.id, name: stop.name, lon: stop.lon, lat: stop.lat });
  }
  for (const [stopId, entries] of timetable.stopTimesByStop) {
    timetable.stopTimesByStop.set(stopId, entries.filter((entry) => entry.tripId !== 't1'));
  }
  const stopTimes = stops.map((stop, index) => ({
    stopId: stop.id, sequence: index + 1, arrivalSeconds: stop.seconds, departureSeconds: stop.seconds,
    pickupType: 0, dropOffType: 0,
  }));
  timetable.stopTimes.set('t1', stopTimes);
  stopTimes.forEach((stop, index) => timetable.stopTimesByStop.set(stop.stopId,
    [...(timetable.stopTimesByStop.get(stop.stopId) ?? []), { tripId: 't1', index }]));

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumTransfers: 0,
    maximumStopDistanceMeters: 2000,
  });
  const countsByTripChain = new Map<string, number>();
  for (const itinerary of result.itineraries) {
    const key = itinerary.segments.map((segment) => `${segment.providerId}:${segment.serviceDate}:${segment.tripId}`).join('>');
    countsByTripChain.set(key, (countsByTripChain.get(key) ?? 0) + 1);
  }

  assert.ok(result.itineraries.length > 0);
  assert.ok([...countsByTripChain.values()].every((count) => count <= 2),
    'a bounded number of stop-pair choices should share the same scheduled vehicle chain');
  assert.equal(result.resultLimitReached, true,
    'suppressing additional stop-pair variants must be visible as candidate sampling');
});

test('same-trip sampling preserves a genuinely cheaper stop-pair option under the two-variant cap', () => {
  const base = findGtfsItineraries(feed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  })[0];
  assert.ok(base);
  const fastest = { ...base, id: 'fastest-stops', durationSeconds: 3_900, walkingMeters: 900,
    fare: { priceMinor: 2_300, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };
  const cheaper = { ...base, id: 'cheaper-stops', durationSeconds: 4_200, walkingMeters: 700,
    fare: { priceMinor: 2_000, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };
  const shortestWalk = { ...base, id: 'shortest-walk-stops', durationSeconds: 4_300, walkingMeters: 300,
    fare: { priceMinor: 2_300, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };

  const selected = sampleGtfsTripChainCandidates([shortestWalk, cheaper, fastest]);
  assert.deepEqual(new Set(selected.map((journey) => journey.id)), new Set([fastest.id, cheaper.id]));
});

test('same-trip sampling uses the lower-walking boarding choice when fares are equal', () => {
  const base = findGtfsItineraries(feed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  })[0];
  assert.ok(base);
  const fastest = { ...base, id: 'fastest-stops', durationSeconds: 3_900, walkingMeters: 900,
    fare: { priceMinor: 2_300, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };
  const shortestWalk = { ...base, id: 'shortest-walk-stops', durationSeconds: 4_300, walkingMeters: 300,
    fare: { priceMinor: 2_300, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };
  const ordinary = { ...base, id: 'ordinary-stops', durationSeconds: 4_200, walkingMeters: 700,
    fare: { priceMinor: 2_300, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };

  const selected = sampleGtfsTripChainCandidates([ordinary, shortestWalk, fastest]);
  assert.deepEqual(new Set(selected.map((journey) => journey.id)), new Set([fastest.id, shortestWalk.id]));
});

test('keeps fastest and cheapest GTFS candidates when the response limit is tight', () => {
  const timetable = feed({ departure: '08:00:00', arrival: '08:30:00' });
  timetable.routes.set('r2', { name: 'Slow cheap bus', mode: 'BUS', transportType: 'bus' });
  timetable.trips.set('t2', { routeId: 'r2', serviceId: 'weekday', headsign: 'Destination' });
  const slowStops = (timetable.stopTimes.get('t1') ?? []).map((stop, index) => ({
    ...stop,
    arrivalSeconds: index === 0 ? 8 * 3600 + 5 * 60 : 8 * 3600 + 45 * 60,
    departureSeconds: index === 0 ? 8 * 3600 + 5 * 60 : 8 * 3600 + 45 * 60,
  }));
  timetable.stopTimes.set('t2', slowStops);
  slowStops.forEach((stop, index) => {
    timetable.stopTimesByStop.set(stop.stopId, [
      ...(timetable.stopTimesByStop.get(stop.stopId) ?? []), { tripId: 't2', index },
    ]);
  });
  timetable.fareProducts = new Map([
    ['fast-fare', { id: 'fast-fare', priceMinor: 1000, currency: 'UAH', transfers: 0, transferDurationSeconds: null }],
    ['cheap-fare', { id: 'cheap-fare', priceMinor: 100, currency: 'UAH', transfers: 0, transferDurationSeconds: null }],
  ]);
  timetable.fareRules = new Map([
    ['fast-fare', [{ fareId: 'fast-fare', routeId: 'r' }]],
    ['cheap-fare', [{ fareId: 'cheap-fare', routeId: 'r2' }]],
  ]);

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    limit: 2, maximumTransfers: 0, maximumStopDistanceMeters: 1000,
  });

  assert.deepEqual(new Set(result.itineraries.map((journey) => journey.segments[0]?.routeId)), new Set(['r', 'r2']));
  assert.equal(result.itineraries.find((journey) => journey.segments[0]?.routeId === 'r2')?.fare?.priceMinor, 100);
});

test('keeps a later faster trip within the same route chain after the route-chain sample fills', () => {
  const timetable = feed();
  const origin = timetable.stops.get('origin');
  const destination = timetable.stops.get('destination');
  assert.ok(origin && destination);
  const dailyTrips = Array.from({ length: 10 }, (_, index) => ({
    id: index === 9 ? 'express-trip' : `regular-${index}`,
    departure: 8 * 3600 + index * 60,
    arrival: index === 9 ? 8 * 3600 + 15 * 60 : 8 * 3600 + 25 * 60 + index * 60,
  }));
  timetable.trips.delete('t1');
  timetable.stopTimes.delete('t1');
  for (const entries of timetable.stopTimesByStop.values()) {
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]?.tripId === 't1') entries.splice(index, 1);
    }
  }
  dailyTrips.forEach((trip) => {
    timetable.trips.set(trip.id, { routeId: 'r', serviceId: 'weekday', headsign: 'Central station' });
    const stops = [
      { stopId: 'origin', sequence: 1, arrivalSeconds: trip.departure, departureSeconds: trip.departure, pickupType: 0, dropOffType: 0 },
      { stopId: 'destination', sequence: 2, arrivalSeconds: trip.arrival, departureSeconds: trip.arrival, pickupType: 0, dropOffType: 0 },
    ];
    timetable.stopTimes.set(trip.id, stops);
    stops.forEach((stop, index) => timetable.stopTimesByStop.set(stop.stopId, [
      ...(timetable.stopTimesByStop.get(stop.stopId) ?? []), { tripId: trip.id, index },
    ]));
  });

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    limit: 10, maximumTransfers: 0, maximumStopDistanceMeters: 1000,
  });

  assert.ok(result.itineraries.some((journey) => journey.segments[0]?.tripId === 'express-trip'),
    'candidate sampling must not let earlier regular departures hide a later express arrival on the same route chain');
  assert.equal(result.resultLimitReached, true, 'discarding additional route-chain candidates remains visible');
});

test('preserves stops for the reverse direction when nearby stops crowd the same route id', () => {
  const timetable = feed();
  const originalTrip = timetable.trips.get('t1');
  assert.ok(originalTrip);
  timetable.trips.set('t1', { ...originalTrip, directionId: '0' });
  const terminal = { id: 'far-terminal', name: 'Far terminal', lon: 24.07, lat: 49.87 };
  timetable.stops.set(terminal.id, terminal);

  // Twenty closer stops all belong to the same route direction. A valid
  // reverse-direction boarding stop ranks 21st but remains inside the access shed.
  for (let index = 1; index <= 19; index++) {
    const stopId = `near-${index}`;
    const tripId = `near-trip-${index}`;
    timetable.stops.set(stopId, { id: stopId, name: `Near ${index}`, lon: 24.02 + index * 0.00014, lat: 49.84 });
    timetable.trips.set(tripId, { routeId: 'r', serviceId: 'weekday', headsign: 'Central station', directionId: '0' });
    timetable.stopTimes.set(tripId, [
      { stopId, sequence: 1, arrivalSeconds: 8 * 3600, departureSeconds: 8 * 3600, pickupType: 0, dropOffType: 0 },
      { stopId: terminal.id, sequence: 2, arrivalSeconds: 9 * 3600, departureSeconds: 9 * 3600, pickupType: 0, dropOffType: 0 },
    ]);
    timetable.stopTimesByStop.set(stopId, [{ tripId, index: 0 }]);
    timetable.stopTimesByStop.set(terminal.id, [
      ...(timetable.stopTimesByStop.get(terminal.id) ?? []), { tripId, index: 1 },
    ]);
  }

  const reverseOriginId = 'reverse-origin';
  timetable.stops.set(reverseOriginId, { id: reverseOriginId, name: 'Reverse direction stop', lon: 24.0235, lat: 49.84 });
  timetable.trips.set('reverse-trip', { routeId: 'r', serviceId: 'weekday', headsign: 'South terminal', directionId: '1' });
  timetable.stopTimes.set('reverse-trip', [
    { stopId: reverseOriginId, sequence: 1, arrivalSeconds: 8 * 3600 + 5 * 60, departureSeconds: 8 * 3600 + 5 * 60, pickupType: 0, dropOffType: 0 },
    { stopId: 'destination', sequence: 2, arrivalSeconds: 8 * 3600 + 25 * 60, departureSeconds: 8 * 3600 + 25 * 60, pickupType: 0, dropOffType: 0 },
  ]);
  timetable.stopTimesByStop.set(reverseOriginId, [{ tripId: 'reverse-trip', index: 0 }]);
  timetable.stopTimesByStop.set('destination', [
    ...(timetable.stopTimesByStop.get('destination') ?? []), { tripId: 'reverse-trip', index: 1 },
  ]);

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  });

  assert.ok(result.itineraries.some((journey) => journey.segments[0]?.tripId === 'reverse-trip'));
  assert.equal(result.searchTruncated, false, 'all in-radius route patterns fit within the bounded stop set');
});

test('bounds a dense route graph and reports omitted GTFS segment candidates', () => {
  const timetable = feed();
  // Routes elsewhere in a national feed must not dilute this corridor's
  // retention quota when they have no stops in the query's interchange set.
  for (let index = 0; index < 1_000; index++) {
    const routeId = `unrelated-${String(index).padStart(4, '0')}`;
    timetable.routes.set(routeId, { name: routeId, mode: 'BUS', transportType: 'bus' });
  }
  const originEntries = [...(timetable.stopTimesByStop.get('origin') ?? [])];
  const destinationEntries = [...(timetable.stopTimesByStop.get('destination') ?? [])];
  for (let index = 0; index < 5_001; index++) {
    const tripId = `dense-${String(index).padStart(4, '0')}`;
    timetable.trips.set(tripId, { routeId: 'r', serviceId: 'weekday', headsign: 'Destination' });
    timetable.stopTimes.set(tripId, [
      { stopId: 'origin', sequence: 1, arrivalSeconds: 8 * 3600, departureSeconds: 8 * 3600, pickupType: 0, dropOffType: 0 },
      { stopId: 'destination', sequence: 2, arrivalSeconds: 8 * 3600 + 40 * 60, departureSeconds: 8 * 3600 + 40 * 60, pickupType: 0, dropOffType: 0 },
    ]);
    originEntries.push({ tripId, index: 0 });
    destinationEntries.push({ tripId, index: 1 });
  }
  // This useful departure is deliberately last in feed insertion order. A
  // prefix cap drops it even though it is the fastest feasible direct option.
  timetable.trips.set('fast-late-trip', { routeId: 'r', serviceId: 'weekday', headsign: 'Destination' });
  timetable.stopTimes.set('fast-late-trip', [
    { stopId: 'origin', sequence: 1, arrivalSeconds: 8 * 3600, departureSeconds: 8 * 3600, pickupType: 0, dropOffType: 0 },
    { stopId: 'destination', sequence: 2, arrivalSeconds: 8 * 3600 + 5 * 60, departureSeconds: 8 * 3600 + 5 * 60, pickupType: 0, dropOffType: 0 },
  ]);
  timetable.stopTimesByStop.set('origin', originEntries);
  timetable.stopTimesByStop.set('destination', destinationEntries);

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  });

  assert.ok(result.itineraries.length > 0, 'the bounded graph still returns feasible scheduled options');
  assert.ok(result.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === 'fast-late-trip')),
    'bounded retention must not favor early rows in a chronologically ordered feed');
  assert.equal(result.searchTruncated, true, 'omitting graph candidates must be visible as a partial search');
  assert.equal(result.candidateGraphTruncated, true, 'the internal result identifies graph-level truncation');
  assert.equal(result.resultLimitReached, true, 'candidate-pool sampling is separately reported');
});

test('excludes isolated remote trip endpoints from the transfer graph and retains a feasible chain', () => {
  const timetable = connectingFeed();
  const noiseOrigin = 'noise-origin';
  const noiseDestination = 'noise-destination';
  timetable.stops.set(noiseOrigin, { id: noiseOrigin, name: 'Remote line start', lon: 24.0201, lat: 49.86 });
  timetable.stops.set(noiseDestination, { id: noiseDestination, name: 'Remote line end', lon: 24.0201, lat: 49.862 });

  const originEntries = [...(timetable.stopTimesByStop.get(noiseOrigin) ?? [])];
  const destinationEntries = [...(timetable.stopTimesByStop.get(noiseDestination) ?? [])];
  for (let index = 0; index < 11_000; index++) {
    const tripId = `noise-${String(index).padStart(5, '0')}`;
    timetable.trips.set(tripId, { routeId: 'rail', serviceId: 'weekday', headsign: 'Remote line end' });
    timetable.stopTimes.set(tripId, [
      { stopId: noiseOrigin, sequence: 1, arrivalSeconds: 8 * 3600, departureSeconds: 8 * 3600, pickupType: 0, dropOffType: 0 },
      { stopId: noiseDestination, sequence: 2, arrivalSeconds: 8 * 3600 + 10 * 60, departureSeconds: 8 * 3600 + 10 * 60, pickupType: 0, dropOffType: 0 },
    ]);
    originEntries.push({ tripId, index: 0 });
    destinationEntries.push({ tripId, index: 1 });
  }
  timetable.stopTimesByStop.set(noiseOrigin, originEntries);
  timetable.stopTimesByStop.set(noiseDestination, destinationEntries);

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300,
    maximumTransfers: 1,
  });

  assert.ok(result.itineraries.some((journey) => journey.segments.map((segment) => segment.tripId).join(',') === 'b1,r1'),
    'the valid bus-to-rail connection remains in the candidate graph');
  assert.equal(result.candidateGraphTruncated, false, 'isolated one-way endpoints do not create an artificial graph overflow');
  assert.equal(result.searchTruncated, false, 'the complete small corridor query is not reported as partial');
});

test('does not treat an unknown fare as free in balanced GTFS candidate sampling', () => {
  const base = findGtfsItineraries(connectingFeed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300,
    maximumTransfers: 1,
  })[0];
  assert.ok(base);
  const known = {
    ...base,
    id: 'known-zero-fare',
    durationSeconds: base.durationSeconds + 60,
    fare: { priceMinor: 0, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
  };
  const unknown = {
    ...base,
    id: 'unknown-fare',
    fare: null,
  };
  const slowerKnown = {
    ...known,
    id: 'slower-known-fare',
    durationSeconds: base.durationSeconds + 3600,
  };

  const ranked = rankGtfsItinerariesForCandidateSampling([unknown, known, slowerKnown]);
  assert.deepEqual(ranked.map((itinerary) => itinerary.id), ['known-zero-fare', 'unknown-fare', 'slower-known-fare']);
  assert.equal(unknown.fare, null, 'unknown fare remains unknown in the candidate data');
});

test('route-chain sample preserves both FASTEST and CHEAPEST extremes', () => {
  const base = findGtfsItineraries(feed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  })[0];
  assert.ok(base);
  const ordinary = Array.from({ length: 10 }, (_, index) => ({
    ...base, id: `ordinary-${index}`, durationSeconds: 4_000 + index * 30,
    fare: { priceMinor: 600 + index * 20, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
  }));
  const fastest = { ...base, id: 'fastest-extreme', durationSeconds: 1_800,
    fare: { priceMinor: 1_500, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };
  const cheapest = { ...base, id: 'cheapest-extreme', durationSeconds: 7_200,
    fare: { priceMinor: 100, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } };
  const selected = sampleGtfsRouteChainCandidates([...ordinary, fastest, cheapest], 8);

  assert.equal(selected.length, 8);
  assert.ok(selected.some((journey) => journey.id === fastest.id), 'the fastest option survives route-chain sampling');
  assert.ok(selected.some((journey) => journey.id === cheapest.id), 'the cheapest known-fare option survives route-chain sampling');
});

test('route-chain sample tie-break is locale-independent and stable across input order', () => {
  const base = findGtfsItineraries(feed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  })[0];
  assert.ok(base);
  const ids = ['Z', 'a', 'Б', 'А', '10', '2', 'z', 'A', 'а', 'б'];
  const equalCandidates = ids.map((id) => ({
    ...base,
    id,
    durationSeconds: 3_600,
    transfers: 0,
    walkingMeters: 100,
    fare: { priceMinor: 500, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
  }));

  const forward = sampleGtfsRouteChainCandidates(equalCandidates, 4).map((journey) => journey.id);
  const reversed = sampleGtfsRouteChainCandidates([...equalCandidates].reverse(), 4).map((journey) => journey.id);
  assert.deepEqual(forward, ['10', '2', 'A', 'Z']);
  assert.deepEqual(reversed, forward, 'equal-score sample does not depend on feed/input insertion order');
});

test('retains the late cheapest transfer after the bounded candidate pool fills', () => {
  const timetable = connectingFeed();
  const products = new Map<string, { id: string; priceMinor: number; currency: string; transfers: number; transferDurationSeconds: null }>();
  const rules = new Map<string, Array<{ fareId: string; routeId: string }>>();
  products.set('bus-fare', { id: 'bus-fare', priceMinor: 1000, currency: 'UAH', transfers: 0, transferDurationSeconds: null });
  rules.set('bus-fare', [{ fareId: 'bus-fare', routeId: 'bus' }]);
  for (let index = 1; index <= 520; index++) {
    const suffix = String(index).padStart(3, '0');
    const routeId = `alt-${suffix}`;
    const tripId = `alt-trip-${suffix}`;
    const fareId = `fare-${suffix}`;
    timetable.routes.set(routeId, { name: `Alternative ${suffix}`, mode: 'BUS', transportType: 'bus' });
    timetable.trips.set(tripId, { routeId, serviceId: 'weekday', headsign: 'Finish' });
    timetable.stopTimes.set(tripId, [
      { stopId: 'hub', sequence: 1, arrivalSeconds: 8 * 3600 + 30 * 60, departureSeconds: 8 * 3600 + 30 * 60, pickupType: 0, dropOffType: 0 },
      { stopId: 'finish', sequence: 2, arrivalSeconds: 8 * 3600 + 40 * 60, departureSeconds: 8 * 3600 + 40 * 60, pickupType: 0, dropOffType: 0 },
    ]);
    timetable.stopTimesByStop.set('hub', [...(timetable.stopTimesByStop.get('hub') ?? []), { tripId, index: 0 }]);
    timetable.stopTimesByStop.set('finish', [...(timetable.stopTimesByStop.get('finish') ?? []), { tripId, index: 1 }]);
    products.set(fareId, { id: fareId, priceMinor: index === 520 ? 100 : 1000, currency: 'UAH', transfers: 0, transferDurationSeconds: null });
    rules.set(fareId, [{ fareId, routeId }]);
  }
  timetable.fareProducts = products;
  timetable.fareRules = rules;

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumAccessWalkingMeters: 200, maximumEgressWalkingMeters: 200,
    maximumTransferWalkingMeters: 200, maximumTransfers: 1, limit: 100,
  });

  const cheapestLateLine = result.itineraries.find((journey) => journey.segments.at(-1)?.routeId === 'alt-520');
  assert.ok(cheapestLateLine, 'the 520th feasible transfer candidate is the lowest-fare route and must survive the 500-item candidate cap');
  assert.equal(cheapestLateLine.fare?.priceMinor, 1100);
});

test('keeps a globally cheapest direct route discovered after the bounded candidate pool fills', () => {
  const timetable = connectingFeed();
  timetable.routes.clear();
  timetable.trips.clear();
  timetable.stopTimes.clear();
  timetable.stopTimesByStop.clear();
  const products = new Map<string, { id: string; priceMinor: number; currency: string; transfers: number; transferDurationSeconds: null }>();
  const rules = new Map<string, Array<{ fareId: string; routeId: string }>>();
  const directRoutes = Array.from({ length: 500 }, (_, index) => `line-${String(index).padStart(3, '0')}`);
  directRoutes.push('zz-cheapest-line');
  for (const routeId of directRoutes) {
    const tripId = `trip-${routeId}`;
    const fareId = `fare-${routeId}`;
    timetable.routes.set(routeId, { name: routeId, mode: 'BUS', transportType: 'bus' });
    timetable.trips.set(tripId, { routeId, serviceId: 'weekday', headsign: 'Finish' });
    const entries = [
      { stopId: 'start', sequence: 1, arrivalSeconds: 8 * 3600, departureSeconds: 8 * 3600, pickupType: 0, dropOffType: 0 },
      { stopId: 'finish', sequence: 2, arrivalSeconds: 8 * 3600 + 20 * 60, departureSeconds: 8 * 3600 + 20 * 60, pickupType: 0, dropOffType: 0 },
    ];
    timetable.stopTimes.set(tripId, entries);
    entries.forEach((entry, index) => {
      const atStop = timetable.stopTimesByStop.get(entry.stopId) ?? [];
      atStop.push({ tripId, index });
      timetable.stopTimesByStop.set(entry.stopId, atStop);
    });
    products.set(fareId, { id: fareId, priceMinor: routeId === 'zz-cheapest-line' ? 100 : 1000, currency: 'UAH', transfers: 0, transferDurationSeconds: null });
    rules.set(fareId, [{ fareId, routeId }]);
  }
  timetable.fareProducts = products;
  timetable.fareRules = rules;

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumTransfers: 0, maximumStopDistanceMeters: 300, limit: 100,
  });

  const cheapest = result.itineraries.find((journey) => journey.segments[0]?.routeId === 'zz-cheapest-line');
  assert.ok(cheapest, 'the CHEAPEST strategy candidate must survive the internal 500-itinerary sample cap');
  assert.equal(cheapest.fare?.priceMinor, 100);
  assert.equal(result.resultLimitReached, true, 'the response must still report that candidate sampling omitted alternatives');
  assert.equal(result.candidateGraphTruncated, false, 'the test exhausts a complete route graph but exceeds the retained candidate sample');

  const globalLimitResult = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumTransfers: 0, maximumStopDistanceMeters: 300, limit: 5,
  });
  const globallyRetainedCheapest = globalLimitResult.itineraries.find((journey) => journey.segments[0]?.routeId === 'zz-cheapest-line');
  assert.ok(globallyRetainedCheapest, 'the objective reservoir must also protect the cheapest route after the global pool cap when space remains for multiple objectives');
  assert.equal(globallyRetainedCheapest.fare?.priceMinor, 100);
  assert.equal(globalLimitResult.resultLimitReached, true);
});

test('uses calendar date exceptions before weekly service and excludes removed service', () => {
  const added = findDirectGtfsJourneys(feed({ monday: '0', exceptionDate: '20261012' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'));
  const removed = findDirectGtfsJourneys(feed({ exceptionDate: '20261012', exceptionType: '2' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'));
  assert.equal(added.length, 1);
  assert.equal(removed.length, 0);
});

test('honors GTFS pickup/drop-off restrictions and only searches nearby stops', () => {
  assert.equal(findDirectGtfsJourneys(feed({ pickup: '1' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z')).length, 0);
  assert.equal(findDirectGtfsJourneys(feed({ pickup: '2' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z')).length, 0);
  assert.equal(findDirectGtfsJourneys(feed({ dropoff: '1' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z')).length, 0);
  assert.equal(findDirectGtfsJourneys(feed({ dropoff: '3' }), request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z')).length, 0);
  const farAway = request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z');
  farAway.origin = [25, 50];
  assert.equal(findDirectGtfsJourneys(feed(), farAway).length, 0);
});

test('applies separate conservative first-mile and last-mile walking limits', () => {
  assert.equal(DEFAULT_MAX_ACCESS_WALKING_METERS, 900);
  assert.equal(DEFAULT_MAX_EGRESS_WALKING_METERS, 1000);
  assert.equal(DEFAULT_MAX_TRANSFER_WALKING_METERS, 400);

  const accessRequest = request('2026-10-12T04:35:00Z', '2026-10-12T05:10:00Z');
  accessRequest.origin = [24.0200, 49.8482];
  assert.equal(findGtfsItinerariesWithStats(feed(), accessRequest).itineraries.length, 0,
    'the default access walk shed must reject a stop more than 900 m away');
  assert.equal(findGtfsItinerariesWithStats(feed(), {
    ...accessRequest, maximumAccessWalkingMeters: 1200,
  }).itineraries.length, 1, 'a caller may explicitly request a wider access walk shed');

  const egressRequest = request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z');
  egressRequest.destination = [24.0300, 49.8600];
  assert.equal(findGtfsItinerariesWithStats(feed(), egressRequest).itineraries.length, 0,
    'the default egress walk shed must reject a stop more than 1,000 m away');
  assert.equal(findGtfsItinerariesWithStats(feed(), {
    ...egressRequest, maximumEgressWalkingMeters: 1200,
  }).itineraries.length, 1, 'a caller may explicitly request a wider egress walk shed');
});

test('finds service after midnight when GTFS uses a 24-hour stop time', () => {
  const journeys = findDirectGtfsJourneys(feed({ departure: '24:15:00', arrival: '24:55:00' }), request('2026-10-12T21:10:00Z', '2026-10-12T21:30:00Z'));
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].departureAt.toISOString(), '2026-10-12T21:15:00.000Z');
  assert.equal(journeys[0].arrivalAt.toISOString(), '2026-10-12T21:55:00.000Z');
});

test('normalizes GTFS rail and ferry journeys into supported journey modes', () => {
  const interval = request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z');
  assert.equal(findDirectGtfsJourneys(feed({ routeType: '2' }), interval)[0]?.mode, 'RAIL');
  assert.equal(findDirectGtfsJourneys(feed({ routeType: '4' }), interval)[0]?.mode, 'FERRY');
});

test('keeps boarding, intermediate, and alighting calls for every selectable GTFS mode', () => {
  const interval = request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z');
  const cases = [
    { name: 'City bus', routeType: '3', mode: 'BUS', transportType: 'bus' },
    { name: 'Маршрутка № 5', routeType: '3', mode: 'MINIBUS', transportType: 'marshrutka' },
    { name: 'City trolleybus', routeType: '11', mode: 'TROLLEYBUS', transportType: 'trolleybus' },
    { name: 'City tram', routeType: '0', mode: 'TRAM', transportType: 'tram' },
    { name: 'City metro', routeType: '1', mode: 'METRO', transportType: 'metro' },
    { name: 'Regional train', routeType: '2', mode: 'RAIL', transportType: 'train' },
  ] as const;

  for (const item of cases) {
    const journeys = findGtfsItineraries(feed({ routeType: item.routeType, routeName: item.name, withIntermediate: true }), {
      ...interval,
      allowedModes: [item.mode],
      allowedTransportTypes: [item.transportType],
      maximumStopDistanceMeters: 100,
    });
    const segment = journeys[0]?.segments[0];
    assert.ok(segment, `${item.name} produces a selectable scheduled segment`);
    assert.equal(segment.mode, item.mode);
    assert.equal(segment.transportType, item.transportType);
    assert.deepEqual(segment.stops?.map((stop) => stop.name), ['Origin stop', 'Middle stop', 'Destination stop']);
  }
});

test('maps city and suburban rail into the canonical train category and excludes funicular', () => {
  const interval = request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z');
  const cityTrain = findGtfsItineraries(feed({ routeType: '2', routeName: 'Київська міська електричка' }), {
    ...interval, allowedModes: ['RAIL'], allowedTransportTypes: ['train'], maximumStopDistanceMeters: 2000,
  });
  const suburbanTrain = findGtfsItineraries(feed({ routeType: '109' }), {
    ...interval, allowedModes: ['RAIL'], allowedTransportTypes: ['train'], maximumStopDistanceMeters: 2000,
  });
  const funicular = findGtfsItineraries(feed({ routeType: '3', routeName: 'Фунікулер Поділ — Верхня станція' }), {
    ...interval, allowedModes: ['FUNICULAR'], allowedTransportTypes: ['train'], maximumStopDistanceMeters: 2000,
  });
  const minibus = findGtfsItineraries(feed({ routeType: '3', routeName: 'Маршрутка № 5' }), {
    ...interval, allowedModes: ['MINIBUS'], allowedTransportTypes: ['marshrutka'], maximumStopDistanceMeters: 2000,
  });
  const intercityBus = findGtfsItineraries(feed({ routeType: '3', routeName: 'Міжміський автобус' }), {
    ...interval, allowedModes: ['BUS'], allowedTransportTypes: ['bus'], maximumStopDistanceMeters: 2000,
  });
  assert.equal(cityTrain[0]?.segments[0]?.transportType, 'city_train');
  assert.equal(suburbanTrain[0]?.segments[0]?.transportType, 'suburban_train');
  assert.equal(funicular.length, 0, 'funicular has no user-selectable product category');
  assert.equal(minibus[0]?.segments[0]?.mode, 'MINIBUS');
  assert.equal(intercityBus[0]?.segments[0]?.transportType, 'intercity_bus');
});

test('does not classify bus or trolleybus routes containing “Кільцева” as city rail', () => {
  const bus = feed({ routeType: '3', routeName: 'А21 Кільцева дорога Три слони' });
  const trolleybus = feed({ routeType: '11', routeName: 'Тролейбус Кільцева' });
  const cityRail = feed({ routeType: '2', routeName: 'Міська електричка Кільцева' });

  assert.equal(bus.routes.get('r')?.transportType, 'bus');
  assert.equal(trolleybus.routes.get('r')?.transportType, 'trolleybus');
  assert.equal(cityRail.routes.get('r')?.transportType, 'city_train');
});

test('composes a time-feasible bus-to-rail itinerary at the same canonical stop', () => {
  const results = findGtfsItineraries(connectingFeed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300,
    maximumTransfers: 1,
    minimumTransferBufferSeconds: 600,
  });

  assert.equal(results.length, 1);
  assert.deepEqual(results[0].segments.map((segment) => segment.mode), ['BUS', 'RAIL']);
  assert.deepEqual(results[0].segments.map((segment) => [segment.originStop.id, segment.destinationStop.id]), [['start', 'hub'], ['hub', 'finish']]);
  assert.equal(results[0].transfers, 1);
  assert.ok(results[0].walkingMeters > 0);
  assert.equal(results[0].departureAt.toISOString(), '2026-10-12T04:55:00.000Z');
  assert.equal(results[0].durationSeconds, Math.ceil((results[0].arrivalAt.getTime() - Date.parse('2026-10-12T04:55:00Z')) / 1000));
  const initialWalkSeconds = Math.ceil(results[0].segments[0].distanceToOriginStopMeters / 1.25);
  const initialWaitSeconds = Math.ceil((results[0].segments[0].departureAt.getTime()
    - results[0].departureAt.getTime() - initialWalkSeconds * 1000) / 1000);
  const transferWaitSeconds = Math.ceil((results[0].segments[1].departureAt.getTime()
    - results[0].segments[0].arrivalAt.getTime()) / 1000);
  assert.equal(results[0].waitingSeconds, initialWaitSeconds + transferWaitSeconds);
  assert.ok(results[0].arrivalAt.getTime() > results[0].segments.at(-1)!.arrivalAt.getTime());
});

test('finds a legal nearby-platform transfer when GTFS omits an explicit transfer row', () => {
  const timetable = connectingFeed({ secondRouteType: '3', secondDeparture: '08:40:00' });
  timetable.stops.delete('hub');
  timetable.stops.set('bus-platform', { id: 'bus-platform', name: 'Bus platform', lon: 24.025, lat: 49.845 });
  timetable.stops.set('tram-platform', { id: 'tram-platform', name: 'Tram platform', lon: 24.02505, lat: 49.845 });
  timetable.stopTimes.get('b1')![1].stopId = 'bus-platform';
  timetable.stopTimes.get('b1')![1].sourceStopId = 'bus-platform';
  timetable.stopTimes.get('b1')![1].sourceStopCoordinates = [24.025, 49.845];
  timetable.stopTimes.get('r1')![0].stopId = 'tram-platform';
  timetable.stopTimes.get('r1')![0].sourceStopId = 'tram-platform';
  timetable.stopTimes.get('r1')![0].sourceStopCoordinates = [24.02505, 49.845];
  timetable.stopTimesByStop = new Map();
  for (const [tripId, entries] of timetable.stopTimes) entries.forEach((entry, index) => {
    const calls = timetable.stopTimesByStop.get(entry.stopId) ?? [];
    calls.push({ tripId, index });
    timetable.stopTimesByStop.set(entry.stopId, calls);
  });

  const query = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300,
    maximumTransferWalkingMeters: 100,
    maximumTransfers: 1,
  };
  const connected = findGtfsItineraries(timetable, query).find((journey) => journey.segments.length === 2);
  assert.ok(connected, 'distinct route platforms within the transfer walk shed can be joined');
  assert.notEqual(connected.segments[0].destinationStop.id, connected.segments[1].originStop.id);
  assert.ok(connected.transferWalkingMeters[0] > 0);

  const outsideWalkShed = findGtfsItineraries(timetable, { ...query, maximumTransferWalkingMeters: 2 });
  assert.equal(outsideWalkShed.some((journey) => journey.segments.length === 2), false,
    'nearby candidates are still rejected when their walking transfer exceeds the configured limit');
});

test('keeps valid shorter and longer chain lengths in one multi-transfer search', () => {
  const timetable = connectingFeed();
  timetable.routes.set('direct', { name: 'Direct bus', mode: 'BUS', transportType: 'bus' });
  timetable.trips.set('direct-trip', { routeId: 'direct', serviceId: 'weekday', headsign: 'Finish' });
  const directStops = [
    { stopId: 'start', sequence: 1, arrivalSeconds: 8 * 3600 + 10 * 60, departureSeconds: 8 * 3600 + 10 * 60, pickupType: 0, dropOffType: 0 },
    { stopId: 'finish', sequence: 2, arrivalSeconds: 8 * 3600 + 50 * 60, departureSeconds: 8 * 3600 + 50 * 60, pickupType: 0, dropOffType: 0 },
  ];
  timetable.stopTimes.set('direct-trip', directStops);
  for (const [index, stop] of directStops.entries()) {
    timetable.stopTimesByStop.set(stop.stopId, [
      ...(timetable.stopTimesByStop.get(stop.stopId) ?? []), { tripId: 'direct-trip', index },
    ]);
  }

  const results = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300,
    maximumTransfers: 1,
  });

  assert.ok(results.itineraries.some((itinerary) => itinerary.segments.length === 1), 'direct route remains available');
  assert.ok(results.itineraries.some((itinerary) => itinerary.segments.length === 2), 'one-transfer route remains available');
});

test('counts initial schedule wait in door-to-door time so fastest ranking favors earliest arrival', () => {
  const interval = request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z');
  const earliestArrival = findGtfsItinerariesWithStats(feed({ departure: '08:00:00', arrival: '08:30:00' }), {
    ...interval, maximumStopDistanceMeters: 1000, maximumTransfers: 0,
  }).itineraries[0];
  const shorterRideLater = findGtfsItinerariesWithStats(feed({ departure: '08:10:00', arrival: '08:35:00' }), {
    ...interval, maximumStopDistanceMeters: 1000, maximumTransfers: 0,
  }).itineraries[0];

  assert.ok(earliestArrival && shorterRideLater);
  assert.ok(earliestArrival.arrivalAt < shorterRideLater.arrivalAt);
  assert.ok(earliestArrival.durationSeconds < shorterRideLater.durationSeconds);
  assert.ok(earliestArrival.waitingSeconds < shorterRideLater.waitingSeconds);
  const candidates = [earliestArrival, shorterRideLater].map((itinerary, index) => ({
    id: index === 0 ? 'earliest-arrival' : 'shorter-ride-later',
    durationSeconds: itinerary.durationSeconds,
    priceMinor: null, transfers: 0, walkingMeters: itinerary.walkingMeters,
    reliability: null, transferRisk: 0, comfort: null, legs: [{ mode: 'BUS' as const }],
  }));
  assert.equal(scoreJourneys(candidates, 'FASTEST')[0].journey.id, 'earliest-arrival');
});

test('uses a short urban transfer buffer and a longer buffer when boarding intercity rail', () => {
  assert.equal(DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS, 180);
  const query = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300, maximumTransfers: 1,
  };
  const urbanFourMinutes = findGtfsItineraries(connectingFeed({ secondRouteType: '3', secondDeparture: '08:24:00' }), query);
  const urbanTwoMinutes = findGtfsItineraries(connectingFeed({ secondRouteType: '3', secondDeparture: '08:22:00' }), query);
  const railNineMinutes = findGtfsItineraries(connectingFeed({ secondDeparture: '08:29:00' }), query);
  const railTenMinutes = findGtfsItineraries(connectingFeed({ secondDeparture: '08:30:00' }), query);
  assert.ok(urbanFourMinutes.some((journey) => journey.transfers === 1));
  assert.equal(urbanTwoMinutes.length, 0);
  assert.equal(railNineMinutes.length, 0);
  assert.ok(railTenMinutes.some((journey) => journey.transfers === 1));
});

test('honors GTFS forbidden and minimum-time transfer rules', () => {
  const query = { ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumStopDistanceMeters: 300, maximumTransfers: 1 };
  const forbiddenFeed = connectingFeed({ secondRouteType: '3', secondDeparture: '08:40:00', transferType: '3' });
  assert.equal(forbiddenFeed.transfers?.[0]?.transferType, 3, 'the optional transfers.txt file is parsed');
  assert.equal(findGtfsItineraries(forbiddenFeed, query).length, 0, 'a prohibited connection is never composed');

  const constrainedFeed = connectingFeed({ secondRouteType: '3', secondDeparture: '08:40:00', transferType: '2', minimumTransferTime: '900' });
  assert.equal(constrainedFeed.transfers?.[0]?.minTransferTimeSeconds, 900);
  assert.ok(findGtfsItineraries(constrainedFeed, query).some((journey) => journey.segments.length === 2));
  const tooShort = connectingFeed({ secondRouteType: '3', secondDeparture: '08:30:00', transferType: '2', minimumTransferTime: '900' });
  assert.equal(findGtfsItineraries(tooShort, query).length, 0, 'min_transfer_time is a hard feasibility constraint');
});

test('applies parent-station transfer rules and preserves explicit in-seat transfers', () => {
  const query = { ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumStopDistanceMeters: 300, maximumTransfers: 1 };
  const parentRestricted = platformTransferFeed('08:40:00');
  parentRestricted.transfers = [{ fromStopId: 'shared-station', toStopId: 'shared-station', transferType: 3 }];
  const mergedRestricted = mergeGtfsTimetables([{ providerId: 'city', providerName: 'City transit', providerCity: 'Львів', feed: parentRestricted }])!;
  assert.equal(findGtfsItineraries(mergedRestricted, query).filter((journey) => journey.segments.length === 2).length, 0,
    'station-level transfer rules apply to child platforms');

  const inSeat = connectingFeed({ secondRouteType: '3', secondDeparture: '08:21:00', transferType: '4', inSeat: true });
  const inSeatJourney = findGtfsItineraries(inSeat, query).find((journey) => journey.segments.length === 2);
  assert.ok(inSeatJourney);
  assert.equal(inSeatJourney.transfers, 0);
  assert.deepEqual(inSeatJourney.transferWalkingMeters, [0]);
  assert.deepEqual(inSeatJourney.transferWalkingSeconds, [0]);
});

test('parses optional GTFS station pathways and their authoritative time and distance', () => {
  const timetable = connectingFeed({ withPathway: true });
  assert.deepEqual(timetable.pathways, [{
    fromStopId: 'hub', toStopId: 'walkway', fromCoordinates: [24.025, 49.845], toCoordinates: [24.0251, 49.8451],
    pathwayMode: 1, bidirectional: true, traversalTimeSeconds: 180, lengthMeters: 200,
  }]);
});

test('uses GTFS pathways for platform transfer time and geometry, and fails closed for disconnected station pathways', () => {
  const query = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300, maximumTransfers: 1, maximumTransferWalkingMeters: 500,
  };
  const feedWithPathways = platformTransferFeed('08:32:00');
  const merged = mergeGtfsTimetables([{ providerId: 'city', providerName: 'City transit', providerCity: 'Львів', feed: feedWithPathways }])!;
  const connected = findGtfsItineraries(merged, query).find((journey) => journey.segments.length === 2);
  assert.ok(connected);
  assert.deepEqual(connected.transferWalkingSeconds, [360]);
  assert.deepEqual(connected.transferWalkingMeters, [400]);
  assert.deepEqual(connected.transferWalkingGeometries[0], [[24.025, 49.845], [24.025025, 49.84502], [24.02505, 49.845]]);
  assert.equal(connected.transfers, 1);

  const differentlyNamedPlatforms = platformTransferFeed('08:40:00');
  differentlyNamedPlatforms.stops.get('rail-platform')!.name = 'East concourse platform 4';
  differentlyNamedPlatforms.stopTimes.get('r1')![0].sourceStopName = 'East concourse platform 4';
  const separateNodes = mergeGtfsTimetables([{ providerId: 'city', providerName: 'City transit', providerCity: 'Львів', feed: differentlyNamedPlatforms }])!;
  const crossPlatform = findGtfsItineraries(separateNodes, query).find((journey) => journey.segments.length === 2);
  assert.ok(crossPlatform, 'nearby platforms with distinct canonical IDs are considered as transfer candidates');
  assert.notEqual(crossPlatform.segments[0].destinationStop.id, crossPlatform.segments[1].originStop.id);
  assert.equal(crossPlatform.transferWalkingSeconds[0], 360);

  const disconnected = mergeGtfsTimetables([{ providerId: 'city', providerName: 'City transit', providerCity: 'Львів', feed: platformTransferFeed('08:40:00', false) }])!;
  assert.equal(findGtfsItineraries(disconnected, query).filter((journey) => journey.segments.length === 2).length, 0,
    'if the feed provides a station pathway graph but no path connects platforms, straight-line proximity is insufficient');

  const shortConnection = mergeGtfsTimetables([{ providerId: 'city', providerName: 'City transit', providerCity: 'Львів', feed: platformTransferFeed('08:28:00') }])!;
  assert.equal(findGtfsItineraries(shortConnection, query).filter((journey) => journey.segments.length === 2).length, 0,
    'a 400 m / 6 minute station transfer cannot fit in an 8 minute connection with the safety buffer');
});

test('composes four scheduled transport segments with three feasible transfers', () => {
  const results = findGtfsItineraries(fourModeTransferFeed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    destination: [24.0401, 49.8601],
    maximumStopDistanceMeters: 300,
    maximumTransfers: 3,
    minimumTransferBufferSeconds: 600,
  });
  const journey = results.find((candidate) => candidate.transfers === 3
    && candidate.segments.map((segment) => segment.mode).join(',') === 'BUS,TRAM,METRO,RAIL');
  assert.ok(journey);
  assert.deepEqual(journey.segments.map((segment) => segment.stops?.map((stop) => stop.name)), [
    ['Start', 'Bus intermediate', 'Hub 1'],
    ['Hub 1', 'Tram intermediate', 'Hub 2'],
    ['Hub 2', 'Metro intermediate', 'Hub 3'],
    ['Hub 3', 'Rail intermediate', 'Finish'],
  ]);
  assert.deepEqual(journey.segments.map((segment) => segment.stops?.[1]?.arrivalAt), [
    '2026-10-12T05:05:00.000Z', '2026-10-12T05:25:00.000Z',
    '2026-10-12T05:45:00.000Z', '2026-10-12T06:07:00.000Z',
  ]);
});

test('keeps nearest stops, represents distinct routes, and reports the bounded stop search', () => {
  const rail = transferFeed({ routeType: '2', routeName: 'Regional train', fromId: 'rail-origin', fromName: 'Rail station',
    fromLon: '24.0203', fromLat: '49.8401', toId: 'rail-destination', toName: 'Rail destination',
    toLon: '24.0300', toLat: '49.8500', departure: '08:00:00', arrival: '08:40:00' });
  const busyBuses = crowdedBusStops();
  busyBuses.routes.set('r2', { name: 'Express bus', mode: 'BUS', transportType: 'bus' });
  busyBuses.trips.set('express-trip', { routeId: 'r2', serviceId: 'weekday', headsign: 'Destination' });
  busyBuses.stops.set('express-origin', { id: 'express-origin', name: 'Express stop', lon: 24.0204, lat: 49.84015 });
  busyBuses.stops.set('express-destination', { id: 'express-destination', name: 'Express destination', lon: 24.03, lat: 49.85 });
  busyBuses.stopTimes.set('express-trip', [
    { stopId: 'express-origin', sequence: 1, arrivalSeconds: 8 * 3600, departureSeconds: 8 * 3600, pickupType: 0, dropOffType: 0 },
    { stopId: 'express-destination', sequence: 2, arrivalSeconds: 8 * 3600 + 25 * 60, departureSeconds: 8 * 3600 + 25 * 60, pickupType: 0, dropOffType: 0 },
  ]);
  busyBuses.stopTimesByStop.set('express-origin', [{ tripId: 'express-trip', index: 0 }]);
  busyBuses.stopTimesByStop.set('express-destination', [{ tripId: 'express-trip', index: 1 }]);
  const merged = mergeGtfsTimetables([
    { providerId: 'busy-city', providerName: 'Busy city buses', providerCity: 'Львів', feed: busyBuses },
    { providerId: 'rail', providerName: 'Regional rail', providerCity: 'Україна', feed: rail },
  ])!;
  const result = findGtfsItinerariesWithStats(merged, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 1000,
    maximumTransfers: 0,
  });
  assert.equal(result.itineraries.length, 2);
  assert.ok(result.itineraries.some((itinerary) => itinerary.segments[0].transportType === 'train'
    && itinerary.segments[0].providerId === 'rail'));
  assert.ok(result.itineraries.some((itinerary) => itinerary.segments.length === 1
    && itinerary.segments[0].routeId.endsWith(':r2')), 'the distinct bus route at the 21st-nearest stop must remain searchable');
  assert.equal(result.searchTruncated, true);
});

test('composes across provider feeds using equivalent Kyiv timezone names and closely matched stops', () => {
  const originFeed = transferFeed({ routeType: '3', routeName: 'City bus', fromId: 'start', fromName: 'Start', fromLon: '24.0200', fromLat: '49.8400',
    toId: 'bus-hub', toName: 'Main station', toLon: '24.0250', toLat: '49.8450', departure: '08:00:00', arrival: '08:20:00', timezone: 'Europe/Kiev' });
  assert.equal(originFeed.timezone, 'Europe/Kyiv');
  const destinationFeed = (hubLon: string) => transferFeed({ routeType: '2', routeName: 'Regional train', fromId: 'rail-hub', fromName: 'Main station', fromLon: hubLon, fromLat: '49.8450',
    toId: 'finish', toName: 'Finish', toLon: '24.0300', toLat: '49.8500', departure: '08:35:00', arrival: '09:00:00' });
  const sources = (railFeed: ReturnType<typeof destinationFeed>) => [
    { providerId: 'city-bus', providerName: 'City bus provider', providerCity: 'Львів', feed: originFeed },
    { providerId: 'regional-rail', providerName: 'Regional rail provider', providerCity: 'Україна', feed: railFeed },
  ];
  const options = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300,
    maximumTransfers: 1,
    minimumTransferBufferSeconds: 600,
  };
  const merged = mergeGtfsTimetables(sources(destinationFeed('24.02505')))!;
  const results = findGtfsItineraries(merged, { ...options, providerId: 'merged', providerName: 'Merged providers', providerCity: 'Україна' });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].segments.map((segment) => segment.providerId), ['city-bus', 'regional-rail']);
  assert.deepEqual(results[0].segments.map((segment) => segment.providerName), ['City bus provider', 'Regional rail provider']);
  assert.deepEqual(results[0].segments.map((segment) => segment.transportType), ['bus', 'train']);
  assert.equal(results[0].transfers, 1);

  const tooFar = mergeGtfsTimetables(sources(destinationFeed('24.0260')))!;
  assert.equal(findGtfsItineraries(tooFar, { ...options, providerId: 'merged', providerName: 'Merged providers', providerCity: 'Україна' }).length, 0);
});

test('composes a city bus and rail itinerary across differently named railway platforms with an explicit walk', () => {
  const cityBus = transferFeed({ routeType: '3', routeName: 'City bus', fromId: 'bus-start', fromName: 'Start',
    fromLon: '24.0000', fromLat: '49.8400', toId: 'bus-station', toName: 'Залізничний вокзал (117)',
    toLon: '23.995026', toLat: '49.839890', departure: '08:00:00', arrival: '08:10:00' });
  const railFeed = (railLon: string, stationName = 'Львів-Головний') => transferFeed({ routeType: '2', routeName: 'Regional train', fromId: 'rail-station',
    fromName: stationName, fromLon: railLon, fromLat: '49.839912', toId: 'rail-finish', toName: 'Finish',
    toLon: '23.9800', toLat: '49.8300', departure: '08:30:00', arrival: '09:00:00' });
  const sources = (rail: ReturnType<typeof railFeed>) => [
    { providerId: 'city-bus', providerName: 'Lviv city transit', providerCity: 'Львів', feed: cityBus },
    { providerId: 'rail', providerName: 'Rail feed', providerCity: 'Україна', feed: rail },
  ];
  const options = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0000, 49.8400] as [number, number], destination: [23.9800, 49.8300] as [number, number],
    maximumStopDistanceMeters: 2000, maximumTransfers: 1, minimumTransferBufferSeconds: 600,
  };

  const merged = mergeGtfsTimetables(sources(railFeed('23.993864')))!;
  const results = findGtfsItineraries(merged, { ...options, providerId: 'merged', providerName: 'Lviv corridor', providerCity: 'Україна' });
  const connected = results.find((itinerary) => itinerary.segments.length === 2);
  assert.ok(connected);
  assert.deepEqual(connected.segments.map((segment) => segment.transportType), ['bus', 'train']);
  assert.ok(connected.transferWalkingMeters[0] >= 80 && connected.transferWalkingMeters[0] <= 90);
  assert.ok(connected.walkingMeters >= connected.transferWalkingMeters[0]);
  assert.equal(connected.segments[0].destinationStop.name, 'Залізничний вокзал (117)');
  assert.equal(connected.segments[1].originStop.name, 'Львів-Головний');
  const walkShedLimited = findGtfsItineraries(merged, {
    ...options, maximumTransferWalkingMeters: 50,
    providerId: 'merged', providerName: 'Lviv corridor', providerCity: 'Україна',
  });
  assert.equal(walkShedLimited.some((itinerary) => itinerary.segments.length === 2), false,
    'a cross-platform transfer outside the configured walk shed must not be composed');

  const kyivAlias = mergeGtfsTimetables(sources(railFeed('23.993864', 'Київ-Пас.')))!;
  const kyivAliasResults = findGtfsItineraries(kyivAlias, {
    ...options, providerId: 'merged', providerName: 'Lviv corridor', providerCity: 'Україна',
  });
  assert.ok(kyivAliasResults.some((itinerary) => itinerary.segments.length === 2
    && itinerary.segments[1].originStop.name === 'Київ-Пас.'));

  const beyondStationRadius = mergeGtfsTimetables(sources(railFeed('23.992900')))!;
  assert.equal(findGtfsItineraries(beyondStationRadius, {
    ...options, providerId: 'merged', providerName: 'Lviv corridor', providerCity: 'Україна',
  }).filter((itinerary) => itinerary.segments.length === 2).length, 0);
});

test('retains secondary city-station platform coordinates when merging a third rail feed', () => {
  const cityBus = transferFeed({ routeType: '3', routeName: 'City bus', fromId: 'bus-start', fromName: 'Start',
    fromLon: '23.9900', fromLat: '49.8400', toId: 'bus-station', toName: 'Залізничний вокзал',
    toLon: '24.0010', toLat: '49.8400', departure: '08:00:00', arrival: '08:10:00' });
  const busStart = cityBus.stops.get('bus-start')!;
  const busStation = cityBus.stops.get('bus-station')!;
  // The first stop creates the canonical station at x=24.0000. The served
  // platform and rail station are each within 150 m of one another, while
  // the representative coordinate is just outside that matching radius.
  cityBus.stops = new Map([
    [busStart.id, busStart],
    ['secondary-platform', { id: 'secondary-platform', name: 'Залізничний вокзал платформа A', lon: 24, lat: 49.84 }],
    [busStation.id, busStation],
  ]);
  const rail = transferFeed({ routeType: '2', routeName: 'Regional train', fromId: 'rail-station', fromName: 'Львів-Головний',
    fromLon: '24.0023', fromLat: '49.8400', toId: 'rail-finish', toName: 'Finish',
    toLon: '24.0200', toLat: '49.8500', departure: '08:30:00', arrival: '09:00:00' });
  const merged = mergeGtfsTimetables([
    { providerId: 'city', providerName: 'Kyiv city transit', providerCity: 'Київ', feed: cityBus },
    { providerId: 'rail', providerName: 'National rail', providerCity: 'Україна', feed: rail },
  ])!;
  const results = findGtfsItineraries(merged, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [23.9900, 49.8400], destination: [24.0200, 49.8500],
    maximumStopDistanceMeters: 2000, maximumTransfers: 1, minimumTransferBufferSeconds: 600,
  });
  const connected = results.find((itinerary) => itinerary.segments.length === 2);
  assert.ok(connected);
  assert.deepEqual(connected.segments.map((segment) => segment.transportType), ['bus', 'train']);
  assert.ok(connected.transferWalkingMeters[0] >= 90 && connected.transferWalkingMeters[0] <= 100);
});

test('does not invent a feasible transfer when the configured buffer is missed', () => {
  const transit = connectingFeed();
  const rail = transit.stopTimes.get('r1')!;
  rail[0].arrivalSeconds = 8 * 3600 + 25 * 60;
  rail[0].departureSeconds = 8 * 3600 + 25 * 60;
  const results = findGtfsItineraries(transit, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300,
    maximumTransfers: 1,
    minimumTransferBufferSeconds: 600,
  });
  assert.equal(results.length, 0);
});

test('rejects feeds without a timezone and validates query bounds', () => {
  assert.throws(() => parseGtfsTimetable({ 'agency.txt': new TextEncoder().encode('agency_name\nTransit') }), /agency_timezone/);
  assert.throws(() => findDirectGtfsJourneys(feed(), { ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumStopDistanceMeters: 50 }), /between 100 and 10000/);
});
