package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Repository handles all database operations for the admin module.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new admin repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// GetAdminByUserID retrieves an admin record by user ID.
func (r *Repository) GetAdminByUserID(ctx context.Context, userID string) (*AdminUser, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	admin := &AdminUser{}
	err := r.db.QueryRow(queryCtx,
		`SELECT id, user_id, permissions, created_at
		 FROM admin_users WHERE user_id = $1`,
		userID,
	).Scan(&admin.ID, &admin.UserID, &admin.Permissions, &admin.CreatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get admin by user ID: %w", err)
	}

	return admin, nil
}

// GetAdminPermissions returns the permission list for an admin.
func (r *Repository) GetAdminPermissions(ctx context.Context, adminID string) ([]string, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var permJSON []byte
	err := r.db.QueryRow(queryCtx,
		`SELECT permissions FROM admin_users WHERE id = $1`,
		adminID,
	).Scan(&permJSON)
	if err != nil {
		return nil, fmt.Errorf("failed to get admin permissions: %w", err)
	}

	var permissions []string
	if err := json.Unmarshal(permJSON, &permissions); err != nil {
		return nil, fmt.Errorf("failed to parse permissions: %w", err)
	}

	return permissions, nil
}

// LogAdminAction records an action in the audit log.
func (r *Repository) LogAdminAction(ctx context.Context, adminID, action, targetType, targetID string, oldValue, newValue json.RawMessage, ipAddress string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	_, err := r.db.Exec(queryCtx,
		`INSERT INTO audit_log (admin_id, action, target_type, target_id, old_value, new_value, ip_address)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		adminID, action, targetType, targetID, oldValue, newValue, ipAddress,
	)
	if err != nil {
		log.Error().Err(err).
			Str("admin_id", adminID).
			Str("action", action).
			Msg("failed to log admin action")
		return fmt.Errorf("failed to log admin action: %w", err)
	}

	return nil
}

// GetDashboardStats fetches aggregate metrics for the admin dashboard.
func (r *Repository) GetDashboardStats(ctx context.Context) (*DashboardStats, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	stats := &DashboardStats{}

	// Total users.
	err := r.db.QueryRow(queryCtx,
		`SELECT COUNT(*) FROM users WHERE role = 'customer'`,
	).Scan(&stats.TotalUsers)
	if err != nil {
		return nil, fmt.Errorf("failed to count users: %w", err)
	}

	// Total helpers.
	err = r.db.QueryRow(queryCtx,
		`SELECT COUNT(*) FROM users WHERE role = 'helper'`,
	).Scan(&stats.TotalHelpers)
	if err != nil {
		return nil, fmt.Errorf("failed to count helpers: %w", err)
	}

	// Active bookings.
	err = r.db.QueryRow(queryCtx,
		`SELECT COUNT(*) FROM bookings WHERE status IN ('pending', 'accepted', 'in_progress')`,
	).Scan(&stats.ActiveBookings)
	if err != nil {
		return nil, fmt.Errorf("failed to count active bookings: %w", err)
	}

	// Revenue today (sum of net amount_paise for completed bookings today).
	err = r.db.QueryRow(queryCtx,
		`SELECT COALESCE(SUM(amount_paise - discount_paise), 0)
		 FROM bookings
		 WHERE status = 'completed' AND created_at >= CURRENT_DATE`,
	).Scan(&stats.RevenueTodayCents)
	if err != nil {
		return nil, fmt.Errorf("failed to calculate revenue: %w", err)
	}

	return stats, nil
}

// queryParamHelper is a simple helper to manage parameter positions in query building.
type queryParamHelper struct {
	args []interface{}
	idx  int
}

func newQueryParamHelper() *queryParamHelper {
	return &queryParamHelper{args: []interface{}{}, idx: 1}
}

func (qh *queryParamHelper) addParam(value interface{}) string {
	qh.args = append(qh.args, value)
	placeholder := fmt.Sprintf("$%d", qh.idx)
	qh.idx++
	return placeholder
}

func (qh *queryParamHelper) getArgs() []interface{} {
	return qh.args
}

func (qh *queryParamHelper) nextPlaceholder() string {
	placeholder := fmt.Sprintf("$%d", qh.idx)
	qh.idx++
	return placeholder
}

// GetAllUsers returns a paginated list of users with optional filters.
func (r *Repository) GetAllUsers(ctx context.Context, page, limit int, role, search string) ([]UserListItem, int, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	offset := (page - 1) * limit

	// Build query with optional filters using helper to manage parameter positions.
	qh := newQueryParamHelper()
	baseQuery := `FROM users WHERE 1=1`

	if role != "" {
		baseQuery += ` AND role = ` + qh.addParam(role)
	}

	if search != "" {
		// Escape wildcard characters in search to prevent unintended LIKE behavior.
		escapedSearch := strings.NewReplacer("%", "\\%", "_", "\\_").Replace(search)
		searchVal := "%" + escapedSearch + "%"
		baseQuery += ` AND (phone ILIKE ` + qh.addParam(searchVal) + ` ESCAPE '\\' OR name ILIKE ` + qh.addParam(searchVal) + ` ESCAPE '\\')`
	}

	// Count total.
	var totalCount int
	countQuery := `SELECT COUNT(*) ` + baseQuery
	err := r.db.QueryRow(queryCtx, countQuery, qh.getArgs()...).Scan(&totalCount)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count users: %w", err)
	}

	// Fetch page - add limit and offset to args.
	limitPlaceholder := qh.nextPlaceholder()
	offsetPlaceholder := qh.nextPlaceholder()
	selectQuery := fmt.Sprintf(
		`SELECT id, phone, COALESCE(name, ''), role, is_suspended, created_at %s ORDER BY created_at DESC LIMIT %s OFFSET %s`,
		baseQuery, limitPlaceholder, offsetPlaceholder,
	)
	args := append(qh.getArgs(), limit, offset)

	rows, err := r.db.Query(queryCtx, selectQuery, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query users: %w", err)
	}
	defer rows.Close()

	var users []UserListItem
	for rows.Next() {
		var u UserListItem
		if err := rows.Scan(&u.ID, &u.Phone, &u.Name, &u.Role, &u.IsSuspended, &u.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("failed to scan user: %w", err)
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating users: %w", err)
	}

	return users, totalCount, nil
}

// SuspendUser sets is_suspended = true for a user.
func (r *Repository) SuspendUser(ctx context.Context, userID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE users SET is_suspended = true, updated_at = now() WHERE id = $1`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to suspend user: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("user not found")
	}
	return nil
}

