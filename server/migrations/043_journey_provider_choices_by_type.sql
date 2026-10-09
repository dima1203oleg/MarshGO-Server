ALTER TABLE journey_preferences
  ADD COLUMN IF NOT EXISTS allowed_transit_providers_by_type jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE journey_preferences
  DROP CONSTRAINT IF EXISTS journey_preferences_allowed_transit_providers_by_type_check;

ALTER TABLE journey_preferences
  ADD CONSTRAINT journey_preferences_allowed_transit_providers_by_type_check
  CHECK (jsonb_typeof(allowed_transit_providers_by_type) = 'object'
    AND jsonb_object_length(allowed_transit_providers_by_type) <= 21);
