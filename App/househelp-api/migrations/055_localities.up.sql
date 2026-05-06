-- 055_localities.sql
-- Operational localities — admin-managed via the CRM. Helpers pick from the
-- active list; bookings snapshot their locality at create time by fuzzy
-- match against this table. No spatial geometry — text match only.

CREATE TABLE IF NOT EXISTS localities (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    city        TEXT        NOT NULL,
    active      BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (name, city)
);

CREATE INDEX IF NOT EXISTS idx_localities_city_active
    ON localities (city, active)
    WHERE active = true;

-- Seed initial operational areas. Edit via CRM after launch.
INSERT INTO localities (name, city, active) VALUES
    ('Sector 51',     'Gurugram', true),
    ('Sector 50',     'Gurugram', true),
    ('Sector 49',     'Gurugram', true),
    ('Sector 56',     'Gurugram', true),
    ('Sector 57',     'Gurugram', true),
    ('Sector 43',     'Gurugram', true),
    ('Sushant Lok',   'Gurugram', true),
    ('DLF Phase 1',   'Gurugram', true),
    ('DLF Phase 2',   'Gurugram', true),
    ('DLF Phase 3',   'Gurugram', true),
    ('DLF Phase 4',   'Gurugram', true),
    ('DLF Phase 5',   'Gurugram', true),
    ('Golf Course Road', 'Gurugram', true),
    ('MG Road',       'Gurugram', true),
    ('Cyber Hub',     'Gurugram', true)
ON CONFLICT (name, city) DO NOTHING;
