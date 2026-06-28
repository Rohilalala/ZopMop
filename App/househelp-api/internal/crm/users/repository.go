package users

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a user lookup yields no result.
var ErrNotFound = errors.New("user not found")

// Repository encapsulates DB access for users. Read methods can use the read
// pool; write methods use the write pool. The Service wires which is which.
type Repository struct {
	read  *pgxpool.Pool
	write *pgxpool.Pool
}

// NewRepository constructs a Repository.
func NewRepository(read, write *pgxpool.Pool) *Repository {
	return &Repository{read: read, write: write}
}

// List returns a page of users matching the filter, plus the total count
// (across all pages, ignoring limit/offset). Built dynamically so each
// optional filter column only adds a clause when it's actually set.
func (r *Repository) List(ctx context.Context, f ListFilter) (*ListResponse, error) {
	args := []any{}
	conds := []string{"u.deleted_at IS NULL"}
	add := func(clause string, vals ...any) {
		args = append(args, vals...)
		conds = append(conds, clause)
	}

	if f.Search != "" {
		// ILIKE match on phone / name / email. Wrap in % at both ends.
		args = append(args, "%"+strings.ToLower(f.Search)+"%")
		idx := len(args)
		conds = append(conds, fmt.Sprintf(
			"(LOWER(u.phone) LIKE $%d OR LOWER(u.name) LIKE $%d OR LOWER(u.email::text) LIKE $%d)",
			idx, idx, idx,
		))
	}
	if f.Status == StatusActive {
		conds = append(conds, "u.is_suspended = FALSE AND u.banned_at IS NULL")
	} else if f.Status == StatusSuspended {
		conds = append(conds, "u.is_suspended = TRUE AND u.banned_at IS NULL")
	} else if f.Status == StatusBanned {
		conds = append(conds, "u.banned_at IS NOT NULL")
	}
	if f.Role != "" {
		add(fmt.Sprintf("u.role = $%d", len(args)+1), f.Role)
	}
	if f.IsVIP != nil {
		add(fmt.Sprintf("u.is_vip = $%d", len(args)+1), *f.IsVIP)
	}
	if f.JoinedAfter != nil {
		add(fmt.Sprintf("u.created_at >= $%d", len(args)+1), *f.JoinedAfter)
	}
	if f.JoinedBefore != nil {
		add(fmt.Sprintf("u.created_at <= $%d", len(args)+1), *f.JoinedBefore)
	}

	// Order column. Whitelist to avoid sql injection via SortBy.
	sortColMap := map[string]string{
		"":             "u.created_at",
		"joined_at":    "u.created_at",
		"total_orders": "stats.total_orders",
		"ltv_cents":    "stats.ltv_cents",
		"name":         "u.name",
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

	// Min orders / min LTV are HAVING-style; apply via subquery.
	having := []string{}
	if f.MinOrders > 0 {
		args = append(args, f.MinOrders)
		having = append(having, fmt.Sprintf("COALESCE(stats.total_orders, 0) >= $%d", len(args)))
	}
	if f.MinLTVCents > 0 {
		args = append(args, f.MinLTVCents)
		having = append(having, fmt.Sprintf("COALESCE(stats.ltv_cents, 0) >= $%d", len(args)))
	}
	havingSQL := ""
	if len(having) > 0 {
		havingSQL = "AND " + strings.Join(having, " AND ")
	}

	// Page query.
	args = append(args, limit, offset)
	limitParam := len(args) - 1
	offsetParam := len(args)

	pageSQL := fmt.Sprintf(`
		SELECT
		  u.id::text, u.phone, u.email, u.name, u.avatar_url, u.role,
		  CASE
		    WHEN u.banned_at IS NOT NULL THEN 'banned'
		    WHEN u.is_suspended            THEN 'suspended'
		    ELSE 'active'
		  END AS status,
		  u.is_vip, u.created_at,
		  COALESCE(stats.total_orders, 0)  AS total_orders,
		  COALESCE(stats.ltv_cents, 0)     AS ltv_cents,
		  stats.last_active_at
		FROM users u
		LEFT JOIN LATERAL (
		  SELECT
		    COUNT(*)                                        AS total_orders,
		    COALESCE(SUM(b.amount_paise) FILTER (WHERE b.status = 'completed'), 0) AS ltv_cents,
		    MAX(b.created_at)                               AS last_active_at
		  FROM bookings b
		  WHERE b.customer_id = u.id
		) stats ON TRUE
		%s %s
		ORDER BY %s %s NULLS LAST
		LIMIT $%d OFFSET $%d
	`, whereSQL, havingSQL, sortCol, sortDir, limitParam, offsetParam)

	rows, err := r.read.Query(ctx, pageSQL, args...)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()

	items := []ListItem{}
	for rows.Next() {
		var (
			it     ListItem
			status string
		)
		if err := rows.Scan(
			&it.ID, &it.Phone, &it.Email, &it.Name, &it.AvatarURL, &it.Role,
			&status, &it.IsVIP, &it.JoinedAt,
			&it.TotalOrders, &it.LTVCents, &it.LastActiveAt,
		); err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		it.Status = Status(status)
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Total count: same WHERE / HAVING logic, no ORDER / LIMIT.
	countArgs := args[:len(args)-2] // strip limit + offset
	countSQL := fmt.Sprintf(`
		SELECT COUNT(*) FROM (
		  SELECT u.id
		  FROM users u
		  LEFT JOIN LATERAL (
		    SELECT
		      COUNT(*)                                        AS total_orders,
		      COALESCE(SUM(b.amount_paise) FILTER (WHERE b.status = 'completed'), 0) AS ltv_cents
		    FROM bookings b
		    WHERE b.customer_id = u.id
		  ) stats ON TRUE
		  %s %s
		) sub
	`, whereSQL, havingSQL)

	var total int
	if err := r.read.QueryRow(ctx, countSQL, countArgs...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count users: %w", err)
	}

	return &ListResponse{
		Items:      items,
		TotalCount: total,
		Limit:      limit,
		Offset:     offset,
	}, nil
}

// Get returns the per-user detail.
func (r *Repository) Get(ctx context.Context, id string) (*Detail, error) {
	const q = `
		SELECT
		  u.id::text, u.phone, u.email, u.name, u.avatar_url, u.role,
		  CASE
		    WHEN u.banned_at IS NOT NULL THEN 'banned'
		    WHEN u.is_suspended            THEN 'suspended'
		    ELSE 'active'
		  END AS status,
		  u.is_vip, u.created_at,
		  u.suspend_reason, u.ban_reason, u.banned_at,
		  COALESCE(stats.total_orders, 0),
		  COALESCE(stats.ltv_cents, 0),
		  COALESCE(stats.avg_order_cents, 0),
		  COALESCE(stats.active_orders, 0),
		  stats.last_active_at
		FROM users u
		LEFT JOIN LATERAL (
		  SELECT
		    COUNT(*)                                        AS total_orders,
		    COALESCE(SUM(b.amount_paise) FILTER (WHERE b.status = 'completed'), 0) AS ltv_cents,
		    COALESCE(AVG(b.amount_paise) FILTER (WHERE b.status = 'completed'), 0)::int AS avg_order_cents,
		    COUNT(*) FILTER (WHERE b.status IN ('pending','searching','dispatching','accepted','arrived','in_progress')) AS active_orders,
		    MAX(b.created_at)                               AS last_active_at
		  FROM bookings b
		  WHERE b.customer_id = u.id
		) stats ON TRUE
		WHERE u.id = $1::uuid AND u.deleted_at IS NULL
	`
	var (
		d      Detail
		status string
	)
	err := r.read.QueryRow(ctx, q, id).Scan(
		&d.ID, &d.Phone, &d.Email, &d.Name, &d.AvatarURL, &d.Role,
		&status, &d.IsVIP, &d.JoinedAt,
		&d.SuspendReason, &d.BanReason, &d.BannedAt,
		&d.TotalOrders, &d.LTVCents, &d.AvgOrderCents, &d.ActiveOrders,
		&d.LastActiveAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}
	d.Status = Status(status)

	cats, err := r.preferredCategories(ctx, id)
	if err != nil {
		return nil, err
	}
	d.PreferredCategories = cats
	return &d, nil
}

func (r *Repository) preferredCategories(ctx context.Context, userID string) ([]CategoryShare, error) {
	const q = `
		SELECT COALESCE(sc.name, '—'), COUNT(*)
		FROM bookings b
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		WHERE b.customer_id = $1::uuid
		GROUP BY sc.name
		ORDER BY COUNT(*) DESC
		LIMIT 5
	`
	rows, err := r.read.Query(ctx, q, userID)
	if err != nil {
		return nil, fmt.Errorf("preferred categories: %w", err)
	}
	defer rows.Close()
	out := []CategoryShare{}
	for rows.Next() {
		var c CategoryShare
		if err := rows.Scan(&c.Category, &c.Count); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Orders returns the user's order history (most recent first).
func (r *Repository) Orders(ctx context.Context, userID string, limit int) ([]OrderRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := r.read.Query(ctx, `
		SELECT b.id::text,
		       COALESCE(sc.name, '—'),
		       b.status, b.amount_paise, b.created_at, b.completed_at
		FROM bookings b
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		WHERE b.customer_id = $1::uuid
		ORDER BY b.created_at DESC
		LIMIT $2
	`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("orders: %w", err)
	}
	defer rows.Close()
	out := []OrderRow{}
	for rows.Next() {
		var o OrderRow
		if err := rows.Scan(&o.ID, &o.Category, &o.Status, &o.AmountPaise, &o.CreatedAt, &o.CompletedAt); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// Suspend toggles is_suspended=true with a reason.
func (r *Repository) Suspend(ctx context.Context, userID, reason string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE users
		SET is_suspended = TRUE, suspend_reason = $2, updated_at = now()
		WHERE id = $1::uuid AND deleted_at IS NULL
	`, userID, reason)
	if err != nil {
		return fmt.Errorf("suspend user: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Unsuspend clears is_suspended.
func (r *Repository) Unsuspend(ctx context.Context, userID string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE users
		SET is_suspended = FALSE, suspend_reason = NULL, updated_at = now()
		WHERE id = $1::uuid AND deleted_at IS NULL
	`, userID)
	if err != nil {
		return fmt.Errorf("unsuspend user: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Ban sets banned_at + ban_reason. Banning a user does NOT cancel their
// active orders — that's a follow-up policy decision the admin owns.
func (r *Repository) Ban(ctx context.Context, userID, reason string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE users
		SET banned_at = now(), ban_reason = $2, updated_at = now()
		WHERE id = $1::uuid AND deleted_at IS NULL
	`, userID, reason)
	if err != nil {
		return fmt.Errorf("ban user: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Unban clears banned_at + ban_reason.
func (r *Repository) Unban(ctx context.Context, userID string) error {
	res, err := r.write.Exec(ctx, `
		UPDATE users
		SET banned_at = NULL, ban_reason = NULL, updated_at = now()
		WHERE id = $1::uuid
	`, userID)
	if err != nil {
		return fmt.Errorf("unban user: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetVIP toggles is_vip.
func (r *Repository) SetVIP(ctx context.Context, userID string, isVIP bool) error {
	res, err := r.write.Exec(ctx, `
		UPDATE users SET is_vip = $2, updated_at = now()
		WHERE id = $1::uuid AND deleted_at IS NULL
	`, userID, isVIP)
	if err != nil {
		return fmt.Errorf("set vip: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// AddNote inserts an admin note for the user.
func (r *Repository) AddNote(ctx context.Context, userID, adminID, adminEmail, body string) (*Note, error) {
	var n Note
	err := r.write.QueryRow(ctx, `
		INSERT INTO crm_user_notes (user_id, admin_id, admin_email, body)
		VALUES ($1::uuid, NULLIF($2, '')::uuid, NULLIF($3, ''), $4)
		RETURNING id::text, admin_email, body, created_at
	`, userID, adminID, adminEmail, body).Scan(&n.ID, &n.AdminEmail, &n.Body, &n.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("add note: %w", err)
	}
	return &n, nil
}

// ListNotes returns the user's notes, most recent first.
func (r *Repository) ListNotes(ctx context.Context, userID string) ([]Note, error) {
	rows, err := r.read.Query(ctx, `
		SELECT id::text, admin_email, body, created_at
		FROM crm_user_notes
		WHERE user_id = $1::uuid
		ORDER BY created_at DESC
		LIMIT 200
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list notes: %w", err)
	}
	defer rows.Close()
	out := []Note{}
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.ID, &n.AdminEmail, &n.Body, &n.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// HasActiveOrders reports whether the user has any in-flight orders.
// Used by the suspend/ban flow to surface a warning before action.
func (r *Repository) HasActiveOrders(ctx context.Context, userID string) (bool, int, error) {
	var count int
	err := r.read.QueryRow(ctx, `
		SELECT COUNT(*) FROM bookings
		WHERE customer_id = $1::uuid
		  AND status IN ('pending','searching','dispatching','accepted','arrived','in_progress')
	`, userID).Scan(&count)
	if err != nil {
		return false, 0, fmt.Errorf("check active orders: %w", err)
	}
	return count > 0, count, nil
}

// _ guards against unused-import in a future change where we touch time
// only conditionally.
var _ = time.Time{}
