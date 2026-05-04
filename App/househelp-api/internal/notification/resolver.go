package notification

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TokenResolver looks up active FCM tokens from the device_tokens table.
// "Active" = updated_at within the last ActiveTokenWindow. The 90-day cutoff
// drops devices that haven't been seen in a quarter (uninstalled, factory
// reset, etc.) so broadcasts don't waste FCM quota on dead targets.
//
// All methods return de-duplicated token slices — the same physical device
// can in principle appear twice if a user re-registered without sending the
// old device_id; SELECT DISTINCT keeps the multicast payloads clean.
type TokenResolver struct {
	pool *pgxpool.Pool
}

// ActiveTokenWindow is the freshness window for considering a device_token
// row "live". Defined here so the user-app, the CRM, and the reach
// estimation queries all agree on the same threshold.
const ActiveTokenWindow = "90 days"

// activeWindowSQL is a snippet usable inside any device_tokens query.
// Kept as a const string (instead of a parameter) so the planner can see
// it as an immutable predicate — interval literals aren't parametrizable.
const activeWindowSQL = "dt.updated_at > now() - interval '" + ActiveTokenWindow + "'"

// NewTokenResolver wires a resolver to the given pool. The pool can be the
// CRM read pool or the user-app pool — neither writes through the resolver
// except for DeleteToken, which is safe against either.
func NewTokenResolver(pool *pgxpool.Pool) *TokenResolver {
	return &TokenResolver{pool: pool}
}

// ── Bulk lookups ─────────────────────────────────────────────────────────

// Users returns active tokens for every customer with a registered device.
// Excludes suspended / banned / deleted accounts so admin broadcasts don't
// hit accounts that the moderation team has cut off.
func (r *TokenResolver) Users(ctx context.Context) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT dt.fcm_token
		FROM device_tokens dt
		JOIN users u ON u.id = dt.user_id
		WHERE dt.user_id IS NOT NULL
		  AND `+activeWindowSQL+`
		  AND u.deleted_at IS NULL
		  AND u.is_suspended = FALSE
		  AND u.banned_at IS NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("resolve user tokens: %w", err)
	}
	return collectTokens(rows)
}

// Workers returns active tokens for every helper / pro account.
func (r *TokenResolver) Workers(ctx context.Context) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT dt.fcm_token
		FROM device_tokens dt
		JOIN users u ON u.id = dt.worker_id
		WHERE dt.worker_id IS NOT NULL
		  AND `+activeWindowSQL+`
		  AND u.deleted_at IS NULL
		  AND u.is_suspended = FALSE
		  AND u.banned_at IS NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("resolve worker tokens: %w", err)
	}
	return collectTokens(rows)
}

// Both returns the union of Users and Workers in one query. A single device
// could in theory be registered for both roles (test devices); DISTINCT
// trims those.
func (r *TokenResolver) Both(ctx context.Context) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT dt.fcm_token
		FROM device_tokens dt
		JOIN users u ON u.id = COALESCE(dt.user_id, dt.worker_id)
		WHERE `+activeWindowSQL+`
		  AND u.deleted_at IS NULL
		  AND u.is_suspended = FALSE
		  AND u.banned_at IS NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("resolve combined tokens: %w", err)
	}
	return collectTokens(rows)
}

// ── Per-account lookups ──────────────────────────────────────────────────

// User returns active tokens for one customer.
func (r *TokenResolver) User(ctx context.Context, userID string) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT dt.fcm_token FROM device_tokens dt
		WHERE dt.user_id = $1::uuid AND `+activeWindowSQL,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("resolve tokens for user: %w", err)
	}
	return collectTokens(rows)
}

// Worker returns active tokens for one helper.
func (r *TokenResolver) Worker(ctx context.Context, workerID string) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT dt.fcm_token FROM device_tokens dt
		WHERE dt.worker_id = $1::uuid AND `+activeWindowSQL,
		workerID,
	)
	if err != nil {
		return nil, fmt.Errorf("resolve tokens for worker: %w", err)
	}
	return collectTokens(rows)
}

