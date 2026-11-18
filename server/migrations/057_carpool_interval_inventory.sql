-- Carpool 5.0 P0.1: route-interval seat inventory + immutable fare basis snapshot.
-- Additive only: existing offers.available_seats / bookings contracts are preserved.
-- seat_occupancy_intervals becomes the authoritative inventory; offers.available_seats
-- is maintained as a derived cache = total_seats - globalMaxOccupancy.
-- Half-open intervals [boarding_ordinal, alighting_ordinal); whole route = [1, 32767).

ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS fare_basis text NOT NULL DEFAULT 'PER_SEAT'
    CONSTRAINT offers_fare_basis_check CHECK (fare_basis IN ('PER_SEAT', 'TOTAL_ALL')),
  ADD COLUMN IF NOT EXISTS inventory_version integer NOT NULL DEFAULT 0;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS boarding_ordinal smallint,
  ADD COLUMN IF NOT EXISTS alighting_ordinal smallint,
  ADD COLUMN IF NOT EXISTS fare_basis text
    CONSTRAINT bookings_fare_basis_check CHECK (fare_basis IS NULL OR fare_basis IN ('PER_SEAT', 'TOTAL_ALL'));

CREATE TABLE IF NOT EXISTS seat_occupancy_intervals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  boarding_ordinal smallint NOT NULL,
  alighting_ordinal smallint NOT NULL,
  seat_count smallint NOT NULL CHECK (seat_count > 0),
  state text NOT NULL DEFAULT 'CONFIRMED'
    CHECK (state IN ('CONFIRMED', 'HELD', 'RELEASED', 'EXPIRED')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seat_occupancy_intervals_range_check
    CHECK (boarding_ordinal >= 1 AND alighting_ordinal > boarding_ordinal),
  CONSTRAINT seat_occupancy_intervals_booking_key UNIQUE (booking_id)
);

CREATE INDEX IF NOT EXISTS seat_occupancy_intervals_offer_idx
  ON seat_occupancy_intervals (offer_id, state, boarding_ordinal, alighting_ordinal);

-- Backfill: every non-cancelled booking occupies the whole route. Existing offers
-- already decremented available_seats; recompute it from intervals so the derived
-- invariant holds exactly even if legacy data drifted.
INSERT INTO seat_occupancy_intervals (offer_id, booking_id, boarding_ordinal, alighting_ordinal, seat_count, state)
SELECT b.offer_id, b.id, 1, 32767, b.seat_count, 'CONFIRMED'
FROM bookings b
WHERE b.status <> 'cancelled'
ON CONFLICT (booking_id) DO NOTHING;

UPDATE offers o
SET available_seats = GREATEST(0, o.total_seats - COALESCE((
      SELECT SUM(oi.seat_count) FROM seat_occupancy_intervals oi
      WHERE oi.offer_id = o.id AND oi.state = 'CONFIRMED'
    ), 0)),
    inventory_version = o.inventory_version + 1;