package payments

import "testing"

// TestDecideMarkAttemptFailed_TruthTable pins the full state-machine
// decision matrix so a future refactor can't silently re-open the
// webhook-wins race (current='success' must NEVER flip to 'failed' just
// because the SDK callback fired late). Same enforcement style as
// DecideChargeable's truth table; this is money code and the decider is
// the load-bearing safety primitive.
func TestDecideMarkAttemptFailed_TruthTable(t *testing.T) {
	t.Parallel()

	type row struct {
		name        string
		current     string
		wantAfter   string
		wantUpdate  bool
		why         string
	}
	rows := []row{
		{
			"pending -> failed (the happy SDK-callback path)",
			"pending", "failed", true,
			"SDK on_failure fired; flip the row, let cash fallback proceed",
		},
		{
			"success -> success no-update (WEBHOOK-WINS — load-bearing)",
			"success", "success", false,
			"webhook beat the SDK callback; payment is real; refusing to flip protects the customer's money",
		},
		{
			"failed -> failed no-update (idempotent re-call)",
			"failed", "failed", false,
			"already terminal; SDK double-fired or frontend retried; safe no-op",
		},
		{
			"refunded -> refunded no-update (admin-only terminal)",
			"refunded", "refunded", false,
			"admin/CRM refund path owns this state; stale callback must not clobber it",
		},
		{
			"unknown future status -> observe only",
			"awaiting_action", "awaiting_action", false,
			"a future status added by a Cashfree integration must not be force-flipped to failed by an old client",
		},
		{
			"empty status -> observe only (defensive)",
			"", "", false,
			"shouldn't happen — payments.gateway_status NOT NULL — but a future migration could; observe, don't write",
		},
	}

	for _, r := range rows {
		got := decideMarkAttemptFailedOutcome(r.current)
		if got.AfterStatus != r.wantAfter || got.WillUpdate != r.wantUpdate {
			t.Errorf("decideMarkAttemptFailedOutcome(%q): %s\n  got = {after:%q, write:%v}\n  want = {after:%q, write:%v}\n  (%s)",
				r.current, r.name,
				got.AfterStatus, got.WillUpdate,
				r.wantAfter, r.wantUpdate, r.why)
		}
	}
}

// TestDecideMarkAttemptFailed_PureFunctionStability — calling the decider
// repeatedly with the same input yields the same answer. 100 iterations
// catches accidental state introduction; same pattern as DecideChargeable.
func TestDecideMarkAttemptFailed_PureFunctionStability(t *testing.T) {
	t.Parallel()

	cases := map[string]markAttemptFailedOutcome{
		"pending":  {AfterStatus: "failed", WillUpdate: true},
		"success":  {AfterStatus: "success", WillUpdate: false},
		"failed":   {AfterStatus: "failed", WillUpdate: false},
		"refunded": {AfterStatus: "refunded", WillUpdate: false},
		"":         {AfterStatus: "", WillUpdate: false},
	}
	for current, want := range cases {
		for i := 0; i < 100; i++ {
			got := decideMarkAttemptFailedOutcome(current)
			if got != want {
				t.Fatalf("decideMarkAttemptFailedOutcome(%q) iter %d: got %+v, want %+v",
					current, i, got, want)
			}
		}
	}
}
