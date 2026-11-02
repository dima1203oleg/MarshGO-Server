-- Anything that marks a vehicle as verified (admin tooling, imports, fixtures) also grants the highest trust level.
CREATE OR REPLACE FUNCTION vehicles_verified_implies_trust() RETURNS trigger AS $$
BEGIN
  IF NEW.verification_status = 'verified' AND NEW.trust_level < 3 THEN NEW.trust_level := 3; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vehicles_verified_trust ON vehicles;
CREATE TRIGGER vehicles_verified_trust BEFORE INSERT OR UPDATE OF verification_status ON vehicles
  FOR EACH ROW EXECUTE FUNCTION vehicles_verified_implies_trust();
