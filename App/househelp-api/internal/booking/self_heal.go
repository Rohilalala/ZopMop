package booking

// self_heal.go — pure decision helpers for the TrackLive End-OTP +
// Start-OTP self-heal contract (Phase 1 Step 5a.1).
//
// Background. Both service OTPs (Start and End) are issued by
// post-commit best-effort calls:
//
//   - Start OTP: (*Service).MarkEnRoute calls otpSvc.Issue(ScopeStart, …)
//     after the en_route_at stamp commits. Failure is logged and the
//     code never gets written — TrackLive would surface "" forever.
//
//   - End OTP: the Cashfree webhook handler AND
//     (*Service).ResolveCash both call otpSvc.Issue(ScopeEnd, …) after
//     their respective payment-resolution commits. Same failure mode.
//
// The customer-side TrackLive load (REST GetTracking + WebSocket push
// loop, which both go through (*Service).GetTracking) is the recovery
// point: every load checks the prerequisite state and re-Issues only
// when the OTP is genuinely absent. Common path is a single Peek + no
// writes — the precondition guards below short-circuit before any
// Issue or extra SQL hit.
//
// These helpers are pure functions so the truth table is testable
// without a DB or a Redis. The same factoring style as
// IsCancellableStatus / IsCancellable.

// SelfHealAction is the single-scope decision on one GetTracking load.
type SelfHealAction int

const (
	// SelfHealSkip — the common path. Either the code already exists
	// (Peek surfaced it; no Issue needed) OR the precondition for
	// issuance is not met (e.g. en_route_at still nil; payment not
	// resolved).
	SelfHealSkip SelfHealAction = iota
	// SelfHealIssue — code is genuinely absent AND the precondition is
	// satisfied. Caller should Issue + repopulate the response. Same
	// load's Peek already returned ErrNotFound; we are not regenerating
	// an existing code (the Step-3 desync risk).
	SelfHealIssue
)

// DecideStartOTPSelfHeal is the Start-OTP decision. peekedCode is the
// value (possibly "") the GetTracking caller already pulled from
// otpSvc.Peek; non-empty means the code is outstanding and we leave
// it alone.
//
// Truth table (see self_heal_test.go):
//
//   booking=nil                              → Skip (defensive)
//   peekedCode!=""                           → Skip (code exists;
//                                                   never regenerate)
//   booking.Status != StatusAccepted         → Skip (Start gate only
//                                                   gates accepted->
//                                                   in_progress; any
//                                                   other status means
//                                                   the gate is past,
//                                                   bypassed, or never
//                                                   reached)
//   booking.EnRouteAt==nil                   → Skip (no Issue should
//                                                   ever have fired
//                                                   upstream)
//   booking.StartedAt!=nil                   → Skip (defensive belt:
//                                                   StartBooking sets
//                                                   status='in_progress'
//                                                   AND started_at
//                                                   simultaneously)
//   accepted + en_route + !started + ""      → Issue
func DecideStartOTPSelfHeal(b *Booking, peekedCode string) SelfHealAction {
	if b == nil || peekedCode != "" {
		return SelfHealSkip
	}
	if b.Status != StatusAccepted {
		return SelfHealSkip
	}
	if b.EnRouteAt == nil {
		return SelfHealSkip
	}
	if b.StartedAt != nil {
		return SelfHealSkip
	}
	return SelfHealIssue
}

// DecideEndOTPSelfHeal is the End-OTP decision. paid is
// (payment_status='paid'); cashCollected is (cash_collected_at IS NOT
// NULL). The caller pulls these from a tight follow-up SELECT —
// they're not on the Booking struct yet.
//
// Truth table (see self_heal_test.go):
//
//   booking=nil                                  → Skip
//   peekedCode!=""                                → Skip   (no regenerate)
//   booking.Status != StatusInProgress            → Skip   (End OTP only
//                                                          gates the
//                                                          in_progress->
//                                                          completed step)
//   payment NOT resolved (paid=false, cash=false) → Skip
//   in_progress + (paid OR cash) + peek=""        → Issue
func DecideEndOTPSelfHeal(b *Booking, peekedCode string, paid, cashCollected bool) SelfHealAction {
	if b == nil || peekedCode != "" {
		return SelfHealSkip
	}
	if b.Status != StatusInProgress {
		return SelfHealSkip
	}
	if !paid && !cashCollected {
		return SelfHealSkip
	}
	return SelfHealIssue
}