// UnsuspendUser sets is_suspended = false for a user.
func (r *Repository) UnsuspendUser(ctx context.Context, userID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE users SET is_suspended = false, updated_at = now() WHERE id = $1`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("failed to unsuspend user: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("user not found")
	}
	return nil
}

// GetAllHelpers returns a paginated list of helpers with optional filters.
func (r *Repository) GetAllHelpers(ctx context.Context, page, limit int, available *bool, minRating float64) ([]HelperListItem, int, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	offset := (page - 1) * limit

	baseQuery := `FROM users u JOIN helpers h ON u.id = h.id WHERE u.role = 'helper'`
	args := []interface{}{}
	argIdx := 1

	if available != nil {
		baseQuery += fmt.Sprintf(` AND h.is_available = $%d`, argIdx)
		args = append(args, *available)
		argIdx++
	}

	if minRating > 0 {
		baseQuery += fmt.Sprintf(` AND h.rating >= $%d`, argIdx)
		args = append(args, minRating)
		argIdx++
	}

	var totalCount int
	err := r.db.QueryRow(queryCtx, `SELECT COUNT(*) `+baseQuery, args...).Scan(&totalCount)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count helpers: %w", err)
	}

	selectQuery := fmt.Sprintf(
		`SELECT u.id, u.phone, COALESCE(u.name, ''), h.is_available, h.rating, h.total_jobs,
		        COALESCE(h.current_lat, 0), COALESCE(h.current_lng, 0)
		 %s ORDER BY h.rating DESC LIMIT $%d OFFSET $%d`,
		baseQuery, argIdx, argIdx+1,
	)
	args = append(args, limit, offset)

	rows, err := r.db.Query(queryCtx, selectQuery, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query helpers: %w", err)
	}
	defer rows.Close()

	var helpers []HelperListItem
	for rows.Next() {
		var h HelperListItem
		if err := rows.Scan(&h.ID, &h.Phone, &h.Name, &h.IsAvailable, &h.Rating,
			&h.TotalJobs, &h.CurrentLat, &h.CurrentLng); err != nil {
			return nil, 0, fmt.Errorf("failed to scan helper: %w", err)
		}
		helpers = append(helpers, h)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating helpers: %w", err)
	}

	return helpers, totalCount, nil
}

// GetBookingsList returns a paginated list of bookings with optional filters.
// `search` matches a partial booking ID, customer phone, or helper phone.
func (r *Repository) GetBookingsList(ctx context.Context, page, limit int, status, search string) ([]BookingListItem, int, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	offset := (page - 1) * limit

	// Escape LIKE wildcards in the search term to keep operator intent explicit.
	searchVal := ""
	if search != "" {
		escaped := strings.NewReplacer("%", "\\%", "_", "\\_").Replace(search)
		searchVal = "%" + escaped + "%"
	}

	var totalCount int
	err := r.db.QueryRow(queryCtx, `
		SELECT COUNT(*)
		FROM bookings b
		LEFT JOIN users cu ON b.customer_id = cu.id AND cu.deleted_at IS NULL
		LEFT JOIN users hu ON b.helper_id = hu.id AND hu.deleted_at IS NULL
		WHERE ($1 = '' OR b.status = $1)
		  AND ($2 = '' OR b.id::text ILIKE $2 ESCAPE '\' OR cu.phone ILIKE $2 ESCAPE '\' OR hu.phone ILIKE $2 ESCAPE '\')
	`, status, searchVal).Scan(&totalCount)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count bookings: %w", err)
	}

	rows, err := r.db.Query(queryCtx, `
		WITH page AS (
			SELECT b.id, b.created_at
			FROM bookings b
			LEFT JOIN users cu ON b.customer_id = cu.id AND cu.deleted_at IS NULL
			LEFT JOIN users hu ON b.helper_id = hu.id AND hu.deleted_at IS NULL
			WHERE ($1 = '' OR b.status = $1)
			  AND ($4 = '' OR b.id::text ILIKE $4 ESCAPE '\' OR cu.phone ILIKE $4 ESCAPE '\' OR hu.phone ILIKE $4 ESCAPE '\')
			ORDER BY b.created_at DESC
			LIMIT $2 OFFSET $3
		)
		SELECT
			b.id, b.customer_id, COALESCE(cu.phone, '(deleted)'), b.helper_id, hu.phone,
			sc.name, b.status, b.amount_paise, b.discount_paise, b.created_at
		FROM page p
		JOIN bookings b ON b.id = p.id
		LEFT JOIN users cu ON b.customer_id = cu.id AND cu.deleted_at IS NULL
		LEFT JOIN users hu ON b.helper_id = hu.id AND hu.deleted_at IS NULL
		JOIN service_categories sc ON b.service_category_id = sc.id
		ORDER BY b.created_at DESC
	`, status, limit, offset, searchVal)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query bookings: %w", err)
	}
	defer rows.Close()

	var bookings []BookingListItem
	for rows.Next() {
		var b BookingListItem
		if err := rows.Scan(&b.ID, &b.CustomerID, &b.CustomerPhone,
			&b.HelperID, &b.HelperPhone, &b.ServiceCategory,
			&b.Status, &b.AmountPaise, &b.DiscountPaise, &b.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("failed to scan booking: %w", err)
		}
		bookings = append(bookings, b)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating bookings: %w", err)
	}

	return bookings, totalCount, nil
}

// GetAuditLog returns a paginated audit trail.
func (r *Repository) GetAuditLog(ctx context.Context, page, limit int, targetType string) ([]AdminActionLog, int, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	offset := (page - 1) * limit

	baseQuery := `FROM audit_log WHERE 1=1`
	args := []interface{}{}
	argIdx := 1

	if targetType != "" {
		baseQuery += fmt.Sprintf(` AND target_type = $%d`, argIdx)
		args = append(args, targetType)
		argIdx++
	}

	var totalCount int
	err := r.db.QueryRow(queryCtx, `SELECT COUNT(*) `+baseQuery, args...).Scan(&totalCount)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count audit logs: %w", err)
	}

	selectQuery := fmt.Sprintf(
		`SELECT id, admin_id, action, target_type, COALESCE(target_id, ''),
		        COALESCE(old_value, 'null'::jsonb), COALESCE(new_value, 'null'::jsonb),
		        COALESCE(ip_address, ''), created_at
		 %s ORDER BY created_at DESC LIMIT $%d OFFSET $%d`,
		baseQuery, argIdx, argIdx+1,
	)
	args = append(args, limit, offset)

	rows, err := r.db.Query(queryCtx, selectQuery, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query audit log: %w", err)
	}
	defer rows.Close()

	var logs []AdminActionLog
	for rows.Next() {
		var l AdminActionLog
		if err := rows.Scan(&l.ID, &l.AdminID, &l.Action, &l.TargetType, &l.TargetID,
			&l.OldValue, &l.NewValue, &l.IPAddress, &l.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("failed to scan audit log: %w", err)
		}
		logs = append(logs, l)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating audit log: %w", err)
	}

	return logs, totalCount, nil
}

// GetAllPromotions returns a paginated list of promotions.
func (r *Repository) GetAllPromotions(ctx context.Context, page, limit int) ([]Promotion, int, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	offset := (page - 1) * limit

	var totalCount int
	err := r.db.QueryRow(queryCtx, `SELECT COUNT(*) FROM promotions`).Scan(&totalCount)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to count promotions: %w", err)
	}

	rows, err := r.db.Query(queryCtx,
		`SELECT id, code, discount_type, discount_value, min_order_cents,
		        max_uses, uses_count, is_active, expires_at, created_by, created_at
		 FROM promotions ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
		limit, offset,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query promotions: %w", err)
	}
	defer rows.Close()

	var promos []Promotion
	for rows.Next() {
		var p Promotion
		if err := rows.Scan(&p.ID, &p.Code, &p.DiscountType, &p.DiscountValue,
			&p.MinOrderCents, &p.MaxUses, &p.UsesCount, &p.IsActive,
			&p.ExpiresAt, &p.CreatedBy, &p.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("failed to scan promotion: %w", err)
		}
		promos = append(promos, p)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating promotions: %w", err)
	}

	return promos, totalCount, nil
}

// CreatePromotion inserts a new promotion.
func (r *Repository) CreatePromotion(ctx context.Context, p *Promotion) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	err := r.db.QueryRow(queryCtx,
		`INSERT INTO promotions (code, discount_type, discount_value, min_order_cents, max_uses, is_active, expires_at, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING id, created_at`,
		p.Code, p.DiscountType, p.DiscountValue, p.MinOrderCents,
		p.MaxUses, p.IsActive, p.ExpiresAt, p.CreatedBy,
	).Scan(&p.ID, &p.CreatedAt)
	if err != nil {
		return fmt.Errorf("failed to create promotion: %w", err)
	}

	return nil
}

