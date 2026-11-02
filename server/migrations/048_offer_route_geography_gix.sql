-- Coordinate-based passenger matching searches along offer geometry in meters.
-- Keep that corridor lookup indexed without changing the existing geometry index.
CREATE INDEX IF NOT EXISTS offers_route_geography_gix
  ON offers USING gist ((route::geography))
  WHERE route IS NOT NULL;
