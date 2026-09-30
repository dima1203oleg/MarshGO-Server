ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS arrival_at timestamptz,
  ADD COLUMN IF NOT EXISTS distance_m integer CHECK (distance_m IS NULL OR distance_m > 0),
  ADD COLUMN IF NOT EXISTS duration_s integer CHECK (duration_s IS NULL OR duration_s > 0),
  ADD COLUMN IF NOT EXISTS route_source text;
