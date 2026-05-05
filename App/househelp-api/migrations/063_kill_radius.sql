-- 063_kill_radius.sql
-- The matching engine no longer thinks in km. Spatial bounds are now
-- expressed as a maximum walking time from the customer's pickup point.
-- The geo-index pre-filter still uses km internally, but it is derived
-- from the walking budget (5 km/h × minutes/60, with a 50% slack factor)
-- and is not a tunable knob.

-- 1. Add the new key with a sensible default.
INSERT INTO app_config (key, value, value_type, description)
VALUES (
    'matching.max_walk_minutes',
    '20',
    'int',
    'Maximum walking minutes from customer to helper'
)
ON CONFLICT (key) DO UPDATE
SET value_type  = EXCLUDED.value_type,
    description = EXCLUDED.description;

-- 2. Retire the old radius keys. They have no consumers in code any more,
-- but leaving them around invites confused operators tweaking values that
-- silently no-op. Hard delete is safe: they are pure config rows, no FKs.
DELETE FROM app_config
WHERE key IN ('matching.radius_km', 'matching.max_radius_km');
