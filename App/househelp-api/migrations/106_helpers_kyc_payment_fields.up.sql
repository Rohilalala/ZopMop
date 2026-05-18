-- 106_helpers_kyc_payment_fields.sql
-- Phase 11B Step 2 backend extension — add KYC + payment + emergency-contact
-- columns to helpers so admin-driven pro registration can capture the full
-- onboarding payload in a single POST /admin/workers call.
--
-- All columns nullable so existing pros (created before this migration) keep
-- working unchanged. Gender uses a CHECK constraint over a tight enum.
--
-- PII / sensitive-data handling for this phase:
--   * aadhaar_number stored as-is (plaintext). Acceptable during pilot with
--     solo-founder + small admin team. NOT acceptable past 5+ admin users
--     or any regulatory audit.
--   * bank_account_number stored as-is. Same constraint.
--   * Both fields get encrypted-at-rest + masked-in-GET treatment in Phase 12.
--     See TODO comments in internal/crm/workers/repository.go.
--
-- Forward-only per repo policy. No .down.sql.

ALTER TABLE helpers
    ADD COLUMN IF NOT EXISTS dob                       DATE,
    ADD COLUMN IF NOT EXISTS gender                    VARCHAR(16),
    ADD COLUMN IF NOT EXISTS languages                 TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS alt_phone                 VARCHAR(20),
    ADD COLUMN IF NOT EXISTS emergency_contact_name    VARCHAR(200),
    ADD COLUMN IF NOT EXISTS emergency_contact_phone   VARCHAR(20),
    ADD COLUMN IF NOT EXISTS aadhaar_number            VARCHAR(20),
    ADD COLUMN IF NOT EXISTS aadhaar_verified          BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS bank_account_number       VARCHAR(40),
    ADD COLUMN IF NOT EXISTS bank_account_holder_name  VARCHAR(200),
    ADD COLUMN IF NOT EXISTS bank_ifsc                 VARCHAR(20),
    ADD COLUMN IF NOT EXISTS bank_verified             BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS photo_url                 TEXT;

-- Gender enum guard. NULL stays allowed (pre-existing rows).
ALTER TABLE helpers DROP CONSTRAINT IF EXISTS helpers_gender_check;
ALTER TABLE helpers
    ADD CONSTRAINT helpers_gender_check
    CHECK (gender IS NULL OR gender IN ('male', 'female', 'other'));

-- Dedup / lookup index on aadhaar_number. Partial so the index only carries
-- rows with a value — keeps it tiny until adoption grows.
CREATE INDEX IF NOT EXISTS idx_helpers_aadhaar
    ON helpers (aadhaar_number)
    WHERE aadhaar_number IS NOT NULL;

-- Operational queue index — "pros with bank info supplied but not yet
-- verified" is the working set for whoever runs penny-drop verification.
-- Skip rows with no bank info (nothing to verify) and rows already verified.
CREATE INDEX IF NOT EXISTS idx_helpers_pending_bank_verification
    ON helpers (approval_status)
    WHERE bank_verified = FALSE AND bank_account_number IS NOT NULL;
