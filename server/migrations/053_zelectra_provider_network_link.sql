-- Keep the enabled Zelectra GBFS source attached to its operator/network.
-- Existing rows created before the operator registry was seeded may have a
-- NULL operator_id even though the source URL is the canonical public feed.
UPDATE mobility_providers
   SET operator_id='zelectra',updated_at=now()
 WHERE provider_type='scooter'
   AND source_type='gbfs'
   AND rtrim(feed_url,'/')='https://zelectra.rideatom.com/gbfs/66/v3.0/gbfs'
   AND operator_id IS DISTINCT FROM 'zelectra';
