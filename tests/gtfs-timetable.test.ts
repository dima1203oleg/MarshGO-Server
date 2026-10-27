import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_ACCESS_WALKING_METERS, DEFAULT_MAX_EGRESS_WALKING_METERS, DEFAULT_MAX_TRANSFER_WALKING_METERS, DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS, createGtfsTransferDecisionContext, eligibleTripInstanceStopEvents, findDirectGtfsJourneys, findGtfsItineraries, findGtfsItinerariesWithStats, findGtfsStopArrivals, maximumGtfsWaitWithinJourney, mergeGtfsTimetables, parseGtfsTimetable, rankGtfsItinerariesForCandidateSampling, retainGtfsDeterministicOverflowSample, sampleGtfsRouteChainCandidates, sampleGtfsTripChainCandidates, selectGtfsCandidatesForCrossProviderSearch } from '../server/journey/gtfsTimetable';
import { scoreJourneys } from '../server/journey/scoring';
import type { GtfsCandidateGraphSnapshot, GtfsDirectJourney, GtfsItinerary, GtfsTimetableFeed } from '../server/journey/gtfsTimetable';
import { queryDirectedEventIndexPrototype, validateEventIndexCandidatesWithProductionTransfers } from './helpers/gtfs-event-label-prototype';
import { lazyEventLabelSearch, lazyEventLabelSearchForRequest } from './helpers/gtfs-lazy-event-label-search';

function feed(overrides: { monday?: string; tuesday?: string; exceptionDate?: string; exceptionType?: string; pickup?: string; dropoff?: string; departure?: string; arrival?: string; routeType?: string; routeName?: string; withShape?: boolean; withIntermediate?: boolean; withArrivalAlternatives?: boolean } = {}) {
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
    'calendar.txt': new TextEncoder().encode(`service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,${overrides.monday ?? '1'},${overrides.tuesday ?? '0'},0,0,0,0,0,20261001,20261031`),
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

function connectingFeed(options: { secondRouteType?: string; secondDeparture?: string; transferType?: string; minimumTransferTime?: string; inSeat?: boolean; withPathway?: boolean; sameRoute?: boolean } = {}) {
  const onwardRouteId = options.sameRoute ? 'bus' : 'rail';
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode('agency_id,agency_name,agency_url,agency_timezone\na,Test,https://example.test,Europe/Kyiv'),
    'routes.txt': new TextEncoder().encode(`route_id,agency_id,route_short_name,route_long_name,route_type\nbus,a,7,City bus,3${options.sameRoute ? '' : `\nrail,a,IC 743,${options.secondRouteType === '3' ? 'Next city bus' : 'Train'},${options.secondRouteType ?? '2'}`}`),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'start,Start,49.8400,24.0200',
      'hub,Transfer hub,49.8450,24.0250',
      ...(options.withPathway ? ['walkway,Station walkway,49.8451,24.0251'] : []),
      'finish,Finish,49.8500,24.0300',
    ].join('\n')),
    'trips.txt': new TextEncoder().encode(`route_id,service_id,trip_id,trip_headsign\nbus,weekday,b1,Transfer hub\n${onwardRouteId},weekday,r1,Finish`),
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

function timeFeasibleChainWithHashCompetingTrips(options: {
  denseIrrelevantInterchange?: boolean;
  pathwayPlatformTransfers?: boolean;
  reverseFirstPathway?: boolean;
} = {}) {
  const timetable = feed();
  timetable.routes.clear();
  timetable.trips.clear();
  timetable.stopTimes.clear();
  timetable.stopTimesByStop.clear();
  timetable.stops.clear();
  for (const [id, name, lon, lat] of [
    ['origin', 'Origin', 24.0200, 49.8400],
    ['hub-a', 'Hub A', 24.0250, 49.8450],
    ['hub-b', 'Hub B', 24.0270, 49.8470],
    ['destination', 'Destination', 24.0300, 49.8500],
  ] as const) timetable.stops.set(id, { id, name, lon, lat });
  for (const [id, name] of [['access', 'Access'], ['middle', 'Middle'], ['egress', 'Egress']] as const) {
    timetable.routes.set(id, { name, mode: 'BUS', transportType: 'bus' });
  }
  const addTrip = (tripId: string, routeId: string, stopIds: string[], times: number[]) => {
    timetable.trips.set(tripId, { routeId, serviceId: 'weekday', headsign: 'Destination' });
    const entries = stopIds.map((stopId, index) => ({
      stopId, sequence: index + 1, arrivalSeconds: times[index], departureSeconds: times[index], pickupType: 0, dropOffType: 0,
    }));
    timetable.stopTimes.set(tripId, entries);
    entries.forEach((entry, index) => timetable.stopTimesByStop.set(entry.stopId, [
      ...(timetable.stopTimesByStop.get(entry.stopId) ?? []), { tripId, index },
    ]));
  };
  addTrip('access-trip', 'access', ['origin', 'hub-a'], [8 * 3600, 8 * 3600 + 10 * 60]);
  addTrip('egress-trip', 'egress', ['hub-b', 'destination'], [8 * 3600 + 35 * 60, 8 * 3600 + 50 * 60]);

  const targetTripId = 'feasible-middle';
  const retentionHash = (key: string) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
    return hash >>> 0;
  };
  const targetKey = `middle\u0000${targetTripId}\u000020261012`;
  let decoyTripId = 'hash-decoy-0';
  for (let index = 1; retentionHash(`middle\u0000${decoyTripId}\u000020261012`) > retentionHash(targetKey); index++) {
    decoyTripId = `hash-decoy-${index}`;
  }
  // The baseline hash policy prefers this trip even though it cannot connect
  // the access and egress schedules. The desired trip can connect both.
  addTrip(decoyTripId, 'middle', ['hub-a', 'hub-b'], [8 * 3600 + 5 * 60, 8 * 3600 + 38 * 60]);
  addTrip(targetTripId, 'middle', ['hub-a', 'hub-b'], [8 * 3600 + 18 * 60, 8 * 3600 + 25 * 60]);
  if (options.pathwayPlatformTransfers) {
    for (const [stopId, name, lon, lat] of [
      ['hub-a-platform', 'Hub A platform', 24.0251, 49.8451],
      ['hub-b-platform', 'Hub B platform', 24.0271, 49.8471],
    ] as const) timetable.stops.set(stopId, { id: stopId, name, lon, lat });
    const middleStops = timetable.stopTimes.get(targetTripId)!;
    middleStops[0]!.stopId = 'hub-a-platform';
    middleStops[1]!.stopId = 'hub-b-platform';
    timetable.stopTimesByStop = new Map();
    for (const [tripId, entries] of timetable.stopTimes) entries.forEach((entry, index) => {
      const atStop = timetable.stopTimesByStop.get(entry.stopId) ?? [];
      atStop.push({ tripId, index }); timetable.stopTimesByStop.set(entry.stopId, atStop);
    });
    timetable.pathways = [
      { fromStopId: options.reverseFirstPathway ? 'hub-a-platform' : 'hub-a',
        toStopId: options.reverseFirstPathway ? 'hub-a' : 'hub-a-platform',
        fromCoordinates: options.reverseFirstPathway ? [24.0251, 49.8451] : [24.025, 49.845],
        toCoordinates: options.reverseFirstPathway ? [24.025, 49.845] : [24.0251, 49.8451],
        pathwayMode: 1, bidirectional: false, traversalTimeSeconds: 60, lengthMeters: 80 },
      { fromStopId: 'hub-b-platform', toStopId: 'hub-b', fromCoordinates: [24.0271, 49.8471],
        toCoordinates: [24.027, 49.847], pathwayMode: 1, bidirectional: false, traversalTimeSeconds: 60, lengthMeters: 80 },
    ];
  }
  if (options.denseIrrelevantInterchange) {
    for (const [stopId, name, lon, lat] of [
      ['dense-a', 'Dense A', 24.0260, 49.8460], ['dense-b', 'Dense B', 24.0265, 49.8465],
    ] as const) timetable.stops.set(stopId, { id: stopId, name, lon, lat });
    timetable.stopTimes.set(targetTripId, ['hub-a', 'dense-a', 'dense-b', 'hub-b'].map((stopId, index) => ({
      stopId, sequence: index + 1,
      arrivalSeconds: [8 * 3600 + 18 * 60, 8 * 3600 + 20 * 60, 8 * 3600 + 22 * 60, 8 * 3600 + 25 * 60][index]!,
      departureSeconds: [8 * 3600 + 18 * 60, 8 * 3600 + 20 * 60, 8 * 3600 + 22 * 60, 8 * 3600 + 25 * 60][index]!,
      pickupType: 0, dropOffType: 0,
    })));
    // These routes inflate generic interchange connectivity, but their trips
    // run outside the requested journey window and cannot form valid transfers.
    for (const [stopIndex, stopId] of ['dense-a', 'dense-b'].entries()) {
      for (let routeIndex = 0; routeIndex < 4; routeIndex++) {
        const routeId = `irrelevant-${stopIndex}-${routeIndex}`;
        const tripId = `${routeId}-trip`;
        timetable.routes.set(routeId, { name: routeId, mode: 'BUS', transportType: 'bus' });
        timetable.trips.set(tripId, { routeId, serviceId: 'weekday', headsign: 'Outside search window' });
        timetable.stopTimes.set(tripId, [
          { stopId, sequence: 1, arrivalSeconds: 12 * 3600, departureSeconds: 12 * 3600, pickupType: 0, dropOffType: 0 },
          { stopId: 'destination', sequence: 2, arrivalSeconds: 12 * 3600 + 10 * 60, departureSeconds: 12 * 3600 + 10 * 60, pickupType: 0, dropOffType: 0 },
        ]);
      }
    }
    timetable.stopTimesByStop = new Map();
    for (const [tripId, entries] of timetable.stopTimes) entries.forEach((entry, index) => {
      const atStop = timetable.stopTimesByStop.get(entry.stopId) ?? [];
      atStop.push({ tripId, index }); timetable.stopTimesByStop.set(entry.stopId, atStop);
    });
  }
  return {
    timetable, targetTripId, decoyTripId,
    targetHash: retentionHash(targetKey),
    decoyHash: retentionHash(`middle\u0000${decoyTripId}\u000020261012`),
  };
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

/**
 * Deliberately small independent oracle for the one-transfer fixtures below.
 * It independently enumerates every origin-to-interchange and
 * interchange-to-destination stop pair on active trips instead of using the
 * production graph, retention, or search helpers. Fixtures use the known
 * Europe/Kyiv UTC+3 offset on 2026-10-12 and either an exact-stop transfer or
 * an explicit pathway chain.
 */
function exhaustiveOneTransferOracle(feed: GtfsTimetableFeed, options: {
  originStopId: string; destinationStopId: string; earliestDeparture: Date; latestDeparture: Date;
  maximumTransferWalkingMeters: number;
}): Set<string> {
  const serviceDate = '20261012';
  const serviceDateException = (serviceId: string) => feed.exceptions.get(serviceId)?.get(serviceDate);
  const active = (serviceId: string) => {
    const exception = serviceDateException(serviceId);
    if (exception !== undefined) return exception === 1;
    const calendar = feed.calendars.get(serviceId);
    return Boolean(calendar && calendar.start <= serviceDate && calendar.end >= serviceDate && calendar.weekdays[0]);
  };
  const scheduledAt = (seconds: number) => Date.UTC(2026, 9, 12) + seconds * 1000 - 3 * 60 * 60_000;
  const updateFor = (tripId: string) => feed.realtimeTripUpdates?.get(`${tripId}\u0000${serviceDate}`);
  const tripCancelled = (tripId: string) => {
    const relationship = updateFor(tripId)?.relationship;
    return relationship === 'CANCELED' || relationship === 'DELETED';
  };
  const eventAt = (tripId: string, stopIndex: number, kind: 'arrival' | 'departure', timeSeconds: number) => {
    const stopTime = feed.stopTimes.get(tripId)![stopIndex]!;
    const update = updateFor(tripId)?.stops.find((item) => item.stopSequence === stopTime.sequence
      && (!item.stopId || item.stopId === stopTime.stopId));
    if (update?.relationship === 'SKIPPED') return null;
    const event = update?.[kind];
    return event?.time?.getTime() ?? scheduledAt(timeSeconds) + (event?.delaySeconds ?? 0) * 1000;
  };
  const pathwayAdjacency = new Map<string, Array<{ to: string; seconds: number; meters: number }>>();
  for (const path of feed.pathways ?? []) {
    const edge = { to: path.toStopId, seconds: path.traversalTimeSeconds ?? 0, meters: path.lengthMeters ?? 0 };
    pathwayAdjacency.set(path.fromStopId, [...(pathwayAdjacency.get(path.fromStopId) ?? []), edge]);
    if (path.bidirectional) pathwayAdjacency.set(path.toStopId, [
      ...(pathwayAdjacency.get(path.toStopId) ?? []),
      { to: path.fromStopId, seconds: path.traversalTimeSeconds ?? 0, meters: path.lengthMeters ?? 0 },
    ]);
  }
  const transferMeasure = (fromStopId: string, toStopId: string) => {
    if (fromStopId === toStopId) return { seconds: 0, meters: 0 };
    // Tiny fixtures have at most a handful of pathway nodes. Exhaustively
    // enumerate simple paths so this oracle does not share production Dijkstra.
    let best: { seconds: number; meters: number } | null = null;
    const visit = (stopId: string, seen: Set<string>, seconds: number, meters: number) => {
      if (stopId === toStopId) {
        if (!best || seconds < best.seconds || (seconds === best.seconds && meters < best.meters)) best = { seconds, meters };
        return;
      }
      for (const edge of pathwayAdjacency.get(stopId) ?? []) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        visit(edge.to, seen, seconds + edge.seconds, meters + edge.meters);
        seen.delete(edge.to);
      }
    };
    visit(fromStopId, new Set([fromStopId]), 0, 0);
    if (best) return best;
    // These fixtures intentionally do not model proximity-only transfers:
    // distinct platforms need a declared path in this independent oracle.
    return null;
  };
  const transferRule = (fromTripId: string, fromStopId: string, toTripId: string, toStopId: string) => {
    const fromTrip = feed.trips.get(fromTripId)!;
    const toTrip = feed.trips.get(toTripId)!;
    const sourceNodes = (tripId: string, stopId: string) => {
      const source = feed.stopTimes.get(tripId)?.find((entry) => entry.stopId === stopId);
      return new Set([stopId, source?.sourceStopId ?? '', source?.sourceParentStationId ?? '',
        feed.stops.get(stopId)?.parentStation ?? '']);
    };
    const fromNodes = sourceNodes(fromTripId, fromStopId);
    const toNodes = sourceNodes(toTripId, toStopId);
    return (feed.transfers ?? []).filter((rule) => fromNodes.has(rule.fromStopId) && toNodes.has(rule.toStopId)
      && (!rule.fromTripId || rule.fromTripId === fromTripId) && (!rule.toTripId || rule.toTripId === toTripId)
      && (!rule.fromRouteId || rule.fromRouteId === fromTrip.routeId) && (!rule.toRouteId || rule.toRouteId === toTrip.routeId))
      .sort((a, b) => Number(Boolean(b.fromTripId || b.toTripId)) - Number(Boolean(a.fromTripId || a.toTripId)))[0];
  };
  const segmentSignature = (tripId: string, from: string, to: string, departureAt: number, arrivalAt: number) =>
    `${tripId}:${from}@${departureAt}>${to}@${arrivalAt}`;
  const allSegments: Array<{ tripId: string; routeId: string; fromStopId: string; toStopId: string;
    departureAt: number; arrivalAt: number }> = [];
  for (const [tripId, trip] of feed.trips) {
    if (!active(trip.serviceId) || tripCancelled(tripId)) continue;
    const stops = feed.stopTimes.get(tripId) ?? [];
    for (let fromIndex = 0; fromIndex < stops.length; fromIndex++) {
      const from = stops[fromIndex]!;
      if (from.pickupType !== 0 || from.stopId !== options.originStopId) continue;
      const departureAt = eventAt(tripId, fromIndex, 'departure', from.departureSeconds);
      if (departureAt === null || departureAt < options.earliestDeparture.getTime()
        || departureAt > options.latestDeparture.getTime()) continue;
      for (let toIndex = fromIndex + 1; toIndex < stops.length; toIndex++) {
        const to = stops[toIndex]!;
        if (to.dropOffType !== 0) continue;
        const arrivalAt = eventAt(tripId, toIndex, 'arrival', to.arrivalSeconds);
        if (arrivalAt === null || arrivalAt < departureAt) continue;
        allSegments.push({ tripId, routeId: trip.routeId, fromStopId: from.stopId,
          toStopId: to.stopId, departureAt, arrivalAt });
      }
    }
  }
  const arrivingSegments = allSegments.filter((segment) => segment.fromStopId === options.originStopId);
  const departingSegments: typeof allSegments = [];
  for (const [tripId, trip] of feed.trips) {
    if (!active(trip.serviceId) || tripCancelled(tripId)) continue;
    const stops = feed.stopTimes.get(tripId) ?? [];
    for (let fromIndex = 0; fromIndex < stops.length; fromIndex++) {
      const from = stops[fromIndex]!;
      if (from.pickupType !== 0) continue;
      const departureAt = eventAt(tripId, fromIndex, 'departure', from.departureSeconds);
      if (departureAt === null) continue;
      for (let toIndex = fromIndex + 1; toIndex < stops.length; toIndex++) {
        const to = stops[toIndex]!;
        if (to.dropOffType !== 0 || to.stopId !== options.destinationStopId) continue;
        const arrivalAt = eventAt(tripId, toIndex, 'arrival', to.arrivalSeconds);
        if (arrivalAt === null || arrivalAt < departureAt) continue;
        departingSegments.push({ tripId, routeId: trip.routeId, fromStopId: from.stopId,
          toStopId: to.stopId, departureAt, arrivalAt });
      }
    }
  }
  const expected = new Set<string>();
  for (const first of arrivingSegments) for (const next of departingSegments) {
    if (first.tripId === next.tripId) continue;
    const measure = transferMeasure(first.toStopId, next.fromStopId);
    if (!measure || measure.meters > options.maximumTransferWalkingMeters) continue;
    const rule = transferRule(first.tripId, first.toStopId, next.tripId, next.fromStopId);
    if (rule?.transferType === 3) continue;
    if (rule?.transferType === 4 && first.routeId !== next.routeId) continue;
    const firstMode = feed.routes.get(first.routeId)?.transportType;
    const nextMode = feed.routes.get(next.routeId)?.transportType;
    const defaultBuffer = firstMode === 'train' || nextMode === 'train' || firstMode === 'intercity_bus' || nextMode === 'intercity_bus'
      ? 600 : 180;
    const required = rule?.transferType === 4 ? 0 : rule?.transferType === 2
      ? Math.max(defaultBuffer + measure.seconds, rule.minTransferTimeSeconds ?? 0)
      : defaultBuffer + measure.seconds;
    if (next.departureAt - first.arrivalAt < required * 1000) continue;
    expected.add(`${segmentSignature(first.tripId, first.fromStopId, first.toStopId, first.departureAt, first.arrivalAt)}|${segmentSignature(next.tripId, next.fromStopId, next.toStopId, next.departureAt, next.arrivalAt)}`);
  }
  return expected;
}


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