// UsersByID returns active tokens for an explicit list of customer IDs.
// Used by the CRM "specific" target_kind path.
func (r *TokenResolver) UsersByID(ctx context.Context, userIDs []string) ([]string, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT dt.fcm_token FROM device_tokens dt
		WHERE dt.user_id = ANY($1::uuid[]) AND `+activeWindowSQL,
		userIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("resolve tokens for users: %w", err)
	}
	return collectTokens(rows)
}

// ── Reach counts (for the CRM compose UI) ────────────────────────────────

// CountUsers returns the number of customers reachable via push.
func (r *TokenResolver) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(DISTINCT dt.user_id)
		FROM device_tokens dt
		JOIN users u ON u.id = dt.user_id
		WHERE dt.user_id IS NOT NULL
		  AND `+activeWindowSQL+`
		  AND u.deleted_at IS NULL
		  AND u.is_suspended = FALSE
		  AND u.banned_at IS NULL
	`).Scan(&n)
	return n, err
}

// CountWorkers returns the number of helpers reachable via push.
func (r *TokenResolver) CountWorkers(ctx context.Context) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(DISTINCT dt.worker_id)
		FROM device_tokens dt
		JOIN users u ON u.id = dt.worker_id
		WHERE dt.worker_id IS NOT NULL
		  AND `+activeWindowSQL+`
		  AND u.deleted_at IS NULL
		  AND u.is_suspended = FALSE
		  AND u.banned_at IS NULL
	`).Scan(&n)
	return n, err
}

// CountBoth returns the union reach for "all users + all workers".
func (r *TokenResolver) CountBoth(ctx context.Context) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(DISTINCT COALESCE(dt.user_id, dt.worker_id))
		FROM device_tokens dt
		JOIN users u ON u.id = COALESCE(dt.user_id, dt.worker_id)
		WHERE `+activeWindowSQL+`
		  AND u.deleted_at IS NULL
		  AND u.is_suspended = FALSE
		  AND u.banned_at IS NULL
	`).Scan(&n)
	return n, err
}

// CountUser returns 1 if the user has at least one active token, else 0.
// Kept symmetric with the bulk counts so the CRM reach endpoint can return
// a value for target=user:<id>.
func (r *TokenResolver) CountUser(ctx context.Context, userID string) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT CASE WHEN EXISTS (
			SELECT 1 FROM device_tokens dt
			WHERE dt.user_id = $1::uuid AND `+activeWindowSQL+`
		) THEN 1 ELSE 0 END
	`, userID).Scan(&n)
	return n, err
}

// CountWorker mirrors CountUser for helpers.
func (r *TokenResolver) CountWorker(ctx context.Context, workerID string) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT CASE WHEN EXISTS (
			SELECT 1 FROM device_tokens dt
			WHERE dt.worker_id = $1::uuid AND `+activeWindowSQL+`
		) THEN 1 ELSE 0 END
	`, workerID).Scan(&n)
	return n, err
}

// ── Maintenance ──────────────────────────────────────────────────────────

// DeleteToken removes every device_tokens row matching the given FCM token.
// Called after FCM reports the token as unregistered (uninstall, fresh
// install, OS reset). Idempotent — missing rows are not an error.
func (r *TokenResolver) DeleteToken(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	_, err := r.pool.Exec(ctx, `DELETE FROM device_tokens WHERE fcm_token = $1`, token)
	if err != nil {
		return fmt.Errorf("delete device token: %w", err)
	}
	return nil
}

// ── helpers ──────────────────────────────────────────────────────────────

// collectTokens drains a pgx.Rows of TEXT values, skipping empty strings.
func collectTokens(rows pgx.Rows) ([]string, error) {
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		if t != "" {
			out = append(out, t)
		}
	}
	return out, rows.Err()
}
