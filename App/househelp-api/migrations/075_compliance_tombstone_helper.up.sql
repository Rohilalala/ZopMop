-- 075_compliance_tombstone_helper.sql
-- Audit C-8 / F2D-1 chunk 3: insert the helpers-side tombstone row so
-- reviews.helper_id can be reassigned to the same TombstoneUserID when
-- a helper deletes their account. Without this row the reassignment
-- UPDATE would violate the reviews_helper_id_fkey constraint
-- (helper_id REFERENCES helpers(id)).
--
-- helpers.id has a 1:1 FK identity with users.id (helpers extend users
-- via shared PK), so the same UUID 00000000-... is used. The users-side
-- tombstone row was inserted by migration 074. The helpers FK to users
-- with ON DELETE CASCADE is satisfied because that users row already
-- exists.
--
-- Default rating=5.00 is the schema default; orphaned reviews under
-- the tombstone helper aren't displayed anywhere (no live profile),
-- so the rating value is operationally meaningless.

INSERT INTO helpers (
    id,
    is_available,
    rating,
    total_jobs,
    created_at
)
VALUES (
    '00000000-0000-0000-0000-000000000000'::uuid,
    FALSE,                                       -- never appears in matching
    5.00,                                        -- schema default; not displayed
    0,
    '1970-01-01T00:00:00Z'::timestamptz
)
ON CONFLICT (id) DO NOTHING;
