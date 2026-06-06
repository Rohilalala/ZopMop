-- Forward-only repo policy per cmd/migrate/main.go:9. This down file exists for
-- tooling completeness only; do not run it as part of normal rollback.
--
-- Reverts service_steps.icon to NULL for exactly the rows 115 set (the 'step-N'
-- numeral keys), restoring the post-Step-2 state so a local up->down->up passes.

UPDATE service_steps SET icon = NULL WHERE icon LIKE 'step-%';