// UpdatePromotion updates a promotion's fields.
func (r *Repository) UpdatePromotion(ctx context.Context, p *Promotion) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE promotions SET code = $2, discount_type = $3, discount_value = $4,
		        min_order_cents = $5, max_uses = $6, is_active = $7, expires_at = $8
		 WHERE id = $1`,
		p.ID, p.Code, p.DiscountType, p.DiscountValue,
		p.MinOrderCents, p.MaxUses, p.IsActive, p.ExpiresAt,
	)
	if err != nil {
		return fmt.Errorf("failed to update promotion: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("promotion not found")
	}
	return nil
}

// DisablePromotion sets is_active = false for a promotion.
func (r *Repository) DisablePromotion(ctx context.Context, promoID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE promotions SET is_active = false WHERE id = $1`,
		promoID,
	)
	if err != nil {
		return fmt.Errorf("failed to disable promotion: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("promotion not found")
	}
	return nil
}

// GetCustomerFCMTokens retrieves all FCM tokens for users with the 'customer' role.
// This is used for broadcasting bulk marketing notifications.
func (r *Repository) GetCustomerFCMTokens(ctx context.Context) ([]string, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT fcm_token FROM users WHERE role = 'customer' AND fcm_token IS NOT NULL AND fcm_token != '' AND deleted_at IS NULL`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query customer FCM tokens: %w", err)
	}
	defer rows.Close()

	var tokens []string
	for rows.Next() {
		var token string
		if err := rows.Scan(&token); err != nil {
			return nil, fmt.Errorf("failed to scan token: %w", err)
		}
		tokens = append(tokens, token)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating tokens: %w", err)
	}

	return tokens, nil
}

// GetProFCMTokens retrieves all FCM tokens for users with the 'pro' role.
func (r *Repository) GetProFCMTokens(ctx context.Context) ([]string, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT fcm_token FROM users WHERE role = 'pro' AND fcm_token IS NOT NULL AND fcm_token != '' AND deleted_at IS NULL`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query pro FCM tokens: %w", err)
	}
	defer rows.Close()

	var tokens []string
	for rows.Next() {
		var token string
		if err := rows.Scan(&token); err != nil {
			return nil, fmt.Errorf("failed to scan token: %w", err)
		}
		tokens = append(tokens, token)
	}
	return tokens, rows.Err()
}

