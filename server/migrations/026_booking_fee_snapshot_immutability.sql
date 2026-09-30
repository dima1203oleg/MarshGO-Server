-- Repair existing installations where the columns/check constraint from 019
-- landed but the immutable snapshot trigger is absent (e.g. pre-trigger DBs).
CREATE OR REPLACE FUNCTION prevent_booking_fee_snapshot_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.fee_class IS DISTINCT FROM OLD.fee_class
     OR NEW.platform_fee_minor IS DISTINCT FROM OLD.platform_fee_minor
     OR NEW.fee_rule_version IS DISTINCT FROM OLD.fee_rule_version THEN
    RAISE EXCEPTION 'booking fee snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bookings_fee_snapshot_immutable ON bookings;
CREATE TRIGGER bookings_fee_snapshot_immutable
  BEFORE UPDATE OF fee_class, platform_fee_minor, fee_rule_version ON bookings
  FOR EACH ROW EXECUTE FUNCTION prevent_booking_fee_snapshot_change();
