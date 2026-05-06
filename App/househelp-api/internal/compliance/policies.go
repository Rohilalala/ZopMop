package compliance

import "time"

// RegisterDefaultPolicies populates a Registry with the chunk-2-approved
// retention policies. Each entry MUST carry a documented LegalBasis —
// silently registered policies are exactly the audit-graded posture
// this package exists to prevent.
//
// Chunk 2 status: only booking_messages is registered. Subsequent chunks
// extend this function once the user has made the retention decision
// for each remaining ambiguous table (reviews, bookings, refunds,
// roomies, audit_log, …).
func RegisterDefaultPolicies(r *Registry) {
	if r == nil {
		return
	}

	// booking_messages — customer↔helper chat. Retain body for trust &
	// safety review for 24 months from created_at; sender_id is
	// anonymised to TombstoneUserID at user-purge time so the row
	// persists without continuing to identify the deleted account.
	// The retention worker (chunk 4+) will hard-delete rows older than
	// the window. Action=ActionDelete here means "delete by retention
	// worker once Window elapses"; the anonymise step is applied at
	// purge time by AnonymizeBookingMessagesTx (chunk 2).
	r.Register(RetentionPolicy{
		Table:        "booking_messages",
		Action:       ActionDelete,
		Window:       24 * 30 * 24 * time.Hour, // ~24 months
		UserIDColumn: "sender_id",
		LegalBasis:   "trust_and_safety_review_window",
	})

	// reviews — customer's text rating of a helper. Decision (chunk 3):
	// retain rating + comment for 3 years from created_at, then hard-
	// delete. Customer-side anonymisation reassigns customer_id to the
	// tombstone user; helper-side anonymisation reassigns helper_id to
	// the tombstone helper (prevents the rating-reset exploit). Both
	// happen at SoftDeleteUser time. The retention sweep is purely
	// time-based — UserIDColumn is set to the timestamp column so the
	// retention worker (chunk 4+) reads it as the sweep predicate
	// rather than as a per-user FK.
	r.Register(RetentionPolicy{
		Table:        "reviews",
		Action:       ActionDelete,
		Window:       3 * 365 * 24 * time.Hour, // 3 years
		UserIDColumn: "created_at",
		LegalBasis:   "reputation_signal_with_data_minimization",
	})

	// bookings — financial records. Decision (chunk 4): completed
	// bookings on any payment rail (Cashfree-paid, COD-completed, or
	// wallet-completed) are retained for 7 years from completed_at to
	// satisfy GST / income-tax audit windows. Pending / cancelled rows
	// where money never moved are hard-deleted on user erasure (no tax
	// obligation). PII redaction at anonymisation time: customer_id /
	// helper_id → tombstone, address text cleared, address_id detached,
	// lat/lng rounded to 1 decimal (~11km). locality (city) and all
	// financial fields are preserved.
	//
	// Time anchor for the retention sweep is completed_at (only set on
	// status='completed' bookings, which are the only rows that survive
	// past anonymisation). The retention worker (chunk 4+ execution
	// loop, deferred) will hard-delete WHERE completed_at older than
	// the window.
	r.Register(RetentionPolicy{
		Table:        "bookings",
		Action:       ActionDelete,
		Window:       7 * 365 * 24 * time.Hour, // 7 years
		UserIDColumn: "completed_at",
		LegalBasis:   "gst_income_tax_audit_defence",
	})

	// crm_login_attempts — forensic record of CRM admin auth events
	// (success + every failure reason, including attempts against
	// emails that never existed). Retention: 90 days from created_at
	// — industry-standard security investigation window. Hard-deleted
	// by the retention worker. CRM admin deletion (when implemented)
	// will additionally call AnonymizeLoginAttemptsByEmail to scrub
	// per-account history before the time-based sweep would otherwise
	// catch it.
	r.Register(RetentionPolicy{
		Table:        "crm_login_attempts",
		Action:       ActionDelete,
		Window:       90 * 24 * time.Hour, // 90 days
		UserIDColumn: "created_at",
		LegalBasis:   "security_forensic_window",
	})
}
