-- Seed new config_manager keys for pricing engine tunables.
INSERT INTO app_config (key, value, value_type, description) VALUES
  ('pricing.engine_version', '"v2"', 'string', 'Pricing engine version. v1 = legacy inline math. v2 = new engine.'),
  ('pricing.time_budget_soft_warn_minutes', '120', 'int', 'Warn customer if cart total duration exceeds this'),
  ('pricing.time_budget_hard_max_minutes', '180', 'int', 'Reject cart if total duration exceeds this'),
  ('pricing.trial_geohash_precision', '7', 'int', 'Geohash precision for trial dedup (7 ~= 150m)'),
  ('pricing.trial_default_variant_code', '"trial_60"', 'string', 'Variant code used as trial offering'),
  ('pricing.adjustment_expiry_minutes', '10', 'int', 'How long a pro adjustment proposal stays pending')
ON CONFLICT (key) DO NOTHING;
