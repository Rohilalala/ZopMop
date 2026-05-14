CREATE TABLE IF NOT EXISTS trial_usage (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone                   VARCHAR(20) NOT NULL,            -- snapshot at time of trial
    device_id               TEXT,                            -- from device_tokens
    address_geohash         VARCHAR(20),                     -- geohash precision 7 (~150m)
    payment_fingerprint     TEXT,                            -- hash of payment method identifier
    booking_id              UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    used_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    manually_unlocked       BOOLEAN NOT NULL DEFAULT false,
    unlocked_by             UUID REFERENCES users(id),
    unlocked_reason         TEXT
);

CREATE INDEX idx_trial_usage_phone ON trial_usage (phone) WHERE manually_unlocked = false;
CREATE INDEX idx_trial_usage_device ON trial_usage (device_id) WHERE device_id IS NOT NULL AND manually_unlocked = false;
CREATE INDEX idx_trial_usage_geohash ON trial_usage (address_geohash) WHERE address_geohash IS NOT NULL AND manually_unlocked = false;
CREATE INDEX idx_trial_usage_payment ON trial_usage (payment_fingerprint) WHERE payment_fingerprint IS NOT NULL AND manually_unlocked = false;
CREATE INDEX idx_trial_usage_user ON trial_usage (user_id);
