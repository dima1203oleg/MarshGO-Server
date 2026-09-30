-- Live route matching filters passenger requests by pickup and dropoff corridor.
-- These indexes prevent demand-catalog scans as the request table grows.
CREATE INDEX IF NOT EXISTS passenger_demands_origin_gix
  ON passenger_demands USING gist(origin);

CREATE INDEX IF NOT EXISTS passenger_demands_destination_gix
  ON passenger_demands USING gist(destination);
