ALTER TABLE mobility_providers
  ADD COLUMN IF NOT EXISTS vehicle_position_url text
    CHECK (vehicle_position_url IS NULL OR vehicle_position_url ~ '^https?://');
