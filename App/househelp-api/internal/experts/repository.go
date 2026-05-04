package experts

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrAlreadyAdded is returned when the (user, helper) pair already exists.
var ErrAlreadyAdded = errors.New("helper already in experts list")

// ErrNotFound is returned when the (user, helper) pair was never present.
var ErrNotFound = errors.New("expert not found")

// ErrHelperUnknown is returned when the target helper does not exist or is
// not an active pro.
var ErrHelperUnknown = errors.New("helper not found")

// Repository wraps the user_preferred_helpers table.
type Repository struct {
	pool *pgxpool.Pool
}

// NewRepository constructs a Repository against the user-app pool.
func NewRepository(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

// List returns the preferred helpers for the given user, joined with
// users + helpers for profile data and a per-pair completed-jobs count.
// Sorted by created_at ASC so the oldest preference is tried first by the
// scheduled-dispatch invite chain.
func (r *Repository) List(ctx context.Context, userID string) ([]Expert, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT
		    uph.helper_id::text,
		    u.name,
		    NULL::text                                AS photo_url,
		    h.rating,
		    COALESCE((
		        SELECT COUNT(*) FROM bookings b
		        WHERE b.customer_id = uph.user_id
		          AND b.helper_id   = uph.helper_id
		          AND b.status      = 'completed'
		    ), 0)::int                                 AS completed_jobs_with_user,
		    uph.created_at
		FROM user_preferred_helpers uph
		JOIN users   u ON u.id = uph.helper_id
		LEFT JOIN helpers h ON h.id = uph.helper_id
		WHERE uph.user_id = $1::uuid
		ORDER BY uph.created_at ASC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list experts: %w", err)
	}
	defer rows.Close()

	out := []Expert{}
	for rows.Next() {
		var e Expert
		if err := rows.Scan(
			&e.HelperID, &e.Name, &e.PhotoURL,
			&e.AverageRating, &e.CompletedJobsWithUser, &e.AddedAt,
		); err != nil {
			return nil, fmt.Errorf("scan expert row: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Count returns the number of preferred helpers the user currently has —
// used by the service layer to enforce MaxExpertsPerUser before insert.
func (r *Repository) Count(ctx context.Context, userID string) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM user_preferred_helpers WHERE user_id = $1::uuid`,
		userID,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count experts: %w", err)
	}
	return n, nil
}

// HelperExists checks that the target helper is a real pro account that
// hasn't been deleted.
func (r *Repository) HelperExists(ctx context.Context, helperID string) (bool, error) {
	var exists bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
		    SELECT 1
		    FROM users u
		    JOIN helpers h ON h.id = u.id
		    WHERE u.id           = $1::uuid
		      AND u.role         IN ('helper','pro')
		      AND u.deleted_at   IS NULL
		      AND u.banned_at    IS NULL
		)
	`, helperID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check helper exists: %w", err)
	}
	return exists, nil
}

// Add inserts a (user, helper) pair. Returns ErrAlreadyAdded on conflict.
func (r *Repository) Add(ctx context.Context, userID, helperID string) error {
	ct, err := r.pool.Exec(ctx, `
		INSERT INTO user_preferred_helpers (user_id, helper_id)
		VALUES ($1::uuid, $2::uuid)
		ON CONFLICT (user_id, helper_id) DO NOTHING
	`, userID, helperID)
	if err != nil {
		return fmt.Errorf("insert expert: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrAlreadyAdded
	}
	return nil
}

// Remove deletes a (user, helper) pair. Returns ErrNotFound if no row.
func (r *Repository) Remove(ctx context.Context, userID, helperID string) error {
	ct, err := r.pool.Exec(ctx,
		`DELETE FROM user_preferred_helpers WHERE user_id = $1::uuid AND helper_id = $2::uuid`,
		userID, helperID,
	)
	if err != nil {
		return fmt.Errorf("delete expert: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// PreferredHelperIDs returns the helper IDs for a given user in oldest-first
// order. Used by the scheduled-dispatch invite chain. Lightweight (no joins)
// because the chain is hot-path.
func (r *Repository) PreferredHelperIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT helper_id::text
		FROM user_preferred_helpers
		WHERE user_id = $1::uuid
		ORDER BY created_at ASC
		LIMIT $2
	`, userID, MaxExpertsPerUser)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("list preferred helper ids: %w", err)
	}
	defer rows.Close()

	out := make([]string, 0, MaxExpertsPerUser)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan helper id: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
