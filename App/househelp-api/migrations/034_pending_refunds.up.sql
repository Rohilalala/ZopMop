CREATE TABLE IF NOT EXISTS pending_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    source VARCHAR(40) NOT NULL,
    source_ref VARCHAR(80),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pending_refunds_user_status ON pending_refunds(user_id, status);
