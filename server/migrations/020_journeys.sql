CREATE TABLE IF NOT EXISTS journeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin geography(Point,4326) NOT NULL,
  origin_name text NOT NULL,
  destination geography(Point,4326) NOT NULL,
  destination_name text NOT NULL,
  requested_departure_at timestamptz NOT NULL,
  requested_arrival_at timestamptz,
  strategy text NOT NULL DEFAULT 'BALANCED'
    CHECK (strategy IN ('FASTEST','CHEAPEST','BALANCED','PREMIUM','RELIABLE','CUSTOM')),
  state text NOT NULL DEFAULT 'PLANNING'
    CHECK (state IN ('PLANNING','PLANNED','PARTIALLY_RESERVED','READY','ACTIVE','TRANSFER','REPLANNING','COMPLETED','CANCELLED','FAILED')),
  passenger_count integer NOT NULL CHECK (passenger_count BETWEEN 1 AND 20),
  total_price_minor integer CHECK (total_price_minor >= 0),
  confirmed_price_minor integer CHECK (confirmed_price_minor >= 0),
  estimated_price_min_minor integer CHECK (estimated_price_min_minor >= 0),
  estimated_price_max_minor integer CHECK (estimated_price_max_minor >= 0),
  total_duration_s integer CHECK (total_duration_s >= 0),
  walking_distance_m integer NOT NULL DEFAULT 0 CHECK (walking_distance_m >= 0),
  transfer_count integer NOT NULL DEFAULT 0 CHECK (transfer_count >= 0),
  reliability_score numeric(4,3) CHECK (reliability_score BETWEEN 0 AND 1),
  comfort_score numeric(4,3) CHECK (comfort_score BETWEEN 0 AND 1),
  current_leg_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CHECK (estimated_price_min_minor IS NULL OR estimated_price_max_minor IS NULL OR estimated_price_min_minor <= estimated_price_max_minor)
);
CREATE INDEX IF NOT EXISTS journeys_user_updated_idx ON journeys(user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS journeys_state_departure_idx ON journeys(state,requested_departure_at);
CREATE INDEX IF NOT EXISTS journeys_origin_gix ON journeys USING gist(origin);
CREATE INDEX IF NOT EXISTS journeys_destination_gix ON journeys USING gist(destination);

CREATE TABLE IF NOT EXISTS journey_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 30),
  mode text NOT NULL CHECK (mode IN ('WALK','COMMUNITY','COMMUNITY_DEMAND','TAXI','TRANSFER','BUS','MINIBUS','RAIL','TRAM','TROLLEYBUS','METRO','URBAN_BUS','CARSHARING')),
  origin geography(Point,4326) NOT NULL,
  origin_name text NOT NULL,
  destination geography(Point,4326) NOT NULL,
  destination_name text NOT NULL,
  scheduled_departure_at timestamptz,
  scheduled_arrival_at timestamptz,
  predicted_departure_at timestamptz,
  predicted_arrival_at timestamptz,
  actual_departure_at timestamptz,
  actual_arrival_at timestamptz,
  duration_s integer CHECK (duration_s >= 0),
  eta_uncertainty_seconds integer CHECK (eta_uncertainty_seconds BETWEEN 0 AND 86400),
  distance_m integer CHECK (distance_m >= 0),
  walking_distance_m integer NOT NULL DEFAULT 0 CHECK (walking_distance_m >= 0),
  price_minor integer CHECK (price_minor >= 0),
  price_min_minor integer CHECK (price_min_minor >= 0),
  price_max_minor integer CHECK (price_max_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'UAH',
  price_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (price_status IN ('LOCKED','ESTIMATED','DYNAMIC','UNKNOWN')),
  availability_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (availability_status IN ('AVAILABLE','LIMITED','UNAVAILABLE','UNKNOWN','BLOCKED_EXTERNAL')),
  provider_id uuid,
  provider_type text,
  offer_id uuid REFERENCES offers(id) ON DELETE SET NULL,
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  demand_id uuid REFERENCES passenger_demands(id) ON DELETE SET NULL,
  navigation_candidate_id uuid REFERENCES navigation_match_candidates(id) ON DELETE SET NULL,
  reliability_score numeric(4,3) CHECK (reliability_score BETWEEN 0 AND 1),
  transfer_risk_score numeric(4,3) CHECK (transfer_risk_score BETWEEN 0 AND 1),
  state text NOT NULL DEFAULT 'SUGGESTED'
    CHECK (state IN ('SUGGESTED','SELECTED','SOFT_MATCH','RESERVED','CONFIRMED','WAITING','ACTIVE','COMPLETED','MISSED','CANCELLED','REPLACED','FAILED')),
  data_source text,
  data_freshness_seconds integer CHECK (data_freshness_seconds >= 0),
  last_updated_at timestamptz,
  realtime_available boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(journey_id,ordinal),
  CHECK (price_min_minor IS NULL OR price_max_minor IS NULL OR price_min_minor <= price_max_minor)
);
CREATE INDEX IF NOT EXISTS journey_legs_journey_ordinal_idx ON journey_legs(journey_id,ordinal);
CREATE INDEX IF NOT EXISTS journey_legs_origin_gix ON journey_legs USING gist(origin);
CREATE INDEX IF NOT EXISTS journey_legs_destination_gix ON journey_legs USING gist(destination);
CREATE INDEX IF NOT EXISTS journey_legs_provider_freshness_idx ON journey_legs(provider_type,last_updated_at DESC);

ALTER TABLE journeys DROP CONSTRAINT IF EXISTS journeys_current_leg_id_fkey;
ALTER TABLE journeys ADD CONSTRAINT journeys_current_leg_id_fkey
  FOREIGN KEY (current_leg_id) REFERENCES journey_legs(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS journey_preferences (
  journey_id uuid PRIMARY KEY REFERENCES journeys(id) ON DELETE CASCADE,
  max_price_minor integer CHECK (max_price_minor >= 0),
  max_total_duration_s integer CHECK (max_total_duration_s > 0),
  max_transfers integer CHECK (max_transfers BETWEEN 0 AND 20),
  max_walking_distance_m integer CHECK (max_walking_distance_m >= 0),
  min_driver_rating numeric(2,1) CHECK (min_driver_rating BETWEEN 0 AND 5),
  allow_community boolean NOT NULL DEFAULT true,
  allow_taxi boolean NOT NULL DEFAULT true,
  allow_bus boolean NOT NULL DEFAULT true,
  allow_minibus boolean NOT NULL DEFAULT true,
  allow_rail boolean NOT NULL DEFAULT true,
  allow_public_transport boolean NOT NULL DEFAULT true,
  allow_carsharing boolean NOT NULL DEFAULT false,
  allow_transfer boolean NOT NULL DEFAULT true,
  preferred_vehicle_class text,
  minimum_transfer_buffer_s integer NOT NULL DEFAULT 600 CHECK (minimum_transfer_buffer_s BETWEEN 0 AND 7200),
  max_community_detour_s integer NOT NULL DEFAULT 900 CHECK (max_community_detour_s BETWEEN 0 AND 7200),
  max_community_detour_m integer NOT NULL DEFAULT 10000 CHECK (max_community_detour_m BETWEEN 0 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
