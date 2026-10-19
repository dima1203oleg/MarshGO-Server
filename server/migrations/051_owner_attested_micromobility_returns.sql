-- The project owner confirms same-provider returns: a vehicle may be returned
-- to any location in that provider's own network. This does not grant
-- cross-provider returns, confirm current inventory, or override a scooter's
-- GBFS geofence. Keep the provenance visible to clients and operators.
ALTER TABLE mobility_networks
  ADD COLUMN IF NOT EXISTS return_rule_source text NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE mobility_networks
  DROP CONSTRAINT IF EXISTS mobility_networks_return_rule_source_check;
ALTER TABLE mobility_networks
  ADD CONSTRAINT mobility_networks_return_rule_source_check
  CHECK (return_rule_source IN ('OWNER_ATTESTED','PROVIDER_API','PROVIDER_DOCUMENTATION','UNKNOWN'));

INSERT INTO mobility_networks(
  network_id,name,return_model,return_rule,compatibility_status,cross_provider_return_confirmed,
  provider_ids,maximum_snapshot_age_seconds,source_url,verified_at,return_rule_source
)
VALUES
  ('bikenow-ua','BikeNow Ukraine','UNKNOWN','ANY_NETWORK_LOCATION','CONFIRMED',false,ARRAY['bikenow'],300,NULL,now(),'OWNER_ATTESTED'),
  ('nextbike-ua','Nextbike Ukraine','UNKNOWN','ANY_NETWORK_LOCATION','CONFIRMED',false,ARRAY['nextbike_ua'],300,NULL,now(),'OWNER_ATTESTED'),
  ('veliki-ua','Veliki.ua','UNKNOWN','ANY_NETWORK_LOCATION','CONFIRMED',false,ARRAY['veliki_ua'],300,NULL,now(),'OWNER_ATTESTED')
ON CONFLICT (network_id) DO UPDATE SET
  name=EXCLUDED.name,
  return_rule=EXCLUDED.return_rule,
  compatibility_status=EXCLUDED.compatibility_status,
  cross_provider_return_confirmed=false,
  provider_ids=EXCLUDED.provider_ids,
  maximum_snapshot_age_seconds=EXCLUDED.maximum_snapshot_age_seconds,
  verified_at=now(),
  return_rule_source='OWNER_ATTESTED',
  updated_at=now()
WHERE mobility_networks.return_rule_source IN ('UNKNOWN','OWNER_ATTESTED');

-- Zelectra's free-floating returns remain bounded by the provider's live GBFS
-- geofencing rules. The owner-confirmed rule is not an unrestricted anywhere
-- return and does not change its live availability or booking capabilities.
UPDATE mobility_networks
   SET return_model='FREE_FLOATING',
       return_rule='FREE_FLOATING_ZONE',
       compatibility_status='CONFIRMED',
       cross_provider_return_confirmed=false,
       provider_ids=ARRAY['zelectra'],
       return_rule_source='OWNER_ATTESTED',
       verified_at=now(),
       updated_at=now()
 WHERE network_id='zelectra-66'
   AND return_rule_source IN ('UNKNOWN','OWNER_ATTESTED');

UPDATE rental_locations
   SET network_id=CASE provider_id
     WHEN 'bikenow' THEN 'bikenow-ua'
     WHEN 'nextbike_ua' THEN 'nextbike-ua'
     WHEN 'veliki_ua' THEN 'veliki-ua'
   END,
   updated_at=now()
 WHERE mode='BICYCLE'
   AND network_id IS NULL
   AND provider_id IN ('bikenow','nextbike_ua','veliki_ua');
