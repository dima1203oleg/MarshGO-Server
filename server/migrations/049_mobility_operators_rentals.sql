-- Stable service operators, compatible rental networks, source provenance, and transfer catalog records.
CREATE TABLE IF NOT EXISTS mobility_operators (
  provider_id text PRIMARY KEY CHECK (provider_id ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  provider_name text NOT NULL CHECK (length(provider_name) BETWEEN 2 AND 160),
  provider_group text NOT NULL CHECK (provider_group IN ('TAXI','TRANSFER','SCOOTER','BICYCLE','CARSHARING','PUBLIC_TRANSPORT')),
  data_source text NOT NULL CHECK (data_source IN ('GBFS','OSM','REST','CSV','MANUAL','PARTNER_API')),
  source_url text NOT NULL CHECK (source_url ~ '^https://'),
  coverage geometry(MultiPolygon,4326),
  integration_status text NOT NULL CHECK (integration_status IN ('ACTIVE_LIVE','ACTIVE_STATIC','CATALOG_ONLY','AFFILIATE_LINK_ONLY','SANDBOX_ONLY','AWAITING_CREDENTIALS','AWAITING_AGREEMENT','DISABLED','ERROR')),
  data_freshness_seconds integer CHECK (data_freshness_seconds IS NULL OR data_freshness_seconds >= 0),
  booking_method text NOT NULL CHECK (booking_method IN ('DEEPLINK','PARTNER_API','IN_APP','NONE','UNKNOWN')),
  pricing_capability text NOT NULL CHECK (pricing_capability IN ('LIVE','CATALOG','STATIC','UNKNOWN','NONE')),
  live_availability_capability boolean NOT NULL DEFAULT false,
  commercial_permissions text NOT NULL CHECK (commercial_permissions IN ('CONFIRMED','ATTRIBUTION_REQUIRED','PARTNER_ONLY','UNKNOWN')),
  attribution_requirements text,
  enabled boolean NOT NULL DEFAULT false,
  last_successful_sync timestamptz,
  last_sync_error text,
  api_key_configured boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mobility_networks (
  network_id text PRIMARY KEY CHECK (network_id ~ '^[a-z0-9][a-z0-9_-]{1,99}$'),
  name text NOT NULL,
  return_model text NOT NULL CHECK (return_model IN ('STATION_BASED','FREE_FLOATING','STAFFED','CONFIRMED_ONE_WAY','UNKNOWN')),
  return_rule text NOT NULL CHECK (return_rule IN ('SAME_LOCATION','ANY_NETWORK_LOCATION','FREE_FLOATING_ZONE','ONE_WAY_CONFIRMED','UNKNOWN')),
  compatibility_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (compatibility_status IN ('CONFIRMED','UNKNOWN','DISABLED')),
  cross_provider_return_confirmed boolean NOT NULL DEFAULT false,
  provider_ids text[] NOT NULL DEFAULT '{}',
  maximum_snapshot_age_seconds integer CHECK (maximum_snapshot_age_seconds IS NULL OR maximum_snapshot_age_seconds >= 0),
  source_url text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rental_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL REFERENCES mobility_operators(provider_id),
  network_id text REFERENCES mobility_networks(network_id),
  mode text NOT NULL CHECK (mode IN ('BICYCLE','SCOOTER')),
  rental_model text NOT NULL CHECK (rental_model IN ('STATION_BASED','FREE_FLOATING','STAFFED','CONFIRMED_ONE_WAY','UNKNOWN')),
  source text NOT NULL CHECK (source IN ('GBFS','OSM','REST','CSV','MANUAL','PARTNER_API')),
  external_id text NOT NULL,
  object_type text CHECK (object_type IN ('node','way','relation','station','vehicle','manual','unknown')),
  name text,
  operator_name text,
  network_name text,
  brand text,
  reference text,
  city text,
  region text,
  address text,
  opening_hours text,
  access text,
  website text,
  phone text,
  capacity integer CHECK (capacity IS NULL OR capacity >= 0),
  vehicle_types text[] NOT NULL DEFAULT '{}',
  pickup_allowed boolean,
  dropoff_allowed boolean,
  geofence_allows_pickup boolean,
  geofence_allows_dropoff boolean,
  one_way_return text NOT NULL DEFAULT 'UNKNOWN' CHECK (one_way_return IN ('CONFIRMED','NOT_ALLOWED','UNKNOWN')),
  availability text NOT NULL DEFAULT 'UNKNOWN' CHECK (availability IN ('AVAILABLE','UNAVAILABLE','UNKNOWN')),
  available_vehicles integer CHECK (available_vehicles IS NULL OR available_vehicles >= 0),
  available_docks integer CHECK (available_docks IS NULL OR available_docks >= 0),
  availability_checked_at timestamptz,
  source_updated_at timestamptz,
  source_imported_at timestamptz NOT NULL DEFAULT now(),
  source_quality text NOT NULL DEFAULT 'UNVERIFIED' CHECK (source_quality IN ('VERIFIED','APPROXIMATE','UNVERIFIED')),
  geom geometry(Geometry,4326) NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS rental_locations_geom_gix ON rental_locations USING gist(geom);
CREATE INDEX IF NOT EXISTS rental_locations_provider_network_idx ON rental_locations(provider_id, network_id, mode);
CREATE INDEX IF NOT EXISTS rental_locations_city_mode_idx ON rental_locations(city, mode, provider_id);

CREATE TABLE IF NOT EXISTS rental_location_sources (
  id bigserial PRIMARY KEY,
  rental_location_id uuid NOT NULL REFERENCES rental_locations(id) ON DELETE CASCADE,
  source text NOT NULL,
  external_id text NOT NULL,
  source_url text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS rental_availability_snapshots (
  id bigserial PRIMARY KEY,
  rental_location_id uuid NOT NULL REFERENCES rental_locations(id) ON DELETE CASCADE,
  provider_id text NOT NULL REFERENCES mobility_operators(provider_id),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz,
  available_vehicles integer CHECK (available_vehicles IS NULL OR available_vehicles >= 0),
  available_docks integer CHECK (available_docks IS NULL OR available_docks >= 0),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS rental_availability_location_observed_idx ON rental_availability_snapshots(rental_location_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS mobility_geofences (
  id bigserial PRIMARY KEY,
  provider_id text NOT NULL REFERENCES mobility_operators(provider_id),
  external_id text NOT NULL,
  geom geometry(Geometry,4326) NOT NULL,
  rules jsonb NOT NULL,
  source_updated_at timestamptz,
  source_imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_id, external_id)
);
CREATE INDEX IF NOT EXISTS mobility_geofences_geom_gix ON mobility_geofences USING gist(geom);

CREATE TABLE IF NOT EXISTS transfer_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL REFERENCES mobility_operators(provider_id),
  external_id text NOT NULL,
  country_code text,
  region text,
  city text,
  iata_code text,
  geom geometry(Point,4326),
  source_updated_at timestamptz,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(provider_id, external_id)
);
CREATE INDEX IF NOT EXISTS transfer_places_geom_gix ON transfer_places USING gist(geom);
CREATE TABLE IF NOT EXISTS transfer_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL REFERENCES mobility_operators(provider_id),
  external_id text NOT NULL,
  origin_place_id uuid NOT NULL REFERENCES transfer_places(id),
  destination_place_id uuid NOT NULL REFERENCES transfer_places(id),
  vehicle_class text,
  seats integer,
  luggage integer,
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency char(3),
  price_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (price_status IN ('CATALOG','DYNAMIC','UNKNOWN')),
  source_updated_at timestamptz,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(provider_id, external_id)
);

CREATE TABLE IF NOT EXISTS provider_source_records (
  id bigserial PRIMARY KEY,
  provider_id text NOT NULL REFERENCES mobility_operators(provider_id),
  source text NOT NULL,
  external_id text NOT NULL,
  record_type text NOT NULL,
  source_url text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw_record jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(provider_id, source, external_id)
);

ALTER TABLE mobility_providers ADD COLUMN IF NOT EXISTS operator_id text REFERENCES mobility_operators(provider_id);
CREATE INDEX IF NOT EXISTS mobility_providers_operator_idx ON mobility_providers(operator_id);

INSERT INTO mobility_operators(provider_id,provider_name,provider_group,data_source,source_url,integration_status,data_freshness_seconds,booking_method,pricing_capability,live_availability_capability,commercial_permissions,attribution_requirements,enabled)
VALUES
 ('kiwitaxi','Kiwitaxi','TRANSFER','CSV','https://kiwitaxi.com/en/partner/webmaster/instructions/api/','AWAITING_CREDENTIALS',NULL,'UNKNOWN','UNKNOWN',false,'PARTNER_ONLY','Partner security token, affiliate ID (pap), and current partner terms must be supplied.',false),
 ('intui_travel','Intui.travel','TRANSFER','PARTNER_API','https://partner.intui.travel/en/auth/','AWAITING_CREDENTIALS',NULL,'PARTNER_API','UNKNOWN',false,'PARTNER_ONLY','API Light credentials/partner agreement; API Wide needs additional agreement.',false),
 ('zelectra','Zelectra','SCOOTER','GBFS','https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs','ACTIVE_LIVE',0,'DEEPLINK','CATALOG',true,'ATTRIBUTION_REQUIRED','Live feed contains Kyiv and out-of-country coordinates; filter by the requested Ukraine viewport. Rental return rules remain unverified.',true),
 ('bikenow','BikeNow','BICYCLE','PARTNER_API','https://bikenow.com.ua/','AWAITING_AGREEMENT',NULL,'UNKNOWN','UNKNOWN',false,'PARTNER_ONLY','Written data/display permission and return rules required.',false),
 ('veliki_ua','Veliki.ua','BICYCLE','MANUAL','https://veliki.ua/vsi-punkti-prokatu.html','ACTIVE_STATIC',NULL,'UNKNOWN','UNKNOWN',false,'UNKNOWN','Attribute the published Veliki.ua location catalog; confirm commercial reuse.',true),
 ('bicycle_operator_unknown','Непідтверджений велопрокат','BICYCLE','OSM','https://www.openstreetmap.org/copyright','ACTIVE_STATIC',NULL,'UNKNOWN','UNKNOWN',false,'ATTRIBUTION_REQUIRED','© OpenStreetMap contributors, ODbL 1.0.',true)
ON CONFLICT(provider_id) DO NOTHING;

UPDATE mobility_providers SET operator_id='zelectra'
WHERE feed_url='https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs';

INSERT INTO mobility_networks(network_id,name,return_model,return_rule,compatibility_status,cross_provider_return_confirmed,provider_ids,maximum_snapshot_age_seconds,source_url,verified_at)
VALUES ('zelectra-66','Zelectra system 66 (coverage unresolved)','UNKNOWN','UNKNOWN','UNKNOWN',false,ARRAY['zelectra'],30,'https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs',NULL)
ON CONFLICT(network_id) DO NOTHING;
