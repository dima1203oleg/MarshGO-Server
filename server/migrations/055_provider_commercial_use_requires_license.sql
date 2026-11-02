-- Earlier provider bootstrap code treated a reachable feed with any nonempty
-- license label as permission for commercial reuse. Re-evaluate existing rows
-- using recognizable license identifiers / explicit terms; unknown stays NULL.
UPDATE mobility_providers
SET commercial_use = CASE
      WHEN license ~* 'non[ -]?commercial|cc[ -]?by[ -]?nc([ -]?(sa|nd))?' THEN false
      WHEN license ~* 'commercial use permitted' THEN true
      WHEN license ~* 'cc[ -]?0|cc[ -]?by([ -]?(sa|nd))?([[:space:]]*[0-9](\.[0-9])?)?|odbl|open database license|odc[ -]?by|open data commons attribution license|pddl' THEN true
      ELSE NULL
    END,
    updated_at = now()
WHERE access = 'open';
