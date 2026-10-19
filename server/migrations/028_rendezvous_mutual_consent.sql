ALTER TABLE rendezvous_sessions
  ADD COLUMN IF NOT EXISTS driver_sharing_consented boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS passenger_sharing_consented boolean NOT NULL DEFAULT false;

-- Existing sessions have no participant-level consent evidence. Require both parties
-- to consent again before sharing any location through the rendezvous endpoints.
UPDATE rendezvous_sessions
   SET location_sharing_enabled=false,
       state=CASE WHEN state IN ('ACTIVE','DRIVER_APPROACHING','PASSENGER_APPROACHING','DRIVER_WAITING','PASSENGER_WAITING','BOTH_NEARBY') THEN 'ACTIVATING' ELSE state END
 WHERE location_sharing_enabled=true;
