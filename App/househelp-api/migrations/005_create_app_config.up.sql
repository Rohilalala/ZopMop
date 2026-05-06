-- 005_create_app_config.sql
-- Dynamic application configuration managed by admins.

CREATE TABLE IF NOT EXISTS app_config (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    value_type VARCHAR(10) NOT NULL CHECK (value_type IN ('string', 'int', 'float', 'bool', 'json')),
    description TEXT,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert all default config values.
INSERT INTO app_config (key, value, value_type, description) VALUES
    ('matching.radius_km', '3', 'float', 'Default helper search radius in km'),
    ('matching.max_radius_km', '5', 'float', 'Expanded radius after timeout in km'),
    ('matching.timeout_seconds', '90', 'int', 'Seconds before expanding search radius'),
    ('matching.max_helpers_notified', '3', 'int', 'How many helpers to notify at once'),
    ('pricing.base_fee_cents', '2000', 'int', 'Platform base fee in cents'),
    ('pricing.surge_multiplier', '1.0', 'float', 'Surge pricing multiplier'),
    ('pricing.surge_enabled', 'false', 'bool', 'Whether surge pricing is active'),
    ('booking.cancellation_window_minutes', '5', 'int', 'Free cancellation window in minutes'),
    ('booking.max_active_per_customer', '1', 'int', 'Max simultaneous bookings per customer'),
    ('app.maintenance_mode', 'false', 'bool', 'Show maintenance screen to all users'),
    ('app.min_app_version_ios', '1.0.0', 'string', 'Minimum supported iOS app version'),
    ('app.min_app_version_android', '1.0.0', 'string', 'Minimum supported Android app version'),
    ('app.support_phone', '', 'string', 'Support phone number shown in app'),
    ('app.support_email', '', 'string', 'Support email shown in app'),
    ('helper.min_rating_to_appear', '3.0', 'float', 'Helpers below this rating are hidden')
ON CONFLICT (key) DO NOTHING;
