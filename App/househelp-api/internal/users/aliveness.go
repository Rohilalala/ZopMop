// Package users exposes shared SQL fragments for queries touching the
// users table.
//
// Kept as a leaf package (no domain imports) so any package that reads
// users can depend on it without inverting the dependency graph onto
// internal/auth.
package users

// AliveCondition is the SQL WHERE-clause fragment that excludes soft-
// deleted users. Append to every users-table read path that should not
// surface deleted rows.
//
// For LEFT JOIN preservation patterns (where the parent row must remain
// visible — e.g. a booking row whose customer was later deleted), put
// this in the JOIN ON clause instead of the WHERE so the parent row
// survives and the user-sourced columns come back NULL.
//
// Audit trail: B5-D1/D2.
const AliveCondition = "deleted_at IS NULL"
