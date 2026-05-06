package compliance

import (
	"testing"
	"time"
)

// Pure-Go scaffold tests for Chunk 1. No DB. Covers:
//   - NewService accepts nil registry and substitutes a fresh empty one
//   - Registry starts empty (chunk-1 invariant)
//   - Register / Lookup round-trips a policy
//   - Lookup of an unregistered table returns ok=false (caller is meant
//     to map this to ErrPolicyDecisionRequired — the registry itself
//     doesn't enforce that, the Service layer will in chunks 2+).

func TestNewService_NilRegistryFallsBackToEmpty(t *testing.T) {
	svc := NewService(nil, nil)
	if svc.Policies() == nil {
		t.Fatalf("Policies() returned nil; expected an empty Registry")
	}
	if got := svc.Policies().Len(); got != 0 {
		t.Fatalf("expected empty registry, got Len=%d", got)
	}
}

func TestRegistry_StartsEmpty(t *testing.T) {
	r := NewRegistry()
	if r.Len() != 0 {
		t.Fatalf("Len=%d, want 0", r.Len())
	}
	if _, ok := r.Lookup("user_addresses"); ok {
		t.Fatalf("Lookup on fresh registry returned ok=true; expected false")
	}
}

func TestRegistry_RegisterLookupRoundtrip(t *testing.T) {
	r := NewRegistry()
	policy := RetentionPolicy{
		Table:        "user_addresses",
		Action:       ActionDelete,
		UserIDColumn: "user_id",
		LegalBasis:   "test scaffold",
	}
	prev, replaced := r.Register(policy)
	if replaced {
		t.Fatalf("first Register reported replaced=true")
	}
	if prev.Table != "" {
		t.Fatalf("first Register returned non-zero previous: %+v", prev)
	}

	got, ok := r.Lookup("user_addresses")
	if !ok {
		t.Fatalf("Lookup after Register returned ok=false")
	}
	if got.Action != ActionDelete || got.LegalBasis != "test scaffold" {
		t.Fatalf("policy round-trip mismatch: %+v", got)
	}
}

func TestRegistry_RegisterReplaces(t *testing.T) {
	r := NewRegistry()
	r.Register(RetentionPolicy{Table: "x", Action: ActionDelete})
	prev, replaced := r.Register(RetentionPolicy{
		Table:  "x",
		Action: ActionAnonymize,
		Window: 30 * 24 * time.Hour,
	})
	if !replaced {
		t.Fatalf("second Register reported replaced=false")
	}
	if prev.Action != ActionDelete {
		t.Fatalf("previous policy not preserved: %+v", prev)
	}
	got, _ := r.Lookup("x")
	if got.Action != ActionAnonymize {
		t.Fatalf("replacement policy not applied: %+v", got)
	}
}

// TestPolicyRegistry_HelperStatusLogRegistered confirms the chunk-9
// retention policy for helper_status_log is wired with the right
// window (90 days), action (Delete), time-based UserIDColumn
// (recorded_at, not user_id — the table has no user surface), and
// legal basis. Helper deletion is handled by the existing CASCADE FK
// to helpers, so there's no compliance.Service method to test
// alongside this — policy registration is the entire chunk-9 surface.
func TestPolicyRegistry_HelperStatusLogRegistered(t *testing.T) {
	r := NewRegistry()
	RegisterDefaultPolicies(r)

	got, ok := r.Lookup("helper_status_log")
	if !ok {
		t.Fatalf("helper_status_log policy not registered")
	}
	if got.Action != ActionDelete {
		t.Errorf("Action = %s, want %s", got.Action, ActionDelete)
	}
	const want = 90 * 24 * time.Hour
	if got.Window != want {
		t.Errorf("Window = %s, want %s (90 days)", got.Window, want)
	}
	if got.UserIDColumn != "recorded_at" {
		t.Errorf("UserIDColumn = %q, want recorded_at (time-based sweep)", got.UserIDColumn)
	}
	if got.LegalBasis != "operational_activity_log" {
		t.Errorf("LegalBasis = %q, want operational_activity_log", got.LegalBasis)
	}
}

// TestPolicyRegistry_PushMessagesRegistered confirms the chunk-8
// retention policy for crm_push_messages is wired with the right
// window + action + legal basis. This is the only verifiable
// behaviour for chunk 8 since the campaign-level schema admits no
// runtime SoftDeleteUser hook (no per-recipient row to scrub).
func TestPolicyRegistry_PushMessagesRegistered(t *testing.T) {
	r := NewRegistry()
	RegisterDefaultPolicies(r)

	got, ok := r.Lookup("crm_push_messages")
	if !ok {
		t.Fatalf("crm_push_messages policy not registered")
	}
	if got.Action != ActionDelete {
		t.Errorf("Action = %s, want %s", got.Action, ActionDelete)
	}
	const want = 90 * 24 * time.Hour
	if got.Window != want {
		t.Errorf("Window = %s, want %s (90 days)", got.Window, want)
	}
	if got.LegalBasis != "marketing_analytics_window" {
		t.Errorf("LegalBasis = %q, want marketing_analytics_window", got.LegalBasis)
	}
	if got.UserIDColumn != "created_at" {
		t.Errorf("UserIDColumn = %q, want created_at (time-based sweep)", got.UserIDColumn)
	}
}

func TestRegistry_AllSnapshotsCopy(t *testing.T) {
	r := NewRegistry()
	r.Register(RetentionPolicy{Table: "a", Action: ActionDelete})
	r.Register(RetentionPolicy{Table: "b", Action: ActionRetain, Window: time.Hour})
	all := r.All()
	if len(all) != 2 {
		t.Fatalf("All() len=%d, want 2", len(all))
	}
	// Confirm All returned a snapshot, not a live view: mutating it must
	// not affect future Lookups.
	all[0] = RetentionPolicy{Table: "tampered"}
	got, _ := r.Lookup("a")
	if got.Table != "a" {
		t.Fatalf("registry leaked internal state through All(): got %+v", got)
	}
}
