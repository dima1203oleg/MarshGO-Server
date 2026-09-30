CREATE TABLE IF NOT EXISTS rendezvous_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  journey_leg_id uuid REFERENCES journey_legs(id) ON DELETE SET NULL,
  pickup_point geography(Point,4326) NOT NULL,
  pickup_label text NOT NULL CHECK (length(pickup_label) BETWEEN 1 AND 160),
  planned_pickup_at timestamptz NOT NULL,
  predicted_pickup_at timestamptz,
  state text NOT NULL DEFAULT 'SCHEDULED' CHECK (state IN (
    'SCHEDULED','ACTIVATING','ACTIVE','DRIVER_APPROACHING','PASSENGER_APPROACHING',
    'DRIVER_WAITING','PASSENGER_WAITING','BOTH_NEARBY','BOARDING','COMPLETED','CANCELLED','EXPIRED'
  )),
  location_sharing_enabled boolean NOT NULL DEFAULT false,
  activation_at timestamptz NOT NULL,
  driver_arrived_at timestamptz,
  passenger_arrived_at timestamptz,
  boarding_started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT location_sharing_enabled OR state IN (
    'ACTIVE','DRIVER_APPROACHING','PASSENGER_APPROACHING','DRIVER_WAITING','PASSENGER_WAITING','BOTH_NEARBY','BOARDING'
  ))
);

CREATE INDEX IF NOT EXISTS rendezvous_active_idx
  ON rendezvous_sessions(state,activation_at) WHERE state NOT IN ('COMPLETED','CANCELLED','EXPIRED');
CREATE INDEX IF NOT EXISTS rendezvous_pickup_gix ON rendezvous_sessions USING gist(pickup_point);

-- Store explicit status/consent transitions only. Exact participant coordinates never enter PostgreSQL.
CREATE TABLE IF NOT EXISTS rendezvous_events (
  id bigserial PRIMARY KEY,
  rendezvous_id uuid NOT NULL REFERENCES rendezvous_sessions(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type ~ '^rendezvous[.][a-z_.-]{1,80}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rendezvous_events_timeline_idx ON rendezvous_events(rendezvous_id,created_at,id);
