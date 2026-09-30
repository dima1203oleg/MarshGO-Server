ALTER TABLE verification_records
  ADD COLUMN IF NOT EXISTS evidence_accessed_at timestamptz;

CREATE INDEX IF NOT EXISTS verification_records_review_queue_idx
  ON verification_records(created_at,id)
  WHERE status='pending';

CREATE UNIQUE INDEX IF NOT EXISTS verification_records_one_pending_type_idx
  ON verification_records(
    user_id,
    verification_type,
    COALESCE(vehicle_id,'00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status='pending';
