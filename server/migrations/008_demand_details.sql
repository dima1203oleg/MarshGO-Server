ALTER TABLE passenger_demands
  ADD COLUMN IF NOT EXISTS budget_type text NOT NULL DEFAULT 'total_all'
    CHECK (budget_type IN ('total_all', 'per_seat')),
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS requirements jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(requirements) = 'object');
