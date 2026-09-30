CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text UNIQUE,
  display_name text NOT NULL,
  email text UNIQUE,
  roles text[] NOT NULL DEFAULT ARRAY['passenger']::text[],
  is_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  make text NOT NULL,
  model text NOT NULL,
  model_year integer NOT NULL CHECK (model_year BETWEEN 1950 AND 2100),
  seat_count integer NOT NULL CHECK (seat_count BETWEEN 1 AND 20),
  plate_encrypted bytea,
  verification_status text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES users(id),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id),
  origin_name text NOT NULL,
  destination_name text NOT NULL,
  origin geography(Point, 4326) NOT NULL,
  destination geography(Point, 4326) NOT NULL,
  route geometry(LineString, 4326),
  departure_at timestamptz NOT NULL,
  price_per_seat_minor integer NOT NULL CHECK (price_per_seat_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'UAH',
  total_seats integer NOT NULL CHECK (total_seats BETWEEN 1 AND 20),
  available_seats integer NOT NULL CHECK (available_seats BETWEEN 0 AND total_seats),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published','in_progress','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offers_departure_status_idx ON offers(status, departure_at);
CREATE INDEX IF NOT EXISTS offers_origin_gix ON offers USING gist(origin);
CREATE INDEX IF NOT EXISTS offers_destination_gix ON offers USING gist(destination);
CREATE INDEX IF NOT EXISTS offers_route_gix ON offers USING gist(route);

CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES offers(id),
  passenger_id uuid NOT NULL REFERENCES users(id),
  seat_count integer NOT NULL CHECK (seat_count BETWEEN 1 AND 20),
  unit_price_minor integer NOT NULL CHECK (unit_price_minor >= 0),
  total_price_minor integer NOT NULL CHECK (total_price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'UAH',
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled','completed')),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  UNIQUE(passenger_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS bookings_passenger_created_idx ON bookings(passenger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_offer_status_idx ON bookings(offer_id, status);

CREATE TABLE IF NOT EXISTS passenger_demands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id uuid NOT NULL REFERENCES users(id),
  origin_name text NOT NULL,
  destination_name text NOT NULL,
  origin geography(Point, 4326) NOT NULL,
  destination geography(Point, 4326) NOT NULL,
  earliest_departure timestamptz NOT NULL,
  latest_departure timestamptz NOT NULL,
  passenger_count integer NOT NULL CHECK (passenger_count BETWEEN 1 AND 20),
  budget_minor integer CHECK (budget_minor >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','cancelled','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (latest_departure >= earliest_departure)
);

CREATE TABLE IF NOT EXISTS proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id uuid NOT NULL REFERENCES passenger_demands(id),
  driver_id uuid NOT NULL REFERENCES users(id),
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'UAH',
  comment text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','expired','withdrawn')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid UNIQUE REFERENCES bookings(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY(conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_phone_created_idx ON otp_challenges(phone_e164, created_at DESC);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
