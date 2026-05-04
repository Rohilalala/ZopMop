package leave

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository owns all DB access for the leave module. All public methods take
// a context.Context (which the timeout middleware bounds) and propagate
// cancellation to pgx.
type Repository struct {
	pool *pgxpool.Pool
}

func NewRepository(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

// ── Balance ────────────────────────────────────────────────────────────────

// HelperBalance is the raw row pulled from the helpers table.
type HelperBalance struct {
	Balance        int
	MonthlyQuota   int
	LastResetAt    time.Time
}

// GetBalance reads the helper's current leave balance plus the quota and
// last-reset timestamp.
func (r *Repository) GetBalance(ctx context.Context, proID string) (HelperBalance, error) {
	var b HelperBalance
	err := r.pool.QueryRow(ctx, `
		SELECT leave_balance, monthly_leave_quota, leave_balance_reset_at
		FROM helpers
		WHERE id = $1
	`, proID).Scan(&b.Balance, &b.MonthlyQuota, &b.LastResetAt)
	return b, err
}

// SetBalanceWithReset writes a fresh balance + reset timestamp. Used by the
// lazy-reset path in Service.Balance when a new month has begun.
func (r *Repository) SetBalanceWithReset(ctx context.Context, proID string, balance int, resetAt time.Time) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE helpers
		SET leave_balance = $2,
		    leave_balance_reset_at = $3
		WHERE id = $1
	`, proID, balance, resetAt)
	return err
}

// AddBalance is the admin allocate path — increments balance by `days` and
// returns the post-update value. days can be negative to revoke.
func (r *Repository) AddBalance(ctx context.Context, proID string, days int) (int, error) {
	var newBalance int
	err := r.pool.QueryRow(ctx, `
		UPDATE helpers
		SET leave_balance = GREATEST(0, leave_balance + $2)
		WHERE id = $1
		RETURNING leave_balance
	`, proID, days).Scan(&newBalance)
	return newBalance, err
}

// DecrementBalance atomically deducts 1 from the balance, refusing to go
// below zero. Returns ErrNoBalance when the row exists but balance is 0,
// pgx.ErrNoRows when the helper row is missing.
var ErrNoBalance = errors.New("leave: no balance remaining")

func (r *Repository) DecrementBalance(ctx context.Context, tx pgx.Tx, proID string) (int, error) {
	var newBalance int
	err := tx.QueryRow(ctx, `
		UPDATE helpers
		SET leave_balance = leave_balance - 1
		WHERE id = $1 AND leave_balance > 0
		RETURNING leave_balance
	`, proID).Scan(&newBalance)
	if errors.Is(err, pgx.ErrNoRows) {
		// Either the helper doesn't exist OR balance was already 0. Distinguish.
		var exists bool
		if e := r.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM helpers WHERE id = $1)`, proID).Scan(&exists); e == nil && exists {
			return 0, ErrNoBalance
		}
		return 0, pgx.ErrNoRows
	}
	return newBalance, err
}

// ── Leaves ─────────────────────────────────────────────────────────────────

// CreateLeave inserts a single leave row. Errors out on duplicate (pro_id, date).
func (r *Repository) CreateLeave(ctx context.Context, tx pgx.Tx, proID string, date time.Time, source, note string) (*Leave, error) {
	var lv Leave
	err := tx.QueryRow(ctx, `
		INSERT INTO pro_leaves (pro_id, date, source, note)
		VALUES ($1, $2, $3, NULLIF($4, ''))
		ON CONFLICT (pro_id, date) DO NOTHING
		RETURNING id, pro_id, date, declared_at, status, source, COALESCE(note, '')
	`, proID, date, source, note).Scan(&lv.ID, &lv.ProID, &lv.Date, &lv.DeclaredAt, &lv.Status, &lv.Source, &lv.Note)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrAlreadyDeclared
	}
	return &lv, err
}

// ErrAlreadyDeclared is returned when (pro_id, date) already exists.
var ErrAlreadyDeclared = errors.New("leave: already declared for this date")

