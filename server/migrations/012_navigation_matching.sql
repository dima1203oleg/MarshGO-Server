ALTER TABLE navigation_sessions
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id),
  ADD COLUMN IF NOT EXISTS vehicle_seat_count integer CHECK (vehicle_seat_count IS NULL OR vehicle_seat_count BETWEEN 1 AND 20);

CREATE TABLE IF NOT EXISTS navigation_match_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  navigation_session_id uuid NOT NULL REFERENCES navigation_sessions(id) ON DELETE CASCADE,
  demand_id uuid NOT NULL REFERENCES passenger_demands(id) ON DELETE CASCADE,
  route_version integer NOT NULL CHECK (route_version > 0),
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','driver_interested','passenger_confirmed','dismissed','expired')),
  detour_distance_m integer NOT NULL CHECK (detour_distance_m >= 0),
  detour_duration_s integer NOT NULL CHECK (detour_duration_s >= 0),
  pickup_eta timestamptz NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(navigation_session_id,demand_id)
);

CREATE INDEX IF NOT EXISTS navigation_match_candidates_session_idx
  ON navigation_match_candidates(navigation_session_id,status,expires_at);
CREATE INDEX IF NOT EXISTS navigation_match_candidates_demand_idx
  ON navigation_match_candidates(demand_id,status,expires_at);

CREATE INDEX IF NOT EXISTS navigation_sessions_route_geography_gix
  ON navigation_sessions USING gist((route::geography));
