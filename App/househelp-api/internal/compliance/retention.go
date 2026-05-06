package compliance

import (
	"sync"
	"time"
)

// RetentionAction is what we do with a row when its retention window
// elapses or when a user requests purge. Every row of every table touched
// by PurgeUserData / retention crons must map to exactly one of these.
type RetentionAction string

const (
	// ActionDelete removes the row outright. Use for rows that are pure
	// PII with no legal/financial retention need (cart, device_tokens,
	// reengagement_notifications).
	ActionDelete RetentionAction = "delete"

	// ActionAnonymize keeps the row but scrubs PII columns in place. Use
	// for rows that must persist beyond the user's account lifetime for
	// counterparty / legal / financial reasons (bookings, refunds, audit
	// trails). The RetentionPolicy must list the columns to clear / mask.
	ActionAnonymize RetentionAction = "anonymize"

	// ActionRetain keeps the row unchanged. Use for rows whose PII content
	// is irreducible (e.g. an audit log entry where the action description
	// itself names the user). Retain is only allowed when a Window is set;
	// "retain forever" is forbidden — the registry validation rejects it.
	ActionRetain RetentionAction = "retain"
)

// RetentionPolicy describes how one table participates in compliance
// flows. Every table touched by PurgeUserData OR a retention cron must
// have one of these registered.
//
// LegalBasis is the human-readable justification (e.g. "GST Act 1985 §36
// — financial records 7 years", "DPDP §13 — operational defence", or
// "no legal basis, pure UX state — delete on request"). Logged on every
// purge / retention sweep so a compliance review can trace why each
// decision was made.
//
// TimeColumn is the TIMESTAMPTZ column that the retention-worker sweep
// compares against `now() - Window`. Examples: 'created_at', 'processed_at',
// 'completed_at', 'recorded_at'. NULL values in this column are skipped
// by the sweep — useful for tables where the column is set only on
// terminal-state rows (e.g. bookings.completed_at, pending_refunds.processed_at).
type RetentionPolicy struct {
	Table      string
	Action     RetentionAction
	Window     time.Duration   // age threshold for retention crons; 0 = no time-bound (only purge-on-request)
	Columns    []string        // columns to anonymize when Action=ActionAnonymize
	TimeColumn string          // TIMESTAMPTZ column the retention sweep compares against now()-Window
	LegalBasis string
}

// Registry holds the active set of RetentionPolicy entries. Goroutine-
// safe so the retention worker and the HTTP purge path can read concurrently.
//
// Chunk-1 state: empty. Chunks 2 and 3 register the unambiguous tables;
// chunk 5 (after policy decisions) registers the rest.
type Registry struct {
	mu       sync.RWMutex
	byTable  map[string]RetentionPolicy
}

// NewRegistry constructs an empty Registry. The caller registers each
// table explicitly via Register.
func NewRegistry() *Registry {
	return &Registry{byTable: make(map[string]RetentionPolicy)}
}

// Register adds or replaces a RetentionPolicy. Returns the previous
// policy if one existed (mostly useful for tests and admin tooling).
func (r *Registry) Register(p RetentionPolicy) (previous RetentionPolicy, replaced bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	previous, replaced = r.byTable[p.Table]
	r.byTable[p.Table] = p
	return
}

// Lookup returns the policy for a given table name, or zero-value +
// false if none is registered. Callers MUST treat (RetentionPolicy{},
// false) as ErrPolicyDecisionRequired — silently defaulting to
// ActionDelete or ActionRetain is exactly the audit-graded posture
// this package exists to prevent.
func (r *Registry) Lookup(table string) (RetentionPolicy, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.byTable[table]
	return p, ok
}

// All returns a snapshot copy of every registered policy. Used by the
// retention worker to iterate without holding the read lock.
func (r *Registry) All() []RetentionPolicy {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]RetentionPolicy, 0, len(r.byTable))
	for _, p := range r.byTable {
		out = append(out, p)
	}
	return out
}

// Len returns the number of registered policies. Cheap helper for the
// retention worker's "no policies registered, sleeping" log line.
func (r *Registry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.byTable)
}
