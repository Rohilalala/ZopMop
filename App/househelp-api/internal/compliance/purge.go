package compliance

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TombstoneUserID is the fixed UUID of the "deleted user" sentinel row
// inserted by migration 074. Compliance flows that need to retain a row
// for legal / T&S reasons but anonymise the FK reassign sender_id /
// reviewer_id / etc. to this id. Code reads "Deleted user" from a UI
// renderer keyed on this constant so handlers don't have to null-check
// every join.
const TombstoneUserID = "00000000-0000-0000-0000-000000000000"

// PurgeReport records the row-count outcome of a PurgeTrivialUserData
// pass per table. Returned to the caller so the audit log can capture
// what was actually deleted, not just "purge ran".
type PurgeReport struct {
	UserAddresses                  int64
	DeviceTokensAsUser             int64
	DeviceTokensAsWorker           int64
	Cart                           int64
	UserPreferredHelpersAsUser     int64
	UserPreferredHelpersAsHelper   int64
	ReengagementNotifications      int64
	BookingMessagesAnonymized      int64
	ReviewsAnonymizedAsCustomer    int64
	ReviewsAnonymizedAsHelper      int64
	BookingsAsCustomerHardDeleted  int64
	BookingsAsCustomerAnonymized   int64
	BookingsAsHelperHardDeleted    int64
	BookingsAsHelperAnonymized     int64
	AuditLogsAnonymized            int64
}

// Total returns the sum of all per-table counts. Useful for audit
// summary lines without exposing the full report shape.
func (r PurgeReport) Total() int64 {
	return r.UserAddresses +
		r.DeviceTokensAsUser +
		r.DeviceTokensAsWorker +
		r.Cart +
		r.UserPreferredHelpersAsUser +
		r.UserPreferredHelpersAsHelper +
		r.ReengagementNotifications +
		r.BookingMessagesAnonymized +
		r.ReviewsAnonymizedAsCustomer +
		r.ReviewsAnonymizedAsHelper +
		r.BookingsAsCustomerHardDeleted +
		r.BookingsAsCustomerAnonymized +
		r.BookingsAsHelperHardDeleted +
		r.BookingsAsHelperAnonymized +
		r.AuditLogsAnonymized
}

// txQuerier is the narrow interface that both *pgxpool.Pool and pgx.Tx
// satisfy via their Exec method. Lets the *Tx variants below be reused
// by the standalone (own-tx) variants without duplicating the SQL.
type txQuerier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgxResult, error)
}

// pgxResult is the subset of pgconn.CommandTag we actually use.
type pgxResult interface {
	RowsAffected() int64
}

// poolAdapter wraps *pgxpool.Pool to make its Exec satisfy txQuerier.
type poolAdapter struct{ p *pgxpool.Pool }

func (a poolAdapter) Exec(ctx context.Context, sql string, args ...any) (pgxResult, error) {
	tag, err := a.p.Exec(ctx, sql, args...)
	return commandTag(tag), err
}

// txAdapter wraps pgx.Tx the same way.
type txAdapter struct{ tx pgx.Tx }

func (a txAdapter) Exec(ctx context.Context, sql string, args ...any) (pgxResult, error) {
	tag, err := a.tx.Exec(ctx, sql, args...)
	return commandTag(tag), err
}

// commandTag adapts pgconn.CommandTag to our minimal pgxResult interface.
type commandTag interface{ RowsAffected() int64 }

// AnonymizeBookingMessagesTx reassigns every booking_messages row whose
// sender_id matches userID to the tombstone sentinel, preserving body
// + sender_role. Runs inside the caller's transaction. Returns the
// number of rows reassigned.
//
// Retention policy: T&S review window — see RetentionPolicy registered
// for booking_messages (24-month delete after created_at).
func (s *Service) AnonymizeBookingMessagesTx(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	return execAnonymizeBookingMessages(ctx, txAdapter{tx: tx}, userID)
}

