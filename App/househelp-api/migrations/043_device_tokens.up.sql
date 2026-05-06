-- 043_device_tokens.sql
-- Per-device FCM token registration. Replaces the single users.fcm_token
-- column model so a single account can receive push on multiple devices.
-- The legacy users.fcm_token column is kept around for backward compat with
-- in-flight app builds; new code reads from device_tokens.

CREATE TABLE IF NOT EXISTS device_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    worker_id   UUID REFERENCES users(id) ON DELETE CASCADE, -- helpers.id IS users.id (helpers extend users via shared PK)
    fcm_token   TEXT NOT NULL,
    platform    VARCHAR(10) NOT NULL CHECK (platform IN ('ios','android','web')),
    device_id   TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT device_tokens_owner_chk CHECK (
        (user_id IS NOT NULL AND worker_id IS NULL) OR
        (user_id IS NULL AND worker_id IS NOT NULL)
    )
);

-- A given device_id maps to exactly one (owner, platform). When a device
-- changes hands or the user logs out + in as someone else, the register
-- endpoint overwrites via ON CONFLICT (device_id, platform) DO UPDATE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_tokens_device
    ON device_tokens (device_id, platform);

-- Lookup: send to all active tokens for a user / worker.
CREATE INDEX IF NOT EXISTS idx_device_tokens_user
    ON device_tokens (user_id, updated_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_device_tokens_worker
    ON device_tokens (worker_id, updated_at DESC) WHERE worker_id IS NOT NULL;

-- Lookup: delete-by-token cleanup when FCM returns "not registered".
CREATE INDEX IF NOT EXISTS idx_device_tokens_token
    ON device_tokens (fcm_token);

-- Backfill: pull legacy fcm_tokens into the new table. Customers go to
-- user_id; pros go to worker_id. Platform unknown → default 'android'.
-- Device ID synthesized as 'legacy:'||id since the original device IDs
-- were never collected. Helpers table has no fcm_token column (verified
-- via 002_create_helpers.sql + later ALTERs), so users is the only source.
INSERT INTO device_tokens (user_id, fcm_token, platform, device_id)
SELECT id, fcm_token, 'android', 'legacy:' || id::text
FROM users
WHERE role = 'customer'
  AND fcm_token IS NOT NULL AND fcm_token <> ''
  AND deleted_at IS NULL
ON CONFLICT (device_id, platform) DO NOTHING;

INSERT INTO device_tokens (worker_id, fcm_token, platform, device_id)
SELECT id, fcm_token, 'android', 'legacy:' || id::text
FROM users
WHERE role = 'pro'
  AND fcm_token IS NOT NULL AND fcm_token <> ''
  AND deleted_at IS NULL
ON CONFLICT (device_id, platform) DO NOTHING;
