ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS vehicles_one_active_per_owner_idx
  ON vehicles(owner_id) WHERE is_active AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS vehicles_owner_created_idx ON vehicles(owner_id,created_at DESC);
