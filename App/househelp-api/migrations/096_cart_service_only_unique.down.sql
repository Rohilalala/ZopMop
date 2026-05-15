-- Forward-only repo policy per cmd/migrate/main.go:9. This down file exists for
-- tooling completeness only; do not run it as part of normal rollback.
DROP INDEX IF EXISTS idx_cart_items_unique_service_only;
