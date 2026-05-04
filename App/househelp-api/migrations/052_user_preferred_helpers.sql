-- 052_user_preferred_helpers.sql
-- "Your Experts" — customer-curated list of preferred pros. Max 5 per
-- customer (enforced in service layer, not as a DB constraint, so admins
-- can override via direct SQL if needed).

CREATE TABLE IF NOT EXISTS user_preferred_helpers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    helper_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, helper_id)
);

CREATE INDEX IF NOT EXISTS idx_user_preferred_helpers_user
    ON user_preferred_helpers (user_id);
