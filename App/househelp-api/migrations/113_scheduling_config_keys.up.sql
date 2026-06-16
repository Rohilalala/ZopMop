-- 113_scheduling_config_keys.sql
-- Slot-capacity pilot values move out of code into admin-managed app_config so
-- they can be changed from the CRM without a deploy:
--   scheduling.service_close_min        — IST service close (minutes-from-midnight)
--   scheduling.capacity_pilot_locality  — single-society fallback locality
-- Code reads these via config_manager (falls back to these same defaults if a
-- row is missing). ON CONFLICT keeps it idempotent / safe to re-run.
--
-- Forward-only by repo policy (cmd/migrate/main.go): no .down.sql.

INSERT INTO app_config (key, value, value_type, description) VALUES
    ('scheduling.service_close_min', '1230', 'int',
     'IST service close in minutes-from-midnight (1230 = 20:30). Scheduled jobs must finish by this; the slot grid and booking gate enforce it.'),
    ('scheduling.capacity_pilot_locality', 'Orchid Island Gurugram', 'string',
     'Fallback locality for slot-capacity gating when an address cannot be mapped to a seeded locality (single-society pilot). Empty disables the fallback.')
ON CONFLICT (key) DO NOTHING;
