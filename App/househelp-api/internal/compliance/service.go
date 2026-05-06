// Package compliance owns the user-data lifecycle: DSAR export, soft-delete,
// hard-delete (PurgeUserData), retention crons over append-only logs, and
// consent ledger management. Audit C-8 / F2D-1: today the soft-delete in
// internal/auth/repository.go scrubs four columns on users only, the post-
// delete hook is Redis-only, and the "30-day grace cron" the comment claims
// does not exist anywhere in the repo. This package is the place that
// fixes that — incrementally, table by table, with retention decisions
// recorded in retention.RetentionPolicy entries.
//
// Chunk 1 status: scaffold only. The Service is wired so cmd/api can
// instantiate it, the registry exists but is empty, no PurgeUserData
// implementation exists yet. Subsequent chunks fill the registry and the
// purge logic per-table after explicit retention decisions.
package compliance

import (
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service is the compliance entry point. It depends on a write pool (the
// purge path mutates user-owned rows) and is wired with whatever retention
// policies have been registered for the current pass.
//
// The Service is intentionally narrow: it does not implement the Fiber
// handler interface itself — the auth handler exposes /me/export and
// DELETE /me, and those handlers call into this Service. That keeps the
// HTTP surface in one place (auth) and the data-lifecycle logic in
// another (compliance).
type Service struct {
	db       *pgxpool.Pool
	policies *Registry
}

// NewService constructs a Service. policies may be nil — the Service
// degrades to "no retention policies registered" mode, which is exactly
// the chunk-1 scaffold state.
func NewService(db *pgxpool.Pool, policies *Registry) *Service {
	if policies == nil {
		policies = NewRegistry()
	}
	return &Service{db: db, policies: policies}
}

// DB returns the write pool. Exposed so future chunks can run multi-table
// transactions inline; not used today.
func (s *Service) DB() *pgxpool.Pool { return s.db }

// Policies returns the registered retention policies. Read-only access.
func (s *Service) Policies() *Registry { return s.policies }