// AnonymizeBookingMessages is the standalone variant — opens its own
// short tx. Suitable for backfill scripts and admin tooling, NOT for
// in-flight user-deletion paths (those should pass their own tx via
// the *Tx variant so the anonymise + delete commit atomically).
func (s *Service) AnonymizeBookingMessages(ctx context.Context, userID string) (int64, error) {
	return execAnonymizeBookingMessages(ctx, poolAdapter{p: s.db}, userID)
}

func execAnonymizeBookingMessages(ctx context.Context, q txQuerier, userID string) (int64, error) {
	res, err := q.Exec(ctx, `
		UPDATE booking_messages
		SET sender_id = $1::uuid
		WHERE sender_id = $2::uuid
	`, TombstoneUserID, userID)
	if err != nil {
		return 0, fmt.Errorf("anonymize booking_messages: %w", err)
	}
	return res.RowsAffected(), nil
}

// AnonymizeReviewsAsCustomerTx reassigns every review authored by the
// given user to the tombstone customer. Rating + comment body are
// preserved per the chunk-3 retention decision (privacy-notes.md):
// helper's reputation should still reflect the past customer's vote
// even after the account is gone. The retention worker (chunk 4+)
// will hard-delete these rows 3 years after created_at.
//
// The reviews trigger fn_reviews_recompute_helper_rating fires only
// on UPDATE OF rating; touching customer_id alone does NOT recompute
// helpers.rating. That is the intended behaviour — anonymising the
// reviewer must not move the helper's rating.
func (s *Service) AnonymizeReviewsAsCustomerTx(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	return execAnonymizeReviewsAsCustomer(ctx, txAdapter{tx: tx}, userID)
}

// AnonymizeReviewsAsCustomer is the standalone variant — opens its
// own short tx. Use the *Tx variant when running inside SoftDeleteUser.
func (s *Service) AnonymizeReviewsAsCustomer(ctx context.Context, userID string) (int64, error) {
	return execAnonymizeReviewsAsCustomer(ctx, poolAdapter{p: s.db}, userID)
}

func execAnonymizeReviewsAsCustomer(ctx context.Context, q txQuerier, userID string) (int64, error) {
	res, err := q.Exec(ctx, `
		UPDATE reviews
		SET customer_id = $1::uuid
		WHERE customer_id = $2::uuid
	`, TombstoneUserID, userID)
	if err != nil {
		return 0, fmt.Errorf("anonymize reviews (customer): %w", err)
	}
	return res.RowsAffected(), nil
}

// AnonymizeReviewsAsHelperTx reassigns every review received by the
// given helper to the tombstone helper. Prevents a rating-reset
// exploit: a helper with bad reviews cannot delete-and-recreate to
// wipe history — the reviews persist under the tombstone, orphaned
// (no live helper profile) but counted toward the 3-year retention
// window.
//
// MUST be called BEFORE the SoftDeleteUser DELETE FROM helpers …
// statement. reviews.helper_id has ON DELETE CASCADE to helpers(id),
// so deleting the helpers row first would wipe the very reviews we
// are trying to retain. Sequencing is enforced by the caller.
//
// The reviews trigger fires only on UPDATE OF rating; touching
// helper_id alone does NOT recompute either helper's rating —
// the deleted helper's rating is moot (their helpers row is about
// to be deleted) and the tombstone helper's rating stays at the
// schema default (orphaned reviews aren't displayed).
func (s *Service) AnonymizeReviewsAsHelperTx(ctx context.Context, tx pgx.Tx, helperID string) (int64, error) {
	return execAnonymizeReviewsAsHelper(ctx, txAdapter{tx: tx}, helperID)
}

// AnonymizeReviewsAsHelper is the standalone variant — opens its
// own short tx. Use the *Tx variant when running inside SoftDeleteUser.
func (s *Service) AnonymizeReviewsAsHelper(ctx context.Context, helperID string) (int64, error) {
	return execAnonymizeReviewsAsHelper(ctx, poolAdapter{p: s.db}, helperID)
}

