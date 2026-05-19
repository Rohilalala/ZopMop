-- 102_pro_contact_reveals.sql
-- Phase 11A — audit trail for pro-initiated customer contact reveals.
--
-- Every successful POST /api/v1/pro/jobs/:id/contact inserts a row here so
-- ops can audit "who saw what when" — required by privacy review since the
-- endpoint hands back an unmasked phone number.
--
-- Forward-only per repo policy. No .down.sql.

CREATE TABLE IF NOT EXISTS pro_contact_reveals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    pro_id          UUID NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    revealed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pro_user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS idx_pro_contact_reveals_booking
    ON pro_contact_reveals (booking_id, revealed_at DESC);

CREATE INDEX IF NOT EXISTS idx_pro_contact_reveals_pro
    ON pro_contact_reveals (pro_id, revealed_at DESC);
