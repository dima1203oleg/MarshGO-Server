-- 056_email_password_auth.sql
-- Add email password authentication, tokenized reset links, and brute force protection

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

-- Enforce unique email (case-insensitive) for accounts that have an email specified
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (lower(email)) WHERE email IS NOT NULL;

-- Table for secure URL-token password resets (not numeric OTPs)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_hash_idx ON password_reset_tokens(token_hash) WHERE consumed_at IS NULL;

-- Audit and lockout log for brute force protection
CREATE TABLE IF NOT EXISTS auth_failed_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  attempt_type text NOT NULL DEFAULT 'login',
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_failed_attempts_lookup_idx ON auth_failed_attempts(identifier, attempted_at);