func execAnonymizeReviewsAsHelper(ctx context.Context, q txQuerier, helperID string) (int64, error) {
	res, err := q.Exec(ctx, `
		UPDATE reviews
		SET helper_id = $1::uuid
		WHERE helper_id = $2::uuid
	`, TombstoneUserID, helperID)
	if err != nil {
		return 0, fmt.Errorf("anonymize reviews (helper): %w", err)
	}
	return res.RowsAffected(), nil
}

// moneyMovedPredicate is the SQL fragment that decides whether a
// booking represents a real money movement and therefore must be
// retained 7 years for tax / audit defence (GST, income tax). Mirrors
// the existing in-code predicate at internal/booking/repository.go:509,663
// so "money moved" stays consistently defined across the codebase.
//
// Captures all three payment rails:
//   - Cashfree direct-pay  : payment_status='paid' once webhook stamps it
//   - COD                  : payment_method='cod', status='completed' (cash collected)
//   - Wallet               : payment_method='wallet', status='completed' (closed-loop debit)
//
// IS DISTINCT FROM rather than != for payment_method because the column
// is nullable; NULL behaves as "not cashfree" in this predicate.
//
// NOTE: payment_status='refunded' is documented in migration 046 but no
// code path writes it today. When the refund flow starts setting that
// value, this predicate must be expanded to include it (refunded
// bookings are still tax records — money moved both directions). See
// privacy-notes.md "Things to revisit before launch".
//
// Three-valued logic: payment_status is nullable, so `payment_status =
// 'paid'` returns NULL (not FALSE) when the column is NULL. Callers
// MUST use `predicate IS TRUE` for keep-and-anonymise and `predicate
// IS NOT TRUE` for hard-delete; these collapse NULL to FALSE the way
// the WHERE clause needs.
const moneyMovedPredicate = `(
	(payment_method IS DISTINCT FROM 'cashfree' AND status = 'completed')
	OR payment_status = 'paid'
)`

// AnonymizeBookingsAsCustomerTx splits the customer's bookings into:
//   - hard-delete: rows where money never moved (cancelled / abandoned /
//     never-completed). No tax obligation, no retention need.
//   - anonymise:   rows where money moved on any rail. customer_id →
//     TombstoneUserID, address text cleared, address_id FK detached,
//     lat/lng rounded to 1-decimal (~11km, "metropolitan area" grain).
//     locality preserved, financial fields preserved for 7-year window.
//
// Sequencing: MUST run before PurgeTrivialUserDataTx — bookings.address_id
// references user_addresses(id) with default RESTRICT; if user_addresses
// is deleted while bookings still reference it the trivial purge fails.
func (s *Service) AnonymizeBookingsAsCustomerTx(ctx context.Context, tx pgx.Tx, userID string) (hardDeleted, anonymized int64, err error) {
	return execAnonymizeBookingsAsCustomer(ctx, txAdapter{tx: tx}, userID)
}

