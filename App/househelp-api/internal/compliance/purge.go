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
	UserAddresses                int64
	DeviceTokensAsUser           int64
	DeviceTokensAsWorker         int64
	Cart                         int64
	UserPreferredHelpersAsUser   int64
	UserPreferredHelpersAsHelper int64
	ReengagementNotifications    int64
	BookingMessagesAnonymized    int64
	ReviewsAnonymizedAsCustomer  int64
	ReviewsAnonymizedAsHelper    int64
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
		r.ReviewsAnonymizedAsHelper
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
