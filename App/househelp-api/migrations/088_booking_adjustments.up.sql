CREATE TABLE IF NOT EXISTS booking_adjustments (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id              UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    booking_service_id      UUID NOT NULL REFERENCES booking_services(id) ON DELETE CASCADE,
    proposed_by_helper_id   UUID NOT NULL REFERENCES users(id),
    old_variant_id          UUID NOT NULL REFERENCES service_variants(id),
    new_variant_id          UUID NOT NULL REFERENCES service_variants(id),
    delta_paise             BIGINT NOT NULL,                 -- positive = upgrade, negative = downgrade
    pro_note                TEXT,
    photo_url               TEXT,                            -- evidence photo from pro
    status                  VARCHAR(20) NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
    customer_responded_at   TIMESTAMPTZ,
    expires_at              TIMESTAMPTZ NOT NULL,            -- e.g. now() + 10 min
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_booking_adjustments_booking ON booking_adjustments (booking_id);
CREATE INDEX idx_booking_adjustments_status ON booking_adjustments (status, expires_at)
    WHERE status = 'pending';
