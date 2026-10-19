ALTER TABLE journey_preferences
  ADD COLUMN IF NOT EXISTS allowed_transport_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allowed_transit_providers text[] NOT NULL DEFAULT '{}';

ALTER TABLE journey_preferences
  DROP CONSTRAINT IF EXISTS journey_preferences_allowed_transport_types_check;

ALTER TABLE journey_preferences
  ADD CONSTRAINT journey_preferences_allowed_transport_types_check
  CHECK (
    cardinality(allowed_transport_types) <= 19
    AND allowed_transport_types <@ ARRAY[
      'carpool','taxi','carsharing','car_rental','transfer','bus','marshrutka','trolleybus','tram','metro',
      'train','suburban_train','intercity_bus','bike','scooter','moped','plane','ferry','walk'
    ]::text[]
  );

ALTER TABLE journey_preferences
  DROP CONSTRAINT IF EXISTS journey_preferences_allowed_transit_providers_check;

ALTER TABLE journey_preferences
  ADD CONSTRAINT journey_preferences_allowed_transit_providers_check
  CHECK (cardinality(allowed_transit_providers) <= 100);