test('eligible trip-instance events preserve scheduled stop order, UTC conversion, and pickup/drop-off semantics', () => {
  const scheduled = feed({ withIntermediate: true });
  const scheduledEvents = eligibleTripInstanceStopEvents(scheduled, 't1', '20261012', [0, 1, 2]);
  assert.ok(scheduledEvents);
  assert.deepEqual(scheduledEvents.events.map(({ stopIndex }) => stopIndex), [0, 1, 2],
    'the event vector stays aligned with the caller-provided stop cursor order');
  assert.deepEqual(scheduledEvents.events.map((event) => ({
    stopIndex: event.stopIndex,
    stopId: event.stopTime.stopId,
    scheduledArrivalAt: event.scheduledArrivalAt?.toISOString(),
    scheduledDepartureAt: event.scheduledDepartureAt?.toISOString(),
    arrivalAt: event.arrivalAt?.toISOString(),
    departureAt: event.departureAt?.toISOString(),
    canBoard: event.canBoard,
    canAlight: event.canAlight,
  })), [
    { stopIndex: 0, stopId: 'origin', scheduledArrivalAt: '2026-10-12T05:00:00.000Z', scheduledDepartureAt: '2026-10-12T05:00:00.000Z', arrivalAt: '2026-10-12T05:00:00.000Z', departureAt: '2026-10-12T05:00:00.000Z', canBoard: true, canAlight: true },
    { stopIndex: 1, stopId: 'middle', scheduledArrivalAt: '2026-10-12T05:20:00.000Z', scheduledDepartureAt: '2026-10-12T05:20:00.000Z', arrivalAt: '2026-10-12T05:20:00.000Z', departureAt: '2026-10-12T05:20:00.000Z', canBoard: true, canAlight: true },
    { stopIndex: 2, stopId: 'destination', scheduledArrivalAt: '2026-10-12T05:40:00.000Z', scheduledDepartureAt: '2026-10-12T05:40:00.000Z', arrivalAt: '2026-10-12T05:40:00.000Z', departureAt: '2026-10-12T05:40:00.000Z', canBoard: true, canAlight: true },
  ], 'event projection matches the previous scheduledTimes + raw pickup/drop-off preparation');

  const restricted = feed({ withIntermediate: true, pickup: '1', dropoff: '3' });
  const restrictedEvents = eligibleTripInstanceStopEvents(restricted, 't1', '20261012', [0, 1, 2]);
  assert.deepEqual(restrictedEvents?.events.map(({ canBoard, canAlight }) => ({ canBoard, canAlight })), [
    { canBoard: false, canAlight: true },
    { canBoard: true, canAlight: true },
    { canBoard: true, canAlight: false },
  ], 'pickup and drop-off restrictions are exposed as event-level feasibility flags');
  assert.throws(() => eligibleTripInstanceStopEvents(scheduled, 't1', '20261012', [0, 99]), RangeError,
    'an invalid stop cursor fails explicitly instead of compacting the event vector out of alignment');
});

test('eligible trip-instance events overlay realtime times and skipped stops without changing service-date gating', () => {
  const timetable = feed({ withIntermediate: true });
  timetable.realtimeTripUpdates = new Map([['t1\u000020261012', {
    tripId: 't1', startDate: '20261012', relationship: 'SCHEDULED',
    stops: [
      { stopSequence: 1, relationship: 'SCHEDULED', arrival: { delaySeconds: 60 }, departure: { delaySeconds: 120 } },
      { stopSequence: 2, relationship: 'SKIPPED' },
      { stopSequence: 3, relationship: 'SCHEDULED', arrival: { delaySeconds: 300 }, departure: { delaySeconds: 360 } },
    ],
    updatedAt: new Date('2026-10-12T04:59:00Z'), feedTimestamp: new Date('2026-10-12T04:59:00Z'),
  }]]);
  const events = eligibleTripInstanceStopEvents(timetable, 't1', '20261012', [0, 1, 2]);
  assert.ok(events);
  assert.equal(events.events[0]?.scheduledDepartureAt?.toISOString(), '2026-10-12T05:00:00.000Z');
  assert.equal(events.events[0]?.departureAt?.toISOString(), '2026-10-12T05:02:00.000Z');
  assert.equal(events.events[0]?.updated, true);
  assert.equal(events.events[1]?.skipped, true);
  assert.equal(events.events[1]?.canBoard, false);
  assert.equal(events.events[1]?.canAlight, false);
  assert.equal(events.events[2]?.scheduledArrivalAt?.toISOString(), '2026-10-12T05:40:00.000Z');
  assert.equal(events.events[2]?.arrivalAt?.toISOString(), '2026-10-12T05:45:00.000Z');
  assert.equal(events.events[2]?.departureAt?.toISOString(), '2026-10-12T05:46:00.000Z');
  assert.equal(events.datedStops?.length, 3, 'full trip-date overlay remains available for segment update attribution');
  assert.equal(events.realtimeUpdate?.updatedAt.toISOString(), '2026-10-12T04:59:00.000Z');

  const inactive = eligibleTripInstanceStopEvents(timetable, 't1', '20261011', [0, 1, 2]);
  assert.equal(inactive, null, 'the same calendar service is excluded on a non-running service date');
  const canceled = structuredClone(timetable);
  canceled.realtimeTripUpdates!.set('t1\u000020261012', {
    tripId: 't1', startDate: '20261012', relationship: 'CANCELED', stops: [],
    updatedAt: new Date('2026-10-12T04:59:00Z'), feedTimestamp: new Date('2026-10-12T04:59:00Z'),
  });
  assert.equal(eligibleTripInstanceStopEvents(canceled, 't1', '20261012', [0, 1, 2]), null,
    'canceled trip instances produce no eligible stop events');
});

test('keeps the same GTFS trip as distinct scheduled instances on different service dates', () => {
  const timetable = feed({ tuesday: '1' });
  const query = {
    ...request('2026-10-12T04:55:00Z', '2026-10-13T05:30:00Z'),
    maximumJourneySeconds: 48 * 60 * 60,
    maximumWaitSeconds: 48 * 60 * 60,
    maximumTransfers: 0,
  };
  const result = findGtfsItinerariesWithStats(timetable, query);

  const serviceDates = result.itineraries.map((journey) => journey.segments[0].serviceDate).sort();
  assert.deepEqual(serviceDates, ['20261012', '20261013']);
  assert.equal(new Set(result.itineraries.map((journey) => journey.id)).size, 2,
    'the same trip_id on separate dates must not collapse to one itinerary');
  const indexed = queryDirectedEventIndexPrototype(timetable, {
    originStopId: 'origin', destinationStopId: 'destination',
    serviceDates: ['20261012', '20261013'], earliestDeparture: query.earliestDeparture,
    latestDeparture: query.latestDeparture, maximumTransferWalkingMeters: 0, maximumTransfers: 0,
  });
  assert.equal(indexed.candidatePaths.size, 2,
    'event labels key the same trip and stop calls by distinct active service dates');
});

test('debug search diagnostics separate graph demand from bounded search saturation', () => {
  const previousDebugValue = process.env.MARSHGO_GTFS_SEARCH_DEBUG;
  const originalInfo = console.info;
  const messages: string[] = [];
  process.env.MARSHGO_GTFS_SEARCH_DEBUG = '1';
  console.info = (...args: unknown[]) => { messages.push(String(args[0])); };
  try {
    findGtfsItinerariesWithStats(feed(), {
      ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
    });
  } finally {
    console.info = originalInfo;
    if (previousDebugValue === undefined) delete process.env.MARSHGO_GTFS_SEARCH_DEBUG;
    else process.env.MARSHGO_GTFS_SEARCH_DEBUG = previousDebugValue;
  }

  const stages = messages.map((message) => JSON.parse(message) as { stage: string; [key: string]: unknown });
  const graph = stages.find((stage) => stage.stage === 'segments-built');
  const ranked = stages.find((stage) => stage.stage === 'itineraries-ranked');
  assert.ok(graph, 'segment graph should emit bounded-demand diagnostics');
  assert.ok(ranked, 'ranked search should emit step/pool diagnostics');
  assert.equal(typeof graph.estimatedGraphDemand, 'number');
  assert.equal(typeof graph.graphRoutesBudgetLimited, 'number');
  assert.equal(typeof graph.globalGraphBudgetBinding, 'number');
  assert.equal(typeof graph.graphSegmentBudgetUnused, 'number');
  assert.equal(typeof graph.graphRoutesUnderfilled, 'number');
  assert.equal(typeof graph.graphRouteBudgetMaxUnused, 'number');
  assert.equal(typeof graph.overflowReservoirRetained, 'number');
  assert.equal(typeof graph.overflowReservoirsAtCap, 'number');
  assert.equal(typeof graph.routeBudgetUnderfillSample, 'string');
  assert.ok(Array.isArray(JSON.parse(String(graph.routeBudgetUnderfillSample))));
  assert.equal(typeof ranked.searchStepLimit, 'number');
  assert.equal(typeof ranked.candidatePoolReachedAtStepByLegCount, 'string');
});

test('GTFS maximum transfer wait never exceeds the total journey horizon', () => {
  assert.equal(maximumGtfsWaitWithinJourney(30 * 60), 30 * 60,
    'a short user journey limit must produce valid shorter transfer bounds');
  assert.equal(maximumGtfsWaitWithinJourney(2 * 60 * 60), 2 * 60 * 60,
    'the transfer wait cannot exceed a two-hour total journey limit');
  assert.equal(maximumGtfsWaitWithinJourney(6 * 60 * 60), 4 * 60 * 60,
    'long journeys keep the four-hour transfer-wait ceiling');
  assert.equal(maximumGtfsWaitWithinJourney(60, 0), 0,
    'an explicitly zero wait remains valid');
  assert.throws(() => maximumGtfsWaitWithinJourney(0), /bounds must be valid integer seconds/);
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

test('keeps a direct GTFS segment whose destination lies beyond twenty interchange stops', () => {
  const timetable = feed();
  const routeStops = Array.from({ length: 26 }, (_, index) => {
    const stopId = `corridor-${index}`;
    const stop = { id: stopId, name: `Corridor stop ${index}`, lon: 24.02 + index * 0.0052, lat: 49.84 };
    timetable.stops.set(stopId, stop);
    return { stopId, sequence: index + 1, seconds: 8 * 3600 + index * 2 * 60 };
  });

  // Every intermediate stop is an interchange, but each alternate route
  // continues outside the search corridor. This recreates a dense corridor
  // without adding another feasible through-service.
  for (let index = 1; index < routeStops.length - 1; index += 1) {
    const routeId = `branch-route-${index}`;
    const tripId = `branch-trip-${index}`;
    const terminalId = `branch-terminal-${index}`;
    timetable.routes.set(routeId, { name: `Branch ${index}`, mode: 'BUS', transportType: 'bus' });
    timetable.trips.set(tripId, { routeId, serviceId: 'weekday', headsign: 'Remote terminal' });
    timetable.stops.set(terminalId, { id: terminalId, name: terminalId, lon: 24.02 + index * 0.0052, lat: 50.1 });
    const branchTimes = [
      { stopId: routeStops[index].stopId, sequence: 1, arrivalSeconds: routeStops[index].seconds, departureSeconds: routeStops[index].seconds, pickupType: 0, dropOffType: 0 },
      { stopId: terminalId, sequence: 2, arrivalSeconds: routeStops[index].seconds + 20 * 60, departureSeconds: routeStops[index].seconds + 20 * 60, pickupType: 0, dropOffType: 0 },
    ];
    timetable.stopTimes.set(tripId, branchTimes);
    for (const [timeIndex, stopTime] of branchTimes.entries()) {
      timetable.stopTimesByStop.set(stopTime.stopId, [
        ...(timetable.stopTimesByStop.get(stopTime.stopId) ?? []), { tripId, index: timeIndex },
      ]);
    }
  }

  const mainTripId = 't1';
  timetable.stopTimes.set(mainTripId, routeStops.map((stop) => ({
    stopId: stop.stopId, sequence: stop.sequence, arrivalSeconds: stop.seconds, departureSeconds: stop.seconds,
    pickupType: 0, dropOffType: 0,
  })));
  for (const [index, stop] of routeStops.entries()) {
    timetable.stopTimesByStop.set(stop.stopId, [
      ...(timetable.stopTimesByStop.get(stop.stopId) ?? []), { tripId: mainTripId, index },
    ]);
  }

  const result = findGtfsItinerariesWithStats(timetable, {
    providerId: 'test', providerName: 'Test Transit', providerCity: 'Львів',
    origin: [24.02, 49.84],
    destination: [24.02 + 25 * 0.0052, 49.84],
    earliestDeparture: new Date('2026-10-12T04:55:00Z'),
    latestDeparture: new Date('2026-10-12T05:30:00Z'),
    now: new Date('2026-10-12T04:00:00Z'),
    limit: 20, maximumTransfers: 1, maximumStopDistanceMeters: 100,
  });

  assert.ok(result.itineraries.some((itinerary) => itinerary.segments.length === 1
    && itinerary.segments[0]?.tripId === mainTripId
    && itinerary.segments[0]?.originStop.id === routeStops[0].stopId
    && itinerary.segments[0]?.destinationStop.id === routeStops[25].stopId),
  'the full ride must remain available when many intermediate stops are transfer-capable');
  assert.equal(result.searchTruncated, true,
    'the long direct segment is preserved, while omitted beyond-window transfer alternatives remain disclosed');
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
  assert.ok([...countsByTripChain.values()].every((count) => count <= 4),
    'a bounded number of stop-pair choices should share the same scheduled vehicle chain');
  assert.equal(result.resultLimitReached, true,
    'suppressing additional stop-pair variants must be visible as candidate sampling');
  assert.equal(result.searchTruncated, true,
    'omitting sampled stop-pair candidates must report that the search was incomplete');
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

test('retains additional same-direction boarding stops within the bounded pattern cap', () => {
  const timetable = feed();
  const route = timetable.routes.get('r');
  assert.ok(route);
  timetable.routes.set('r2', { ...route, name: '8' });
  timetable.trips.set('t1', { ...timetable.trips.get('t1')!, directionId: '0' });
  const terminal = { id: 'pattern-terminal', name: 'Pattern terminal', lon: 24.07, lat: 49.87 };
  timetable.stops.set(terminal.id, terminal);

  // The first 20 access stops are already selected. Two of them expose the
  // same second route pattern, while a useful stop on that pattern ranks 21st.
  for (let index = 1; index <= 19; index++) {
    const stopId = `pattern-near-${index}`;
    const tripId = `pattern-near-trip-${index}`;
    timetable.stops.set(stopId, { id: stopId, name: `Pattern near ${index}`, lon: 24.0201 + index * 0.0001, lat: 49.8401 });
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

  const addPatternTrip = (tripId: string, fromStopId: string, toStopId: string, departure: number, arrival: number) => {
    timetable.trips.set(tripId, { routeId: 'r2', serviceId: 'weekday', headsign: 'South terminal', directionId: '1' });
    const stops = [
      { stopId: fromStopId, sequence: 1, arrivalSeconds: departure, departureSeconds: departure, pickupType: 0, dropOffType: 0 },
      { stopId: toStopId, sequence: 2, arrivalSeconds: arrival, departureSeconds: arrival, pickupType: 0, dropOffType: 0 },
    ];
    timetable.stopTimes.set(tripId, stops);
    stops.forEach((stop, index) => timetable.stopTimesByStop.set(stop.stopId, [
      ...(timetable.stopTimesByStop.get(stop.stopId) ?? []), { tripId, index },
    ]));
  };
  addPatternTrip('pattern-cover-1', 'origin', terminal.id, 8 * 3600, 9 * 3600);
  addPatternTrip('pattern-cover-2', 'pattern-near-1', terminal.id, 8 * 3600, 9 * 3600);

  const usefulStop = 'pattern-useful-boarding';
  timetable.stops.set(usefulStop, { id: usefulStop, name: 'Useful boarding', lon: 24.025, lat: 49.8401 });
  addPatternTrip('pattern-useful-trip', usefulStop, 'destination', 8 * 3600 + 5 * 60, 8 * 3600 + 25 * 60);

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  });
  assert.ok(result.itineraries.some((journey) => journey.segments[0]?.tripId === 'pattern-useful-trip'),
    'bounded selection must keep a useful third stop on a covered route pattern');
  assert.equal(result.searchTruncated, false, 'all relevant stops fit below the per-side bound for this fixture');
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
  assert.equal(result.truncation.candidateGraph, true, 'structured truncation reasons identify graph loss');
  assert.equal(result.truncation.stopSelection, false, 'graph loss is distinguishable from stop-selection loss');
  assert.equal(result.resultLimitReached, true, 'candidate-pool sampling is separately reported');

  const reordered = structuredClone(timetable);
  reordered.trips = new Map([...reordered.trips].reverse());
  const reorderedResult = findGtfsItinerariesWithStats(reordered, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  });
  assert.deepEqual(reorderedResult.itineraries.map(({ id }) => id), result.itineraries.map(({ id }) => id),
    'bounded retention and leftover-budget fill must ignore GTFS Map insertion order');
  assert.equal(reorderedResult.searchTruncated, result.searchTruncated);
});

test('query-time retention keeps a feasible multi-leg chain under an injected graph budget', () => {
  const { timetable, targetTripId, decoyTripId, targetHash, decoyHash } = timeFeasibleChainWithHashCompetingTrips();
  timetable.fareProducts = new Map([
    ['access-fare', { id: 'access-fare', priceMinor: 300, currency: 'UAH', transfers: 0, transferDurationSeconds: null }],
    ['middle-fare', { id: 'middle-fare', priceMinor: 200, currency: 'UAH', transfers: 0, transferDurationSeconds: null }],
    ['egress-fare', { id: 'egress-fare', priceMinor: 400, currency: 'UAH', transfers: 0, transferDurationSeconds: null }],
  ]);
  timetable.fareRules = new Map([
    ['access-fare', [{ fareId: 'access-fare', routeId: 'access' }]],
    ['middle-fare', [{ fareId: 'middle-fare', routeId: 'middle' }]],
    ['egress-fare', [{ fareId: 'egress-fare', routeId: 'egress' }]],
  ]);
  const searchInput = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0200, 49.8400] as [number, number], destination: [24.0300, 49.8500] as [number, number],
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100, maximumTransfers: 2,
  };
  const graphLimits = { totalSegments: 3, segmentsPerRoute: 1 };
  const result = findGtfsItinerariesWithStats(timetable, searchInput, graphLimits);

  assert.equal(result.candidateGraphTruncated, true);
  assert.equal(result.searchTruncated, true);
  assert.ok(decoyHash < targetHash, 'the baseline hash ordering gives the infeasible decoy better retention priority');
  const feasibleChain = result.itineraries.find((itinerary) => itinerary.segments.map((segment) => segment.tripId).join(',')
    === `access-trip,${targetTripId},egress-trip`);
  assert.ok(feasibleChain,
  'query-time retention preserves the exact middle trip that fits both scheduled transfers');
  assert.equal(feasibleChain.fare?.priceMinor, 900, 'query-time retention does not lose known fare totals');
  assert.ok(!result.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === decoyTripId)),
    'the infeasible lower-hash group is not allowed to crowd out the scheduled chain');

  const reordered = structuredClone(timetable);
  reordered.trips = new Map([...reordered.trips].reverse());
  const reorderedResult = findGtfsItinerariesWithStats(reordered, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0200, 49.8400], destination: [24.0300, 49.8500],
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100, maximumTransfers: 2,
  }, { totalSegments: 3, segmentsPerRoute: 1 });
  assert.deepEqual(reorderedResult.itineraries.map(({ id }) => id), result.itineraries.map(({ id }) => id),
    'schedule-aware retention remains independent of GTFS Map insertion order');

  const forbidden = structuredClone(timetable);
  forbidden.transfers = [{ fromStopId: 'hub-a', toStopId: 'hub-a', transferType: 3 }];
  const forbiddenResult = findGtfsItinerariesWithStats(forbidden, searchInput, graphLimits);
  assert.ok(!forbiddenResult.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === targetTripId)),
    'retention priority never overrides an explicit forbidden GTFS transfer');

  const cancelled = structuredClone(timetable);
  cancelled.realtimeTripUpdates = new Map([['feasible-middle\u000020261012', {
    tripId: targetTripId, startDate: '20261012', relationship: 'CANCELED', stops: [],
    updatedAt: new Date('2026-10-12T05:00:00Z'), feedTimestamp: new Date('2026-10-12T05:00:00Z'),
  }]]);
  const cancelledResult = findGtfsItinerariesWithStats(cancelled, searchInput, graphLimits);
  assert.ok(!cancelledResult.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === targetTripId)),
    'canceled trips are excluded from both temporal retention signals and returned itineraries');

  const skipped = structuredClone(timetable);
  skipped.realtimeTripUpdates = new Map([['feasible-middle\u000020261012', {
    tripId: targetTripId, startDate: '20261012', relationship: 'SCHEDULED',
    stops: [{ stopSequence: 1, relationship: 'SKIPPED' }],
    updatedAt: new Date('2026-10-12T05:00:00Z'), feedTimestamp: new Date('2026-10-12T05:00:00Z'),
  }]]);
  const skippedResult = findGtfsItinerariesWithStats(skipped, searchInput, graphLimits);
  assert.ok(!skippedResult.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === targetTripId)),
    'skipped boarding stops are excluded from temporal retention and returned itineraries');
});

