-- Official Kyiv City open-data resources are exposed as GeoJSON downloads over HTTPS.
ALTER TABLE mobility_providers DROP CONSTRAINT IF EXISTS mobility_providers_source_type_check;
ALTER TABLE mobility_providers ADD CONSTRAINT mobility_providers_source_type_check
  CHECK (source_type IN ('gtfs','gtfs_rt','gbfs','gofs','rest','graphql','websocket','json','csv','geojson','marshgo'));

-- Preserve source licensing and distinguish discovery from production enablement.
ALTER TABLE mobility_providers
  ADD COLUMN IF NOT EXISTS commercial_use boolean,
  ADD COLUMN IF NOT EXISTS attribution_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS discovery_status text NOT NULL DEFAULT 'DISCOVERED';
ALTER TABLE mobility_providers DROP CONSTRAINT IF EXISTS mobility_providers_discovery_status_check;
ALTER TABLE mobility_providers ADD CONSTRAINT mobility_providers_discovery_status_check
  CHECK (discovery_status IN ('DISCOVERED','VALIDATED','ENABLED','NOT_AVAILABLE','REQUIRES_PARTNERSHIP','TEMPORARILY_UNAVAILABLE'));

UPDATE mobility_providers
SET commercial_use = CASE WHEN access = 'open' AND license IS NOT NULL THEN true ELSE NULL END,
    attribution_required = (access = 'open' AND license IS NOT NULL),
    last_verified_at = CASE WHEN access = 'open' AND license IS NOT NULL THEN COALESCE(last_checked_at, now()) ELSE last_verified_at END,
    discovery_status = CASE WHEN access = 'requires_partner_access' THEN 'REQUIRES_PARTNERSHIP'::text
      WHEN access = 'open' AND license IS NOT NULL THEN 'ENABLED'::text ELSE 'DISCOVERED'::text END;

CREATE INDEX IF NOT EXISTS mobility_providers_discovery_status_idx ON mobility_providers(discovery_status, city, provider_type);
