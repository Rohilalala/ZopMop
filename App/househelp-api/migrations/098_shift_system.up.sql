-- 098_shift_system.up.sql
--
-- Phase 7 Part A: pro shift commitment, online sessions, zone
-- approval, cancellations, absences.
--
-- Naming reconciliation: the spec uses `pros`, `zones`, `admins`,
-- `fortnights`. This repo has:
--   * helpers           — PK = users(id); the canonical "pros" table
--                         (a user with users.role='pro' has a matching
--                         helpers row carrying pro-only fields).
--   * service_zones     — the canonical "zones" table.
--   * admin_users       — the canonical "admins" table (PK = users(id)).
--   * no fortnights     — use a fortnight_start DATE anchor on each
--                         absence + on helpers.
--
-- Forward-only per backend CLAUDE.md (no .down.sql).

-- 1. Helpers gets fortnight + perf-rolling columns.
ALTER TABLE helpers
    ADD COLUMN IF NOT EXISTS weekly_hours_target           INT  NOT NULL DEFAULT 80,
    ADD COLUMN IF NOT EXISTS fortnight_start_date          DATE,
    ADD COLUMN IF NOT EXISTS current_fortnight_online_min  INT  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cancellation_count_30d        INT  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS leave_balance                 INT  NOT NULL DEFAULT 0;

-- Default fortnight anchor: first Monday on or before today. The
-- 3 AM cron resets to the next fortnight when current_fortnight_end
-- has passed.
UPDATE helpers
   SET fortnight_start_date = (current_date - ((extract(dow FROM current_date)::int + 6) % 7))
 WHERE fortnight_start_date IS NULL;

-- 2. Pro zone assignment — which service_zone a pro is mapped to,
--    with history.
CREATE TABLE IF NOT EXISTS pro_zone_assignments (
    pro_id          UUID        NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    zone_id         UUID        NOT NULL REFERENCES service_zones(id),
    effective_from  DATE        NOT NULL,
    effective_to    DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pro_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_pro_zone_current
    ON pro_zone_assignments (pro_id)
    WHERE effective_to IS NULL;

-- 3. Shift commitments — pro pre-declares each shift; locked at 3 AM IST
--    of the shift date.
CREATE TABLE IF NOT EXISTS shift_commitments (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pro_id             UUID        NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    shift_date         DATE        NOT NULL,
    start_time         TIME        NOT NULL,
    end_time           TIME        NOT NULL,
    committed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at          TIMESTAMPTZ,                                      -- stamped by 3 AM cron
    status             VARCHAR(16) NOT NULL DEFAULT 'committed'
        CHECK (status IN ('committed','active','completed','missed','cancelled')),
    online_started_at  TIMESTAMPTZ,
    online_ended_at    TIMESTAMPTZ,
    late_show          BOOLEAN     NOT NULL DEFAULT false,                -- Go Online tapped > 30 min after start
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pro_id, shift_date, start_time)
);

CREATE INDEX IF NOT EXISTS idx_shift_commitments_pro_date
    ON shift_commitments (pro_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_shift_commitments_status_date
    ON shift_commitments (status, shift_date);

-- 4. Shift sessions — one per online-tap → offline-tap pair. A single
--    commitment can have multiple sessions if the pro toggles online
--    state mid-shift.
CREATE TABLE IF NOT EXISTS shift_sessions (
    id                             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    commitment_id                  UUID        NOT NULL REFERENCES shift_commitments(id) ON DELETE CASCADE,
    pro_id                         UUID        NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    online_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    offline_at                     TIMESTAMPTZ,
    online_minutes                 INT,                                  -- computed at offline tap
    job_minutes                    INT         NOT NULL DEFAULT 0,
    location_verified_at_start     BOOLEAN     NOT NULL DEFAULT false,
    manual_approval_used           BOOLEAN     NOT NULL DEFAULT false,
    manual_approval_admin_id       UUID        REFERENCES admin_users(id),
    start_lat                      DECIMAL(10,8),
    start_lng                      DECIMAL(11,8),
    created_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shift_sessions_pro_open
    ON shift_sessions (pro_id)
    WHERE offline_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shift_sessions_commitment
    ON shift_sessions (commitment_id);

-- 5. Booking cancellations — pro-initiated, fuels the 5-strike rule.
--    Only counts toward the rule when the customer was actually
--    notified (i.e. booking had already transitioned past pending).
CREATE TABLE IF NOT EXISTS booking_cancellations (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pro_id                   UUID        NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    booking_id               UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    cancelled_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    customer_was_notified    BOOLEAN     NOT NULL DEFAULT false,
    estimated_job_minutes    INT         NOT NULL DEFAULT 0,
    penalty_amount_paise     INT         NOT NULL DEFAULT 0,
    cancellation_index_30d   INT         NOT NULL DEFAULT 0,             -- 1..N within rolling 30-day window
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_cancellations_pro_time
    ON booking_cancellations (pro_id, cancelled_at DESC);

-- 6. Absence records — 3 AM cron writes one per pro per skipped day;
--    also covers manual sick/casual leave entered later.
CREATE TABLE IF NOT EXISTS absence_records (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pro_id                UUID        NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    absence_date          DATE        NOT NULL,
    reason                VARCHAR(32) NOT NULL
        CHECK (reason IN ('no_commit_by_3am','missed_shift','sick_leave','casual_leave','manual')),
    is_first_in_fortnight BOOLEAN     NOT NULL DEFAULT false,
    leave_deducted        BOOLEAN     NOT NULL DEFAULT false,
    cash_deducted_paise   INT         NOT NULL DEFAULT 0,
    fortnight_start       DATE        NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (pro_id, absence_date, reason)
);

CREATE INDEX IF NOT EXISTS idx_absence_pro_fortnight
    ON absence_records (pro_id, fortnight_start);

-- 7. Zone approval requests — outside-zone manual approval flow.
CREATE TABLE IF NOT EXISTS zone_approval_requests (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pro_id                UUID        NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
    shift_commitment_id   UUID        NOT NULL REFERENCES shift_commitments(id) ON DELETE CASCADE,
    requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    current_lat           DECIMAL(10,8) NOT NULL,
    current_lng           DECIMAL(11,8) NOT NULL,
    photo_url             TEXT,
    status                VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected')),
    reviewed_by           UUID        REFERENCES admin_users(id),
    reviewed_at           TIMESTAMPTZ,
    notes                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_zone_approval_pending
    ON zone_approval_requests (status, requested_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_zone_approval_commitment
    ON zone_approval_requests (shift_commitment_id);