test('query-time retention keeps a scheduled connector ahead of dense irrelevant interchanges', () => {
  const { timetable, targetTripId } = timeFeasibleChainWithHashCompetingTrips({ denseIrrelevantInterchange: true });
  const searchInput = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0200, 49.8400] as [number, number], destination: [24.0300, 49.8500] as [number, number],
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100, maximumTransfers: 2,
  };
  const previousDebugValue = process.env.MARSHGO_GTFS_SEARCH_DEBUG;
  const originalInfo = console.info;
  const messages: string[] = [];
  process.env.MARSHGO_GTFS_SEARCH_DEBUG = '1';
  console.info = (...args: unknown[]) => { messages.push(String(args[0])); };
  let result: ReturnType<typeof findGtfsItinerariesWithStats>;
  try {
    result = findGtfsItinerariesWithStats(timetable, searchInput, { totalSegments: 3, segmentsPerRoute: 1 });
  } finally {
    console.info = originalInfo;
    if (previousDebugValue === undefined) delete process.env.MARSHGO_GTFS_SEARCH_DEBUG;
    else process.env.MARSHGO_GTFS_SEARCH_DEBUG = previousDebugValue;
  }
  const graph = messages.map((message) => JSON.parse(message) as { stage: string; [key: string]: unknown })
    .find((stage) => stage.stage === 'segments-built');
  assert.ok(graph, 'the fixture exposes graph-retention diagnostics');
  assert.ok(Number(graph.overflowReservoirRetained) >= 3,
    'bounded overflow keeps a temporally feasible connector in addition to endpoint fallbacks');
  assert.ok(Number(graph.overflowConnectorReservoirRetained) >= 1,
    'connector fallbacks use a separate bounded reservoir');
  assert.ok(Number(graph.segments) <= 3, 'connector recovery preserves the injected total graph cap');
  assert.ok(result.candidateGraphTruncated, 'the fixture exercises a bounded dense graph');
  assert.ok(result.itineraries.some((itinerary) => itinerary.segments.map((segment) => segment.tripId).join(',')
    === `access-trip,${targetTripId},egress-trip`),
  'the exact scheduled connector survives even when irrelevant stops have more connected routes');
});

test('query-time retention preserves a feasible connector across nearby stop IDs', () => {
  const { timetable, targetTripId } = timeFeasibleChainWithHashCompetingTrips();
  timetable.stops.set('hub-a-near', { id: 'hub-a-near', name: 'Hub A nearby platform', lon: 24.0255, lat: 49.8450 });
  timetable.stops.set('hub-b-near', { id: 'hub-b-near', name: 'Hub B nearby platform', lon: 24.0275, lat: 49.8470 });
  const targetStops = timetable.stopTimes.get(targetTripId)!;
  targetStops[0]!.stopId = 'hub-a-near';
  timetable.stopTimes.get('egress-trip')![0]!.stopId = 'hub-b-near';
  timetable.stopTimesByStop = new Map();
  for (const [tripId, entries] of timetable.stopTimes) entries.forEach((entry, index) => {
    const atStop = timetable.stopTimesByStop.get(entry.stopId) ?? [];
    atStop.push({ tripId, index });
    timetable.stopTimesByStop.set(entry.stopId, atStop);
  });
  const searchInput = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0200, 49.8400] as [number, number], destination: [24.0300, 49.8500] as [number, number],
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100, maximumTransferWalkingMeters: 400,
    maximumTransfers: 2,
  };
  const result = findGtfsItinerariesWithStats(timetable, searchInput, { totalSegments: 3, segmentsPerRoute: 1 });
  assert.ok(result.itineraries.some((itinerary) => itinerary.segments.map((segment) => segment.tripId).join(',')
    === `access-trip,${targetTripId},egress-trip`),
  'the bounded graph keeps a feasible transfer across nearby stop IDs at the origin and destination frontiers');
});

test('query-time retention recognizes scheduled transfers between pathway-linked platforms', () => {
  const { timetable: sourceFeed, targetTripId } = timeFeasibleChainWithHashCompetingTrips({ pathwayPlatformTransfers: true });
  const providerId = 'pathway-provider';
  const timetable = mergeGtfsTimetables([{ providerId, providerName: 'Pathway provider', providerCity: 'Львів', feed: sourceFeed }])!;
  const searchInput = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0200, 49.8400] as [number, number], destination: [24.0300, 49.8500] as [number, number],
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100, maximumTransfers: 2,
  };
  const result = findGtfsItinerariesWithStats(timetable, searchInput, { totalSegments: 3, segmentsPerRoute: 1 });
  assert.ok(result.candidateGraphTruncated, 'the fixture exercises a bounded graph');
  assert.ok(result.itineraries.some((itinerary) => itinerary.segments.map((segment) => segment.tripId).join(',')
    === `${providerId}:access-trip,${providerId}:${targetTripId},${providerId}:egress-trip`),
  'the connecting trip survives after the provider merge prefixes both source stop and pathway IDs');
});

test('query-time retention respects directed GTFS pathways between platforms', () => {
  const { timetable: sourceFeed, targetTripId } = timeFeasibleChainWithHashCompetingTrips({
    pathwayPlatformTransfers: true, reverseFirstPathway: true,
  });
  const providerId = 'pathway-provider';
  const timetable = mergeGtfsTimetables([{ providerId, providerName: 'Pathway provider', providerCity: 'Львів', feed: sourceFeed }])!;
  const searchInput = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0200, 49.8400] as [number, number], destination: [24.0300, 49.8500] as [number, number],
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100, maximumTransfers: 2,
  };
  const result = findGtfsItinerariesWithStats(timetable, searchInput, { totalSegments: 3, segmentsPerRoute: 1 });
  assert.ok(result.candidateGraphTruncated, 'the fixture exercises a bounded graph');
  assert.ok(!result.itineraries.some((itinerary) => itinerary.segments.map((segment) => segment.tripId).join(',')
    === `${providerId}:access-trip,${providerId}:${targetTripId},${providerId}:egress-trip`),
  'a reverse-only pathway cannot connect the access arrival to the next platform');
});

test('query-time retention does not let a temporally matched but forbidden trip crowd out a feasible chain', () => {
  const { timetable, targetTripId, decoyTripId } = timeFeasibleChainWithHashCompetingTrips();
  const decoyTimes = timetable.stopTimes.get(decoyTripId)!;
  decoyTimes[0]!.arrivalSeconds = 8 * 3600 + 18 * 60;
  decoyTimes[0]!.departureSeconds = 8 * 3600 + 18 * 60;
  decoyTimes[1]!.arrivalSeconds = 8 * 3600 + 25 * 60;
  decoyTimes[1]!.departureSeconds = 8 * 3600 + 25 * 60;
  timetable.transfers = [{
    fromStopId: 'hub-a', toStopId: 'hub-a', transferType: 3,
    fromTripId: 'access-trip', toTripId: decoyTripId,
  }];

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0200, 49.8400], destination: [24.0300, 49.8500],
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100, maximumTransfers: 2,
  }, { totalSegments: 3, segmentsPerRoute: 1 });

  assert.ok(result.itineraries.some((itinerary) => itinerary.segments.map((segment) => segment.tripId).join(',')
    === `access-trip,${targetTripId},egress-trip`),
  'the hash-preferred middle trip is explicitly forbidden, so retention must preserve the feasible alternative');
  assert.ok(!result.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === decoyTripId)),
    'the final itinerary must never use the explicitly forbidden connection');
});

test('query-time retention applies trip-specific minimum transfer time before prioritizing a connection', () => {
  const { timetable, targetTripId, decoyTripId } = timeFeasibleChainWithHashCompetingTrips();
  const decoyTimes = timetable.stopTimes.get(decoyTripId)!;
  decoyTimes[0]!.arrivalSeconds = 8 * 3600 + 18 * 60;
  decoyTimes[0]!.departureSeconds = 8 * 3600 + 18 * 60;
  decoyTimes[1]!.arrivalSeconds = 8 * 3600 + 25 * 60;
  decoyTimes[1]!.departureSeconds = 8 * 3600 + 25 * 60;
  timetable.transfers = [{
    fromStopId: 'hub-a', toStopId: 'hub-a', transferType: 2,
    minTransferTimeSeconds: 900, fromTripId: 'access-trip', toTripId: decoyTripId,
  }];

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0200, 49.8400], destination: [24.0300, 49.8500],
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100, maximumTransfers: 2,
  }, { totalSegments: 3, segmentsPerRoute: 1 });

  assert.ok(result.itineraries.some((itinerary) => itinerary.segments.map((segment) => segment.tripId).join(',')
    === `access-trip,${targetTripId},egress-trip`),
  'the trip-specific 15-minute minimum makes the decoy infeasible, so retention must preserve the feasible chain');
  assert.ok(!result.itineraries.some((itinerary) => itinerary.segments.some((segment) => segment.tripId === decoyTripId)),
    'the final itinerary must never use a connection that misses its explicit minimum transfer time');
});

test('query-time retention does not treat a shared parent station as proof of a feasible platform transfer', () => {
  const { timetable, targetTripId, decoyTripId } = timeFeasibleChainWithHashCompetingTrips();
  timetable.stops.set('hub-a-platform-decoy', {
    id: 'hub-a-platform-decoy', name: 'Hub A alternate platform', lon: 24.025, lat: 49.845,
    parentStation: 'shared-hub-a',
  });
  timetable.stops.set('hub-a', { ...timetable.stops.get('hub-a')!, parentStation: 'shared-hub-a' });
  const accessTimes = timetable.stopTimes.get('access-trip')!;
  const decoyTimes = timetable.stopTimes.get(decoyTripId)!;
  accessTimes[1]!.sourceParentStationId = 'shared-hub-a';
  decoyTimes[0]!.stopId = 'hub-a-platform-decoy';
  decoyTimes[0]!.sourceStopId = 'hub-a-platform-decoy';
  decoyTimes[0]!.sourceParentStationId = 'shared-hub-a';
  timetable.stopTimesByStop = new Map();
  for (const [tripId, entries] of timetable.stopTimes) entries.forEach((entry, index) => {
    const atStop = timetable.stopTimesByStop.get(entry.stopId) ?? [];
    atStop.push({ tripId, index });
    timetable.stopTimesByStop.set(entry.stopId, atStop);
  });

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0200, 49.8400], destination: [24.0300, 49.8500],
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100, maximumTransfers: 2,
  }, { totalSegments: 3, segmentsPerRoute: 1 });

  assert.ok(result.itineraries.some((itinerary) => itinerary.segments.map((segment) => segment.tripId).join(',')
    === `access-trip,${targetTripId},egress-trip`),
  'a shared parent alone must not make the platform-shifted decoy crowd out the exact-stop chain');
});

