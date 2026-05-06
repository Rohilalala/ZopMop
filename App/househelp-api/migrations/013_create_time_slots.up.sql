-- 013_create_time_slots.sql
-- Time slots available for booking. Slots are pre-generated per date.

CREATE TABLE IF NOT EXISTS time_slots (
    id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_date        DATE    NOT NULL,
    start_time       TIME    NOT NULL,
    end_time         TIME    NOT NULL,
    max_bookings     INTEGER NOT NULL DEFAULT 10,
    current_bookings INTEGER NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (slot_date, start_time)
);

CREATE INDEX IF NOT EXISTS idx_time_slots_date ON time_slots (slot_date);
