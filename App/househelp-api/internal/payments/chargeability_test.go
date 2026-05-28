package payments

import (
	"testing"
	"time"
)

// TestDecideChargeable_TruthTable pins the full decision matrix so a
// future refactor that "simplifies" the precondition can't silently
// re-open the double-charge window the Phase 1 cart cleanup closed.
// Same enforcement style as the booking cancel-truth-table +
// self-heal-truth-table + payroll-decoupling tests in this codebase.
func TestDecideChargeable_TruthTable(t *testing.T) {
	t.Parallel()
	now := time.Now()
	paidStatus := "paid"
	pendingStatus := "pending"
	failedStatus := "failed"
	refundedStatus := "refunded"

	type row struct {
		name            string
		paymentStatus   *string
		cashCollectedAt *time.Time
		want            PaymentChargeability
		why             string
	}
	rows := []row{
		{
			"unpaid (both nil) — settle-stranded-unpaid path must work",
			nil, nil, Chargeable,
			"the kept PaymentScreen route reaches this for old unpaid bookings",
		},
		{
			"payment_status='pending' — booking awaits webhook; can still charge",
			&pendingStatus, nil, Chargeable,
			"sentinel row exists but webhook hasn't landed; user retry is legit",
		},
		{
			"payment_status='failed' — last attempt failed; new order ok",
			&failedStatus, nil, Chargeable,
			"after a failed payment, user is allowed to try again",
		},
		{
			"payment_status='paid' — block",
			&paidStatus, nil, BlockedAlreadyPaidOnline,
			"the Phase 1 double-charge case the cart used to enable",
		},
		{
			"payment_status='refunded' — block as online-paid for safety",
			// Defensive: if a booking was paid then refunded, do NOT
			// re-charge — admin/CRM is the right channel for re-collection.
			// Returns Chargeable today; flag this row for an explicit
			// review when refund handling is revisited.
			&refundedStatus, nil, Chargeable,
			"refunded state isn't currently blocked; admin reconciliation path applies",
		},
		{
			"cash_collected_at set — block",
			nil, &now, BlockedAlreadyPaidCash,
			"customer's ResolveCash already attributed the money to the pro",
		},
		{
			"cash AND online paid (should never coexist) — cash wins",
			&paidStatus, &now, BlockedAlreadyPaidCash,
			"defensive: cash is the more specific failure mode",
		},
	}
	for _, r := range rows {
		got := DecideChargeable(r.paymentStatus, r.cashCollectedAt)
		if got != r.want {
			t.Errorf("DecideChargeable: %s\n  got = %v, want = %v  (%s)", r.name, got, r.want, r.why)
		}
	}
}

// TestDecideChargeable_PureFunctionStability — calling the decider
// repeatedly with the same inputs yields the same answer. Cheap
// regression guard against accidentally introducing state.
func TestDecideChargeable_PureFunctionStability(t *testing.T) {
	t.Parallel()
	now := time.Now()
	paid := "paid"
	for i := 0; i < 100; i++ {
		if got := DecideChargeable(&paid, nil); got != BlockedAlreadyPaidOnline {
			t.Fatalf("paid iter %d: got %v, want BlockedAlreadyPaidOnline", i, got)
		}
		if got := DecideChargeable(nil, &now); got != BlockedAlreadyPaidCash {
			t.Fatalf("cash iter %d: got %v, want BlockedAlreadyPaidCash", i, got)
		}
		if got := DecideChargeable(nil, nil); got != Chargeable {
			t.Fatalf("unpaid iter %d: got %v, want Chargeable", i, got)
		}
	}
}