test('oversized single trips retain a useful exact direct segment inside the bounded sample', () => {
  const timetable = feed();
  timetable.trips.clear();
  timetable.stopTimes.clear();
  timetable.stopTimesByStop.clear();
  const stopIds = ['origin', 'dense-destination'];
  for (let index = 1; index <= 300; index++) stopIds.push(`dense-stop-${String(index).padStart(3, '0')}`);
  timetable.stops.set('dense-destination', { id: 'dense-destination', name: 'Destination stop', lon: 24.0301, lat: 49.8501 });
  for (let index = 1; index <= 300; index++) {
    const stopId = `dense-stop-${String(index).padStart(3, '0')}`;
    const fraction = index / 300;
    timetable.stops.set(stopId, {
      id: stopId, name: stopId,
      lon: 24.0301 + fraction * 0.001,
      lat: 49.8501 + fraction * 0.001,
    });
  }
  timetable.routes.set('dense-support-route', { name: 'Support', mode: 'TRAM', transportType: 'tram' });
  const makeStopTimes = () => stopIds.map((stopId, index) => ({
    stopId,
    sequence: index + 1,
    arrivalSeconds: 8 * 3600 + index * 60,
    departureSeconds: 8 * 3600 + index * 60,
    pickupType: 0,
    dropOffType: 0,
  }));
  for (const [tripId, routeId] of [['oversized-trip', 'r'], ['oversized-support-trip', 'dense-support-route']] as const) {
    timetable.trips.set(tripId, { routeId, serviceId: 'weekday', headsign: 'Destination' });
    const stopTimes = makeStopTimes();
    timetable.stopTimes.set(tripId, stopTimes);
    stopTimes.forEach((stopTime, index) => {
      timetable.stopTimesByStop.set(stopTime.stopId, [
        ...(timetable.stopTimesByStop.get(stopTime.stopId) ?? []), { tripId, index },
      ]);
    });
  }

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  });

  assert.equal(result.candidateGraphTruncated, false,
    'a direct-only query must not spend graph capacity on segments that cannot connect its selected origin and destination stops');
  assert.ok(result.itineraries.some((journey) => journey.segments.some((segment) =>
    segment.tripId === 'oversized-trip' && segment.originStop.id === 'origin'
      && segment.destinationStop.id === 'dense-destination')),
  `sampling must preserve the exact direct scheduled segment needed for this query (returned ${result.itineraries.length}, trips: ${result.itineraries.flatMap((journey) => journey.segments.map((segment) => segment.tripId)).slice(0, 10).join(',')})`);
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

test('balanced GTFS candidate sampling agrees with the final scorer on transfer effort', () => {
  const base = findGtfsItineraries(connectingFeed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    maximumStopDistanceMeters: 300,
    maximumTransfers: 1,
  })[0];
  assert.ok(base);
  const connecting = {
    ...base,
    id: 'connecting-two-transfers',
    durationSeconds: 3_600,
    transfers: 2,
    fare: { priceMinor: 1_000, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
  };
  const direct = {
    ...base,
    id: 'direct-no-transfer',
    durationSeconds: 4_000,
    transfers: 0,
    fare: { priceMinor: 1_000, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
  };
  const asScorable = (itinerary: typeof base) => ({
    id: itinerary.id,
    durationSeconds: itinerary.durationSeconds,
    priceMinor: itinerary.fare?.currency === 'UAH' ? itinerary.fare.priceMinor : null,
    transfers: itinerary.transfers,
    walkingMeters: itinerary.walkingMeters,
    reliability: null,
    transferRisk: itinerary.transfers > 0 ? 0.3 : 0,
    comfort: null,
    legs: [],
  });
  const finalRanking = scoreJourneys([asScorable(connecting), asScorable(direct)], 'BALANCED').map(({ journey }) => journey.id);
  const sampledRanking = rankGtfsItinerariesForCandidateSampling([connecting, direct]).map(({ id }) => id);

  assert.deepEqual(sampledRanking, finalRanking);
  assert.equal(sampledRanking[0], 'direct-no-transfer');
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

test('route-chain sample preserves the full FASTEST, CHEAPEST, and BALANCED winner set', () => {
  const base = findGtfsItineraries(feed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  })[0];
  assert.ok(base);
  const candidates = [
    ...Array.from({ length: 18 }, (_, index) => ({
      ...base, id: `ordinary-${index}`, durationSeconds: 4_400 + index * 17,
      walkingMeters: 800 + index * 5, transfers: index % 3 === 0 ? 1 : 0,
      fare: { priceMinor: 800 + index * 13, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
    })),
    { ...base, id: 'fastest-extreme', durationSeconds: 1_800, walkingMeters: 1_200, transfers: 1,
      fare: { priceMinor: 1_800, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } },
    { ...base, id: 'cheapest-extreme', durationSeconds: 7_200, walkingMeters: 500, transfers: 0,
      fare: { priceMinor: 100, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } },
    { ...base, id: 'balanced-extreme', durationSeconds: 3_900, walkingMeters: 100, transfers: 0,
      fare: { priceMinor: 700, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } },
  ];
  const scored = candidates.map((itinerary) => ({
    id: itinerary.id,
    durationSeconds: itinerary.durationSeconds,
    priceMinor: itinerary.fare?.currency === 'UAH' ? itinerary.fare.priceMinor : null,
    transfers: itinerary.transfers,
    walkingMeters: itinerary.walkingMeters,
    reliability: null,
    transferRisk: itinerary.transfers > 0 ? 0.3 : 0,
    comfort: null,
    legs: [],
  }));
  const winners = new Set(['FASTEST', 'CHEAPEST', 'BALANCED'].map((strategy) =>
    scoreJourneys(scored, strategy as 'FASTEST' | 'CHEAPEST' | 'BALANCED')[0].journey.id));
  assert.equal(winners.size, 3, 'the fixture must exercise three distinct strategy winners');

  const sampled = sampleGtfsRouteChainCandidates(candidates, 8);
  for (const winner of winners) assert.ok(sampled.some((itinerary) => itinerary.id === winner),
    `route-chain sampling must retain strategy winner ${winner}`);
});

test('bounded objective overflow sample is stable across candidate arrival order', () => {
  const base = findGtfsItineraries(feed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  })[0];
  assert.ok(base);
  const candidates = [
    { ...base, id: 'fast-expensive', durationSeconds: 900, walkingMeters: 1_800, transfers: 1,
      fare: { priceMinor: 900, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } },
    { ...base, id: 'cheap-slow', durationSeconds: 5_400, walkingMeters: 100, transfers: 1,
      fare: { priceMinor: 600, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } },
    { ...base, id: 'middle', durationSeconds: 3_000, walkingMeters: 700, transfers: 0,
      fare: { priceMinor: 250, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } },
    { ...base, id: 'low-walk', durationSeconds: 4_200, walkingMeters: 1_000, transfers: 0,
      fare: { priceMinor: 0, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } },
    { ...base, id: 'fast-cheap-transfer', durationSeconds: 1_500, walkingMeters: 300, transfers: 2,
      fare: { priceMinor: 500, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const } },
  ];
  const permute = <T,>(items: T[]): T[][] => items.length
    ? items.flatMap((item, index) => permute(items.filter((_, otherIndex) => otherIndex !== index)
      ).map((permutation) => [item, ...permutation]))
    : [[]];
  const permutations = permute(candidates);
  const expected = permutations[0]!.reduce((sample, candidate) =>
    retainGtfsDeterministicOverflowSample(sample, candidate, 1), [] as GtfsItinerary[]).map(({ id }) => id);
  for (const [index, order] of permutations.entries()) {
    const retained = order.reduce((sample, candidate) =>
      retainGtfsDeterministicOverflowSample(sample, candidate, 1), [] as GtfsItinerary[]);
    assert.deepEqual(retained.map(({ id }) => id), expected, `sample is order-independent (permutation ${index})`);
  }
});

test('cross-provider GTFS cap preserves slow cheapest routes before filling by arrival', () => {
  const base = findGtfsItineraries(feed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  })[0];
  assert.ok(base);
  const candidates = Array.from({ length: 130 }, (_, index) => ({
    ...base,
    id: `route-${String(index).padStart(3, '0')}`,
    durationSeconds: 1_800 + index * 10,
    arrivalAt: new Date(base.arrivalAt.getTime() + index * 10_000),
    fare: { priceMinor: index === 129 ? 100 : 1_000 + index, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
  }));
  const selected = selectGtfsCandidatesForCrossProviderSearch(candidates, 100);

  assert.equal(selected.length, 100);
  assert.ok(selected.some((journey) => journey.id === 'route-000'), 'the fastest candidate survives');
  assert.ok(selected.some((journey) => journey.id === 'route-129'), 'the slowest known-cheapest candidate survives');
  assert.deepEqual(
    selectGtfsCandidatesForCrossProviderSearch([...candidates].reverse(), 100).map(({ id }) => id),
    selected.map(({ id }) => id),
    'objective retention is deterministic and independent of provider insertion order',
  );
});

test('cross-provider GTFS cap uses the shared candidate pool when preserving its balanced winner', () => {
  const base = findGtfsItineraries(feed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 0,
  })[0];
  assert.ok(base);
  const withFare = (id: string, durationSeconds: number, priceMinor: number) => ({
    ...base,
    id,
    durationSeconds,
    fare: { priceMinor, currency: 'UAH', allocations: [], source: 'gtfs-v1' as const },
  });
  const candidates = [
    withFare('fast-expensive', 1_000, 10_000),
    withFare('balanced-winner', 6_000, 5_100),
    withFare('cheapest-slower', 6_800, 5_000),
    withFare('alternative-d', 2_000, 9_000),
    withFare('alternative-e', 3_000, 8_000),
    withFare('alternative-f', 4_000, 7_000),
  ];
  const communityCandidate = {
    id: 'long-community-option',
    durationSeconds: 30_000,
    priceMinor: 10_000,
    transfers: 0,
    walkingMeters: 0,
    reliability: null,
    transferRisk: 0,
    comfort: null,
    legs: [{ mode: 'COMMUNITY' as const }],
  };
  const toScorable = (itinerary: typeof base) => ({
    id: itinerary.id,
    durationSeconds: itinerary.durationSeconds,
    priceMinor: itinerary.fare?.currency === 'UAH' ? itinerary.fare.priceMinor : null,
    transfers: itinerary.transfers,
    walkingMeters: itinerary.walkingMeters,
    reliability: null,
    transferRisk: itinerary.transfers > 0 ? 0.3 : 0,
    comfort: null,
    legs: [],
  });
  const completeMixedPoolWinner = scoreJourneys(
    [...candidates.map(toScorable), communityCandidate], 'BALANCED',
  )[0]?.journey.id;
  assert.equal(completeMixedPoolWinner, 'balanced-winner',
    'the fixture proves that shared mode ranges change the winning GTFS candidate');
  const completeStrategyWinners = ['FASTEST', 'CHEAPEST', 'BALANCED'].map((strategy) =>
    scoreJourneys([...candidates.map(toScorable), communityCandidate], strategy as 'FASTEST' | 'CHEAPEST' | 'BALANCED')[0]?.journey.id,
  );

  const transitOnlySample = selectGtfsCandidatesForCrossProviderSearch(candidates, 5);
  assert.ok(!transitOnlySample.some(({ id }) => id === 'balanced-winner'),
    'without mixed-mode score ranges, the transit-only balanced sample omits the later winner');

  const mixedModeSample = selectGtfsCandidatesForCrossProviderSearch(candidates, 5, [communityCandidate]);
  assert.ok(mixedModeSample.some(({ id }) => id === 'balanced-winner'),
    'the route that wins in the full mixed-mode score pool survives bounded GTFS pruning');
  for (const winnerId of completeStrategyWinners) {
    if (winnerId && candidates.some(({ id }) => id === winnerId)) {
      assert.ok(mixedModeSample.some(({ id }) => id === winnerId),
        `the ${winnerId} winner from a complete mixed-provider strategy ranking survives the GTFS candidate cap`);
    }
  }
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

test('keeps the cheapest three-leg option after a dense two-leg candidate pool fills', () => {
  const { timetable } = timeFeasibleChainWithHashCompetingTrips();
  const products = new Map<string, { id: string; priceMinor: number; currency: string; transfers: number; transferDurationSeconds: null }>();
  const rules = new Map<string, Array<{ fareId: string; routeId: string }>>();
  for (const routeId of ['access', 'middle', 'egress']) {
    const fareId = `${routeId}-fare`;
    products.set(fareId, { id: fareId, priceMinor: 100, currency: 'UAH', transfers: 0, transferDurationSeconds: null });
    rules.set(fareId, [{ fareId, routeId }]);
  }

  // Saturate the global result sample with many feasible two-leg options. The
  // three-leg chain is slower but strictly cheaper and must remain available
  // through its own bounded objective window.
  for (let index = 0; index < 13_000; index++) {
    const suffix = String(index).padStart(5, '0');
    const routeId = `alt-${suffix}`;
    const tripId = `alt-trip-${suffix}`;
    const fareId = `fare-${suffix}`;
    timetable.routes.set(routeId, { name: `Alternative ${suffix}`, mode: 'BUS', transportType: 'bus' });
    timetable.trips.set(tripId, { routeId, serviceId: 'weekday', headsign: 'Destination' });
    const entries = [
      { stopId: 'hub-a', sequence: 1, arrivalSeconds: 8 * 3600 + 30 * 60, departureSeconds: 8 * 3600 + 30 * 60, pickupType: 0, dropOffType: 0 },
      { stopId: 'destination', sequence: 2, arrivalSeconds: 8 * 3600 + 40 * 60, departureSeconds: 8 * 3600 + 40 * 60, pickupType: 0, dropOffType: 0 },
    ];
    timetable.stopTimes.set(tripId, entries);
    entries.forEach((entry, entryIndex) => {
      let atStop = timetable.stopTimesByStop.get(entry.stopId);
      if (!atStop) {
        atStop = [];
        timetable.stopTimesByStop.set(entry.stopId, atStop);
      }
      atStop.push({ tripId, index: entryIndex });
    });
    products.set(fareId, { id: fareId, priceMinor: 1_000, currency: 'UAH', transfers: 0, transferDurationSeconds: null });
    rules.set(fareId, [{ fareId, routeId }]);
  }
  timetable.fareProducts = products;
  timetable.fareRules = rules;

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'),
    origin: [24.0200, 49.8400], destination: [24.0300, 49.8500],
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100,
    maximumTransferWalkingMeters: 100, maximumTransfers: 2, limit: 5,
  });

  const cheapest = result.itineraries.filter((itinerary) => itinerary.fare?.currency === 'UAH')
    .sort((left, right) => left.fare!.priceMinor - right.fare!.priceMinor
      || left.durationSeconds - right.durationSeconds)[0];
  assert.ok(cheapest);
  assert.deepEqual(cheapest.segments.map((segment) => segment.routeId), ['access', 'middle', 'egress']);
  assert.equal(cheapest.fare?.priceMinor, 300);
  assert.equal(result.searchTruncated, true, 'the bounded dense-feed search must continue to disclose truncation');
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
  assert.equal(result.truncation.candidateGraph, false);
  assert.equal(result.truncation.responsePage, true, 'the response page is distinguished from graph loss');

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
  const timetable = feed({ departure: '24:15:00', arrival: '24:55:00', monday: '0', exceptionDate: '20261012' });
  const journeys = findDirectGtfsJourneys(timetable, request('2026-10-12T21:10:00Z', '2026-10-12T21:30:00Z'));
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].departureAt.toISOString(), '2026-10-12T21:15:00.000Z');
  assert.equal(journeys[0].arrivalAt.toISOString(), '2026-10-12T21:55:00.000Z');
  const indexed = queryDirectedEventIndexPrototype(timetable, {
    originStopId: 'origin', destinationStopId: 'destination', serviceDates: ['20261012'],
    earliestDeparture: new Date('2026-10-12T21:10:00Z'), latestDeparture: new Date('2026-10-12T21:30:00Z'),
    maximumTransferWalkingMeters: 100, maximumTransfers: 0,
  });
  assert.deepEqual([...indexed.candidatePaths], [
    `t1:origin@${Date.parse('2026-10-12T21:15:00Z')}>destination@${Date.parse('2026-10-12T21:55:00Z')}`,
  ], 'dated event labels honor a calendar exception, agency timezone, and GTFS 24:15 service time');
});

test('finds a 71-hour GTFS service trip on its two-day-old service date', () => {
  const timetable = feed({ departure: '71:15:00', arrival: '71:55:00', monday: '0', exceptionDate: '20261012' });
  const query = {
    ...request('2026-10-14T20:10:00Z', '2026-10-14T20:30:00Z'),
    maximumTransfers: 0,
  };
  const direct = findDirectGtfsJourneys(timetable, query);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].serviceDate, '20261012');
  assert.equal(direct[0].departureAt.toISOString(), '2026-10-14T20:15:00.000Z');
  assert.equal(direct[0].arrivalAt.toISOString(), '2026-10-14T20:55:00.000Z');

  const routed = findGtfsItinerariesWithStats(timetable, query);
  assert.equal(routed.itineraries.length, 1,
    'the production multimodal search must include the prior two service dates too');
  assert.equal(routed.itineraries[0].segments[0].serviceDate, '20261012');
  assert.equal(routed.itineraries[0].segments[0].departureAt.toISOString(), '2026-10-14T20:15:00.000Z');
  assert.equal(routed.itineraries[0].segments[0].arrivalAt.toISOString(), '2026-10-14T20:55:00.000Z');
  assert.equal(routed.searchTruncated, false, 'the complete tiny 71-hour service-date fixture is not truncated');
});

