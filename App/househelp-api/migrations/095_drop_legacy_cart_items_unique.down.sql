-- Forward-only repo policy per cmd/migrate/main.go:9. This down file exists for
-- tooling completeness only; do not run it as part of normal rollback.
ALTER TABLE cart_items ADD CONSTRAINT cart_items_cart_id_service_id_key UNIQUE (cart_id, service_id);
