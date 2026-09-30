CREATE TABLE IF NOT EXISTS realtime_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  recipient_ids uuid[] NOT NULL,
  payload jsonb NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS realtime_outbox_pending_idx
  ON realtime_outbox(available_at, created_at)
  WHERE published_at IS NULL;
