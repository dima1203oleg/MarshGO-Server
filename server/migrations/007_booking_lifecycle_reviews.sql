ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('confirmed','boarding','in_progress','completed','cancelled','no_show'));
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE TABLE IF NOT EXISTS booking_events (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_events_booking_idx ON booking_events(booking_id,created_at,id);

CREATE TABLE IF NOT EXISTS booking_completion_confirmations (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(booking_id,user_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  author_id uuid NOT NULL REFERENCES users(id),
  target_id uuid NOT NULL REFERENCES users(id),
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text CHECK (comment IS NULL OR length(comment) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(booking_id,author_id),
  CHECK (author_id <> target_id)
);
CREATE INDEX IF NOT EXISTS reviews_target_created_idx ON reviews(target_id,created_at DESC);

INSERT INTO booking_events(booking_id,from_status,to_status,created_at)
SELECT id,NULL,status,created_at FROM bookings
ON CONFLICT DO NOTHING;
