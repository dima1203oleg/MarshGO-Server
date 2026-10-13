ALTER TABLE journey_preferences
  DROP CONSTRAINT IF EXISTS journey_preferences_allowed_transport_types_check;

ALTER TABLE journey_preferences
  ADD CONSTRAINT journey_preferences_allowed_transport_types_check
  CHECK (
    cardinality(allowed_transport_types) <= 21
    AND allowed_transport_types <@ ARRAY[
      'carpool','taxi','carsharing','car_rental','transfer','bus','marshrutka','trolleybus','tram','metro',
      'city_train','funicular','train','suburban_train','intercity_bus','bike','scooter','moped','plane','ferry','walk'
    ]::text[]
  );