// IsOnLeave returns true when the pro has an approved leave row for the
// given date.
func (r *Repository) IsOnLeave(ctx context.Context, proID string, date time.Time) (bool, error) {
	var exists bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM pro_leaves
			WHERE pro_id = $1 AND date = $2 AND status = $3
		)
	`, proID, date, StatusApproved).Scan(&exists)
	return exists, err
}

// CountUsedSince returns the count of approved leaves for this pro since
// the given timestamp. Used to compute "used this month".
func (r *Repository) CountUsedSince(ctx context.Context, proID string, since time.Time) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM pro_leaves
		WHERE pro_id = $1 AND status = $2 AND declared_at >= $3
	`, proID, StatusApproved, since).Scan(&n)
	return n, err
}

// ListByPro returns leave history for a pro, newest first.
func (r *Repository) ListByPro(ctx context.Context, proID string, limit int) ([]Leave, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := r.pool.Query(ctx, `
		SELECT id, pro_id, date, declared_at, status, source, COALESCE(note, '')
		FROM pro_leaves
		WHERE pro_id = $1
		ORDER BY date DESC, declared_at DESC
		LIMIT $2
	`, proID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Leave{}
	for rows.Next() {
		var lv Leave
		if err := rows.Scan(&lv.ID, &lv.ProID, &lv.Date, &lv.DeclaredAt, &lv.Status, &lv.Source, &lv.Note); err != nil {
			return nil, err
		}
		out = append(out, lv)
	}
	return out, rows.Err()
}

// ── Booking reassignment helpers ───────────────────────────────────────────

// AssignedBooking is the minimal projection needed by the reassignment loop.
type AssignedBooking struct {
	ID                string
	CustomerID        string
	HelperID          string
	TimeSlotID        string
	ScheduledTime     time.Time
	ServiceCategoryID string
	ServiceName       string
	CustomerName      string
	Lat               float64
	Lng               float64
}

// ListProBookingsOnDate returns all non-terminal scheduled bookings assigned
// to a specific pro on a specific date.
func (r *Repository) ListProBookingsOnDate(ctx context.Context, proID string, date time.Time) ([]AssignedBooking, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT b.id, b.customer_id, b.helper_id, b.time_slot_id, b.scheduled_time,
		       b.service_category_id,
		       COALESCE(sc.name, ''), COALESCE(u.name, ''),
		       b.lat::float8, b.lng::float8
		FROM bookings b
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		LEFT JOIN users u ON u.id = b.customer_id
		WHERE b.helper_id = $1
		  AND b.scheduled_time IS NOT NULL
		  AND b.scheduled_time::date = $2
		  AND b.status IN ('pending', 'accepted')
	`, proID, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AssignedBooking{}
	for rows.Next() {
		var b AssignedBooking
		if err := rows.Scan(&b.ID, &b.CustomerID, &b.HelperID, &b.TimeSlotID, &b.ScheduledTime,
			&b.ServiceCategoryID, &b.ServiceName, &b.CustomerName, &b.Lat, &b.Lng); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// FindReplacementPro returns the id of an active pro with no conflicting
// scheduled booking in the same time slot, no leave on that date, and
// supporting the same service category. Returns empty string + nil when no
// match.
func (r *Repository) FindReplacementPro(ctx context.Context, excludeProID, serviceCategoryID, timeSlotID string, date time.Time) (string, error) {
	var id string
	err := r.pool.QueryRow(ctx, `
		SELECT u.id
		FROM users u
		JOIN helpers h ON h.id = u.id
		WHERE u.role = 'helper'
		  AND u.id <> $1
		  AND h.is_available = true
		  AND NOT EXISTS (
		      SELECT 1 FROM pro_leaves pl
		      WHERE pl.pro_id = u.id AND pl.date = $4 AND pl.status = 'approved'
		  )
		  AND NOT EXISTS (
		      SELECT 1 FROM bookings b
		      WHERE b.helper_id = u.id
		        AND b.time_slot_id = $3
		        AND b.status IN ('pending', 'accepted')
		  )
		ORDER BY h.rating DESC NULLS LAST, h.total_jobs DESC
		LIMIT 1
	`, excludeProID, serviceCategoryID, timeSlotID, date).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// ReassignBooking updates the helper_id on a booking. Caller passes the new
// pro id; status stays 'accepted' (assumes original was assigned).
func (r *Repository) ReassignBooking(ctx context.Context, bookingID, newProID string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE bookings
		SET helper_id = $2,
		    updated_at = now()
		WHERE id = $1
	`, bookingID, newProID)
	return err
}

