-- Turn-by-turn steps of the current navigation route (OSRM maneuvers), replaced together with the route geometry.
ALTER TABLE navigation_sessions ADD COLUMN IF NOT EXISTS maneuvers jsonb NOT NULL DEFAULT '[]'::jsonb;
