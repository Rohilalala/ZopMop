-- 009_create_user_addresses.sql
-- Saved delivery/service addresses for customers.

CREATE TABLE IF NOT EXISTS user_addresses (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag            VARCHAR(10)  NOT NULL CHECK (tag IN ('Home', 'Work', 'Other')),
    title          VARCHAR(100) NOT NULL,
    flat_no        VARCHAR(50)  NOT NULL,
    floor          VARCHAR(50)  NOT NULL DEFAULT '',
    building_name  VARCHAR(100) NOT NULL,
    landmark       VARCHAR(100) NOT NULL DEFAULT '',
    full_address   TEXT         NOT NULL,
    receiver_name  VARCHAR(100) NOT NULL DEFAULT '',
    receiver_phone VARCHAR(20)  NOT NULL DEFAULT '',
    lat            DOUBLE PRECISION NOT NULL,
    lon            DOUBLE PRECISION NOT NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_addresses_user_id ON user_addresses (user_id);
