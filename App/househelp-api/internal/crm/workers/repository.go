package workers

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a worker lookup yields no result.
var ErrNotFound = errors.New("worker not found")

// Repository wraps DB access for the workers module.
type Repository struct {
	read  *pgxpool.Pool
	write *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(read, write *pgxpool.Pool) *Repository {
	return &Repository{read: read, write: write}
}

const statusExpr = `
	CASE
	  WHEN u.banned_at IS NOT NULL                                     THEN 'banned'
	  WHEN u.is_suspended                                              THEN 'suspended'
	  WHEN h.approval_status = 'pending'                               THEN 'pending'
	  WHEN h.approval_status = 'rejected'                              THEN 'rejected'
	  ELSE 'active'
	END
`

// List returns a page of workers and total count. Only users w/ role='pro'
// are considered.
func (r *Repository) List(ctx context.Context, f ListFilter) (*ListResponse, error) {
	args := []any{}
	conds := []string{"u.role = 'pro'", "u.deleted_at IS NULL"}
	add := func(clause string, vals ...any) {
		args = append(args, vals...)
		conds = append(conds, clause)
	}

	if f.Search != "" {
		args = append(args, "%"+strings.ToLower(f.Search)+"%")
		idx := len(args)
		conds = append(conds, fmt.Sprintf(
			"(LOWER(u.phone) LIKE $%d OR LOWER(u.name) LIKE $%d OR LOWER(u.email::text) LIKE $%d)",
			idx, idx, idx,
		))
	}
	switch f.Status {
	case StatusActive:
		conds = append(conds, "u.banned_at IS NULL AND u.is_suspended = FALSE AND h.approval_status = 'approved'")
	case StatusPending:
		conds = append(conds, "h.approval_status = 'pending'")
	case StatusRejected:
		conds = append(conds, "h.approval_status = 'rejected'")
	case StatusSuspended:
		conds = append(conds, "u.is_suspended = TRUE AND u.banned_at IS NULL")
	case StatusBanned:
		conds = append(conds, "u.banned_at IS NOT NULL")
	}
	if f.Category != "" {
		add(fmt.Sprintf("$%d = ANY(h.services)", len(args)+1), f.Category)
	}
	if f.OnlyOnline {
		conds = append(conds, "h.is_available = TRUE")
	}

	sortColMap := map[string]string{
		"":          "u.created_at",
		"joined_at": "u.created_at",
		"total_jobs": "h.total_jobs",
		"rating":    "h.rating",
		"name":      "u.name",
	}
	sortCol, ok := sortColMap[f.SortBy]
	if !ok {
		sortCol = "u.created_at"
	}
	sortDir := strings.ToUpper(strings.TrimSpace(f.SortDir))
	if sortDir != "ASC" {
		sortDir = "DESC"
	}

	limit := f.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	whereSQL := "WHERE " + strings.Join(conds, " AND ")

	args = append(args, limit, offset)
	limitParam := len(args) - 1
	offsetParam := len(args)

	pageSQL := fmt.Sprintf(`
		SELECT
		  u.id::text, u.phone, u.name, u.avatar_url,
		  %s AS status,
		  h.is_available,
		  (h.is_available AND h.last_location_at IS NOT NULL
		    AND h.last_location_at > NOW() - INTERVAL '90 seconds') AS is_online,
		  u.is_vip, h.rating, h.total_jobs, h.services,
		  u.created_at, last_b.created_at AS last_active_at
		FROM users u
		JOIN helpers h ON h.id = u.id
		LEFT JOIN LATERAL (
		  SELECT created_at FROM bookings
		  WHERE helper_id = u.id
		  ORDER BY created_at DESC
		  LIMIT 1
		) last_b ON TRUE
		%s
		ORDER BY %s %s NULLS LAST
		LIMIT $%d OFFSET $%d
	`, statusExpr, whereSQL, sortCol, sortDir, limitParam, offsetParam)

	rows, err := r.read.Query(ctx, pageSQL, args...)
	if err != nil {
		return nil, fmt.Errorf("list workers: %w", err)
	}
	defer rows.Close()

	items := []ListItem{}
	for rows.Next() {
		var (
			it     ListItem
			status string
		)
		if err := rows.Scan(
			&it.ID, &it.Phone, &it.Name, &it.AvatarURL, &status,
			&it.IsAvailable, &it.IsOnline, &it.IsVIP, &it.Rating, &it.TotalJobs, &it.Categories,
			&it.JoinedAt, &it.LastActiveAt,
		); err != nil {
			return nil, fmt.Errorf("scan worker: %w", err)
		}
		it.Status = Status(status)
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	countArgs := args[:len(args)-2]
	countSQL := fmt.Sprintf(`
		SELECT COUNT(*) FROM users u
		JOIN helpers h ON h.id = u.id
		%s
	`, whereSQL)
	var total int
	if err := r.read.QueryRow(ctx, countSQL, countArgs...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count workers: %w", err)
	}

	return &ListResponse{Items: items, TotalCount: total, Limit: limit, Offset: offset}, nil
}

// Get returns the per-worker detail.
func (r *Repository) Get(ctx context.Context, id string) (*Detail, error) {
	q := fmt.Sprintf(`
		SELECT
		  u.id::text, u.phone, u.name, u.avatar_url,
		  %s AS status,
		  h.is_available,
		  (h.is_available AND h.last_location_at IS NOT NULL
		    AND h.last_location_at > NOW() - INTERVAL '90 seconds') AS is_online,
		  u.is_vip, h.rating, h.total_jobs, h.services,
		  u.created_at, last_b.created_at AS last_active_at,
		  COALESCE(h.address, ''),
		  h.current_lat, h.current_lng,
		  u.suspend_reason, u.ban_reason,
		  COALESCE(stats.completed_30d, 0),
		  COALESCE(stats.earnings_30d_cents, 0),
		  COALESCE(stats.cancellation_rate, 0),
		  h.locality
		FROM users u
		JOIN helpers h ON h.id = u.id
		LEFT JOIN LATERAL (
		  SELECT created_at FROM bookings
		  WHERE helper_id = u.id
		  ORDER BY created_at DESC
		  LIMIT 1
		) last_b ON TRUE
		LEFT JOIN LATERAL (
		  SELECT
		    COUNT(*) FILTER (WHERE b.status = 'completed' AND b.completed_at >= now() - interval '30 days') AS completed_30d,
		    COALESCE(SUM(b.price_cents) FILTER (WHERE b.status = 'completed' AND b.completed_at >= now() - interval '30 days'), 0) AS earnings_30d_cents,
		    CASE
		      WHEN COUNT(*) = 0 THEN 0
		      ELSE COUNT(*) FILTER (WHERE b.status = 'cancelled')::float / COUNT(*)
		    END AS cancellation_rate
		  FROM bookings b
		  WHERE b.helper_id = u.id
		) stats ON TRUE
		WHERE u.id = $1::uuid AND u.role = 'pro' AND u.deleted_at IS NULL
	`, statusExpr)

	var (
		d      Detail
		status string
		lat    *float64
		lng    *float64
	)
	err := r.read.QueryRow(ctx, q, id).Scan(
		&d.ID, &d.Phone, &d.Name, &d.AvatarURL, &status,
		&d.IsAvailable, &d.IsOnline, &d.IsVIP, &d.Rating, &d.TotalJobs, &d.Categories,
		&d.JoinedAt, &d.LastActiveAt,
		&d.Address, &lat, &lng,
		&d.SuspendReason, &d.BanReason,
		&d.CompletedJobs30d, &d.Earnings30dCents, &d.CancellationRate,
		&d.Locality,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get worker: %w", err)
	}
	d.Status = Status(status)
	d.CurrentLat = lat
	d.CurrentLng = lng
	return &d, nil
}

// Jobs returns the worker's job history (most recent first).
func (r *Repository) Jobs(ctx context.Context, workerID string, limit int) ([]JobRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.read.Query(ctx, `
		SELECT b.id::text,
		       COALESCE(sc.name, '—'),
		       b.status, b.price_cents, b.created_at, b.completed_at
		FROM bookings b
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		WHERE b.helper_id = $1::uuid
		ORDER BY b.created_at DESC
		LIMIT $2
	`, workerID, limit)
	if err != nil {
		return nil, fmt.Errorf("worker jobs: %w", err)
	}
	defer rows.Close()
	out := []JobRow{}
	for rows.Next() {
		var j JobRow
		if err := rows.Scan(&j.ID, &j.Category, &j.Status, &j.PriceCents, &j.CreatedAt, &j.CompletedAt); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// LivePins returns all currently-online workers with coordinates. Used by
// the Live Map page; refreshed every 10s. Filters mirror List(StatusActive)
// so suspended/banned/pending/rejected helpers never leak onto the map even
// if they happen to have stale lat/lng + is_available=TRUE.
func (r *Repository) LivePins(ctx context.Context) ([]LivePin, error) {
	rows, err := r.read.Query(ctx, `
		SELECT u.id::text, u.name, u.phone, h.current_lat::float8, h.current_lng::float8, h.rating::float8,
		       active.id::text, active.status
		FROM helpers h
		JOIN users u ON u.id = h.id
		LEFT JOIN LATERAL (
		  SELECT id, status FROM bookings
		  WHERE helper_id = u.id
		    AND status IN ('assigned','en_route','in_progress','arrived')
		  ORDER BY created_at DESC
		  LIMIT 1
		) active ON TRUE
		WHERE h.is_available = TRUE
		  AND h.current_lat IS NOT NULL
		  AND h.current_lng IS NOT NULL
		  AND h.last_location_at IS NOT NULL
		  AND h.last_location_at > NOW() - INTERVAL '90 seconds'
		  AND u.deleted_at IS NULL
		  AND u.role = 'pro'
		  AND u.banned_at IS NULL
		  AND u.is_suspended = FALSE
		  AND h.approval_status = 'approved'
	`)
	if err != nil {
		return nil, fmt.Errorf("live pins: %w", err)
	}
	defer rows.Close()

	out := []LivePin{}
	for rows.Next() {
		var (
			p             LivePin
			activeID      *string
			activeStatus  *string
		)
		if err := rows.Scan(&p.ID, &p.Name, &p.Phone, &p.Lat, &p.Lng, &p.Rating, &activeID, &activeStatus); err != nil {
			return nil, err
		}
		switch {
		case activeID == nil:
			p.JobStatus = "idle"
		case activeStatus != nil && *activeStatus == "in_progress":
			p.JobStatus = "on_job"
			p.ActiveBookingID = activeID
		default: // assigned / en_route / arrived
			p.JobStatus = "en_route"
			p.ActiveBookingID = activeID
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// HasActiveJob reports whether the worker has an in-flight booking. Used
// before force-offline to surface a warning.
func (r *Repository) HasActiveJob(ctx context.Context, workerID string) (bool, *string, error) {
	var bookingID *string
	err := r.read.QueryRow(ctx, `
		SELECT id::text FROM bookings
		WHERE helper_id = $1::uuid
		  AND status IN ('assigned','en_route','in_progress','arrived')
		ORDER BY created_at DESC
		LIMIT 1
	`, workerID).Scan(&bookingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil, nil
	}
	if err != nil {
		return false, nil, fmt.Errorf("check active job: %w", err)
	}
	return bookingID != nil, bookingID, nil
}

// ── Mutations ──────────────────────────────────────────────────────────

// Approve flips approval_status to 'approved'.
func (r *Repository) Approve(ctx context.Context, workerID string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE helpers SET approval_status = 'approved' WHERE id = $1::uuid
	`, workerID)
	if err != nil {
		return fmt.Errorf("approve: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Reject flips approval_status to 'rejected'. Reason is stored as a note
// (so the reason history is queryable alongside other admin notes).
func (r *Repository) Reject(ctx context.Context, workerID string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE helpers SET approval_status = 'rejected' WHERE id = $1::uuid
	`, workerID)
	if err != nil {
		return fmt.Errorf("reject: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Suspend / Unsuspend / Ban / Unban operate on the user row exactly like
// the users module. Duplicated here so the workers handler stays
// self-contained (we don't want it reaching across to internal/crm/users).
func (r *Repository) Suspend(ctx context.Context, workerID, reason string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE users SET is_suspended = TRUE, suspend_reason = $2, updated_at = now()
		WHERE id = $1::uuid AND role = 'pro' AND deleted_at IS NULL
	`, workerID, reason)
	if err != nil {
		return fmt.Errorf("suspend worker: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Unsuspend clears the suspension.
func (r *Repository) Unsuspend(ctx context.Context, workerID string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE users SET is_suspended = FALSE, suspend_reason = NULL, updated_at = now()
		WHERE id = $1::uuid AND role = 'pro' AND deleted_at IS NULL
	`, workerID)
	if err != nil {
		return fmt.Errorf("unsuspend worker: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ForceOffline toggles is_available=false. Doesn't cancel any active booking.
func (r *Repository) ForceOffline(ctx context.Context, workerID string) error {
	res, err := r.write.Exec(ctx, `UPDATE helpers SET is_available = FALSE WHERE id = $1::uuid`, workerID)
	if err != nil {
		return fmt.Errorf("force offline: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetCategories overwrites the worker's services array.
func (r *Repository) SetCategories(ctx context.Context, workerID string, cats []string) error {
	if cats == nil {
		cats = []string{}
	}
	res, err := r.write.Exec(ctx, `UPDATE helpers SET services = $2 WHERE id = $1::uuid`, workerID, cats)
	if err != nil {
		return fmt.Errorf("set categories: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetLocality validates against active localities and writes the canonical
// (case-corrected) name back. Empty input clears the field. Returns the
// stored value or an error suitable for surfacing to the admin user.
func (r *Repository) SetLocality(ctx context.Context, workerID, locality string) (string, error) {
	loc := strings.TrimSpace(locality)
	if loc == "" {
		_, err := r.write.Exec(ctx, `UPDATE helpers SET locality = NULL WHERE id = $1::uuid`, workerID)
		if err != nil {
			return "", fmt.Errorf("clear locality: %w", err)
		}
		return "", nil
	}
	var canonical string
	err := r.write.QueryRow(ctx,
		`SELECT name FROM localities WHERE active = true AND name ILIKE $1 LIMIT 1`,
		loc,
	).Scan(&canonical)
	if err != nil {
		return "", fmt.Errorf("unknown locality")
	}
	if _, err := r.write.Exec(ctx,
		`UPDATE helpers SET locality = $2 WHERE id = $1::uuid`, workerID, canonical,
	); err != nil {
		return "", fmt.Errorf("write locality: %w", err)
	}
	return canonical, nil
}
