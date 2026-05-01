package insights

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository struct {
	db *pgxpool.Pool
}

func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// AvgRatingForHelpers returns the avg rating for the given helper IDs.
// Returns 5.0 when the set is empty (best-default for fresh markets).
func (r *Repository) AvgRatingForHelpers(ctx context.Context, helperIDs []string) (float64, error) {
	if len(helperIDs) == 0 {
		return 5.0, nil
	}
	row := r.db.QueryRow(ctx,
		`SELECT COALESCE(AVG(rating), 5.0) FROM helpers WHERE id = ANY($1::uuid[]) AND is_available = true`,
		helperIDs,
	)
	var avg float64
	if err := row.Scan(&avg); err != nil {
		return 0, fmt.Errorf("avg rating scan: %w", err)
	}
	return avg, nil
}

// FilterAvailableHelpers returns only the helper IDs from the input list that are currently available.
func (r *Repository) FilterAvailableHelpers(ctx context.Context, helperIDs []string) ([]string, error) {
	if len(helperIDs) == 0 {
		return []string{}, nil
	}
	rows, err := r.db.Query(ctx,
		`SELECT id::text FROM helpers WHERE id = ANY($1::uuid[]) AND is_available = true`,
		helperIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("filter available helpers: %w", err)
	}
	defer rows.Close()

	var available []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan available helper: %w", err)
		}
		available = append(available, id)
	}
	return available, rows.Err()
}

// MyUsualServiceIDs returns service category IDs for a user, ranked by:
//  1. Recency (most recent booking first), then
//  2. Frequency (most used first) for ties / additional fill.
//
// Result is deduplicated; up to `limit` IDs returned.
func (r *Repository) MyUsualServiceIDs(ctx context.Context, userID string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 6
	}

	// Combined query: rank by latest booking time desc, with frequency as tiebreaker.
	rows, err := r.db.Query(ctx, `
		SELECT bs.service_id::text AS sid
		FROM booking_services bs
		JOIN bookings b ON b.id = bs.booking_id
		WHERE b.customer_id = $1::uuid
		GROUP BY bs.service_id
		ORDER BY MAX(b.created_at) DESC, COUNT(*) DESC
		LIMIT $2
	`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("query usuals: %w", err)
	}
	defer rows.Close()

	out := make([]string, 0, limit)
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			return nil, fmt.Errorf("scan usuals: %w", err)
		}
		out = append(out, sid)
	}
	return out, rows.Err()
}
