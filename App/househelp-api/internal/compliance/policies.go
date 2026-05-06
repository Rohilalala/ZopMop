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
		Table:      "booking_messages",
		Action:     ActionDelete,
		Window:     24 * 30 * 24 * time.Hour, // ~24 months
		TimeColumn: "created_at",
		LegalBasis: "trust_and_safety_review_window",
	})

	// reviews — customer's text rating of a helper. Decision (chunk 3):
	// retain rating + comment for 3 years from created_at, then hard-
	// delete. Customer-side anonymisation reassigns customer_id to the
	// tombstone user; helper-side anonymisation reassigns helper_id to
	// the tombstone helper (prevents the rating-reset exploit). Both
	// happen at SoftDeleteUser time. The retention sweep is purely
	// time-based — TimeColumn is set to the timestamp column so the
	// retention worker (chunk 4+) reads it as the sweep predicate
	// rather than as a per-user FK.
	r.Register(RetentionPolicy{
		Table:        "reviews",
		Action:       ActionDelete,
		Window:       3 * 365 * 24 * time.Hour, // 3 years
		TimeColumn: "created_at",
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
		TimeColumn: "completed_at",
		LegalBasis:   "gst_income_tax_audit_defence",
	})

	// crm_audit_log — CRM v2 admin action audit trail. 3-year retention
	// matches typical security-audit-defence windows. On user erasure,
	// target_id of rows where the deleted user was the action target
	// is anonymised to TombstoneUserID; actor fields (admin_id,
	// admin_email) preserved within the window.
	//
	// JSONB before_value/after_value scrubbing is a documented follow-up
	// — see AnonymizeAuditLogsAsTargetTx and privacy-notes.md.
	r.Register(RetentionPolicy{
		Table:        "crm_audit_log",
		Action:       ActionDelete,
		Window:       3 * 365 * 24 * time.Hour, // 3 years
		TimeColumn: "created_at",
		LegalBasis:   "security_audit_retention",
	})

	// audit_log (legacy migration 008) — older admin action trail still
	// being written by internal/admin/repository.go. Same 3-year
	// retention; same target-side anonymisation rule.
	r.Register(RetentionPolicy{
		Table:        "audit_log",
		Action:       ActionDelete,
		Window:       3 * 365 * 24 * time.Hour, // 3 years
		TimeColumn: "created_at",
		LegalBasis:   "security_audit_retention_legacy",
	})

	// pending_refunds — financial records. Decision (chunk 7): refunds
	// where money actually returned to the customer are retained 7
	// years from processed_at to satisfy GST / income-tax audit
	// windows (matches the bookings policy). Refunds that never moved
	// money (pending / approved-but-not-processed / rejected /
	// cancelled / gateway_error without a gateway_refund_id) are
	// hard-deleted on user erasure — no tax obligation.
	//
	// SoftDeleteUser blocks deletion via ErrActiveRefund when the user
	// has a refund in the chunk-3 'approved' in-flight lock state
	// claimed within the last 10 minutes; stale locks do NOT block.
	r.Register(RetentionPolicy{
		Table:        "pending_refunds",
		Action:       ActionDelete,
		Window:       7 * 365 * 24 * time.Hour, // 7 years
		TimeColumn: "processed_at",
		LegalBasis:   "gst_income_tax_audit_defence_refund",
	})

	// crm_push_messages — campaign-level marketing-push table. Each row
	// represents one campaign (broadcast or 'specific'-target), not
	// one push to one user. There is no per-recipient delivery log,
	// so user-deletion has no row-level scrub target — user IDs can
	// appear only inside target_filter JSONB on target_kind='specific'
	// campaigns (a small fraction of rows). The 90-day window bounds
	// that exposure.
	//
	// Decision (chunk 8): no SoftDeleteUser hook; rely on the
	// time-based sweep alone. Selective JSONB scrubbing for the
	// `target_filter.user_ids` key is a viable follow-up if a
	// stricter posture is desired — see privacy-notes.md.
	r.Register(RetentionPolicy{
		Table:        "crm_push_messages",
		Action:       ActionDelete,
		Window:       90 * 24 * time.Hour, // 90 days
		TimeColumn: "created_at",
		LegalBasis:   "marketing_analytics_window",
	})

	// helper_status_log — online/offline availability-toggle log.
	// Schema is intentionally narrow: (id, helper_id, status,
	// recorded_at) with status ∈ {'online','offline'}. NOT a location
	// log — no lat/lng / booking_id / customer surface. Helper deletion
	// is already handled by the table's ON DELETE CASCADE FK to
	// helpers(id); the SoftDeleteUser tx drops the helpers row and the
	// cascade wipes status entries automatically. No compliance method
	// hookup needed.
	//
	// Decision (chunk 9): policy-only. 90-day window matches typical
	// activity-log retention. The audit's "location pings near customer
	// addresses" framing referred to a different surface (tracking_ws
	// ephemeral state / helpers.location overwrite-in-place column);
	// see privacy-notes.md follow-up.
	r.Register(RetentionPolicy{
		Table:        "helper_status_log",
		Action:       ActionDelete,
		Window:       90 * 24 * time.Hour, // 90 days
		TimeColumn: "recorded_at",
		LegalBasis:   "operational_activity_log",
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
		TimeColumn: "created_at",
		LegalBasis:   "security_forensic_window",
	})
}
