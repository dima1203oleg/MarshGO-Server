ALTER TABLE navigation_sessions
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT now();

UPDATE navigation_sessions
   SET last_activity_at=GREATEST(started_at,COALESCE(current_location_at,started_at));

CREATE INDEX IF NOT EXISTS navigation_sessions_activity_idx
  ON navigation_sessions(last_activity_at)
  WHERE state IN ('active','paused');
