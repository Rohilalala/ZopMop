-- 074_compliance_tombstone_user.sql
-- Audit C-8 / F2D-1: insert the sentinel "deleted user" row that compliance
-- uses as the FK target when anonymising user-tagged history (e.g.
-- booking_messages.sender_id reassigned to this row when the original
-- account is purged but the chat content is retained for trust & safety
-- review per RetentionPolicy).
--
-- The id is fixed: 00000000-0000-0000-0000-000000000000. Code references
-- it via compliance.TombstoneUserID. Idempotent via ON CONFLICT (id).

INSERT INTO users (
    id,
    phone,
    name,
    role,
    is_suspended,
    deleted_at,
    deletion_reason,
    has_accepted_privacy_policy,
    privacy_policy_accepted_at,
    created_at,
    updated_at
)
VALUES (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'del:tombstone',
    NULL,
    'customer',
    TRUE,                                            -- never logs in
    '1970-01-01T00:00:00Z'::timestamptz,             -- epoch sentinel
    'compliance:tombstone',
    TRUE,
    '1970-01-01T00:00:00Z'::timestamptz,
    '1970-01-01T00:00:00Z'::timestamptz,
    '1970-01-01T00:00:00Z'::timestamptz
)
ON CONFLICT (id) DO NOTHING;
