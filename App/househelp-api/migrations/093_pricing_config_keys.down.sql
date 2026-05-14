DELETE FROM app_config WHERE key IN (
    'pricing.engine_version',
    'pricing.time_budget_soft_warn_minutes',
    'pricing.time_budget_hard_max_minutes',
    'pricing.trial_geohash_precision',
    'pricing.trial_default_variant_code',
    'pricing.adjustment_expiry_minutes'
);
