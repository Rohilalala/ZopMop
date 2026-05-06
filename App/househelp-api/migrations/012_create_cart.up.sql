-- 012_create_cart.sql
-- One cart per user; cart_items tracks selected services with chosen duration.

CREATE TABLE IF NOT EXISTS cart (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS cart_items (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id          UUID        NOT NULL REFERENCES cart(id) ON DELETE CASCADE,
    service_id       UUID        NOT NULL REFERENCES service_categories(id),
    duration_minutes INTEGER     NOT NULL DEFAULT 30,
    price_cents      INTEGER     NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cart_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_user_id      ON cart (user_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON cart_items (cart_id);
