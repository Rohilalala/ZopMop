-- 011_extend_service_categories.sql
-- Adds rich metadata columns to service_categories and creates
-- service_includes, service_excludes, service_steps, service_addons tables.

ALTER TABLE service_categories
    ADD COLUMN IF NOT EXISTS description         TEXT,
    ADD COLUMN IF NOT EXISTS short_description   VARCHAR(255),
    ADD COLUMN IF NOT EXISTS emoji               VARCHAR(10),
    ADD COLUMN IF NOT EXISTS bg_color            VARCHAR(20)    NOT NULL DEFAULT '#EEF2FF',
    ADD COLUMN IF NOT EXISTS rating              DECIMAL(3,1)   NOT NULL DEFAULT 4.9,
    ADD COLUMN IF NOT EXISTS review_count        INTEGER        NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS mrp_cents           INTEGER,
    ADD COLUMN IF NOT EXISTS min_duration_minutes  INTEGER      NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS max_duration_minutes  INTEGER      NOT NULL DEFAULT 90,
    ADD COLUMN IF NOT EXISTS duration_step_minutes INTEGER      NOT NULL DEFAULT 15;

-- What's included in the service
CREATE TABLE IF NOT EXISTS service_includes (
    id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id   UUID    NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    item         TEXT    NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_service_includes_service_id ON service_includes (service_id);

-- What's excluded from the service
CREATE TABLE IF NOT EXISTS service_excludes (
    id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id   UUID    NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    item         TEXT    NOT NULL,
    display_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_service_excludes_service_id ON service_excludes (service_id);

-- How the service works (step-by-step)
CREATE TABLE IF NOT EXISTS service_steps (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id  UUID         NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    step_number INTEGER      NOT NULL,
    title       VARCHAR(100) NOT NULL,
    description TEXT,
    icon        VARCHAR(10),
    UNIQUE (service_id, step_number)
);
CREATE INDEX IF NOT EXISTS idx_service_steps_service_id ON service_steps (service_id);

-- Optional add-on services for a base service
CREATE TABLE IF NOT EXISTS service_addons (
    id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id       UUID    NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    addon_service_id UUID    NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
    display_order    INTEGER NOT NULL DEFAULT 0,
    UNIQUE (service_id, addon_service_id)
);
CREATE INDEX IF NOT EXISTS idx_service_addons_service_id ON service_addons (service_id);