test('finds a 99-hour GTFS service trip on its four-day-old service date', () => {
  const timetable = feed({ departure: '99:15:00', arrival: '99:55:00', monday: '0', exceptionDate: '20261012' });
  const query = {
    ...request('2026-10-16T00:10:00Z', '2026-10-16T00:30:00Z'),
    maximumTransfers: 0,
  };
  const direct = findDirectGtfsJourneys(timetable, query);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].serviceDate, '20261012');
  assert.equal(direct[0].departureAt.toISOString(), '2026-10-16T00:15:00.000Z');
  assert.equal(direct[0].arrivalAt.toISOString(), '2026-10-16T00:55:00.000Z');

  const routed = findGtfsItinerariesWithStats(timetable, query);
  assert.equal(routed.itineraries.length, 1,
    'the production multimodal search must include service dates four days earlier');
  assert.equal(routed.itineraries[0].segments[0].serviceDate, '20261012');
  assert.equal(routed.itineraries[0].segments[0].departureAt.toISOString(), '2026-10-16T00:15:00.000Z');
  assert.equal(routed.itineraries[0].segments[0].arrivalAt.toISOString(), '2026-10-16T00:55:00.000Z');

  const arrivals = findGtfsStopArrivals(timetable, 'destination', {
    now: new Date('2026-10-16T00:10:00Z'), limit: 10,
  });
  assert.equal(arrivals.length, 1,
    'the stop-arrivals view must include service times up to the supported horizon');
  assert.equal(arrivals[0].scheduledArrivalAt.toISOString(), '2026-10-16T00:55:00.000Z');
});

test('includes the next GTFS service date during the prior-evening spring-forward overlap', () => {
  const timetable = feed({ departure: '00:30:00', arrival: '00:45:00', monday: '0', exceptionDate: '20270328' });
  const query = {
    ...request('2027-03-27T21:25:00Z', '2027-03-27T21:35:00Z'),
    maximumTransfers: 0,
  };

  const direct = findDirectGtfsJourneys(timetable, query);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].serviceDate, '20270328');
  assert.equal(direct[0].departureAt.toISOString(), '2027-03-27T21:30:00.000Z');
  assert.equal(direct[0].arrivalAt.toISOString(), '2027-03-27T21:45:00.000Z');

  const routed = findGtfsItinerariesWithStats(timetable, query);
  assert.equal(routed.itineraries.length, 1);
  assert.equal(routed.itineraries[0].segments[0].serviceDate, '20270328');
  assert.equal(routed.itineraries[0].segments[0].departureAt.toISOString(), '2027-03-27T21:30:00.000Z');

  const arrivals = findGtfsStopArrivals(timetable, 'destination', {
    now: new Date('2027-03-27T21:25:00Z'), horizonSeconds: 60 * 60, limit: 10,
  });
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].scheduledArrivalAt.toISOString(), '2027-03-27T21:45:00.000Z');
});

test('keeps extended GTFS service seconds anchored to the originating service date across spring-forward', () => {
  const timetable = feed({ departure: '27:30:00', arrival: '28:30:00', monday: '0', exceptionDate: '20270327' });
  const query = {
    ...request('2027-03-28T01:20:00Z', '2027-03-28T01:40:00Z'),
    maximumTransfers: 0,
  };

  const direct = findDirectGtfsJourneys(timetable, query);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].serviceDate, '20270327');
  assert.equal(direct[0].departureAt.toISOString(), '2027-03-28T01:30:00.000Z');
  assert.equal(direct[0].arrivalAt.toISOString(), '2027-03-28T02:30:00.000Z');

  const routed = findGtfsItinerariesWithStats(timetable, query);
  assert.equal(routed.itineraries.length, 1);
  assert.equal(routed.itineraries[0].segments[0].serviceDate, '20270327');
  assert.equal(routed.itineraries[0].segments[0].departureAt.toISOString(), '2027-03-28T01:30:00.000Z');
  assert.equal(routed.itineraries[0].segments[0].arrivalAt.toISOString(), '2027-03-28T02:30:00.000Z');

  const arrivals = findGtfsStopArrivals(timetable, 'destination', {
    now: new Date('2027-03-28T01:20:00Z'), horizonSeconds: 2 * 60 * 60, limit: 10,
  });
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].scheduledArrivalAt.toISOString(), '2027-03-28T02:30:00.000Z');
});

test('uses the noon-minus-12 service origin on the Kyiv fall-back date without a forward lookahead', () => {
  const timetable = feed({ departure: '00:30:00', arrival: '00:45:00', monday: '0', exceptionDate: '20261025' });
  const query = {
    ...request('2026-10-24T22:25:00Z', '2026-10-24T22:35:00Z'),
    maximumTransfers: 0,
  };

  const direct = findDirectGtfsJourneys(timetable, query);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].serviceDate, '20261025');
  assert.equal(direct[0].departureAt.toISOString(), '2026-10-24T22:30:00.000Z');
  assert.equal(direct[0].arrivalAt.toISOString(), '2026-10-24T22:45:00.000Z');

  const routed = findGtfsItinerariesWithStats(timetable, query);
  assert.equal(routed.itineraries.length, 1);
  assert.equal(routed.itineraries[0].segments[0].serviceDate, '20261025');
  assert.equal(routed.itineraries[0].segments[0].departureAt.toISOString(), '2026-10-24T22:30:00.000Z');

  const arrivals = findGtfsStopArrivals(timetable, 'destination', {
    now: new Date('2026-10-24T22:25:00Z'), horizonSeconds: 60 * 60, limit: 10,
  });
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].scheduledArrivalAt.toISOString(), '2026-10-24T22:45:00.000Z');
});

test('finds prior-service-date GTFS times during the Kyiv fall-back midnight window', () => {
  const timetable = feed({ departure: '24:30:00', arrival: '24:45:00', monday: '0', exceptionDate: '20261024' });
  const query = {
    ...request('2026-10-24T21:20:00Z', '2026-10-24T21:40:00Z'),
    maximumTransfers: 0,
  };

  const direct = findDirectGtfsJourneys(timetable, query);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].serviceDate, '20261024');
  assert.equal(direct[0].departureAt.toISOString(), '2026-10-24T21:30:00.000Z');
  assert.equal(direct[0].arrivalAt.toISOString(), '2026-10-24T21:45:00.000Z');

  const routed = findGtfsItinerariesWithStats(timetable, query);
  assert.equal(routed.itineraries.length, 1);
  assert.equal(routed.itineraries[0].segments[0].serviceDate, '20261024');
  assert.equal(routed.itineraries[0].segments[0].departureAt.toISOString(), '2026-10-24T21:30:00.000Z');
  assert.equal(routed.itineraries[0].segments[0].arrivalAt.toISOString(), '2026-10-24T21:45:00.000Z');

  const arrivals = findGtfsStopArrivals(timetable, 'destination', {
    now: new Date('2026-10-24T21:20:00Z'), horizonSeconds: 60 * 60, limit: 10,
  });
  assert.equal(arrivals.length, 1);
  assert.equal(arrivals[0].scheduledArrivalAt.toISOString(), '2026-10-24T21:45:00.000Z');
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

test('matches an exhaustive small-feed oracle for every feasible one-transfer trip pair', () => {
  const timetable = feed();
  timetable.routes.clear();
  timetable.trips.clear();
  timetable.stopTimes.clear();
  timetable.stopTimesByStop.clear();
  timetable.stops.clear();
  timetable.stops.set('start', { id: 'start', name: 'Start', lon: 24.0201, lat: 49.8401 });
  timetable.stops.set('hub', { id: 'hub', name: 'Transfer hub', lon: 24.025, lat: 49.845 });
  timetable.stops.set('finish', { id: 'finish', name: 'Finish', lon: 24.0301, lat: 49.8501 });
  timetable.routes.set('bus', { name: '7', mode: 'BUS', transportType: 'bus' });
  timetable.routes.set('tram', { name: '2', mode: 'TRAM', transportType: 'tram' });
  const addTrip = (tripId: string, routeId: 'bus' | 'tram', from: string, to: string, departure: number, arrival: number) => {
    timetable.trips.set(tripId, { routeId, serviceId: 'weekday', headsign: to });
    const entries = [from, to].map((stopId, index) => ({
      stopId, sequence: index + 1, arrivalSeconds: index === 0 ? departure : arrival,
      departureSeconds: index === 0 ? departure : arrival, pickupType: 0, dropOffType: 0,
    }));
    timetable.stopTimes.set(tripId, entries);
    entries.forEach((entry, index) => timetable.stopTimesByStop.set(entry.stopId,
      [...(timetable.stopTimesByStop.get(entry.stopId) ?? []), { tripId, index }]));
  };
  const seconds = (time: string) => {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 3600 + minutes * 60;
  };
  for (const [tripId, departure, arrival] of [
    ['bus-1', '08:00', '08:15'], ['bus-2', '08:05', '08:20'], ['bus-3', '08:10', '08:25'],
  ]) addTrip(tripId, 'bus', 'start', 'hub', seconds(departure), seconds(arrival));
  for (const [tripId, departure, arrival] of [
    ['tram-1', '08:20', '08:45'], ['tram-2', '08:27', '08:50'], ['tram-3', '08:30', '08:55'],
  ]) addTrip(tripId, 'tram', 'hub', 'finish', seconds(departure), seconds(arrival));

  // Independent exhaustive oracle for this deliberately tiny, single-stop
  // transfer feed: every bus trip is paired with every tram trip, applying
  // the three-minute urban connection buffer and the query's departure window.
  const expected = new Set<string>();
  const latestFirstDeparture = seconds('08:12');
  const transferBuffer = DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS;
  for (const [busTripId, busTimes] of timetable.stopTimes) {
    if (timetable.trips.get(busTripId)?.routeId !== 'bus' || busTimes[0].departureSeconds > latestFirstDeparture) continue;
    for (const [tramTripId, tramTimes] of timetable.stopTimes) {
      if (timetable.trips.get(tramTripId)?.routeId !== 'tram') continue;
      if (tramTimes[0].departureSeconds >= busTimes[1].arrivalSeconds + transferBuffer) {
        expected.add(`${busTripId}>${tramTripId}`);
      }
    }
  }

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:12:00Z'),
    maximumAccessWalkingMeters: 300, maximumEgressWalkingMeters: 300,
    maximumTransferWalkingMeters: 100, maximumTransfers: 1,
  });
  const actual = new Set(result.itineraries
    .filter((journey) => journey.segments.length === 2)
    .map((journey) => journey.segments.map((segment) => segment.tripId).join('>')));

  assert.deepEqual([...actual].sort(), [...expected].sort());
  assert.equal(result.searchTruncated, false, 'a feed below all sampling and graph caps must be complete');
  assert.deepEqual(result.truncation, { stopSelection: false, candidateGraph: false, searchBudget: false,
    searchStepLimit: false, candidatePoolLimit: false, candidateSampling: false, responsePage: false });
  assert.equal(expected.size, 6, 'oracle fixture covers early, marginal, and missed-buffer connections');
});

test('matches an exhaustive two-transfer oracle and all three ranking winners', () => {
  const timetable = feed();
  timetable.routes.clear();
  timetable.trips.clear();
  timetable.stopTimes.clear();
  timetable.stopTimesByStop.clear();
  timetable.stops.clear();
  timetable.stops.set('start', { id: 'start', name: 'Start', lon: 24.0201, lat: 49.8401 });
  timetable.stops.set('hub-a', { id: 'hub-a', name: 'Transfer A', lon: 24.025, lat: 49.845 });
  timetable.stops.set('hub-b', { id: 'hub-b', name: 'Transfer B', lon: 24.0275, lat: 49.8475 });
  timetable.stops.set('finish', { id: 'finish', name: 'Finish', lon: 24.0301, lat: 49.8501 });
  const fares = [
    [800, 200, 300],
    [1_000, 50, 300],
    [1_000, 50, 300],
  ];
  timetable.fareProducts = new Map();
  timetable.fareRules = new Map();
  const addTrip = (prefix: 'bus' | 'tram' | 'train', index: number, from: string, to: string,
    departure: string, arrival: string, fareMinor: number) => {
    const routeId = `${prefix}-${index}`;
    const tripId = `${routeId}-trip`;
    const fareId = `${routeId}-fare`;
    const route = prefix === 'bus' ? { name: `Bus ${index}`, mode: 'BUS' as const, transportType: 'bus' as const }
      : prefix === 'tram' ? { name: `Tram ${index}`, mode: 'TRAM' as const, transportType: 'tram' as const }
        : { name: `Train ${index}`, mode: 'RAIL' as const, transportType: 'train' as const };
    timetable.routes.set(routeId, route);
    timetable.trips.set(tripId, { routeId, serviceId: 'weekday', headsign: to });
    const seconds = (value: string) => {
      const [hours, minutes] = value.split(':').map(Number);
      return hours * 3600 + minutes * 60;
    };
    const entries = [
      { stopId: from, sequence: 1, arrivalSeconds: seconds(departure), departureSeconds: seconds(departure), pickupType: 0, dropOffType: 0 },
      { stopId: to, sequence: 2, arrivalSeconds: seconds(arrival), departureSeconds: seconds(arrival), pickupType: 0, dropOffType: 0 },
    ];
    timetable.stopTimes.set(tripId, entries);
    entries.forEach((entry, stopIndex) => timetable.stopTimesByStop.set(entry.stopId,
      [...(timetable.stopTimesByStop.get(entry.stopId) ?? []), { tripId, index: stopIndex }]));
    timetable.fareProducts!.set(fareId, { id: fareId, priceMinor: fareMinor, currency: 'UAH', transfers: null,
      transferDurationSeconds: null });
    timetable.fareRules!.set(fareId, [{ fareId, routeId }]);
    return { tripId, departure, arrival, fareMinor };
  };
  const buses = ['08:00', '08:05', '08:10'].map((departure, index) =>
    addTrip('bus', index, 'start', 'hub-a', departure,
      ['08:10', '08:15', '08:20'][index], fares[0][index]));
  const direct = addTrip('bus', 3, 'start', 'finish', '08:05', '08:51', 800);
  const trams = ['08:15', '08:20', '08:25'].map((departure, index) =>
    addTrip('tram', index, 'hub-a', 'hub-b', departure,
      ['08:25', '08:30', '08:35'][index], fares[1][index]));
  const trains = ['08:35', '08:40', '08:45'].map((departure, index) =>
    addTrip('train', index, 'hub-b', 'finish', departure,
      ['08:45', '08:50', '08:55'][index], fares[2][index]));
  const bufferSeconds = DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS;
  const intercityTransferBufferSeconds = 10 * 60;
  const latestFirstDepartureSeconds = 8 * 3600 + 12 * 60;
  const expected = new Map<string, {
    id: string; durationSeconds: number; priceMinor: number; transfers: number; walkingMeters: number;
    reliability: null; transferRisk: number; comfort: null; legs: Array<{ mode: 'BUS' | 'TRAM' | 'RAIL' }>;
  }>();
  expected.set(direct.tripId, {
    id: direct.tripId,
    durationSeconds: (Date.UTC(2026, 9, 12, 5, 51) - Date.parse('2026-10-12T04:55:00Z')) / 1000,
    priceMinor: direct.fareMinor, transfers: 0, walkingMeters: 0, reliability: null,
    transferRisk: 0, comfort: null, legs: [{ mode: 'BUS' }],
  });
  const seconds = (value: string) => {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 3600 + minutes * 60;
  };
  for (const bus of buses) for (const tram of trams) for (const train of trains) {
    if (seconds(bus.departure) > latestFirstDepartureSeconds
      || seconds(tram.departure) < seconds(bus.arrival) + bufferSeconds
      || seconds(train.departure) < seconds(tram.arrival) + intercityTransferBufferSeconds) continue;
    const id = [bus.tripId, tram.tripId, train.tripId].join('>');
    const [hours, minutes] = train.arrival.split(':').map(Number);
    // The fixture date is before the Europe/Kyiv DST transition (UTC+3).
    const arrivalAt = Date.UTC(2026, 9, 12, hours - 3, minutes);
    expected.set(id, {
      id,
      durationSeconds: (arrivalAt - Date.parse('2026-10-12T04:55:00Z')) / 1000,
      priceMinor: bus.fareMinor + tram.fareMinor + train.fareMinor,
      transfers: 2, walkingMeters: 0, reliability: null, transferRisk: 0.25, comfort: null,
      legs: [{ mode: 'BUS' }, { mode: 'TRAM' }, { mode: 'RAIL' }],
    });
  }

  const result = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:12:00Z'),
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100,
    maximumTransferWalkingMeters: 100, maximumTransfers: 2,
  });
  const actualById = new Map(result.itineraries.map((journey) => [journey.segments.map((segment) => segment.tripId).join('>'), journey]));
  assert.deepEqual([...actualById.keys()].sort(), [...expected.keys()].sort(),
    'the bounded search returns the direct trip and every and only time-feasible three-leg chain');
  assert.equal(expected.size, 11, 'the oracle covers a direct trip and ten early, marginal, or missed-buffer three-leg chains');
  assert.equal(result.searchTruncated, false, 'the complete small graph is searched without sampling loss');

  const lazyOracle = lazyEventLabelSearch(timetable, {
    originStopIds: ['start'], destinationStopIds: ['finish'], serviceDates: ['20261012'],
    earliestDeparture: new Date('2026-10-12T04:55:00Z'), latestDeparture: new Date('2026-10-12T05:12:00Z'),
    maximumJourneySeconds: 2 * 60 * 60, maximumTransfers: 2, maximumWaitSeconds: 2 * 60 * 60,
    transferRadiusMeters: 100, minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
    providerId: 'p1', providerName: 'Test Transit',
  });
  const lazyByChain = new Map([...lazyOracle.identities.values()].map((entry) => [entry.tripIds.join('>'), entry]));
  assert.equal(lazyOracle.searchTruncated, false, 'the exhaustive small-feed lazy search stays within its explicit label budget');
  assert.deepEqual([...lazyByChain.keys()].sort(), [...expected.keys()].sort(),
    'independent lazy label search enumerates every direct, one-transfer and two-transfer oracle identity');
  for (const [chain, option] of expected) {
    assert.equal(lazyByChain.get(chain)?.fareMinor, option.priceMinor, `${chain}: exact itinerary cost matches the brute-force fare oracle`);
  }

  const eventLabels = queryDirectedEventIndexPrototype(timetable, {
    originStopId: 'start', destinationStopId: 'finish',
    earliestDeparture: new Date('2026-10-12T04:55:00Z'), latestDeparture: new Date('2026-10-12T05:12:00Z'),
    maximumTransferWalkingMeters: 100, maximumTransfers: 2,
  });
  const exactEventLabels = validateEventIndexCandidatesWithProductionTransfers(timetable, {
    candidatePaths: eventLabels.candidatePaths, transferRadius: 100,
    minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
  });
  const indexedChainIds = new Set([...exactEventLabels.feasiblePaths].map((path) => path.split('|')
    .map((leg) => leg.slice(0, leg.indexOf(':'))).join('>')));
  assert.deepEqual([...expected.keys()].filter((chain) => !indexedChainIds.has(chain)), [],
    'the event-label frontier keeps every direct, one-transfer, and two-transfer oracle chain');
  const eventCandidateFeed = structuredClone(timetable);
  eventCandidateFeed.trips = new Map([...eventCandidateFeed.trips].filter(([tripId]) => eventLabels.candidateTripIds.has(tripId)));
  const eventRouteIds = new Set([...eventCandidateFeed.trips.values()].map((trip) => trip.routeId));
  eventCandidateFeed.routes = new Map([...eventCandidateFeed.routes].filter(([routeId]) => eventRouteIds.has(routeId)));
  eventCandidateFeed.stopTimes = new Map([...eventCandidateFeed.stopTimes]
    .filter(([tripId]) => eventLabels.candidateTripIds.has(tripId)));
  eventCandidateFeed.stopTimesByStop = new Map();
  for (const [tripId, stopTimes] of eventCandidateFeed.stopTimes) stopTimes.forEach((stopTime, index) =>
    eventCandidateFeed.stopTimesByStop.set(stopTime.stopId,
      [...(eventCandidateFeed.stopTimesByStop.get(stopTime.stopId) ?? []), { tripId, index }]));
  const eventCandidateResult = findGtfsItinerariesWithStats(eventCandidateFeed, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:12:00Z'),
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100,
    maximumTransferWalkingMeters: 100, maximumTransfers: 2,
  });
  const eventCandidateById = new Map(eventCandidateResult.itineraries.map((journey) => [
    journey.segments.map((segment) => segment.tripId).join('>'), journey,
  ]));
  assert.equal(eventCandidateResult.searchTruncated, false);
  assert.deepEqual([...eventCandidateById.keys()].sort(), [...expected.keys()].sort(),
    'production materialization over event-label candidates returns the exhaustive identity set');
  assert.deepEqual([...eventCandidateById].map(([id, journey]) => [id, journey.fare])
    .sort(([left], [right]) => String(left).localeCompare(String(right))),
  [...actualById].map(([id, journey]) => [id, journey.fare])
    .sort(([left], [right]) => String(left).localeCompare(String(right))),
  'the label frontier preserves fare allocations for each full trip chain, not only a scalar journey price');

  const actualScoringOptions = [...actualById].map(([id, journey]) => ({
    id, durationSeconds: journey.durationSeconds,
    priceMinor: journey.fare?.currency === 'UAH' ? journey.fare.priceMinor : null,
    transfers: journey.transfers, walkingMeters: journey.walkingMeters,
    reliability: null, transferRisk: journey.transfers > 0 ? 0.25 : 0, comfort: null,
    legs: journey.segments.map((segment) => ({ mode: segment.mode })),
  }));
  const expectedScoringOptions = [...expected.values()];
  const exhaustiveWinnerIds: Partial<Record<'FASTEST' | 'CHEAPEST' | 'BALANCED', string>> = {};
  for (const strategy of ['FASTEST', 'CHEAPEST', 'BALANCED'] as const) {
    const expectedWinner = scoreJourneys(expectedScoringOptions, strategy)[0]?.journey.id;
    const actualWinner = scoreJourneys(actualScoringOptions, strategy)[0]?.journey.id;
    assert.equal(actualWinner, expectedWinner, `${strategy} winner matches exhaustive oracle`);
    if (expectedWinner) exhaustiveWinnerIds[strategy] = expectedWinner;
  }
  assert.deepEqual(exhaustiveWinnerIds, {
    FASTEST: 'bus-0-trip>tram-0-trip>train-0-trip',
    CHEAPEST: 'bus-1-trip>tram-1-trip>train-1-trip',
    BALANCED: 'bus-3-trip',
  }, 'the independently enumerated fixture has known, distinct winners for all three strategies');

  const boundedResult = findGtfsItinerariesWithStats(timetable, {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:12:00Z'),
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100,
    maximumTransferWalkingMeters: 100, maximumTransfers: 2,
  }, { totalSegments: 9, segmentsPerRoute: 1 });
  assert.equal(boundedResult.candidateGraphTruncated, true,
    'a graph whose route demand exceeds its global budget is marked incomplete');
  assert.equal(boundedResult.truncation.candidateGraph, true);
  assert.equal(boundedResult.searchTruncated, true,
    'the deliberately tight graph budget must continue to be reported as partial');
  const boundedChainIds = new Set(boundedResult.itineraries.map((journey) => journey.segments
    .map((segment) => segment.tripId).join('>')));
  for (const [strategy, winnerId] of Object.entries(exhaustiveWinnerIds)) {
    assert.ok(boundedChainIds.has(winnerId), `bounded graph retains the exhaustive ${strategy} winner ${winnerId}`);
  }
});