// AnonymizeBookingsAsCustomer is the standalone variant — opens its own
// short tx. Use the *Tx variant when running inside SoftDeleteUser.
func (s *Service) AnonymizeBookingsAsCustomer(ctx context.Context, userID string) (hardDeleted, anonymized int64, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("anonymize bookings (customer) begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	hardDeleted, anonymized, err = execAnonymizeBookingsAsCustomer(ctx, txAdapter{tx: tx}, userID)
	if err != nil {
		return hardDeleted, anonymized, err
	}
	if err := tx.Commit(ctx); err != nil {
		return hardDeleted, anonymized, fmt.Errorf("anonymize bookings (customer) commit: %w", err)
	}
	return hardDeleted, anonymized, nil
}

func execAnonymizeBookingsAsCustomer(ctx context.Context, q txQuerier, userID string) (int64, int64, error) {
	// 1. Hard-delete: money never moved.
	res, err := q.Exec(ctx, `
		DELETE FROM bookings
		WHERE customer_id = $1::uuid
		  AND `+moneyMovedPredicate+` IS NOT TRUE`, userID)
	if err != nil {
		return 0, 0, fmt.Errorf("hard-delete bookings (customer): %w", err)
	}
	hardDeleted := res.RowsAffected()

	// 2. Anonymise: money moved → retain row, scrub PII columns.
	res, err = q.Exec(ctx, `
		UPDATE bookings
		SET customer_id = $1::uuid,
		    address     = '',
		    address_id  = NULL,
		    lat         = ROUND(lat, 1),
		    lng         = ROUND(lng, 1),
		    updated_at  = NOW()
		WHERE customer_id = $2::uuid
		  AND `+moneyMovedPredicate+` IS TRUE`, TombstoneUserID, userID)
	if err != nil {
		return hardDeleted, 0, fmt.Errorf("anonymise bookings (customer): %w", err)
	}
	return hardDeleted, res.RowsAffected(), nil
}

// AnonymizeBookingsAsHelperTx mirrors AnonymizeBookingsAsCustomerTx for
// the helper edge. Helper-side anonymisation reassigns helper_id to
// TombstoneUserID (not a tombstone-helper-row, because bookings.helper_id
// FK is to users(id), not helpers(id) — confirmed Phase A.4).
func (s *Service) AnonymizeBookingsAsHelperTx(ctx context.Context, tx pgx.Tx, helperID string) (hardDeleted, anonymized int64, err error) {
	return execAnonymizeBookingsAsHelper(ctx, txAdapter{tx: tx}, helperID)
}

// AnonymizeBookingsAsHelper is the standalone variant — opens its own
// short tx. Use the *Tx variant when running inside SoftDeleteUser.
func (s *Service) AnonymizeBookingsAsHelper(ctx context.Context, helperID string) (hardDeleted, anonymized int64, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("anonymize bookings (helper) begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	hardDeleted, anonymized, err = execAnonymizeBookingsAsHelper(ctx, txAdapter{tx: tx}, helperID)
	if err != nil {
		return hardDeleted, anonymized, err
	}
	if err := tx.Commit(ctx); err != nil {
		return hardDeleted, anonymized, fmt.Errorf("anonymize bookings (helper) commit: %w", err)
	}
	return hardDeleted, anonymized, nil
}

// AnonymizeAuditLogsAsTargetTx reassigns target_id in both audit log
// tables — crm_audit_log (CRM v2 path) and audit_log (legacy admin
// path) — for rows where the deleted user was the target of an admin
// action. Action history (admin_id, admin_email, action, module,
// ip_address, user_agent, request_id) is preserved: actors stay
// accountable for what they did within the 3-year retention window.
//
// Match predicate is `target_id = $userID::text` only. target_id is
// TEXT in both schemas; for user-as-target rows it holds the user's
// UUID as a string. We do NOT filter by target_type because UUID
// uniqueness makes target_id alone sufficient and the target_type
// label is inconsistent across modules ('user' / 'worker' / 'customer'
// in different writers).
//
// KNOWN GAP — JSONB Before/After (audit C-8 follow-up): the
// before_value / after_value (legacy: old_value / new_value) JSONB
// columns may contain user PII baked in by the recording module
// (e.g. admin user-suspension actions log the full user row,
// including phone and name). This method does NOT scrub those
// payloads. The 3-year retention window registered in policies.go
// is the hard bound — PII ages out via the retention worker. Per-key
// recursive redaction is documented as follow-up in privacy-notes.md.
//
// Returns total rows updated across both tables.
func (s *Service) AnonymizeAuditLogsAsTargetTx(ctx context.Context, tx pgx.Tx, userID string) (int64, error) {
	return execAnonymizeAuditLogsAsTarget(ctx, txAdapter{tx: tx}, userID)
}

// AnonymizeAuditLogsAsTarget is the standalone variant — opens its
// own short tx so the two UPDATEs (crm_audit_log + audit_log) commit
// atomically.
func (s *Service) AnonymizeAuditLogsAsTarget(ctx context.Context, userID string) (int64, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("anonymize audit logs begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	n, err := execAnonymizeAuditLogsAsTarget(ctx, txAdapter{tx: tx}, userID)
	if err != nil {
		return n, err
	}
	if err := tx.Commit(ctx); err != nil {
		return n, fmt.Errorf("anonymize audit logs commit: %w", err)
	}
	return n, nil
}

func execAnonymizeAuditLogsAsTarget(ctx context.Context, q txQuerier, userID string) (int64, error) {
	var total int64

	res, err := q.Exec(ctx, `
		UPDATE crm_audit_log
		SET target_id = $1
		WHERE target_id = $2::text
	`, TombstoneUserID, userID)
	if err != nil {
		return 0, fmt.Errorf("anonymize crm_audit_log: %w", err)
	}
	total += res.RowsAffected()

	res, err = q.Exec(ctx, `
		UPDATE audit_log
		SET target_id = $1
		WHERE target_id = $2::text
	`, TombstoneUserID, userID)
	if err != nil {
		return total, fmt.Errorf("anonymize audit_log (legacy): %w", err)
	}
	total += res.RowsAffected()

	return total, nil
}

// AnonymizeLoginAttemptsByEmailTx scrubs CRM login-attempt records for
// the given email. Replaces `email` with the fixed sentinel
// `<deleted>@tombstone.local` and NULLs `ip_address`. `success` and
// `reason` are forensic counters with no PII content and are
// preserved so per-row record-counts (e.g. "how many bad_password
// attempts in the 90 days before the account was deleted?") survive
// for the retention window.
//
// CITEXT column: comparison is case-insensitive automatically;
// `Admin@Example.COM` matches `admin@example.com`.
//
// No live caller today. CRM admin deletion is not yet implemented;
// this method is the compliance scrub hook ready for that future
// flow. The 90-day retention sweep registered in policies.go is the
// immediate forensic-window guarantee. Audit C-8 / F2D-1 chunk 5.
func (s *Service) AnonymizeLoginAttemptsByEmailTx(ctx context.Context, tx pgx.Tx, email string) (int64, error) {
	return execAnonymizeLoginAttemptsByEmail(ctx, txAdapter{tx: tx}, email)
}

// AnonymizeLoginAttemptsByEmail is the standalone variant — opens its
// own short tx. Use the *Tx variant when wired into a CRM admin
// deletion flow (none exists today).
func (s *Service) AnonymizeLoginAttemptsByEmail(ctx context.Context, email string) (int64, error) {
	return execAnonymizeLoginAttemptsByEmail(ctx, poolAdapter{p: s.db}, email)
}

func execAnonymizeLoginAttemptsByEmail(ctx context.Context, q txQuerier, email string) (int64, error) {
	res, err := q.Exec(ctx, `
		UPDATE crm_login_attempts
		SET email      = '<deleted>@tombstone.local',
		    ip_address = NULL
		WHERE email = $1
	`, email)
	if err != nil {
		return 0, fmt.Errorf("anonymize crm_login_attempts: %w", err)
	}
	return res.RowsAffected(), nil
}

func execAnonymizeBookingsAsHelper(ctx context.Context, q txQuerier, helperID string) (int64, int64, error) {
	res, err := q.Exec(ctx, `
		DELETE FROM bookings
		WHERE helper_id = $1::uuid
		  AND `+moneyMovedPredicate+` IS NOT TRUE`, helperID)
	if err != nil {
		return 0, 0, fmt.Errorf("hard-delete bookings (helper): %w", err)
	}
	hardDeleted := res.RowsAffected()

	res, err = q.Exec(ctx, `
		UPDATE bookings
		SET helper_id   = $1::uuid,
		    address     = '',
		    address_id  = NULL,
		    lat         = ROUND(lat, 1),
		    lng         = ROUND(lng, 1),
		    updated_at  = NOW()
		WHERE helper_id = $2::uuid
		  AND `+moneyMovedPredicate+` IS TRUE`, TombstoneUserID, helperID)
	if err != nil {
		return hardDeleted, 0, fmt.Errorf("anonymise bookings (helper): %w", err)
	}
	return hardDeleted, res.RowsAffected(), nil
}

// PurgeTrivialUserDataTx hard-deletes user-owned rows with no cross-
// user dependency and no T&S retention requirement. Runs inside the
// caller's transaction. Returns a PurgeReport with the per-table row
// counts.
//
// Tables purged:
//   - user_addresses             (CASCADE FK; manual delete here)
//   - device_tokens              (CASCADE FK; both user_id + worker_id)
//   - cart                       (CASCADE FK)
//   - user_preferred_helpers     (CASCADE FK; both user_id + helper_id)
//   - reengagement_notifications (CASCADE FK)
//
// CASCADE never fires today because SoftDeleteUser doesn't delete the
// users row; this method runs the deletes manually so soft-delete
// actually wipes child PII rather than orphaning it indefinitely.
func (s *Service) PurgeTrivialUserDataTx(ctx context.Context, tx pgx.Tx, userID string) (PurgeReport, error) {
	return execPurgeTrivialUserData(ctx, txAdapter{tx: tx}, userID)
}

// PurgeTrivialUserData is the standalone variant — opens its own tx.
// Tx variant should be preferred when called inside SoftDeleteUser so
// every child delete commits atomically with the user-row scrub.
func (s *Service) PurgeTrivialUserData(ctx context.Context, userID string) (PurgeReport, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return PurgeReport{}, fmt.Errorf("purge begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	report, err := execPurgeTrivialUserData(ctx, txAdapter{tx: tx}, userID)
	if err != nil {
		return report, err
	}
	if err := tx.Commit(ctx); err != nil {
		return report, fmt.Errorf("purge commit: %w", err)
	}
	return report, nil
}

func execPurgeTrivialUserData(ctx context.Context, q txQuerier, userID string) (PurgeReport, error) {
	var r PurgeReport

	// user_addresses
	res, err := q.Exec(ctx, `DELETE FROM user_addresses WHERE user_id = $1::uuid`, userID)
	if err != nil {
		return r, fmt.Errorf("purge user_addresses: %w", err)
	}
	r.UserAddresses = res.RowsAffected()

	// device_tokens — owner can be user_id OR worker_id (helpers extend
	// users via shared PK). Purge both edges.
	res, err = q.Exec(ctx, `DELETE FROM device_tokens WHERE user_id = $1::uuid`, userID)
	if err != nil {
		return r, fmt.Errorf("purge device_tokens (user_id): %w", err)
	}
	r.DeviceTokensAsUser = res.RowsAffected()

	res, err = q.Exec(ctx, `DELETE FROM device_tokens WHERE worker_id = $1::uuid`, userID)
	if err != nil {
		return r, fmt.Errorf("purge device_tokens (worker_id): %w", err)
	}
	r.DeviceTokensAsWorker = res.RowsAffected()

	// cart
	res, err = q.Exec(ctx, `DELETE FROM cart WHERE user_id = $1::uuid`, userID)
	if err != nil {
		return r, fmt.Errorf("purge cart: %w", err)
	}
	r.Cart = res.RowsAffected()

	// user_preferred_helpers — bilateral. Customer's "preferred" list
	// AND any other customer who preferred this user as a helper.
	res, err = q.Exec(ctx, `DELETE FROM user_preferred_helpers WHERE user_id = $1::uuid`, userID)
	if err != nil {
		return r, fmt.Errorf("purge user_preferred_helpers (user_id): %w", err)
	}
	r.UserPreferredHelpersAsUser = res.RowsAffected()

	res, err = q.Exec(ctx, `DELETE FROM user_preferred_helpers WHERE helper_id = $1::uuid`, userID)
	if err != nil {
		return r, fmt.Errorf("purge user_preferred_helpers (helper_id): %w", err)
	}
	r.UserPreferredHelpersAsHelper = res.RowsAffected()

	// reengagement_notifications
	res, err = q.Exec(ctx, `DELETE FROM reengagement_notifications WHERE user_id = $1::uuid`, userID)
	if err != nil {
		return r, fmt.Errorf("purge reengagement_notifications: %w", err)
	}
	r.ReengagementNotifications = res.RowsAffected()

	return r, nil
}
