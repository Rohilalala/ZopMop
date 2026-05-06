-- 014_update_bookings_for_scheduling.sql
-- Adds scheduling fields to bookings and creates booking_services for multi-service bookings.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS address_id             UUID        REFERENCES user_addresses(id),
    ADD COLUMN IF NOT EXISTS time_slot_id           UUID        REFERENCES time_slots(id),
    ADD COLUMN IF NOT EXISTS scheduled_time         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS total_duration_minutes INTEGER     NOT NULL DEFAULT 0;

-- One row per service within a booking (replaces single service_category_id for new flow)
CREATE TABLE IF NOT EXISTS booking_services (
    id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id       UUID    NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    service_id       UUID    NOT NULL REFERENCES service_categories(id),
    duration_minutes INTEGER NOT NULL,
    price_cents      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_booking_services_booking_id ON booking_services (booking_id);
