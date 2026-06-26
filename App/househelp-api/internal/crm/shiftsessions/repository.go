// Package shiftsessions exposes a read-only CRM admin view of pro shift
// sessions, including the mandatory go-online / go-offline selfies
// (shift_sessions.online_selfie_url / offline_selfie_url — base64 data URLs).
package shiftsessions

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository is read-only DB access for the shift-sessions admin view.
type Repository struct {
	read *pgxpool.Pool
}

// NewRepository constructs a Repository against the read pool.
func NewRepository(read *pgxpool.Pool) *Repository {
	return &Repository{read: read}
}

// SessionItem is one shift session joined to its pro, with selfie URLs.
type SessionItem struct {
	ID               string     `json:"id"`
	ProID            string     `json:"pro_id"`
	ProName          *string    `json:"pro_name"`
	ProPhone         *string    `json:"pro_phone"`
	OnlineAt         *time.Time `json:"online_at"`
	OfflineAt        *time.Time `json:"offline_at"`
	OnlineMinutes    *int       `json:"online_minutes"`
	OnlineSelfieURL  *string    `json:"online_selfie_url"`
	OfflineSelfieURL *string    `json:"offline_selfie_url"`
}

// ListResponse is the paginated envelope (mirrors the workers module).
type ListResponse struct {
	Items      []SessionItem `json:"items"`
	TotalCount int           `json:"total_count"`
	Limit      int           `json:"limit"`
	Offset     int           `json:"offset"`
}

// List returns shift sessions newest-first, with the pro name/phone and both
// selfie URLs.
func (r *Repository) List(ctx context.Context, limit, offset int) (*ListResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var total int
	if err := r.read.QueryRow(ctx, `SELECT COUNT(*) FROM shift_sessions`).Scan(&total); err != nil {
		return nil, fmt.Errorf("count shift sessions: %w", err)
	}

	rows, err := r.read.Query(ctx, `
		SELECT ss.id::text, ss.pro_id::text, u.name, u.phone,
		       ss.online_at, ss.offline_at, ss.online_minutes,
		       ss.online_selfie_url, ss.offline_selfie_url
		  FROM shift_sessions ss
		  JOIN users u ON u.id = ss.pro_id
		 ORDER BY ss.online_at DESC NULLS LAST
		 LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("list shift sessions: %w", err)
	}
	defer rows.Close()

	items := make([]SessionItem, 0, limit)
	for rows.Next() {
		var s SessionItem
		if err := rows.Scan(
			&s.ID, &s.ProID, &s.ProName, &s.ProPhone,
			&s.OnlineAt, &s.OfflineAt, &s.OnlineMinutes,
			&s.OnlineSelfieURL, &s.OfflineSelfieURL,
		); err != nil {
			return nil, err
		}
		items = append(items, s)
	}
	return &ListResponse{Items: items, TotalCount: total, Limit: limit, Offset: offset}, rows.Err()
}
