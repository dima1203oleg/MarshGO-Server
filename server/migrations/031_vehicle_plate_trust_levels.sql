-- Trust levels replace the manual approval gate: 1 = plate + photo (auto), 2 = vehicle documents verified, 3 = driver verified too.
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS plate text CHECK (plate IS NULL OR plate ~ '^[A-Z0-9]{3,8}$'),
  ADD COLUMN IF NOT EXISTS trust_level smallint NOT NULL DEFAULT 0 CHECK (trust_level BETWEEN 0 AND 3);
UPDATE vehicles SET trust_level=3 WHERE verification_status='verified' AND trust_level=0;
UPDATE vehicles v SET trust_level=1 WHERE trust_level=0 AND EXISTS (SELECT 1 FROM vehicle_photos p WHERE p.vehicle_id=v.id);
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_active_plate_idx ON vehicles(plate) WHERE plate IS NOT NULL AND archived_at IS NULL;
