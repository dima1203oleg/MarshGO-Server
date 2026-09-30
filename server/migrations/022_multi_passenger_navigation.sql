ALTER TABLE navigation_waypoints
  DROP CONSTRAINT IF EXISTS navigation_waypoints_ordinal_check;
ALTER TABLE navigation_waypoints
  ADD CONSTRAINT navigation_waypoints_ordinal_check CHECK (ordinal BETWEEN 1 AND 30);
ALTER TABLE navigation_waypoints
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled','visited','skipped'));

ALTER TABLE navigation_match_candidates
  ADD COLUMN IF NOT EXISTS pickup_ordinal smallint CHECK (pickup_ordinal BETWEEN 1 AND 30),
  ADD COLUMN IF NOT EXISTS dropoff_ordinal smallint CHECK (dropoff_ordinal BETWEEN 1 AND 30),
  ADD CONSTRAINT navigation_candidate_stop_order_check
    CHECK (pickup_ordinal IS NULL OR dropoff_ordinal IS NULL OR pickup_ordinal < dropoff_ordinal);