test('keeps type-4 event labels and fare-v1 coverage/zones separate from passenger transfer counts', () => {
  const timetable = connectingFeed({ secondDeparture: '08:21:00', transferType: '4', inSeat: true, sameRoute: true });
  timetable.stopTimes.get('b1')![0]!.sourceZoneId = 'z1';
  timetable.stopTimes.get('b1')![1]!.sourceZoneId = 'z2';
  timetable.stopTimes.get('r1')![0]!.sourceZoneId = 'z2';
  timetable.stopTimes.get('r1')![1]!.sourceZoneId = 'z3';
  timetable.fareProducts = new Map([['through', {
    id: 'through', priceMinor: 1850, currency: 'UAH', transfers: 1, transferDurationSeconds: 3600,
  }]]);
  timetable.fareRules = new Map([['through', [
    { fareId: 'through', routeId: 'bus' },
    { fareId: 'through', originZoneId: 'z1', destinationZoneId: 'z3' },
    { fareId: 'through', originZoneId: 'z1', destinationZoneId: 'z3', containsZoneId: 'z2' },
  ]]]);
  const query = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:12:00Z'),
    maximumAccessWalkingMeters: 100, maximumEgressWalkingMeters: 100,
    maximumTransferWalkingMeters: 100, maximumTransfers: 1,
  };
  const oracle = findGtfsItinerariesWithStats(timetable, query).itineraries.find((journey) => journey.segments.length === 2);
  assert.ok(oracle);
  assert.equal(oracle.transfers, 0, 'a GTFS type-4 continuation adds a segment but no passenger transfer');
  assert.equal(oracle.fare?.priceMinor, 1850);
  assert.deepEqual(oracle.fare?.allocations.map((part) => ({ product: part.fareProductId,
    included: part.includedByPreviousFare, price: part.priceMinor })), [
    { product: 'through', included: false, price: 1850 },
    { product: 'through', included: true, price: 0 },
  ], 'fare-v1 transfer coverage and zone constraints apply across both in-seat segments');

  const lazyFareLabels = lazyEventLabelSearch(timetable, {
    originStopIds: ['start'], destinationStopIds: ['finish'], serviceDates: ['20261012'],
    earliestDeparture: query.earliestDeparture, latestDeparture: query.latestDeparture,
    maximumJourneySeconds: 2 * 60 * 60, maximumTransfers: 1, maximumWaitSeconds: 2 * 60 * 60,
    transferRadiusMeters: 100, minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
    providerId: 'p1', providerName: 'Test Transit',
  });
  const lazyFareChain = [...lazyFareLabels.identities.values()].find((entry) => entry.tripIds.join('>') === 'b1>r1');
  assert.equal(lazyFareLabels.searchTruncated, false);
  assert.ok(lazyFareChain, 'independent lazy labels retain the type-4 continuation');
  assert.equal(lazyFareChain.fareMinor, oracle.fare?.priceMinor);
  assert.deepEqual(lazyFareChain.fareAllocations, oracle.fare?.allocations,
    'the independent event label retains the exact fare-v1 allocation frontier result');

  const labels = queryDirectedEventIndexPrototype(timetable, {
    originStopId: 'start', destinationStopId: 'finish', earliestDeparture: query.earliestDeparture,
    latestDeparture: query.latestDeparture, maximumTransferWalkingMeters: 100, maximumTransfers: 1,
  });
  const exactLabels = validateEventIndexCandidatesWithProductionTransfers(timetable, {
    candidatePaths: labels.candidatePaths, transferRadius: 100,
    minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
  });
  assert.ok([...exactLabels.feasiblePaths].some((path) => path.split('|').length === 2),
    'the exact transfer authority keeps both type-4 segments even though physical transfer count is zero');
  const labelCandidateFeed = structuredClone(timetable);
  labelCandidateFeed.trips = new Map([...labelCandidateFeed.trips]
    .filter(([tripId]) => labels.candidateTripIds.has(tripId)));
  const labelRouteIds = new Set([...labelCandidateFeed.trips.values()].map((trip) => trip.routeId));
  labelCandidateFeed.routes = new Map([...labelCandidateFeed.routes]
    .filter(([routeId]) => labelRouteIds.has(routeId)));
  labelCandidateFeed.stopTimes = new Map([...labelCandidateFeed.stopTimes]
    .filter(([tripId]) => labels.candidateTripIds.has(tripId)));
  labelCandidateFeed.stopTimesByStop = new Map();
  for (const [tripId, stopTimes] of labelCandidateFeed.stopTimes) stopTimes.forEach((stopTime, index) =>
    labelCandidateFeed.stopTimesByStop.set(stopTime.stopId,
      [...(labelCandidateFeed.stopTimesByStop.get(stopTime.stopId) ?? []), { tripId, index }]));
  const materialized = findGtfsItinerariesWithStats(labelCandidateFeed, query).itineraries
    .find((journey) => journey.segments.length === 2);
  assert.ok(materialized);
  assert.deepEqual(materialized.fare, oracle.fare,
    'the candidate labels preserve the exact fare allocation, not only its scalar total');

  const unknownFareFeed = structuredClone(timetable);
  unknownFareFeed.fareProducts = new Map();
  unknownFareFeed.fareRules = new Map();
  const unknownLabels = queryDirectedEventIndexPrototype(unknownFareFeed, {
    originStopId: 'start', destinationStopId: 'finish', earliestDeparture: query.earliestDeparture,
    latestDeparture: query.latestDeparture, maximumTransferWalkingMeters: 100, maximumTransfers: 1,
  });
  assert.ok([...unknownLabels.candidatePaths].some((path) => path.split('|').length === 2),
    'unknown fare does not prune a feasible event-label chain');
  const unknownLazyLabels = lazyEventLabelSearch(unknownFareFeed, {
    originStopIds: ['start'], destinationStopIds: ['finish'], serviceDates: ['20261012'],
    earliestDeparture: query.earliestDeparture, latestDeparture: query.latestDeparture,
    maximumJourneySeconds: 2 * 60 * 60, maximumTransfers: 1, maximumWaitSeconds: 2 * 60 * 60,
    transferRadiusMeters: 100, minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
    providerId: 'p1', providerName: 'Test Transit',
  });
  assert.ok([...unknownLazyLabels.identities.values()].some((entry) => entry.tripIds.length === 2 && entry.fareMinor === null),
    'unknown fare does not prune or become a zero-cost lazy label');
  const unknown = findGtfsItineraries(unknownFareFeed, query).find((journey) => journey.segments.length === 2);
  assert.ok(unknown);
  assert.equal(unknown.fare, null, 'unknown fare remains unknown, never a zero-price dominance value');
});

