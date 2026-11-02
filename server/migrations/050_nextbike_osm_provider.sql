INSERT INTO mobility_operators(
  provider_id, provider_name, provider_group, data_source, source_url,
  integration_status, data_freshness_seconds, booking_method, pricing_capability,
  live_availability_capability, commercial_permissions, attribution_requirements, enabled
)
VALUES (
  'nextbike_ua', 'Nextbike', 'BICYCLE', 'OSM', 'https://www.openstreetmap.org/copyright',
  'ACTIVE_STATIC', NULL, 'UNKNOWN', 'UNKNOWN', false, 'ATTRIBUTION_REQUIRED',
  'OSM locations only; © OpenStreetMap contributors, ODbL 1.0. No live stock or inter-station return rules are confirmed.', true
)
ON CONFLICT (provider_id) DO NOTHING;
