ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS fee_class text NOT NULL DEFAULT 'community',
  ADD COLUMN IF NOT EXISTS platform_fee_minor integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_rule_version text NOT NULL DEFAULT 'community-0pct-v1';

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_fee_class_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_fee_class_check
  CHECK (fee_class IN ('community') AND platform_fee_minor >= 0 AND platform_fee_minor <= total_price_minor);

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
