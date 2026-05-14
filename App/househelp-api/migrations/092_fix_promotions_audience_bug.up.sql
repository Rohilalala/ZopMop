-- Audit flagged: CHECK allows 'specific' but Go queries 'user_segment'.
-- Standardize to 'specific'. Update Go later in Phase 4.
-- This migration is data-only — fix any rows with mismatched value.
UPDATE promotions SET audience = 'specific' WHERE audience NOT IN ('all','new_users','vip','specific');
-- CHECK constraint stays as-is. Go code will be updated to query 'specific' in Phase 4.
