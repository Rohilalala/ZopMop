-- 008_create_audit_log.sql
-- Audit trail for all admin actions.

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID NOT NULL REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50),         -- e.g. "user", "banner", "config"
    target_id TEXT,
    old_value JSONB,
    new_value JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for audit log queries.
CREATE INDEX IF NOT EXISTS idx_audit_log_admin_id ON audit_log (admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_target_type ON audit_log (target_type);