// CancelBookingNoCoverage marks a booking cancelled because no replacement
// pro was available.
func (r *Repository) CancelBookingNoCoverage(ctx context.Context, bookingID string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE bookings
		SET status = 'cancelled',
		    cancelled_at = now(),
		    updated_at = now()
		WHERE id = $1
	`, bookingID)
	return err
}

// NearestOpenSlot describes one suggested alternative slot offered to the
// customer when their booking gets cancelled.
type NearestOpenSlot struct {
	SlotID    string    `json:"slot_id"`
	StartTime time.Time `json:"start_time"`
	EndTime   time.Time `json:"end_time"`
}

// FindNearestOpenSlots returns up to `limit` time slots starting on/after
// `from` that have at least one helper available (active, not on leave,
// no conflicting booking) — used in the cancellation push notification.
func (r *Repository) FindNearestOpenSlots(ctx context.Context, serviceCategoryID string, from time.Time, limit int) ([]NearestOpenSlot, error) {
	if limit <= 0 || limit > 10 {
		limit = 3
	}
	rows, err := r.pool.Query(ctx, `
		SELECT ts.id,
		       (ts.slot_date::timestamp + ts.start_time)::timestamptz,
		       (ts.slot_date::timestamp + ts.end_time)::timestamptz
		FROM time_slots ts
		WHERE ts.is_active = true
		  AND ts.current_bookings < ts.max_bookings
		  AND (ts.slot_date::timestamp + ts.start_time)::timestamptz >= $1
		  AND EXISTS (
		      SELECT 1
		      FROM users u
		      JOIN helpers h ON h.id = u.id
		      WHERE u.role = 'helper'
		        AND h.is_available = true
		        AND NOT EXISTS (
		            SELECT 1 FROM pro_leaves pl
		            WHERE pl.pro_id = u.id AND pl.date = ts.slot_date AND pl.status = 'approved'
		        )
		        AND NOT EXISTS (
		            SELECT 1 FROM bookings b
		            WHERE b.helper_id = u.id
		              AND b.time_slot_id = ts.id
		              AND b.status IN ('pending', 'accepted')
		        )
		  )
		ORDER BY (ts.slot_date::timestamp + ts.start_time) ASC
		LIMIT $2
	`, from, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NearestOpenSlot{}
	for rows.Next() {
		var s NearestOpenSlot
		if err := rows.Scan(&s.SlotID, &s.StartTime, &s.EndTime); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ResetExpiredBalances refills leave_balance to monthly_leave_quota for every
// helper whose leave_balance_reset_at is older than the current calendar
// month start (in Asia/Kolkata). Idempotent — calling it inside a month
// updates zero rows. Returns the number of helpers reset.
func (r *Repository) ResetExpiredBalances(ctx context.Context) (int64, error) {
	tag, err := r.pool.Exec(ctx, `
		UPDATE helpers
		SET leave_balance = monthly_leave_quota,
		    leave_balance_reset_at = date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata'
		WHERE leave_balance_reset_at <
		      (date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata')
	`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ── Tx helpers ─────────────────────────────────────────────────────────────

// Begin returns a fresh tx — used by the declare-leave path which needs the
// balance decrement and the leave row to land atomically.
func (r *Repository) Begin(ctx context.Context) (pgx.Tx, error) {
	return r.pool.Begin(ctx)
}
