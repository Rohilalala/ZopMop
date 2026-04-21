package analytics

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Repository handles all analytics database reads and writes.
type Repository struct {
	db *pgxpool.Pool
}

// NewRepository creates a new analytics repository.
func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

// ── Write ─────────────────────────────────────────────────────────────────────

// TrackEvent inserts a single event row. Called from goroutines — never returns
// an error to the caller; failures are logged and silently dropped so analytics
// can never affect the main request path.
func (r *Repository) TrackEvent(ctx context.Context, eventName, userID, bookingID string, props map[string]interface{}) {
	var propsJSON []byte
	if props == nil {
		propsJSON = []byte("{}")
	} else if b, merr := json.Marshal(props); merr != nil {
		propsJSON = []byte("{}")
	} else {
		propsJSON = b
	}

	// Convert empty strings to nil so the FK columns stay NULL.
	var uid, bid *string
	if userID != "" {
		uid = &userID
	}
	if bookingID != "" {
		bid = &bookingID
	}

	qCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	if _, execErr := r.db.Exec(qCtx,
		`INSERT INTO analytics_events (event_name, user_id, booking_id, properties)
		 VALUES ($1, $2, $3, $4)`,
		eventName, uid, bid, propsJSON,
	); execErr != nil {
		log.Warn().Err(execErr).Str("event", eventName).Msg("[analytics] failed to write event")
	}
}

// ── Read / Aggregation ────────────────────────────────────────────────────────

// GetOverview returns KPI aggregates for the past `days` days.
func (r *Repository) GetOverview(ctx context.Context, days int) (*OverviewResponse, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	resp := &OverviewResponse{
		Period: fmt.Sprintf("last_%d_days", days),
	}

	// Booking counts + revenue from the bookings table.
	err := r.db.QueryRow(qCtx, `
		SELECT
			COUNT(*)                                              AS total,
			COUNT(*) FILTER (WHERE status = 'completed')         AS completed,
			COUNT(*) FILTER (WHERE status = 'cancelled')         AS cancelled,
			COUNT(*) FILTER (WHERE status = 'pending')           AS pending_cnt,
			COUNT(*) FILTER (WHERE status IN ('accepted','in_progress','completed')) AS matched,
			COALESCE(SUM(price_cents - discount_cents)
				FILTER (WHERE status = 'completed'), 0)          AS revenue
		FROM bookings
		WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
	`, days).Scan(
		&resp.TotalBookings,
		&resp.CompletedBookings,
		&resp.CancelledBookings,
		&resp.PendingBookings,
		&resp.MatchSuccessRate, // temp: holds matched count, converted below
		&resp.TotalRevenueCents,
	)
	if err != nil {
		return nil, fmt.Errorf("overview booking query failed: %w", err)
	}

	// Convert raw matched count → rate.
	if resp.TotalBookings > 0 {
		matchedCount := int(resp.MatchSuccessRate) // was stored as float64, holds int
		resp.MatchSuccessRate = float64(matchedCount) / float64(resp.TotalBookings) * 100
	}

	// Completion rate (completed / terminal bookings).
	terminal := resp.CompletedBookings + resp.CancelledBookings
	if terminal > 0 {
		resp.CompletionRate = float64(resp.CompletedBookings) / float64(terminal) * 100
	}

	// Avg order value across completed bookings.
	if resp.CompletedBookings > 0 {
		resp.AvgOrderValueCents = resp.TotalRevenueCents / int64(resp.CompletedBookings)
	}

	// Active helpers (currently available).
	if err := r.db.QueryRow(qCtx,
		`SELECT COUNT(*) FROM helpers WHERE is_available = true`,
	).Scan(&resp.ActiveHelpers); err != nil {
		log.Warn().Err(err).Msg("[analytics] failed to count active helpers")
	}

	// New users in the period.
	if err := r.db.QueryRow(qCtx,
		`SELECT COUNT(*) FROM users WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')`, days,
	).Scan(&resp.NewUsers); err != nil {
		log.Warn().Err(err).Msg("[analytics] failed to count new users")
	}

	return resp, nil
}

