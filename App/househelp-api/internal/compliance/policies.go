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
}
