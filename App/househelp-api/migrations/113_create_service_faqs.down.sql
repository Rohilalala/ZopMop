-- Forward-only repo policy per cmd/migrate/main.go:9. This down file exists for
-- tooling completeness only; do not run it as part of normal rollback.
--
-- Drops the per-service FAQ table created in 113. (Seed rows from 114 are removed
-- by 114's down; this also cascades if run while rows still exist.)

DROP TABLE IF EXISTS service_faqs;
