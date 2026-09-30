CREATE UNIQUE INDEX IF NOT EXISTS vehicle_photos_one_primary_idx
  ON vehicle_photos(vehicle_id) WHERE is_primary;
