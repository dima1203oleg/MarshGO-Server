ALTER TABLE account_deletion_requests
  ADD COLUMN IF NOT EXISTS cooling_off_until timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

UPDATE account_deletion_requests
   SET status='cooling_off',
       cooling_off_until=COALESCE(cooling_off_until,requested_at+interval '30 days')
 WHERE status='pending';

ALTER TABLE account_deletion_requests
  DROP CONSTRAINT IF EXISTS account_deletion_requests_status_check;

ALTER TABLE account_deletion_requests
  ADD CONSTRAINT account_deletion_requests_status_check
  CHECK (status IN ('cooling_off','approved','processing','completed','cancelled','rejected'));

DROP INDEX IF EXISTS account_deletion_one_pending_idx;
CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_one_active_idx
  ON account_deletion_requests(user_id)
  WHERE status IN ('cooling_off','approved','processing');

CREATE INDEX IF NOT EXISTS account_deletion_due_idx
  ON account_deletion_requests(cooling_off_until,id)
  WHERE status='cooling_off';
