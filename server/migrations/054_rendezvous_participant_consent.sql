ALTER TABLE rendezvous_sessions
  ADD COLUMN IF NOT EXISTS driver_location_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS passenger_location_consent_at timestamptz;

COMMENT ON COLUMN rendezvous_sessions.driver_location_consent_at IS
  'Explicit, revocable consent by the driver to share foreground GPS for this rendezvous.';
COMMENT ON COLUMN rendezvous_sessions.passenger_location_consent_at IS
  'Explicit, revocable consent by the passenger to share foreground GPS for this rendezvous.';

-- Existing global sharing switches are not evidence of individual consent.
UPDATE rendezvous_sessions
   SET location_sharing_enabled=false,
       driver_location_consent_at=NULL,
       passenger_location_consent_at=NULL,
       updated_at=now()
 WHERE location_sharing_enabled=true;
