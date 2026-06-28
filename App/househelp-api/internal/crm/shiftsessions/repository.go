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

// SessionItem is one shift session joined to its pro. The selfie URLs are large
// base64 data URLs, so the list exposes only presence flags; the actual images
// are lazy-loaded per session via GetSelfies to keep the list response bounded.
type SessionItem struct {
	ID               string     `json:"id"`
	ProID            string     `json:"pro_id"`
	ProName          *string    `json:"pro_name"`
	ProPhone         *string    `json:"pro_phone"`
	OnlineAt         *time.Time `json:"online_at"`
	OfflineAt        *time.Time `json:"offline_at"`
	OnlineMinutes    *int       `json:"online_minutes"`
	HasOnlineSelfie  bool       `json:"has_online_selfie"`
	HasOfflineSelfie bool       `json:"has_offline_selfie"`
}

// ListResponse is the paginated envelope (mirrors the workers module).
type ListResponse struct {
	Items      []SessionItem `json:"items"`
	TotalCount int           `json:"total_count"`
	Limit      int           `json:"limit"`
	Offset     int           `json:"offset"`
}

// List returns shift sessions newest-first with the pro name/phone and selfie
// PRESENCE flags only (never the base64 image bodies).
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
		       (ss.online_selfie_url IS NOT NULL)  AS has_online_selfie,
		       (ss.offline_selfie_url IS NOT NULL) AS has_offline_selfie
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
			&s.HasOnlineSelfie, &s.HasOfflineSelfie,
		); err != nil {
			return nil, err
		}
		items = append(items, s)
	}
	return &ListResponse{Items: items, TotalCount: total, Limit: limit, Offset: offset}, rows.Err()
}

// Selfies holds the (large, base64) selfie data URLs for a single session.
type Selfies struct {
	OnlineSelfieURL  *string `json:"online_selfie_url"`
	OfflineSelfieURL *string `json:"offline_selfie_url"`
}

// GetSelfies returns the selfies for one session — lazy-loaded by the CRM so
// they never bloat the list response. Returns pgx.ErrNoRows if the id is unknown.
func (r *Repository) GetSelfies(ctx context.Context, id string) (*Selfies, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var s Selfies
	if err := r.read.QueryRow(ctx,
		`SELECT online_selfie_url, offline_selfie_url FROM shift_sessions WHERE id = $1::uuid`,
		id).Scan(&s.OnlineSelfieURL, &s.OfflineSelfieURL); err != nil {
		return nil, err
	}
	return &s, nil
}
