-- Mobility Control Center: registry of external transport/data sources managed without code changes.
CREATE TABLE IF NOT EXISTS mobility_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  city text NOT NULL CHECK (length(city) BETWEEN 2 AND 120),
  provider_type text NOT NULL CHECK (provider_type IN ('public_transit','bike','ebike','scooter','moped','carsharing','taxi','carpool','on_demand','other')),
  source_type text NOT NULL CHECK (source_type IN ('gtfs','gtfs_rt','gbfs','gofs','rest','graphql','websocket','json','csv','marshgo')),
  feed_url text NOT NULL CHECK (feed_url ~ '^https://'),
  realtime_url text CHECK (realtime_url IS NULL OR realtime_url ~ '^https://'),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled','disabled','paused')),
  health text NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown','healthy','degraded','offline')),
  last_checked_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  last_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, city)
);
CREATE INDEX IF NOT EXISTS mobility_providers_city_idx ON mobility_providers(city, status);
