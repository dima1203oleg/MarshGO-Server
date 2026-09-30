ALTER TABLE proposals
  DROP CONSTRAINT IF EXISTS proposals_navigation_candidate_id_fkey;

ALTER TABLE proposals
  ADD CONSTRAINT proposals_navigation_candidate_id_fkey
  FOREIGN KEY (navigation_candidate_id) REFERENCES navigation_match_candidates(id);
