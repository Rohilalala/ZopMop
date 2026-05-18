-- 104_admin_booking_notes.sql
-- Phase 11B — free-text notes attached to a booking by a CRM admin.
-- Append-only audit trail visible from the booking detail page.

CREATE TABLE IF NOT EXISTS admin_booking_notes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    admin_id    UUID NOT NULL REFERENCES crm_admins(id),
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_booking_notes_booking
    ON admin_booking_notes (booking_id, created_at DESC);
