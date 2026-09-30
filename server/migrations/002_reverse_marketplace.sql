ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id),
  ADD COLUMN IF NOT EXISTS departure_at timestamptz,
  ADD COLUMN IF NOT EXISTS revision_number integer NOT NULL DEFAULT 1 CHECK (revision_number > 0);
CREATE INDEX IF NOT EXISTS proposals_demand_status_idx ON proposals(demand_id, status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS proposals_one_accepted_per_demand_idx ON proposals(demand_id) WHERE status = 'accepted';

CREATE TABLE IF NOT EXISTS proposal_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  actor_id uuid NOT NULL REFERENCES users(id),
  actor_role text NOT NULL CHECK (actor_role IN ('driver','passenger')),
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  departure_at timestamptz NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(proposal_id, revision_number)
);
