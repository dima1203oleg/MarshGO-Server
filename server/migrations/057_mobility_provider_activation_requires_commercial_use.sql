-- Preserve provider rows and history, but stop serving sources whose
-- commercial reuse has not been explicitly established.
UPDATE mobility_providers
SET status = 'disabled',
    discovery_status = CASE
      WHEN commercial_use IS FALSE THEN 'REQUIRES_PARTNERSHIP'
      ELSE 'DISCOVERED'
    END,
    last_error = CASE
      WHEN commercial_use IS FALSE THEN 'NONCOMMERCIAL_LICENSE: commercial reuse is not permitted'
      ELSE 'LICENSE_UNVERIFIED: explicit commercial-use terms are required before enabling'
    END,
    updated_at = now()
WHERE status = 'enabled'
  AND commercial_use IS DISTINCT FROM TRUE;

ALTER TABLE mobility_providers
  ADD CONSTRAINT mobility_providers_enabled_requires_commercial_use
  CHECK (status <> 'enabled' OR commercial_use IS TRUE);
