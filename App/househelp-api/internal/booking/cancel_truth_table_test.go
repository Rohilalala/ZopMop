package booking

// cancel_truth_table_test.go — pure-function regression guard for the
// cancellation truth table. The status check inside CancelBooking is the
// ONLY thing preventing a pro from self-service-cancelling an
// in-progress unpaid booking — which would silently bypass the
// completed-and-unpaid customer block that the whole Phase 1
// payment-gated flow depends on (see
// docs/phase-1-payment-gated-flow.md).
//
// A future refactor that "simplifies" the status check could inadvertently
// re-open the bypass. This test pins every status + every accepted-substate
// combination so any change to IsCancellable / IsCancellableStatus
// requires either updating the table or breaking these tests
// deliberately. Same philosophy as
// internal/payroll/decoupling_test.go.

import (
	"testing"
	"time"
)

// TestIsCancellableStatus_PinsTruthTable asserts the full status enum is
// covered + every value's outcome. If someone adds a new BookingStatus
// constant (e.g. 'pending_customer_action' for some future flow), the
// switch in IsCancellableStatus falls through to the default-return
// (false), and this test still passes for known statuses — but the new
// status needs a row added here, forcing a deliberate decision.
func TestIsCancellableStatus_PinsTruthTable(t *testing.T) {
	t.Parallel()
	type row struct {
		status BookingStatus
		want   bool
		why    string
	}
	rows := []row{
		{StatusPending, true, "customer hasn't been matched yet"},
		{StatusSearching, false, "StealthDispatcher actively dispatching; cancel would race"},
		{StatusAccepted, true, "pro accepted; pre-trip-commit cancel is legitimate"},
		{StatusInProgress, false, "service STARTED — would bypass the unpaid-block escape hatch"},
		{StatusCompleted, false, "terminal"},
		{StatusCancelled, false, "already terminal"},
	}
	for _, r := range rows {
		got := IsCancellableStatus(r.status)
		if got != r.want {
			t.Errorf("IsCancellableStatus(%q) = %v, want %v (%s)", r.status, got, r.want, r.why)
		}
	}
}

// TestIsCancellableStatus_UnknownStatusRejected guards against a future
// enum addition silently inheriting "cancellable". The fall-through in
// the switch returns false for any unrecognised value; this test pins
// that.
func TestIsCancellableStatus_UnknownStatusRejected(t *testing.T) {
	t.Parallel()
	cases := []BookingStatus{
		"unknown",
		"future_state",
		"",
		"PENDING", // wrong case
		"pending_customer_action",
	}
	for _, s := range cases {
		if IsCancellableStatus(s) {
			t.Errorf("IsCancellableStatus(%q) = true, want false (unknown statuses must default to NOT cancellable)", s)
		}
	}
}

// TestIsCancellable_SubstateGuards pins the accepted-substate behaviour.
// status='accepted' alone is cancellable; once en_route_at OR arrived_at
// is stamped the pro has committed to the trip and the only out is admin
// force-complete via the CRM (per docs/phase-1-payment-gated-flow.md).
func TestIsCancellable_SubstateGuards(t *testing.T) {
	t.Parallel()
	now := time.Now()

	type row struct {
		name string
		b    *Booking
		want bool
	}
	rows := []row{
		{
			"nil booking — defensive false",
			nil,
			false,
		},
		{
			"accepted, no timestamps — cancellable",
			&Booking{Status: StatusAccepted},
			true,
		},
		{
			"accepted + en_route_at set — pro committed to trip — rejected",
			&Booking{Status: StatusAccepted, EnRouteAt: &now},
			false,
		},
		{
			"accepted + arrived_at set — pro at customer — rejected",
			&Booking{Status: StatusAccepted, ArrivedAt: &now},
			false,
		},
		{
			"accepted + en_route_at + arrived_at set — rejected",
			&Booking{Status: StatusAccepted, EnRouteAt: &now, ArrivedAt: &now},
			false,
		},
		{
			"pending — substates irrelevant — cancellable",
			&Booking{Status: StatusPending},
			true,
		},
		{
			"in_progress — substates irrelevant — rejected",
			&Booking{Status: StatusInProgress, EnRouteAt: &now, ArrivedAt: &now, StartedAt: &now},
			false,
		},
		{
			"completed — terminal — rejected",
			&Booking{Status: StatusCompleted, EnRouteAt: &now, ArrivedAt: &now, StartedAt: &now, CompletedAt: &now},
			false,
		},
		{
			"cancelled — terminal — rejected",
			&Booking{Status: StatusCancelled},
			false,
		},
		{
			"searching — rejected (matching engine actively dispatching)",
			&Booking{Status: StatusSearching},
			false,
		},
	}
	for _, r := range rows {
		got := IsCancellable(r.b)
		if got != r.want {
			t.Errorf("IsCancellable: %s\n  got = %v, want = %v", r.name, got, r.want)
		}
	}
}