// GetAllFCMTokens retrieves FCM tokens for every registered user.
func (r *Repository) GetAllFCMTokens(ctx context.Context) ([]string, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT fcm_token FROM users WHERE fcm_token IS NOT NULL AND fcm_token != '' AND deleted_at IS NULL`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query all FCM tokens: %w", err)
	}
	defer rows.Close()

	var tokens []string
	for rows.Next() {
		var token string
		if err := rows.Scan(&token); err != nil {
			return nil, fmt.Errorf("failed to scan token: %w", err)
		}
		tokens = append(tokens, token)
	}
	return tokens, rows.Err()
}

// CancelBooking force-cancels a booking regardless of current state (admin override).
func (r *Repository) CancelBooking(ctx context.Context, bookingID string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	result, err := r.db.Exec(queryCtx,
		`UPDATE bookings
		 SET status = 'cancelled', updated_at = now(), cancelled_at = now(), cancelled_by = 'admin'
		 WHERE id = $1 AND status NOT IN ('cancelled', 'completed')`,
		bookingID,
	)
	if err != nil {
		return fmt.Errorf("failed to cancel booking: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("booking not found or already in terminal state")
	}
	return nil
}

// GetPendingHelpers returns helpers with approval_status='pending', joined to
// users. Mirrors GetAllHelpers but filtered to pending and ordered oldest-first
// so reviewers work the queue FIFO.
func (r *Repository) GetPendingHelpers(ctx context.Context, page, limit int) ([]HelperListItem, int, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	offset := (page - 1) * limit

	baseQuery := `FROM users u JOIN helpers h ON u.id = h.id
	              WHERE u.role IN ('helper', 'pro') AND h.approval_status = 'pending'`

	var totalCount int
	if err := r.db.QueryRow(queryCtx, `SELECT COUNT(*) `+baseQuery).Scan(&totalCount); err != nil {
		return nil, 0, fmt.Errorf("failed to count pending helpers: %w", err)
	}

	selectQuery := `SELECT u.id, u.phone, COALESCE(u.name, ''), h.is_available, h.rating, h.total_jobs,
	                       COALESCE(h.current_lat, 0), COALESCE(h.current_lng, 0)
	                ` + baseQuery + ` ORDER BY u.created_at ASC LIMIT $1 OFFSET $2`

	rows, err := r.db.Query(queryCtx, selectQuery, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query pending helpers: %w", err)
	}
	defer rows.Close()

	var helpers []HelperListItem
	for rows.Next() {
		var h HelperListItem
		if err := rows.Scan(&h.ID, &h.Phone, &h.Name, &h.IsAvailable, &h.Rating,
			&h.TotalJobs, &h.CurrentLat, &h.CurrentLng); err != nil {
			return nil, 0, fmt.Errorf("failed to scan pending helper: %w", err)
		}
		helpers = append(helpers, h)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating pending helpers: %w", err)
	}

	return helpers, totalCount, nil
}

// SetHelperApproval sets approval_status to 'approved' or 'rejected'. Returns
// "helper not found" if no row was updated. status must be validated by caller.
func (r *Repository) SetHelperApproval(ctx context.Context, helperID, status string) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if status != "approved" && status != "rejected" {
		return fmt.Errorf("invalid approval status: %s", status)
	}

	result, err := r.db.Exec(queryCtx,
		`UPDATE helpers SET approval_status = $2 WHERE id = $1`,
		helperID, status,
	)
	if err != nil {
		return fmt.Errorf("failed to set helper approval: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("helper not found")
	}
	return nil
}

// GetBookingStatus returns the current status for a booking.
func (r *Repository) GetBookingStatus(ctx context.Context, bookingID string) (string, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var status string
	if err := r.db.QueryRow(queryCtx,
		`SELECT status FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(&status); err != nil {
		if err == pgx.ErrNoRows {
			return "", fmt.Errorf("booking not found")
		}
		return "", fmt.Errorf("failed to get booking status: %w", err)
	}

	return status, nil
}
