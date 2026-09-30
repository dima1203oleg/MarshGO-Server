CREATE TABLE IF NOT EXISTS user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_dedupe_key text NOT NULL,
  event_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '180 days'),
  UNIQUE(user_id,source_dedupe_key)
);

CREATE INDEX IF NOT EXISTS user_notifications_inbox_idx
  ON user_notifications(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS user_notifications_unread_idx
  ON user_notifications(user_id,created_at DESC)
  WHERE read_at IS NULL;