test('graph-relative lazy search matches production itinerary materialization, costs, sampling and strategy winners', () => {
  const timetable = feed({ withArrivalAlternatives: true });
  timetable.fareProducts = new Map([
    ['fare-r', { id: 'fare-r', priceMinor: 250, currency: 'UAH', transfers: null, transferDurationSeconds: null }],
    ['fare-r2', { id: 'fare-r2', priceMinor: 90, currency: 'UAH', transfers: null, transferDurationSeconds: null }],
  ]);
  timetable.fareRules = new Map([
    ['fare-r', [{ fareId: 'fare-r', routeId: 'r' }]],
    ['fare-r2', [{ fareId: 'fare-r2', routeId: 'r2' }]],
  ]);
  const query = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:12:00Z'),
    maximumJourneySeconds: 2 * 60 * 60, maximumTransfers: 0,
    maximumAccessWalkingMeters: 900, maximumEgressWalkingMeters: 1000,
    maximumTransferWalkingMeters: 400, minimumTransferBufferSeconds: 180,
    maximumWaitSeconds: 2 * 60 * 60, limit: 100,
  };
  const production = findGtfsItinerariesWithStats(timetable, query);
  let capturedGraph: GtfsCandidateGraphSnapshot | undefined;
  const observedProduction = findGtfsItinerariesWithStats(timetable, query, {}, (snapshot) => { capturedGraph = snapshot; });
  assert.deepEqual(observedProduction, production, 'the optional candidate graph observer does not alter production output');
  assert.ok(capturedGraph);
  assert.ok(Object.isFrozen(capturedGraph) && Object.isFrozen(capturedGraph.segments)
    && Object.isFrozen(capturedGraph.firstLegIds), 'the observer exposes frozen graph collections');
  const expectedFirstLegs = capturedGraph.segments.filter(({ journey }) => capturedGraph!.originStopIds.includes(journey.originStop.id)
    && journey.departureAt.getTime() <= query.latestDeparture.getTime()
    && journey.departureAt.getTime() >= query.earliestDeparture.getTime()
      + Math.ceil(journey.distanceToOriginStopMeters / 1.25) * 1000).map(({ id }) => id);
  assert.deepEqual([...capturedGraph.firstLegIds].sort(), [...expectedFirstLegs].sort(),
    'the graph snapshot first legs match the production origin/time/access predicate');
  const lazy = lazyEventLabelSearchForRequest(timetable, query);
  assert.equal(lazy.searchTruncated, false, 'tiny lazy request remains complete');
  assert.equal(production.searchTruncated, false, 'tiny production request remains complete');
  const boundedProduction = findGtfsItinerariesWithStats(connectingFeed(), {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumTransfers: 1,
  }, { maxQueuedSearchWork: 0 });
  assert.equal(boundedProduction.truncation.searchBudget, true,
    'production reports queued GTFS work dropped at its explicit frontier bound');
  assert.equal(boundedProduction.searchTruncated, true,
    'a queue-bounded production traversal never presents its partial search as complete');
  const signature = (journey: GtfsItinerary) => journey.id;
  const productionById = new Map(production.itineraries.map((journey) => [signature(journey), journey]));
  const lazyById = new Map(lazy.itineraries.map((journey) => [signature(journey), journey]));
  assert.deepEqual([...lazyById.keys()].sort(), [...productionById.keys()].sort(),
    'graph-relative search traverses the exact production-selected access/egress graph and itinerary identity set');
  for (const [id, expected] of productionById) {
    const actual = lazyById.get(id)!;
    assert.deepEqual({ departure: actual.departureAt.getTime(), arrival: actual.arrivalAt.getTime(),
      duration: actual.durationSeconds, waiting: actual.waitingSeconds, transfers: actual.transfers,
      walking: actual.walkingMeters, fare: actual.fare }, {
      departure: expected.departureAt.getTime(), arrival: expected.arrivalAt.getTime(),
      duration: expected.durationSeconds, waiting: expected.waitingSeconds, transfers: expected.transfers,
      walking: expected.walkingMeters, fare: expected.fare,
    }, `production public itinerary fields match for ${id}`);
  }
  for (const strategy of ['FASTEST', 'CHEAPEST', 'BALANCED'] as const) {
    const expected = scoreJourneys(production.itineraries.map((journey) => ({
      id: journey.id, durationSeconds: journey.durationSeconds,
      priceMinor: journey.fare?.currency === 'UAH' ? journey.fare.priceMinor : null,
      transfers: journey.transfers, walkingMeters: journey.walkingMeters, reliability: null,
      transferRisk: journey.transfers > 0 ? 0.3 : 0, comfort: null,
      legs: journey.segments.map((segment) => ({ mode: segment.mode })),
    })), strategy)[0]?.journey.id ?? null;
    assert.equal(lazy.winners[strategy], expected, `${strategy} winner agrees for the exact request shape`);
  }

  const transferFeed = connectingFeed({ secondDeparture: '08:35:00' });
  transferFeed.fareProducts = new Map([
    ['fare-bus', { id: 'fare-bus', priceMinor: 250, currency: 'UAH', transfers: 1, transferDurationSeconds: 3600 }],
    ['fare-rail', { id: 'fare-rail', priceMinor: 180, currency: 'UAH', transfers: null, transferDurationSeconds: null }],
  ]);
  transferFeed.fareRules = new Map([
    ['fare-bus', [{ fareId: 'fare-bus', routeId: 'bus' }]],
    ['fare-rail', [{ fareId: 'fare-rail', routeId: 'rail' }]],
  ]);
  const transferQuery = { ...query, origin: [24.0201, 49.8401] as [number, number],
    destination: [24.0301, 49.8501] as [number, number], maximumTransfers: 1 };
  const transferProduction = findGtfsItinerariesWithStats(transferFeed, transferQuery);
  const transferLazy = lazyEventLabelSearchForRequest(transferFeed, transferQuery);
  const transferProductionById = new Map(transferProduction.itineraries.map((journey) => [journey.id, journey]));
  const transferLazyById = new Map(transferLazy.itineraries.map((journey) => [journey.id, journey]));
  assert.equal(transferProduction.searchTruncated, false);
  assert.equal(transferLazy.searchTruncated, false);
  assert.deepEqual([...transferLazyById.keys()].sort(), [...transferProductionById.keys()].sort(),
    'graph-relative traversal preserves feasible transfer and response-sampling identities');
  for (const [id, expected] of transferProductionById) {
    const actual = transferLazyById.get(id)!;
    assert.deepEqual({ arrival: actual.arrivalAt.getTime(), duration: actual.durationSeconds,
      waiting: actual.waitingSeconds, transfers: actual.transfers, walking: actual.walkingMeters,
      transferMeters: actual.transferWalkingMeters, transferSeconds: actual.transferWalkingSeconds,
      inSeat: actual.transferInSeat, minimumBuffers: actual.transferMinimumBufferSeconds,
      ruleMinimums: actual.transferRuleMinimumSeconds, fare: actual.fare }, {
      arrival: expected.arrivalAt.getTime(), duration: expected.durationSeconds,
      waiting: expected.waitingSeconds, transfers: expected.transfers, walking: expected.walkingMeters,
      transferMeters: expected.transferWalkingMeters, transferSeconds: expected.transferWalkingSeconds,
      inSeat: expected.transferInSeat, minimumBuffers: expected.transferMinimumBufferSeconds,
      ruleMinimums: expected.transferRuleMinimumSeconds, fare: expected.fare,
    }, `production transfer metadata and total costs match for ${id}`);
  }
  for (const strategy of ['FASTEST', 'CHEAPEST', 'BALANCED'] as const) {
    const expectedWinner = scoreJourneys(transferProduction.itineraries.map((journey) => ({
      id: journey.id, durationSeconds: journey.durationSeconds,
      priceMinor: journey.fare?.currency === 'UAH' ? journey.fare.priceMinor : null,
      transfers: journey.transfers, walkingMeters: journey.walkingMeters, reliability: null,
      transferRisk: journey.transfers > 0 ? 0.3 : 0, comfort: null,
      legs: journey.segments.map((segment) => ({ mode: segment.mode })),
    })), strategy)[0]?.journey.id ?? null;
    assert.equal(transferLazy.winners[strategy], expectedWinner, `${strategy} transfer winner agrees`);
  }

  let transferGraph: GtfsCandidateGraphSnapshot | undefined;
  const observedTransferProduction = findGtfsItinerariesWithStats(transferFeed, transferQuery, {}, (snapshot) => { transferGraph = snapshot; });
  assert.deepEqual(observedTransferProduction, transferProduction, 'capturing a transfer graph is observational');
  assert.ok(transferGraph);
  const segmentById = new Map(transferGraph.segments.map(({ id, journey }) => [id, journey] as const));
  const busFirstLeg = transferGraph.firstLegIds.find((id) => segmentById.get(id)?.tripId === 'b1');
  assert.ok(busFirstLeg, 'the captured graph contains the scheduled first bus leg');
  const expectedOnwardLegs = transferGraph.segments.filter(({ journey }) => journey.tripId === 'r1'
    && journey.originStop.id === 'hub' && journey.destinationStop.id === 'finish').map(({ id }) => id);
  assert.deepEqual(transferGraph.successors(busFirstLeg, 1), expectedOnwardLegs,
    'successor enumeration is the exact production transfer candidate view');
  assert.ok(expectedOnwardLegs.length > 0);
  assert.equal(transferGraph.transferDecision(busFirstLeg, expectedOnwardLegs[0]!).feasible, true,
    'successor feasibility delegates to the production transfer authority');

  const forbiddenFeed = connectingFeed({ transferType: '3', secondDeparture: '08:35:00' });
  const forbiddenProduction = findGtfsItinerariesWithStats(forbiddenFeed, transferQuery);
  const forbiddenLazy = lazyEventLabelSearchForRequest(forbiddenFeed, transferQuery);
  assert.deepEqual(forbiddenLazy.itineraries.map(({ id }) => id).sort(), forbiddenProduction.itineraries.map(({ id }) => id).sort(),
    'graph-relative traversal agrees for forbidden transfers');
  assert.equal(forbiddenLazy.itineraries.some(({ segments }) => segments.length > 1), false,
    'GTFS transfer_type=3 stays forbidden');
  const forbiddenBoardingLabels = lazyEventLabelSearch(forbiddenFeed, {
    originStopIds: ['start'], destinationStopIds: ['finish'], serviceDates: ['20261012'],
    earliestDeparture: transferQuery.earliestDeparture, latestDeparture: transferQuery.latestDeparture,
    maximumJourneySeconds: 6 * 60 * 60, maximumTransfers: 1, maximumWaitSeconds: 4 * 60 * 60,
    transferRadiusMeters: transferQuery.maximumTransferWalkingMeters!,
    minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
    providerId: 'p1', providerName: 'Test Transit',
  });
  assert.equal(forbiddenBoardingLabels.materializedBoardingExpansions, 1,
    'a forbidden transfer is rejected from its boarding event before downstream stop-pair legs are materialized');

  const inSeatFeed = connectingFeed({ sameRoute: true, transferType: '4', inSeat: true, secondDeparture: '08:35:00' });
  const inSeatProduction = findGtfsItinerariesWithStats(inSeatFeed, transferQuery);
  const inSeatLazy = lazyEventLabelSearchForRequest(inSeatFeed, transferQuery);
  assert.deepEqual(inSeatLazy.itineraries.map(({ id }) => id).sort(), inSeatProduction.itineraries.map(({ id }) => id).sort(),
    'graph-relative traversal agrees for explicit in-seat transfers');
  assert.ok(inSeatLazy.itineraries.some(({ segments, transferInSeat }) => segments.length === 2 && transferInSeat[0] === true),
    'GTFS transfer_type=4 remains traversable');

  const shortWaitQuery = { ...transferQuery, maximumWaitSeconds: 5 * 60 };
  const shortWaitProduction = findGtfsItinerariesWithStats(transferFeed, shortWaitQuery);
  const shortWaitLazy = lazyEventLabelSearchForRequest(transferFeed, shortWaitQuery);
  assert.deepEqual(shortWaitLazy.itineraries.map(({ id }) => id).sort(), shortWaitProduction.itineraries.map(({ id }) => id).sort(),
    'graph-relative traversal applies the production maximum-wait rule');
});

test('matches a deterministic exhaustive oracle for pathways, transfer rules, loops, and realtime overlays', () => {
  const query = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:12:00Z'),
    maximumAccessWalkingMeters: 300, maximumEgressWalkingMeters: 300,
    maximumTransferWalkingMeters: 500, maximumTransfers: 1,
  };
  const signature = (journey: GtfsItinerary) => journey.segments.map((segment) =>
    `${segment.tripId}:${segment.originStop.id}@${segment.departureAt.getTime()}>${segment.destinationStop.id}@${segment.arrivalAt.getTime()}`).join('|');
  const assertMatchesOracle = (timetable: GtfsTimetableFeed, label: string) => {
    const expected = exhaustiveOneTransferOracle(timetable, {
      originStopId: 'start', destinationStopId: 'finish',
      earliestDeparture: query.earliestDeparture, latestDeparture: query.latestDeparture,
      maximumTransferWalkingMeters: query.maximumTransferWalkingMeters,
    });
    const lazyLabels = lazyEventLabelSearch(timetable, {
      originStopIds: ['start'], destinationStopIds: ['finish'], serviceDates: ['20261012'],
      earliestDeparture: query.earliestDeparture, latestDeparture: query.latestDeparture,
      maximumJourneySeconds: 6 * 60 * 60, maximumTransfers: query.maximumTransfers,
      maximumWaitSeconds: 4 * 60 * 60, transferRadiusMeters: query.maximumTransferWalkingMeters,
      minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS, providerId: 'p1', providerName: 'Test Transit',
    });
    assert.equal(lazyLabels.searchTruncated, false, `${label}: small-feed event-label budget remains complete`);
    const lazySegmentIdentities = new Set([...lazyLabels.identities.values()].map((entry) => entry.segmentIdentities.join('|')));
    assert.deepEqual([...lazySegmentIdentities].sort(), [...expected].sort(),
      `${label}: independent lazy labels equal the brute-force trip-pair identity oracle`);
    const prototype = queryDirectedEventIndexPrototype(timetable, {
      originStopId: 'start', destinationStopId: 'finish',
      earliestDeparture: query.earliestDeparture, latestDeparture: query.latestDeparture,
      maximumTransferWalkingMeters: query.maximumTransferWalkingMeters, maximumTransfers: query.maximumTransfers,
    });
    const exactTransferValidation = validateEventIndexCandidatesWithProductionTransfers(timetable, {
      candidatePaths: prototype.candidatePaths, transferRadius: query.maximumTransferWalkingMeters,
      minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
    });
    assert.deepEqual([...expected].filter((identity) => !prototype.candidatePaths.has(identity)), [],
      `${label}: lazy event index must retain every exhaustive feasible identity`);
    assert.deepEqual([...expected].filter((identity) => !exactTransferValidation.feasiblePaths.has(identity)), [],
      `${label}: shared production transfer authority must accept every exhaustive feasible event chain`);
    assert.deepEqual([...exactTransferValidation.feasiblePaths].filter((identity) => expected.has(identity)).sort(),
      [...expected].sort(), `${label}: exact transfer validation preserves the exhaustive identity set`);

    // Give only the trip instances the query-directed index selected to the
    // unchanged production router. Its exact transferDecision and lifecycle
    // logic validates the candidates; this does not call a prototype validator.
    const candidateFeed = structuredClone(timetable);
    candidateFeed.trips = new Map([...candidateFeed.trips].filter(([tripId]) => prototype.candidateTripIds.has(tripId)));
    const retainedRouteIds = new Set([...candidateFeed.trips.values()].map((trip) => trip.routeId));
    candidateFeed.routes = new Map([...candidateFeed.routes].filter(([routeId]) => retainedRouteIds.has(routeId)));
    candidateFeed.stopTimes = new Map([...candidateFeed.stopTimes].filter(([tripId]) => prototype.candidateTripIds.has(tripId)));
    candidateFeed.stopTimesByStop = new Map();
    for (const [tripId, stopTimes] of candidateFeed.stopTimes) stopTimes.forEach((stopTime, index) => {
      candidateFeed.stopTimesByStop.set(stopTime.stopId, [
        ...(candidateFeed.stopTimesByStop.get(stopTime.stopId) ?? []), { tripId, index },
      ]);
    });
    if (candidateFeed.realtimeTripUpdates) candidateFeed.realtimeTripUpdates = new Map(
      [...candidateFeed.realtimeTripUpdates].filter(([key]) => [...prototype.candidateTripIds]
        .some((tripId) => key.startsWith(`${tripId}\u0000`))));

    const result = findGtfsItinerariesWithStats(timetable, query);
    assert.equal(result.searchTruncated, false, `${label}: tiny fixture must fit all production bounds`);
    const actual = new Set(result.itineraries.filter((journey) => journey.segments.length === 2).map(signature));
    assert.deepEqual([...actual].sort(), [...expected].sort(), `${label}: production result set equals full event-pair enumeration`);

    const indexedResult = findGtfsItinerariesWithStats(candidateFeed, query);
    assert.equal(indexedResult.searchTruncated, false, `${label}: indexed fixture must fit all production bounds`);
    const indexedActual = new Set(indexedResult.itineraries.filter((journey) => journey.segments.length === 2)
      .map(signature).filter((identity) => prototype.candidatePaths.has(identity)));
    assert.deepEqual([...indexedActual].sort(), [...expected].sort(),
      `${label}: unchanged production feasibility over index candidates equals exhaustive event oracle`);
    return expected;
  };

  const pathwayOnly = platformTransferFeed('08:40:00');
  const pathwayExpected = assertMatchesOracle(pathwayOnly, 'explicit pathway-only platform transfer');
  assert.equal(pathwayExpected.size, 1);

  const forbiddenPlatform = platformTransferFeed('08:40:00');
  forbiddenPlatform.transfers = [{ fromStopId: 'shared-station', toStopId: 'shared-station', transferType: 3 }];
  assert.equal(assertMatchesOracle(forbiddenPlatform, 'station-level forbidden platform transfer').size, 0);

  const minimumPlatform = platformTransferFeed('08:45:00');
  minimumPlatform.transfers = [{ fromStopId: 'shared-station', toStopId: 'shared-station', transferType: 2,
    minTransferTimeSeconds: 1_500 }];
  assert.equal(assertMatchesOracle(minimumPlatform, 'station-level minimum transfer time met').size, 1);
  const tooShortPlatform = platformTransferFeed('08:40:00');
  tooShortPlatform.transfers = [{ fromStopId: 'shared-station', toStopId: 'shared-station', transferType: 2,
    minTransferTimeSeconds: 1_500 }];
  assert.equal(assertMatchesOracle(tooShortPlatform, 'station-level minimum transfer time missed').size, 0);

  const loop = connectingFeed({ secondRouteType: '3', secondDeparture: '08:20:00' });
  loop.stops.set('via-loop', { id: 'via-loop', name: 'Loop stop', lon: 24.035, lat: 49.8475 });
  loop.stopTimes.set('b1', [
    { stopId: 'start', sequence: 1, arrivalSeconds: 8 * 3600, departureSeconds: 8 * 3600, pickupType: 0, dropOffType: 0 },
    { stopId: 'hub', sequence: 2, arrivalSeconds: 8 * 3600 + 7 * 60, departureSeconds: 8 * 3600 + 7 * 60, pickupType: 0, dropOffType: 1 },
    { stopId: 'via-loop', sequence: 3, arrivalSeconds: 8 * 3600 + 11 * 60, departureSeconds: 8 * 3600 + 11 * 60, pickupType: 0, dropOffType: 0 },
    { stopId: 'hub', sequence: 4, arrivalSeconds: 8 * 3600 + 17 * 60, departureSeconds: 8 * 3600 + 17 * 60, pickupType: 0, dropOffType: 0 },
  ]);
  loop.stopTimesByStop = new Map();
  for (const [tripId, entries] of loop.stopTimes) entries.forEach((entry, index) => loop.stopTimesByStop.set(entry.stopId,
    [...(loop.stopTimesByStop.get(entry.stopId) ?? []), { tripId, index }]));
  const loopExpected = assertMatchesOracle(loop, 'loop trip with first hub occurrence not alightable');
  assert.equal(loopExpected.size, 1);
  assert.ok([...loopExpected][0]?.includes(`hub@${Date.parse('2026-10-12T05:17:00.000Z')}`),
    'the exhaustive event oracle retains the later alight occurrence after the earlier one is pickup/drop-off restricted');

  const sameRouteInSeat = connectingFeed({ secondDeparture: '08:21:00', transferType: '4', inSeat: true, sameRoute: true });
  const inSeatExpected = assertMatchesOracle(sameRouteInSeat, 'same-route explicit type-4 continuation');
  assert.equal(inSeatExpected.size, 1);
  const inSeatActual = findGtfsItineraries(sameRouteInSeat, query).find((journey) => journey.segments.length === 2);
  assert.ok(inSeatActual);
  assert.equal(inSeatActual.transfers, 0, 'type-4 remains an in-seat continuation, not a passenger transfer');

  const skippedArrival = connectingFeed({ secondRouteType: '3', secondDeparture: '08:40:00' });
  skippedArrival.realtimeTripUpdates = new Map([['b1\u000020261012', {
    tripId: 'b1', startDate: '20261012', relationship: 'SCHEDULED',
    stops: [{ stopSequence: 2, relationship: 'SKIPPED' }],
    updatedAt: new Date('2026-10-12T04:59:00Z'), feedTimestamp: new Date('2026-10-12T04:59:00Z'),
  }]]);
  assert.equal(assertMatchesOracle(skippedArrival, 'realtime skipped transfer stop').size, 0);

  const cancelledFirstTrip = connectingFeed({ secondRouteType: '3', secondDeparture: '08:40:00' });
  cancelledFirstTrip.realtimeTripUpdates = new Map([['b1\u000020261012', {
    tripId: 'b1', startDate: '20261012', relationship: 'CANCELED', stops: [],
    updatedAt: new Date('2026-10-12T04:59:00Z'), feedTimestamp: new Date('2026-10-12T04:59:00Z'),
  }]]);
  assert.equal(assertMatchesOracle(cancelledFirstTrip, 'realtime canceled first trip').size, 0);

  const delayedConnection = connectingFeed({ secondRouteType: '3', secondDeparture: '08:25:00' });
  delayedConnection.realtimeTripUpdates = new Map([['b1\u000020261012', {
    tripId: 'b1', startDate: '20261012', relationship: 'SCHEDULED',
    stops: [{ stopSequence: 2, relationship: 'SCHEDULED', arrival: { delaySeconds: 180 } }],
    updatedAt: new Date('2026-10-12T04:59:00Z'), feedTimestamp: new Date('2026-10-12T04:59:00Z'),
  }]]);
  assert.equal(assertMatchesOracle(delayedConnection, 'realtime delay makes the transfer infeasible').size, 0);
});

