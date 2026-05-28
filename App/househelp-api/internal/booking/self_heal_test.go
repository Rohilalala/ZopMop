package booking

// self_heal_test.go — truth-table guard for the Phase 1 Step 5a.1
// TrackLive self-heal decisions.
//
// The decisions are pure functions over the booking state; no DB or
// Redis required. The live happy-path against GetTracking is exercised
// by the integration smoke. These tests pin the decision matrix so a
// future refactor that "tidies up" the precondition checks can't
// silently re-open a regression — e.g. Issuing on every push tick
// (every-tick write), or regenerating an existing code mid-handoff
// (the Step-3 desync risk).

import (
	"testing"
	"time"
)

// TestDecideStartOTPSelfHeal_TruthTable pins every meaningful state
// combination. The two principal hazards are:
//
//   (a) Issuing when a code already exists — would rotate the code
//       mid-handoff (customer sees X, pro types Y, gate rejects).
//   (b) Issuing on every push tick when the code DOES exist — would
//       turn a 5-second WS push into a 5-second Redis write storm.
//
// Both are blocked by the same guard: peekedCode != "" → Skip.
func TestDecideStartOTPSelfHeal_TruthTable(t *testing.T) {
	t.Parallel()
	now := time.Now()

	type row struct {
		name       string
		booking    *Booking
		peekedCode string
		want       SelfHealAction
	}
	rows := []row{
		{
			"nil booking — defensive skip",
			nil, "", SelfHealSkip,
		},
		{
			"en_route_at nil + no code — pre-Issue state, do nothing",
			&Booking{Status: StatusAccepted, EnRouteAt: nil},
			"",
			SelfHealSkip,
		},
		{
			"en_route_at set + code already outstanding — must NOT regenerate",
			&Booking{Status: StatusAccepted, EnRouteAt: &now},
			"123456",
			SelfHealSkip,
		},
		{
			"en_route_at set + code outstanding + multiple ticks — same skip",
			// Pinned twice in the same row to make the "every tick is
			// skipped" property explicit. The decision is pure, so
			// calling it again yields the same answer.
			&Booking{Status: StatusAccepted, EnRouteAt: &now},
			"654321",
			SelfHealSkip,
		},
		{
			"accepted + en_route_at set + code absent — THE self-heal path",
			&Booking{Status: StatusAccepted, EnRouteAt: &now},
			"",
			SelfHealIssue,
		},
		{
			"accepted + en_route_at nil + code absent — pre-MarkEnRoute; skip",
			&Booking{Status: StatusAccepted, EnRouteAt: nil},
			"",
			SelfHealSkip,
		},
		{
			"in_progress + started_at set + code absent — gate ALREADY " +
				"consumed at StartBooking; do not heal a passed gate",
			// Even though en_route_at is still set, started_at being
			// non-nil means StartBooking has already verified + consumed
			// the Start OTP. Re-Issuing here serves no consumer and
			// would burn a write per push tick for every in_progress
			// booking.
			&Booking{Status: StatusInProgress, EnRouteAt: &now, StartedAt: &now},
			"",
			SelfHealSkip,
		},
		{
			"completed — start gate already passed; never heal",
			&Booking{Status: StatusCompleted, EnRouteAt: &now, StartedAt: &now, CompletedAt: &now},
			"",
			SelfHealSkip,
		},
		{
			"cancelled — terminal; never heal",
			&Booking{Status: StatusCancelled, EnRouteAt: &now},
			"",
			SelfHealSkip,
		},
	}
	for _, r := range rows {
		got := DecideStartOTPSelfHeal(r.booking, r.peekedCode)
		if got != r.want {
			t.Errorf("DecideStartOTPSelfHeal: %s\n  got = %v, want = %v", r.name, got, r.want)
		}
	}
}

// TestDecideEndOTPSelfHeal_TruthTable pins the End-OTP decision matrix.
// The hazard model is identical to Start: never regenerate an
// outstanding code, never write on the common path.
func TestDecideEndOTPSelfHeal_TruthTable(t *testing.T) {
	t.Parallel()
	now := time.Now()

	type row struct {
		name          string
		booking       *Booking
		peekedCode    string
		paid          bool
		cashCollected bool
		want          SelfHealAction
	}
	rows := []row{
		{
			"nil booking — defensive skip",
			nil, "", false, false, SelfHealSkip,
		},
		{
			"pre-in_progress — end gate not yet relevant",
			&Booking{Status: StatusAccepted, EnRouteAt: &now},
			"", true, false, SelfHealSkip,
		},
		{
			"in_progress + no payment + no cash — payment not resolved",
			&Booking{Status: StatusInProgress, StartedAt: &now},
			"", false, false, SelfHealSkip,
		},
		{
			"in_progress + paid + code outstanding — never regenerate",
			&Booking{Status: StatusInProgress, StartedAt: &now},
			"999999", true, false, SelfHealSkip,
		},
		{
			"in_progress + cash + code outstanding — never regenerate",
			&Booking{Status: StatusInProgress, StartedAt: &now},
			"888888", false, true, SelfHealSkip,
		},
		{
			"in_progress + paid + code absent — self-heal",
			&Booking{Status: StatusInProgress, StartedAt: &now},
			"", true, false, SelfHealIssue,
		},
		{
			"in_progress + cash + code absent — self-heal",
			&Booking{Status: StatusInProgress, StartedAt: &now},
			"", false, true, SelfHealIssue,
		},
		{
			"in_progress + paid + cash (both) + code absent — self-heal",
			// Edge case: backend should never produce this state, but
			// defensively the heal still fires once and stays idempotent
			// thereafter.
			&Booking{Status: StatusInProgress, StartedAt: &now},
			"", true, true, SelfHealIssue,
		},
		{
			"completed — gate already passed; the End OTP was consumed at " +
				"CompleteBooking and we should not re-issue against a " +
				"terminal booking",
			&Booking{Status: StatusCompleted, StartedAt: &now, CompletedAt: &now},
			"", true, false, SelfHealSkip,
		},
		{
			"cancelled — same as completed; never heal a terminal booking",
			&Booking{Status: StatusCancelled},
			"", true, false, SelfHealSkip,
		},
	}
	for _, r := range rows {
		got := DecideEndOTPSelfHeal(r.booking, r.peekedCode, r.paid, r.cashCollected)
		if got != r.want {
			t.Errorf("DecideEndOTPSelfHeal: %s\n  got = %v, want = %v", r.name, got, r.want)
		}
	}
}

// TestDecideOTPSelfHeal_PureFunctionStability — calling either helper
// repeatedly with the same inputs MUST return the same answer. This is
// the "no every-tick write" property: if the decision were stateful or
// time-dependent, the WS push loop could oscillate Skip/Issue.
func TestDecideOTPSelfHeal_PureFunctionStability(t *testing.T) {
	t.Parallel()
	now := time.Now()
	b := &Booking{Status: StatusInProgress, StartedAt: &now, EnRouteAt: &now}
	for i := 0; i < 100; i++ {
		if got := DecideStartOTPSelfHeal(b, "abc"); got != SelfHealSkip {
			t.Fatalf("Start iter %d: got %v, want SelfHealSkip", i, got)
		}
		if got := DecideEndOTPSelfHeal(b, "xyz", true, false); got != SelfHealSkip {
			t.Fatalf("End iter %d: got %v, want SelfHealSkip", i, got)
		}
	}
}
