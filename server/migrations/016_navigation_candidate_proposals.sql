ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS navigation_candidate_id uuid REFERENCES navigation_match_candidates(id);

CREATE UNIQUE INDEX IF NOT EXISTS proposals_navigation_candidate_unique_idx
  ON proposals(navigation_candidate_id)
  WHERE navigation_candidate_id IS NOT NULL;