test('test-only event index materializes legs only for query-relevant stops', () => {
  const timetable = connectingFeed();
  const route = timetable.routes.get('bus');
  assert.ok(route);
  timetable.routes.set('noise', { ...route, name: 'Remote service' });
  let exhaustivePairCount = 0;
  for (let tripIndex = 0; tripIndex < 100; tripIndex++) {
    const tripId = `remote-trip-${tripIndex}`;
    timetable.trips.set(tripId, { routeId: 'noise', serviceId: 'weekday', headsign: 'Remote terminal' });
    const stopTimes = Array.from({ length: 10 }, (_, stopIndex) => {
      const stopId = `${tripId}-stop-${stopIndex}`;
      timetable.stops.set(stopId, { id: stopId, name: stopId, lon: 25 + tripIndex * 0.0001, lat: 49.84 + stopIndex * 0.0001 });
      const seconds = 8 * 3600 + tripIndex * 60 + stopIndex * 60;
      return { stopId, sequence: stopIndex + 1, arrivalSeconds: seconds, departureSeconds: seconds,
        pickupType: 0, dropOffType: 0 };
    });
    timetable.stopTimes.set(tripId, stopTimes);
    exhaustivePairCount += stopTimes.length * (stopTimes.length - 1) / 2;
  }
  timetable.stopTimesByStop = new Map();
  for (const [tripId, stopTimes] of timetable.stopTimes) stopTimes.forEach((stopTime, index) => {
    timetable.stopTimesByStop.set(stopTime.stopId, [
      ...(timetable.stopTimesByStop.get(stopTime.stopId) ?? []), { tripId, index },
    ]);
  });

  const query = {
    ...request('2026-10-12T04:55:00Z', '2026-10-12T05:12:00Z'),
    maximumAccessWalkingMeters: 300, maximumEgressWalkingMeters: 300,
    maximumTransferWalkingMeters: 500, maximumTransfers: 1,
  };
  const prototype = queryDirectedEventIndexPrototype(timetable, {
    originStopId: 'start', destinationStopId: 'finish',
    earliestDeparture: query.earliestDeparture, latestDeparture: query.latestDeparture,
    maximumTransferWalkingMeters: query.maximumTransferWalkingMeters, maximumTransfers: query.maximumTransfers,
  });
  const exhaustive = exhaustiveOneTransferOracle(timetable, {
    originStopId: 'start', destinationStopId: 'finish',
    earliestDeparture: query.earliestDeparture, latestDeparture: query.latestDeparture,
    maximumTransferWalkingMeters: query.maximumTransferWalkingMeters,
  });
  assert.deepEqual([...exhaustive].filter((identity) => !prototype.candidatePaths.has(identity)), []);
  assert.equal(exhaustive.size, 1);
  assert.equal(prototype.indexedBoardingEvents, 1_004,
    'the event index retains all 1,000 remote departures plus four local events');
  assert.equal(prototype.materializedLegs, 2,
    'only the two query-corridor legs are materialized');
  assert.ok(prototype.materializedLegs < exhaustivePairCount / 100,
    `lazy legs (${prototype.materializedLegs}) stay far below exhaustive pairs (${exhaustivePairCount})`);
});

test('honors GTFS forbidden and minimum-time transfer rules', () => {
  const query = { ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumStopDistanceMeters: 300, maximumTransfers: 1 };
  const forbiddenFeed = connectingFeed({ secondRouteType: '3', secondDeparture: '08:40:00', transferType: '3' });
  assert.equal(forbiddenFeed.transfers?.[0]?.transferType, 3, 'the optional transfers.txt file is parsed');
  assert.equal(findGtfsItineraries(forbiddenFeed, query).length, 0, 'a prohibited connection is never composed');

  const constrainedFeed = connectingFeed({ secondRouteType: '3', secondDeparture: '08:40:00', transferType: '2', minimumTransferTime: '900' });
  const matchingTransferRules = constrainedFeed.transfers ?? [];
  constrainedFeed.transfers = [
    ...Array.from({ length: 2_000 }, (_, index) => ({
      fromStopId: `unrelated-from-${index}`,
      toStopId: `unrelated-to-${index}`,
      transferType: 2,
      minTransferTimeSeconds: 900,
    })),
    ...matchingTransferRules,
  ];
  assert.equal(constrainedFeed.transfers?.find((rule) => rule.fromStopId === 'hub')?.minTransferTimeSeconds, 900);
  const constrainedJourney = findGtfsItineraries(constrainedFeed, query)
    .find((journey) => journey.segments.length === 2);
  assert.ok(constrainedJourney, 'an indexed relevant rule still composes through many unrelated rules');
  assert.deepEqual(constrainedJourney.transferRuleMinimumSeconds, [900]);
  const tooShort = connectingFeed({ secondRouteType: '3', secondDeparture: '08:30:00', transferType: '2', minimumTransferTime: '900' });
  assert.equal(findGtfsItineraries(tooShort, query).length, 0, 'min_transfer_time is a hard feasibility constraint');
});

test('the extracted transfer decision matches public router feasibility for type 2, 3, and 4 rules', () => {
  const query = { ...request('2026-10-12T04:55:00Z', '2026-10-12T05:30:00Z'), maximumStopDistanceMeters: 300,
    maximumTransferWalkingMeters: 500, maximumTransfers: 1 };
  const compare = (timetable: GtfsTimetableFeed, expected: boolean, expectedInSeat = false) => {
    const departureSeconds = timetable.stopTimes.get('r1')?.[0]?.departureSeconds ?? 8 * 3600;
    const nextDeparture = new Date(Date.UTC(2026, 9, 12) + (departureSeconds - 3 * 3600) * 1000);
    const previous = {
      providerId: 'p1', routeId: 'bus', tripId: 'b1', transportType: 'bus',
      destinationStop: { id: 'hub', name: 'Transfer hub', coordinates: [24.025, 49.845] as [number, number] },
      destinationTransferNodeIds: ['hub'], arrivalAt: new Date('2026-10-12T05:20:00Z'),
    } as unknown as GtfsDirectJourney;
    const next = {
      providerId: 'p1', routeId: timetable.trips.get('r1')?.routeId ?? 'rail', tripId: 'r1', transportType: 'bus',
      originStop: { id: 'hub', name: 'Transfer hub', coordinates: [24.025, 49.845] as [number, number] },
      originTransferNodeIds: ['hub'], departureAt: nextDeparture,
    } as unknown as GtfsDirectJourney;
    const context = createGtfsTransferDecisionContext({
      feed: timetable,
      transferRadius: query.maximumTransferWalkingMeters ?? DEFAULT_MAX_TRANSFER_WALKING_METERS,
      minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
    });
    const decision = context.decide(previous, next);
    assert.equal(decision.feasible, expected);
    assert.equal(decision.measure.inSeat, expectedInSeat);
    const publicChain = findGtfsItineraries(timetable, query).find((journey) => journey.segments.length === 2);
    assert.equal(Boolean(publicChain), expected, 'production router agrees with the extracted authority');
    if (publicChain) {
      assert.equal(publicChain.transferInSeat[0], expectedInSeat);
      assert.equal(publicChain.transferRuleMinimumSeconds[0], decision.ruleMinimumSeconds);
      assert.equal(publicChain.transferWalkingSeconds[0], decision.measure.walkingSeconds);
    }
  };

  compare(connectingFeed({ secondRouteType: '3', secondDeparture: '08:40:00', transferType: '2', minimumTransferTime: '900' }), true);
  compare(connectingFeed({ secondRouteType: '3', secondDeparture: '08:30:00', transferType: '2', minimumTransferTime: '900' }), false);
  compare(connectingFeed({ secondRouteType: '3', secondDeparture: '08:40:00', transferType: '3' }), false);
  compare(connectingFeed({ secondRouteType: '3', secondDeparture: '08:21:00', transferType: '4', inSeat: true }), true, true);

  const platformQuery = { ...query, maximumTransferWalkingMeters: 500 };
  const platformFeed = mergeGtfsTimetables([{ providerId: 'city', providerName: 'City transit', providerCity: 'Львів',
    feed: platformTransferFeed('08:40:00') }])!;
  const platformContext = createGtfsTransferDecisionContext({ feed: platformFeed,
    transferRadius: platformQuery.maximumTransferWalkingMeters, minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS });
  const platformPrevious = {
    providerId: 'city', routeId: 'bus', tripId: 'b1', transportType: 'bus',
    destinationStop: { id: 'city:bus-platform', name: 'Transfer station', coordinates: [24.025, 49.845] as [number, number] },
    destinationTransferNodeIds: ['city:bus-platform'], arrivalAt: new Date('2026-10-12T05:20:00Z'),
  } as unknown as GtfsDirectJourney;
  const platformNext = {
    providerId: 'city', routeId: 'rail', tripId: 'r1', transportType: 'bus',
    originStop: { id: 'city:rail-platform', name: 'Transfer station', coordinates: [24.02505, 49.845] as [number, number] },
    originTransferNodeIds: ['city:rail-platform'], departureAt: new Date('2026-10-12T05:40:00Z'),
  } as unknown as GtfsDirectJourney;
  const platformDecision = platformContext.decide(platformPrevious, platformNext);
  const platformChain = findGtfsItineraries(platformFeed, platformQuery).find((journey) => journey.segments.length === 2);
  assert.ok(platformDecision.feasible && platformChain, 'the extracted pathway context and public router accept the same platform connection');
  assert.deepEqual(platformChain.transferWalkingMeters, [platformDecision.measure.walkingMeters]);
  assert.deepEqual(platformChain.transferWalkingSeconds, [platformDecision.measure.walkingSeconds]);
  assert.deepEqual(platformChain.transferWalkingGeometries[0], platformDecision.measure.geometry);
});

test('independent lazy event labels preserve service dates and repeated trip-call identity', () => {
  const timetable = connectingFeed({ secondRouteType: '3', secondDeparture: '08:40:00' });
  timetable.stops.set('loop-stop', { id: 'loop-stop', name: 'Loop stop', lon: 24.026, lat: 49.846 });
  timetable.stopTimes.set('b1', [
    { stopId: 'start', sequence: 1, arrivalSeconds: 8 * 3600, departureSeconds: 8 * 3600, pickupType: 0, dropOffType: 0 },
    { stopId: 'hub', sequence: 2, arrivalSeconds: 8 * 3600 + 10 * 60, departureSeconds: 8 * 3600 + 10 * 60, pickupType: 0, dropOffType: 1 },
    { stopId: 'loop-stop', sequence: 3, arrivalSeconds: 8 * 3600 + 15 * 60, departureSeconds: 8 * 3600 + 15 * 60, pickupType: 0, dropOffType: 0 },
    { stopId: 'hub', sequence: 4, arrivalSeconds: 8 * 3600 + 25 * 60, departureSeconds: 8 * 3600 + 25 * 60, pickupType: 0, dropOffType: 0 },
  ]);
  timetable.stopTimesByStop = new Map();
  for (const [tripId, stopTimes] of timetable.stopTimes) stopTimes.forEach((stopTime, index) => {
    timetable.stopTimesByStop.set(stopTime.stopId, [
      ...(timetable.stopTimesByStop.get(stopTime.stopId) ?? []), { tripId, index },
    ]);
  });
  const start = new Date('2026-10-12T04:55:00Z');
  const end = new Date('2026-10-19T05:12:00Z');
  const options = { originStopIds: ['start'], destinationStopIds: ['finish'],
    serviceDates: ['20261012', '20261019'], earliestDeparture: start, latestDeparture: end,
    maximumJourneySeconds: 7 * 24 * 60 * 60 + 60 * 60, maximumTransfers: 1, maximumWaitSeconds: 4 * 60 * 60,
    transferRadiusMeters: 100, minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
    providerId: 'p1', providerName: 'Test Transit' };
  const lazy = lazyEventLabelSearch(timetable, options);
  assert.equal(lazy.searchTruncated, false);
  const expected = new Set([
    'p1:20261012:b1:0:3:1791781200000:1791782700000|p1:20261012:r1:0:1:1791783600000:1791784800000',
    'p1:20261019:b1:0:3:1792386000000:1792387500000|p1:20261019:r1:0:1:1792388400000:1792389600000',
  ]);
  assert.deepEqual([...lazy.identities.keys()].sort(), [...expected].sort(),
    'the frontier keeps both distinct service instances and uses the later alight call in the loop trip');
  assert.ok([...lazy.identities.values()].every((entry) => entry.fareMinor === null),
    'unpublished fare remains unknown, not a zero-cost label');

  const lazyIdentities = new Set([...lazy.identities.values()].map((entry) => entry.serviceDates
    .map((serviceDate, index) => `${entry.tripIds[index]}:${serviceDate}`).join('>')));
  assert.deepEqual([...lazyIdentities].sort(), ['b1:20261012>r1:20261012', 'b1:20261019>r1:20261019']);

  const removedService = structuredClone(timetable);
  removedService.exceptions.set('weekday', new Map([['20261019', 2]]));
  const afterException = lazyEventLabelSearch(removedService, options);
  assert.deepEqual([...afterException.identities.values()].map((entry) => entry.serviceDates[0]).sort(), ['20261012'],
    'a calendar-date removal suppresses only that service-date instance');

  const afterMidnight = connectingFeed({ secondRouteType: '3', secondDeparture: '25:40:00' });
  afterMidnight.stopTimes.get('b1')![0]!.arrivalSeconds = 25 * 3600;
  afterMidnight.stopTimes.get('b1')![0]!.departureSeconds = 25 * 3600;
  afterMidnight.stopTimes.get('b1')![1]!.arrivalSeconds = 25 * 3600 + 20 * 60;
  afterMidnight.stopTimes.get('b1')![1]!.departureSeconds = 25 * 3600 + 20 * 60;
  afterMidnight.stopTimes.get('r1')![1]!.arrivalSeconds = 26 * 3600;
  afterMidnight.stopTimes.get('r1')![1]!.departureSeconds = 26 * 3600;
  const overnight = lazyEventLabelSearch(afterMidnight, {
    originStopIds: ['start'], destinationStopIds: ['finish'], serviceDates: ['20261012'],
    earliestDeparture: new Date('2026-10-12T21:55:00Z'), latestDeparture: new Date('2026-10-12T22:05:00Z'),
    maximumJourneySeconds: 2 * 60 * 60, maximumTransfers: 1, maximumWaitSeconds: 60 * 60,
    transferRadiusMeters: 100, minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
    providerId: 'p1', providerName: 'Test Transit',
  });
  assert.equal(overnight.identities.size, 1, 'GTFS service times beyond 24:00 remain on their originating service date');
  assert.ok([...overnight.identities.values()].every((entry) => entry.serviceDates.every((date) => date === '20261012')),
    `overnight labels preserve originating date: ${JSON.stringify([...overnight.identities.keys()])}`);

  const warsaw = structuredClone(timetable);
  warsaw.timezone = 'Europe/Warsaw';
  const warsawLabels = lazyEventLabelSearch(warsaw, {
    originStopIds: ['start'], destinationStopIds: ['finish'], serviceDates: ['20261012'],
    earliestDeparture: new Date('2026-10-12T05:55:00Z'), latestDeparture: new Date('2026-10-12T06:12:00Z'),
    maximumJourneySeconds: 2 * 60 * 60, maximumTransfers: 1, maximumWaitSeconds: 60 * 60,
    transferRadiusMeters: 100, minimumTransferBufferSeconds: DEFAULT_MINIMUM_TRANSFER_BUFFER_SECONDS,
    providerId: 'p1', providerName: 'Test Transit',
  });
  const warsawChain = [...warsawLabels.identities.values()].find((entry) => entry.tripIds.join('>') === 'b1>r1');
  assert.ok(warsawChain);
  assert.equal(warsawChain.segmentIdentities[0]?.match(/@(\d+)>/)?.[1], String(Date.parse('2026-10-12T06:00:00Z')),
    'service-date event projection honors the feed timezone offset');
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

  const sameRouteInSeat = connectingFeed({ secondDeparture: '08:21:00', transferType: '4', inSeat: true, sameRoute: true });
  const sameRouteJourney = findGtfsItineraries(sameRouteInSeat, query).find((journey) => journey.segments.length === 2);
  assert.ok(sameRouteJourney, 'an explicit in-seat continuation may use the same GTFS route');
  assert.equal(sameRouteJourney.transfers, 0);
  assert.deepEqual(sameRouteJourney.transferWalkingMeters, [0]);
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
  const capturedPathwaySearch = lazyEventLabelSearchForRequest(merged, query);
  assert.ok(capturedPathwaySearch.itineraries.some((journey) => journey.id === connected.id
    && journey.transferWalkingMeters[0] === 400 && journey.transferWalkingSeconds[0] === 360),
  'the graph-relative oracle traverses production pathway successors with the authoritative pathway measure');
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
  const capturedGraphSearch = lazyEventLabelSearchForRequest(merged,
    { ...options, providerId: 'merged', providerName: 'Merged providers', providerCity: 'Україна' });
  assert.deepEqual(capturedGraphSearch.itineraries.map(({ id }) => id).sort(), results.map(({ id }) => id).sort(),
    'the graph-relative oracle traverses the exact cross-provider candidate graph');
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
