CREATE TABLE IF NOT EXISTS moderation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id),
  reported_user_id uuid NOT NULL REFERENCES users(id),
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('safety','harassment','fraud','service','other')),
  details text NOT NULL CHECK (length(details) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','resolved','dismissed')),
  reviewer_id uuid REFERENCES users(id),
  resolution_action text CHECK (resolution_action IN ('no_action','suspend_account')),
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (reporter_id <> reported_user_id),
  CHECK ((status IN ('resolved','dismissed')) = (resolved_at IS NOT NULL)),
  CHECK ((status IN ('resolved','dismissed')) = (resolution_action IS NOT NULL)),
  CHECK (resolution_note IS NULL OR length(resolution_note) BETWEEN 3 AND 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS moderation_one_open_report_per_booking_idx
  ON moderation_cases(reporter_id, booking_id)
  WHERE booking_id IS NOT NULL AND status IN ('open','in_review');
CREATE INDEX IF NOT EXISTS moderation_cases_queue_idx
  ON moderation_cases(status, created_at, id);
CREATE INDEX IF NOT EXISTS moderation_cases_reported_user_idx
  ON moderation_cases(reported_user_id, created_at DESC);
