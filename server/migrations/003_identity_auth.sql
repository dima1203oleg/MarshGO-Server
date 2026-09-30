ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('active','suspended','deletion_requested','deleted'));

CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('passenger','driver','carrier','admin','moderator')),
  granted_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, role)
);
INSERT INTO user_roles(user_id,role)
SELECT u.id, r.role FROM users u CROSS JOIN LATERAL unnest(u.roles) AS r(role)
ON CONFLICT DO NOTHING;

ALTER TABLE otp_challenges
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS request_ip_hash text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS refresh_token_hash text UNIQUE,
  ADD COLUMN IF NOT EXISTS refresh_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS family_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
CREATE INDEX IF NOT EXISTS sessions_family_idx ON sessions(family_id);
CREATE INDEX IF NOT EXISTS sessions_refresh_expiry_idx ON sessions(refresh_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS driver_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  verification_level text NOT NULL DEFAULT 'unverified' CHECK (verification_level IN ('unverified','phone','identity','commercial')),
  profile_status text NOT NULL DEFAULT 'pending' CHECK (profile_status IN ('pending','active','suspended','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verification_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  vehicle_id uuid REFERENCES vehicles(id),
  verification_type text NOT NULL CHECK (verification_type IN ('identity','driver_license','vehicle','commercial')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewer_id uuid REFERENCES users(id),
  evidence_ref text,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
CREATE TABLE IF NOT EXISTS vehicle_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_one_pending_idx ON account_deletion_requests(user_id) WHERE status='pending';
