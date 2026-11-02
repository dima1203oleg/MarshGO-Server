-- Preserve a driver's chosen display order for photos belonging to one vehicle.
ALTER TABLE vehicle_photos
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY vehicle_id ORDER BY is_primary DESC, created_at, id) - 1 AS position
  FROM vehicle_photos
)
UPDATE vehicle_photos AS photo
SET sort_order = ordered.position
FROM ordered
WHERE photo.id = ordered.id;

CREATE INDEX IF NOT EXISTS vehicle_photos_vehicle_order_idx
  ON vehicle_photos(vehicle_id, sort_order, created_at, id);
