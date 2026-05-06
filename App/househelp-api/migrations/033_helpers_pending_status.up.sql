ALTER TABLE helpers ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_helpers_approval_status ON helpers(approval_status);
