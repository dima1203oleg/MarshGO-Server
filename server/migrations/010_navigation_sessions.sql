CREATE TABLE IF NOT EXISTS navigation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','ended')),
  destination_name text NOT NULL CHECK (length(destination_name) BETWEEN 1 AND 120),
  destination geography(Point,4326),
  route geometry(LineString,4326),
  route_distance_m integer CHECK (route_distance_m IS NULL OR route_distance_m > 0),
  route_duration_s integer CHECK (route_duration_s IS NULL OR route_duration_s > 0),
  route_version integer NOT NULL DEFAULT 1 CHECK (route_version > 0),
  opt_in boolean NOT NULL DEFAULT false,
  current_location geography(Point,4326),
  current_location_accuracy_m real CHECK (current_location_accuracy_m IS NULL OR current_location_accuracy_m BETWEEN 0 AND 1000),
  current_location_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CHECK ((state = 'ended') = (ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS navigation_sessions_one_active_driver_idx
  ON navigation_sessions(driver_id) WHERE state IN ('active','paused');
CREATE INDEX IF NOT EXISTS navigation_sessions_active_driver_idx
  ON navigation_sessions(driver_id,state) WHERE state IN ('active','paused');
CREATE INDEX IF NOT EXISTS navigation_sessions_route_gix
  ON navigation_sessions USING gist(route);
CREATE INDEX IF NOT EXISTS navigation_sessions_location_gix
  ON navigation_sessions USING gist(current_location);
