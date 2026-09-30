ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS fee_class text NOT NULL DEFAULT 'community',
  ADD COLUMN IF NOT EXISTS platform_fee_minor integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_rule_version text NOT NULL DEFAULT 'community-0pct-v1';

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_fee_class_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_fee_class_check
  CHECK (fee_class IN ('community') AND platform_fee_minor >= 0 AND platform_fee_minor <= total_price_minor);
