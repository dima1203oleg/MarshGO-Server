import type { PoolClient } from 'pg';

// Route-interval seat inventory (Carpool 5.0 P0.1). Half-open [boarding, alighting).
// A whole-route booking spans [1, 32767); partial bookings use a strict subset.
// seat_occupancy_intervals is authoritative; offers.available_seats is a derived
// cache = total_seats - globalMaxOccupancy, maintained in the same transaction.
export const WHOLE_ROUTE_BOARDING = 1;
export const WHOLE_ROUTE_ALIGHTING = 32767;
export const MAX_PARTIAL_ALIGHTING = 32766;

// Route-bound ordinal validation (Carpool 5.0 P0.2, G10/G15). Ordinals are directed
// segment-occurrence numbers (spec VIII.4 / XXXIX.1): N route vertices ⇒ N−1 segments,
// so a partial interval is realizable only when 1 <= boarding < alighting <= N. An
// unrouted offer has no segment space and admits only the whole-route sentinel. The
// caller has already enforced the coarse abstract bound (1 <= boarding < alighting <=
// 32766); this refines it against the offer's actual geometry. Dependency-free for tests.
export function routeIntervalViolation(
  routePoints: number | null, alighting: number,
): { code: string; message: string } | null {
  if (routePoints === null) {
    return { code: 'ordinals_require_route', message: 'partial boarding/alighting ordinals require a routed offer; book the whole route instead' };
  }
  if (alighting > routePoints) {
    return { code: 'ordinal_out_of_route', message: `alightingOrdinal must not exceed the route point count (${routePoints}); ordinals are directed segment occurrences` };
  }
  return null;
}

const ACTIVE_INTERVAL = `(oi.state = 'CONFIRMED' OR (oi.state = 'HELD' AND oi.expires_at > now()))`;

// Occupancy is a step function that only rises at boarding ordinals, so its maximum
// over [boarding, alighting) occurs at the interval start or an existing boarding
// ordinal strictly inside the range. This avoids generate_series over the full
// 32766-segment whole-route space while staying exact.
export async function maxOccupancyOverInterval(
  client: PoolClient, offerId: string, boarding: number, alighting: number,
): Promise<number> {
  const { rows } = await client.query<{ max_occ: number | null }>(
    `WITH points AS (
       SELECT $2::smallint AS ord
       UNION
       SELECT oi.boarding_ordinal
         FROM seat_occupancy_intervals oi
        WHERE oi.offer_id = $1 AND oi.boarding_ordinal > $2 AND oi.boarding_ordinal < $3
          AND ${ACTIVE_INTERVAL}
     ), occ AS (
       SELECT p.ord, COALESCE(SUM(oi.seat_count), 0) AS seats
         FROM points p
         LEFT JOIN seat_occupancy_intervals oi
           ON oi.offer_id = $1 AND oi.boarding_ordinal <= p.ord AND oi.alighting_ordinal > p.ord
          AND ${ACTIVE_INTERVAL}
        GROUP BY p.ord
     )
     SELECT COALESCE(MAX(seats), 0)::int AS max_occ FROM occ`,
    [offerId, boarding, alighting],
  );
  return Number(rows[0]?.max_occ ?? 0);
}

export async function globalMaxOccupancy(client: PoolClient, offerId: string): Promise<number> {
  const { rows } = await client.query<{ max_occ: number | null }>(
    `WITH points AS (
       SELECT DISTINCT oi.boarding_ordinal AS ord
         FROM seat_occupancy_intervals oi
        WHERE oi.offer_id = $1 AND ${ACTIVE_INTERVAL}
     ), occ AS (
       SELECT p.ord, COALESCE(SUM(oi.seat_count), 0) AS seats
         FROM points p
         LEFT JOIN seat_occupancy_intervals oi
           ON oi.offer_id = $1 AND oi.boarding_ordinal <= p.ord AND oi.alighting_ordinal > p.ord
          AND ${ACTIVE_INTERVAL}
        GROUP BY p.ord
     )
     SELECT COALESCE(MAX(seats), 0)::int AS max_occ FROM occ`,
    [offerId],
  );
  return Number(rows[0]?.max_occ ?? 0);
}

export async function recordOccupancy(
  client: PoolClient,
  interval: { offerId: string; bookingId: string; boarding: number; alighting: number; seats: number },
): Promise<void> {
  await client.query(
    `INSERT INTO seat_occupancy_intervals(offer_id, booking_id, boarding_ordinal, alighting_ordinal, seat_count, state)
     VALUES ($1, $2, $3, $4, $5, 'CONFIRMED')`,
    [interval.offerId, interval.bookingId, interval.boarding, interval.alighting, interval.seats],
  );
}

export async function releaseOccupancy(client: PoolClient, bookingId: string): Promise<void> {
  await client.query(
    "UPDATE seat_occupancy_intervals SET state = 'RELEASED' WHERE booking_id = $1 AND state IN ('CONFIRMED', 'HELD')",
    [bookingId],
  );
}

export async function releaseOfferOccupancy(client: PoolClient, offerId: string): Promise<void> {
  await client.query(
    "UPDATE seat_occupancy_intervals SET state = 'RELEASED' WHERE offer_id = $1 AND state IN ('CONFIRMED', 'HELD')",
    [offerId],
  );
}

// Recompute the derived available_seats cache from authoritative intervals and bump
// the inventory version. Caller must already hold the offer row FOR UPDATE.
export async function refreshAvailableSeats(client: PoolClient, offerId: string): Promise<number> {
  const occupancy = await globalMaxOccupancy(client, offerId);
  const { rows } = await client.query<{ available_seats: number }>(
    `UPDATE offers SET available_seats = GREATEST(0, total_seats - $2), inventory_version = inventory_version + 1
      WHERE id = $1 RETURNING available_seats`,
    [offerId, occupancy],
  );
  return Number(rows[0]?.available_seats ?? 0);
}