// GetFunnel returns the booking conversion funnel for the past `days` days.
// The funnel is built from a mix of analytics_events (client-side) and
// bookings table (backend lifecycle) counts.
func (r *Repository) GetFunnel(ctx context.Context, days int) (*FunnelResponse, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Client-side event counts: distinct users per event.
	clientEventCounts := map[string]int{}
	rows, err := r.db.Query(qCtx, `
		SELECT event_name, COUNT(DISTINCT user_id) AS cnt
		FROM analytics_events
		WHERE event_name = ANY($1)
		  AND created_at >= NOW() - ($2 * INTERVAL '1 day')
		GROUP BY event_name
	`, []string{EventServiceViewed, EventBookingFlowStarted, EventBookingFlowDropped}, days)
	if err != nil {
		return nil, fmt.Errorf("funnel client event query failed: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var cnt int
		if err := rows.Scan(&name, &cnt); err == nil {
			clientEventCounts[name] = cnt
		}
	}

	// Backend booking lifecycle counts.
	var created, accepted, started, completed int
	if err := r.db.QueryRow(qCtx, `
		SELECT
			COUNT(*)                                              AS created,
			COUNT(*) FILTER (WHERE status IN ('accepted','in_progress','completed')) AS accepted,
			COUNT(*) FILTER (WHERE started_at IS NOT NULL)        AS started,
			COUNT(*) FILTER (WHERE status = 'completed')          AS completed
		FROM bookings
		WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
	`, days).Scan(&created, &accepted, &started, &completed); err != nil {
		return nil, fmt.Errorf("funnel booking query failed: %w", err)
	}

	// Build ordered funnel steps.
	type raw struct {
		step  string
		event string
		count int
	}
	ordered := []raw{
		{"Service Viewed", EventServiceViewed, clientEventCounts[EventServiceViewed]},
		{"Booking Flow Started", EventBookingFlowStarted, clientEventCounts[EventBookingFlowStarted]},
		{"Booking Created", EventBookingCreated, created},
		{"Helper Matched", EventBookingAccepted, accepted},
		{"Job Started", EventBookingStarted, started},
		{"Job Completed", EventBookingCompleted, completed},
	}

	steps := make([]FunnelStep, 0, len(ordered))
	for i, r := range ordered {
		conv := 0.0
		if i == 0 {
			conv = 100.0 // top of funnel is always 100%
		} else if ordered[i-1].count > 0 {
			conv = float64(r.count) / float64(ordered[i-1].count) * 100
		}
		steps = append(steps, FunnelStep{
			Step:          r.step,
			EventName:     r.event,
			Count:         r.count,
			ConversionPct: conv,
		})
	}

	return &FunnelResponse{
		Period: fmt.Sprintf("last_%d_days", days),
		Steps:  steps,
	}, nil
}

// GetBookingTrends returns daily booking counts for the past `days` days.
func (r *Repository) GetBookingTrends(ctx context.Context, days int) ([]BookingTrendDay, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := r.db.Query(qCtx, `
		SELECT
			DATE_TRUNC('day', created_at)::date::text        AS date,
			COUNT(*)                                          AS created,
			COUNT(*) FILTER (WHERE status = 'completed')     AS completed,
			COUNT(*) FILTER (WHERE status = 'cancelled')     AS cancelled
		FROM bookings
		WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
		GROUP BY 1
		ORDER BY 1 ASC
	`, days)
	if err != nil {
		return nil, fmt.Errorf("booking trends query failed: %w", err)
	}
	defer rows.Close()

	var result []BookingTrendDay
	for rows.Next() {
		var d BookingTrendDay
		if err := rows.Scan(&d.Date, &d.Created, &d.Completed, &d.Cancelled); err != nil {
			return nil, fmt.Errorf("failed to scan booking trend row: %w", err)
		}
		result = append(result, d)
	}
	return result, rows.Err()
}

// GetWorkerPerformance returns per-helper performance metrics for the past `days` days.
func (r *Repository) GetWorkerPerformance(ctx context.Context, days, limit int) ([]WorkerMetrics, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := r.db.Query(qCtx, `
		SELECT
			h.id                                                                      AS helper_id,
			COALESCE(u.name, 'Unknown')                                               AS name,
			COUNT(b.id) FILTER (WHERE b.id IS NOT NULL)                               AS total_assigned,
			COUNT(b.id) FILTER (WHERE b.status = 'completed')                         AS total_completed,
			COUNT(b.id) FILTER (WHERE b.status = 'cancelled')                         AS total_cancelled,
			COALESCE(
				AVG(EXTRACT(EPOCH FROM (b.accepted_at - b.created_at)))
				FILTER (WHERE b.accepted_at IS NOT NULL), 0
			)                                                                          AS avg_response_sec,
			COALESCE(
				AVG(EXTRACT(EPOCH FROM (b.completed_at - b.started_at)) / 60.0)
				FILTER (WHERE b.completed_at IS NOT NULL AND b.started_at IS NOT NULL), 0
			)                                                                          AS avg_job_min,
			COALESCE(h.rating, 5.0)                                                    AS rating
		FROM helpers h
		JOIN users u ON u.id = h.id
		LEFT JOIN bookings b
			ON b.helper_id = h.id
			AND b.created_at >= NOW() - ($1 * INTERVAL '1 day')
		GROUP BY h.id, u.name, h.rating
		HAVING COUNT(b.id) FILTER (WHERE b.id IS NOT NULL) > 0
		ORDER BY total_completed DESC, avg_response_sec ASC
		LIMIT $2
	`, days, limit)
	if err != nil {
		return nil, fmt.Errorf("worker performance query failed: %w", err)
	}
	defer rows.Close()

	var result []WorkerMetrics
	for rows.Next() {
		var m WorkerMetrics
		if err := rows.Scan(
			&m.HelperID, &m.Name,
			&m.TotalAssigned, &m.TotalCompleted, &m.TotalCancelled,
			&m.AvgResponseSec, &m.AvgJobMinutes, &m.Rating,
		); err != nil {
			return nil, fmt.Errorf("failed to scan worker metrics row: %w", err)
		}
		if m.TotalAssigned > 0 {
			m.CompletionRate = float64(m.TotalCompleted) / float64(m.TotalAssigned) * 100
		}
		result = append(result, m)
	}
	return result, rows.Err()
}

// GetOperationalMetrics returns system-level timing and efficiency metrics.
func (r *Repository) GetOperationalMetrics(ctx context.Context, days int) (*OperationalMetrics, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	resp := &OperationalMetrics{
		Period: fmt.Sprintf("last_%d_days", days),
	}

	err := r.db.QueryRow(qCtx, `
		SELECT
			COALESCE(
				AVG(EXTRACT(EPOCH FROM (accepted_at - created_at)))
				FILTER (WHERE accepted_at IS NOT NULL), 0
			)                                                                      AS avg_assign_sec,
			COALESCE(
				AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60.0)
				FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL), 0
			)                                                                      AS avg_job_min,
			COUNT(*) FILTER (
				WHERE status IN ('accepted','in_progress','completed')
			) * 100.0 / NULLIF(COUNT(*), 0)                                        AS match_rate,
			COUNT(*) FILTER (
				WHERE status = 'cancelled' AND cancelled_by = 'system'
			)                                                                      AS auto_expired,
			COALESCE(SUM(match_attempts), 0)                                       AS total_attempts
		FROM bookings
		WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
	`, days).Scan(
		&resp.AvgTimeToAssignSec,
		&resp.AvgJobDurationMin,
		&resp.MatchSuccessRate,
		&resp.AutoExpiredBookings,
		&resp.TotalMatchAttempts,
	)
	if err != nil {
		return nil, fmt.Errorf("operational metrics query failed: %w", err)
	}

	return resp, nil
}

// GetRevenueTrends returns daily revenue aggregates for the past `days` days.
func (r *Repository) GetRevenueTrends(ctx context.Context, days int) ([]RevenueTrendDay, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := r.db.Query(qCtx, `
		SELECT
			DATE_TRUNC('day', completed_at)::date::text         AS date,
			COALESCE(SUM(price_cents), 0)                       AS gross,
			COALESCE(SUM(discount_cents), 0)                    AS discount,
			COALESCE(SUM(price_cents - discount_cents), 0)      AS net,
			COUNT(*)                                             AS booking_count
		FROM bookings
		WHERE status = 'completed'
		  AND completed_at >= NOW() - ($1 * INTERVAL '1 day')
		GROUP BY 1
		ORDER BY 1 ASC
	`, days)
	if err != nil {
		return nil, fmt.Errorf("revenue trends query failed: %w", err)
	}
	defer rows.Close()

	var result []RevenueTrendDay
	for rows.Next() {
		var d RevenueTrendDay
		if err := rows.Scan(&d.Date, &d.GrossRevenueCents, &d.DiscountCents, &d.NetRevenueCents, &d.BookingCount); err != nil {
			return nil, fmt.Errorf("failed to scan revenue row: %w", err)
		}
		result = append(result, d)
	}
	return result, rows.Err()
}
