-- P0 partner platform foundation. Organizations are separate from transport providers:
-- a partner may use several modules and provider connections over time.
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 120),
  legal_name text NOT NULL CHECK (length(trim(legal_name)) BETWEEN 2 AND 180),
  status text NOT NULL DEFAULT 'PENDING_REVIEW'
    CHECK (status IN ('PENDING_REVIEW','ACTIVE','SUSPENDED','REJECTED')),
  dispatch_mode text NOT NULL
    CHECK (dispatch_mode IN ('INTEGRATION_ONLY','NATIVE_DISPATCH')),
  created_by uuid NOT NULL REFERENCES users(id),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  status_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'PENDING_REVIEW' AND reviewed_at IS NULL)
      OR (status IN ('ACTIVE','SUSPENDED','REJECTED') AND reviewed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS organizations_status_created_idx
  ON organizations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS organizations_created_by_idx
  ON organizations(created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN (
    'organization_owner','organization_admin','dispatcher','fleet_manager',
    'finance_manager','technical_manager','viewer'
  )),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INVITED','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS organization_memberships_user_status_idx
  ON organization_memberships(user_id, status, organization_id);

CREATE TABLE IF NOT EXISTS partner_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  applicant_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED','UNDER_REVIEW','NEEDS_INFORMATION','APPROVED','REJECTED')),
  contact_email text,
  contact_phone text,
  city text NOT NULL CHECK (length(trim(city)) BETWEEN 2 AND 120),
  website text,
  review_note text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('APPROVED','REJECTED') AND reviewed_at IS NOT NULL)
      OR (status NOT IN ('APPROVED','REJECTED') AND reviewed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS partner_applications_status_created_idx
  ON partner_applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS partner_applications_organization_created_idx
  ON partner_applications(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS organization_service_modules (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_mode text NOT NULL CHECK (service_mode IN (
    'taxi','transfer','bus','carsharing','scooter','bicycle','public_transit'
  )),
  status text NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','ENABLED','PAUSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id, service_mode)
);

CREATE INDEX IF NOT EXISTS organization_service_modules_mode_status_idx
  ON organization_service_modules(service_mode, status, organization_id);
