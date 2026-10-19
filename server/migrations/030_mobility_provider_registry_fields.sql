-- Registry metadata for discovered open-data sources; non-https endpoints may be recorded but are never fetched.
ALTER TABLE mobility_providers DROP CONSTRAINT IF EXISTS mobility_providers_feed_url_check;
ALTER TABLE mobility_providers DROP CONSTRAINT IF EXISTS mobility_providers_realtime_url_check;
ALTER TABLE mobility_providers ADD CONSTRAINT mobility_providers_feed_url_check CHECK (feed_url ~ '^https?://');
ALTER TABLE mobility_providers ADD CONSTRAINT mobility_providers_realtime_url_check CHECK (realtime_url IS NULL OR realtime_url ~ '^https?://');
ALTER TABLE mobility_providers
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'UA',
  ADD COLUMN IF NOT EXISTS access text NOT NULL DEFAULT 'open' CHECK (access IN ('open','requires_credentials','requires_partner_access','insecure_endpoint')),
  ADD COLUMN IF NOT EXISTS license text,
  ADD COLUMN IF NOT EXISTS update_frequency text,
  ADD COLUMN IF NOT EXISTS coverage text,
  ADD COLUMN IF NOT EXISTS source_ref text;
