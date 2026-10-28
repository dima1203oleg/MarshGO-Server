import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findGtfsItinerariesWithStats,
  mergeGtfsTimetableSourcesByTimezone,
  parseGtfsTimetable,
  type GtfsTimetableSource,
} from '../server/journey/gtfsTimetable';
import { projectScheduledGtfsCandidatePool } from '../server/journey/scheduledGtfsCandidatePool';
import { scoreJourneys } from '../server/journey/scoring';

const date = '20261028';

function timeOfDay(totalMinutes: number): string {
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours}:${minutes}:00`;
}

function source(providerId: string, timezone: string, trips: Array<{ departure: string; arrival: string }>): GtfsTimetableSource {
  const routeRows = trips.map((_, index) => `route-${providerId}-${index},agency,${index + 1},Test bus ${index + 1},3`).join('\n');
  const tripRows = trips.map((_, index) => `route-${providerId}-${index},weekday,${providerId}-trip-${index},Destination`).join('\n');
  const stopTimeRows = trips.flatMap((trip, index) => [
    `${providerId}-trip-${index},${trip.departure},${trip.departure},origin,1,0,0`,
    `${providerId}-trip-${index},${trip.arrival},${trip.arrival},destination,2,0,0`,
  ]).join('\n');
  const files: Record<string, Uint8Array> = {
    'agency.txt': new TextEncoder().encode(`agency_id,agency_name,agency_url,agency_timezone\nagency,Test,https://example.test,${timezone}`),
    'routes.txt': new TextEncoder().encode(`route_id,agency_id,route_short_name,route_long_name,route_type\n${routeRows}`),
    'stops.txt': new TextEncoder().encode([
      'stop_id,stop_name,stop_lat,stop_lon',
      'origin,Origin stop,49.8400,24.0200',
      'destination,Destination stop,49.8500,24.0300',
    ].join('\n')),
    'trips.txt': new TextEncoder().encode(`route_id,service_id,trip_id,trip_headsign\n${tripRows}`),
    'stop_times.txt': new TextEncoder().encode([
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type',
      stopTimeRows,
    ].join('\n')),
    'calendar.txt': new TextEncoder().encode(`service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nweekday,0,0,1,0,0,0,0,${date},${date}`),
  };
  const feed = parseGtfsTimetable(files, new Date('2026-10-28T05:00:00Z'));
  return { providerId, providerName: providerId, providerCity: 'Test', feed };
}

describe('scheduled GTFS timezone aggregation and pool', () => {
  it('searches each timezone group in local service time and preserves the complete-search FASTEST winner', () => {
    const kyiv = source('provider-ua', 'Europe/Kyiv', Array.from({ length: 60 }, (_, index) => {
      const departureMinutes = 8 * 60 + index;
      return { departure: timeOfDay(departureMinutes), arrival: timeOfDay(departureMinutes + 40) };
    }));
    const warsawTrips = Array.from({ length: 60 }, (_, index) => {
      const departureMinutes = 7 * 60 + 30 + index;
      return { departure: timeOfDay(departureMinutes), arrival: timeOfDay(departureMinutes + 60) };
    });
    warsawTrips.push({ departure: '09:15:00', arrival: '09:25:00' });
    const warsaw = source('provider-pl', 'Europe/Warsaw', warsawTrips);
    const groups = mergeGtfsTimetableSourcesByTimezone([kyiv, warsaw]);

    assert.deepEqual(groups.map(({ feed }) => feed.timezone), ['Europe/Kyiv', 'Europe/Warsaw']);
    assert.deepEqual(groups.map(({ sources }) => sources.map(({ providerId }) => providerId)), [['provider-ua'], ['provider-pl']]);

    const rawCandidates = groups.flatMap(({ sources, feed }) => {
      const firstSource = sources[0]!;
      return findGtfsItinerariesWithStats(feed, {
        providerId: firstSource.providerId,
        providerName: firstSource.providerName,
        origin: [24.02, 49.84],
        destination: [24.03, 49.85],
        earliestDeparture: new Date('2026-10-28T06:00:00Z'),
        latestDeparture: new Date('2026-10-28T09:00:00Z'),
        now: new Date('2026-10-28T05:30:00Z'),
        maximumJourneySeconds: 4 * 60 * 60,
        maximumTransfers: 0,
        maximumWaitSeconds: 4 * 60 * 60,
        maximumAccessWalkingMeters: 900,
        maximumEgressWalkingMeters: 1000,
        maximumTransferWalkingMeters: 400,
        limit: 100,
        allowedModes: ['BUS'],
      }).itineraries;
    });
    const pool = projectScheduledGtfsCandidatePool(rawCandidates, 100, ['BALANCED', 'FASTEST', 'CHEAPEST']);
    const complete = projectScheduledGtfsCandidatePool(rawCandidates, rawCandidates.length, ['BALANCED', 'FASTEST', 'CHEAPEST']);

    assert.equal(rawCandidates.length, 121);
    assert.equal(pool.truncated, true);
    assert.equal(pool.candidates.length, 100);
    assert.equal(pool.hasUnknownFare, true);

    const kyivMorning = complete.candidates.find(({ itinerary }) => itinerary.id.includes('provider-ua-trip-0'));
    const warsawMorning = complete.candidates.find(({ itinerary }) => itinerary.id.includes('provider-pl-trip-0'));
    assert.equal(kyivMorning?.itinerary.segments[0]?.departureAt.toISOString(), '2026-10-28T06:00:00.000Z');
    assert.equal(warsawMorning?.itinerary.segments[0]?.departureAt.toISOString(), '2026-10-28T06:30:00.000Z');

    const fullFastest = scoreJourneys(complete.candidates, 'FASTEST')[0]?.journey;
    assert.ok(fullFastest);
    assert.equal(scoreJourneys(pool.candidates, 'FASTEST')[0]?.journey.id, fullFastest.id);
  });
});
