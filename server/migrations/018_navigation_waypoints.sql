CREATE TABLE IF NOT EXISTS navigation_waypoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  navigation_session_id uuid NOT NULL REFERENCES navigation_sessions(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES navigation_match_candidates(id),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 6),
  kind text NOT NULL CHECK (kind IN ('pickup','dropoff')),
  place_name text NOT NULL,
  location geography(Point,4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(navigation_session_id,ordinal),
  UNIQUE(candidate_id,kind)
);

CREATE INDEX IF NOT EXISTS navigation_waypoints_session_idx
  ON navigation_waypoints(navigation_session_id,ordinal);
