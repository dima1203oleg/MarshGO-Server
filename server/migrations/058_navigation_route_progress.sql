-- Carpool 5.0 P0.2-B: loop-safe route progress persistence (spec VIII.4 / XXXIX.1, G03/T17).
-- Additive nullable columns; existing sessions keep NULL progress and match as before.
ALTER TABLE navigation_sessions
  ADD COLUMN IF NOT EXISTS progress_ordinal integer,
  ADD COLUMN IF NOT EXISTS progress_offset_m real,
  ADD COLUMN IF NOT EXISTS progress_cumulative_m real,
  ADD COLUMN IF NOT EXISTS progress_fraction real CHECK (progress_fraction IS NULL OR progress_fraction BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS progress_status text CHECK (progress_status IS NULL OR progress_status IN ('RELIABLE','UNCERTAIN','OFF_ROUTE')),
  ADD COLUMN IF NOT EXISTS progress_uncertainty_m real,
  ADD COLUMN IF NOT EXISTS last_reliable_fix_at timestamptz;