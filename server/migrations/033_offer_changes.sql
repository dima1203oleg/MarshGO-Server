-- Scheduled trips can be edited after publishing. Every change is recorded; significant ones need each booked passenger's approval.
CREATE TABLE IF NOT EXISTS offer_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES offers(id),
  changed_by uuid NOT NULL REFERENCES users(id),
  field text NOT NULL CHECK (field IN ('price','departure','seats','vehicle','status')),
  old_value text,
  new_value text,
  significant boolean NOT NULL DEFAULT false,
  reason text CHECK (reason IS NULL OR length(reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offer_changes_offer_idx ON offer_changes(offer_id, created_at);

CREATE TABLE IF NOT EXISTS booking_change_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','superseded')),
  summary jsonb NOT NULL,
  new_unit_price_minor integer CHECK (new_unit_price_minor IS NULL OR new_unit_price_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_change_approvals_one_pending_idx ON booking_change_approvals(booking_id) WHERE status = 'pending';
