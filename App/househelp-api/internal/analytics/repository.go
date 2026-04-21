package analytics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
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

	// Maintain a compact distinct user/event/day rollup for funnel reads.
	if uid != nil {
		if _, rollupErr := r.db.Exec(qCtx,
			`INSERT INTO analytics_event_user_daily (event_date, event_name, user_id)
			 VALUES (CURRENT_DATE, $1, $2)
			 ON CONFLICT (event_date, event_name, user_id) DO NOTHING`,
			eventName, uid,
		); rollupErr != nil && !isUndefinedTable(rollupErr) {
			log.Warn().Err(rollupErr).Str("event", eventName).Msg("[analytics] failed to write event daily rollup")
		}
	}
}

// RefreshRollups recomputes recent analytics rollups used by dashboard endpoints.
func (r *Repository) RefreshRollups(ctx context.Context) error {
	if r == nil || r.db == nil {
		return fmt.Errorf("analytics repository db is nil")
	}

	qCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	tx, err := r.db.Begin(qCtx)
	if err != nil {
		return fmt.Errorf("begin rollup refresh tx: %w", err)
	}
	defer tx.Rollback(qCtx)

	if _, err := tx.Exec(qCtx, `
		INSERT INTO analytics_event_user_daily (event_date, event_name, user_id, created_at)
		SELECT
			DATE_TRUNC('day', created_at)::date AS event_date,
			event_name,
			user_id,
			NOW()
		FROM analytics_events
		WHERE user_id IS NOT NULL
		  AND created_at >= NOW() - INTERVAL '7 days'
		GROUP BY 1, 2, 3
		ON CONFLICT (event_date, event_name, user_id)
		DO UPDATE SET created_at = EXCLUDED.created_at
	`); err != nil {
		return fmt.Errorf("refresh analytics_event_user_daily: %w", err)
	}

	if _, err := tx.Exec(qCtx, `
		INSERT INTO analytics_funnel_hourly (bucket_hour, event_name, distinct_users, updated_at)
		SELECT
			DATE_TRUNC('hour', created_at) AS bucket_hour,
			event_name,
			COUNT(DISTINCT user_id) AS distinct_users,
			NOW() AS updated_at
		FROM analytics_events
		WHERE user_id IS NOT NULL
		  AND created_at >= NOW() - INTERVAL '72 hours'
		GROUP BY 1, 2
		ON CONFLICT (bucket_hour, event_name)
		DO UPDATE SET
			distinct_users = EXCLUDED.distinct_users,
			updated_at = EXCLUDED.updated_at
	`); err != nil {
		return fmt.Errorf("refresh analytics_funnel_hourly: %w", err)
	}

	if _, err := tx.Exec(qCtx, `
		INSERT INTO analytics_booking_kpi_hourly (
			bucket_hour,
			total_bookings,
			completed_bookings,
			cancelled_bookings,
			pending_bookings,
			matched_bookings,
			started_bookings,
			auto_expired_bookings,
			total_match_attempts,
			revenue_gross_cents,
			revenue_discount_cents,
			revenue_net_cents,
			assign_seconds_sum,
			assign_seconds_samples,
			job_minutes_sum,
			job_minutes_samples,
			updated_at
		)
		SELECT
			DATE_TRUNC('hour', created_at) AS bucket_hour,
			COUNT(*) AS total_bookings,
			COUNT(*) FILTER (WHERE status = 'completed') AS completed_bookings,
			COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_bookings,
			COUNT(*) FILTER (WHERE status = 'pending') AS pending_bookings,
			COUNT(*) FILTER (WHERE status IN ('accepted','in_progress','completed')) AS matched_bookings,
			COUNT(*) FILTER (WHERE started_at IS NOT NULL) AS started_bookings,
			COUNT(*) FILTER (WHERE status = 'cancelled' AND cancelled_by = 'system') AS auto_expired_bookings,
			COALESCE(SUM(match_attempts), 0) AS total_match_attempts,
			COALESCE(SUM(price_cents), 0) AS revenue_gross_cents,
			COALESCE(SUM(discount_cents), 0) AS revenue_discount_cents,
			COALESCE(SUM(price_cents - discount_cents), 0) AS revenue_net_cents,
			COALESCE(
				SUM(EXTRACT(EPOCH FROM (accepted_at - created_at)))
				FILTER (WHERE accepted_at IS NOT NULL),
				0
			) AS assign_seconds_sum,
			COUNT(*) FILTER (WHERE accepted_at IS NOT NULL) AS assign_seconds_samples,
			COALESCE(
				SUM(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60.0)
				FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL),
				0
			) AS job_minutes_sum,
			COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL) AS job_minutes_samples,
			NOW() AS updated_at
		FROM bookings
		WHERE created_at >= NOW() - INTERVAL '72 hours'
		GROUP BY 1
		ON CONFLICT (bucket_hour)
		DO UPDATE SET
			total_bookings = EXCLUDED.total_bookings,
			completed_bookings = EXCLUDED.completed_bookings,
			cancelled_bookings = EXCLUDED.cancelled_bookings,
			pending_bookings = EXCLUDED.pending_bookings,
			matched_bookings = EXCLUDED.matched_bookings,
			started_bookings = EXCLUDED.started_bookings,
			auto_expired_bookings = EXCLUDED.auto_expired_bookings,
			total_match_attempts = EXCLUDED.total_match_attempts,
			revenue_gross_cents = EXCLUDED.revenue_gross_cents,
			revenue_discount_cents = EXCLUDED.revenue_discount_cents,
			revenue_net_cents = EXCLUDED.revenue_net_cents,
			assign_seconds_sum = EXCLUDED.assign_seconds_sum,
			assign_seconds_samples = EXCLUDED.assign_seconds_samples,
			job_minutes_sum = EXCLUDED.job_minutes_sum,
			job_minutes_samples = EXCLUDED.job_minutes_samples,
			updated_at = EXCLUDED.updated_at
	`); err != nil {
		return fmt.Errorf("refresh analytics_booking_kpi_hourly: %w", err)
	}

	if _, err := tx.Exec(qCtx, `
		INSERT INTO analytics_helper_daily (
			bucket_date,
			helper_id,
			total_assigned,
			total_completed,
			total_cancelled,
			response_seconds_sum,
			response_seconds_samples,
			job_minutes_sum,
			job_minutes_samples,
			updated_at
		)
		SELECT
			DATE_TRUNC('day', created_at)::date AS bucket_date,
			helper_id,
			COUNT(*) AS total_assigned,
			COUNT(*) FILTER (WHERE status = 'completed') AS total_completed,
			COUNT(*) FILTER (WHERE status = 'cancelled') AS total_cancelled,
			COALESCE(
				SUM(EXTRACT(EPOCH FROM (accepted_at - created_at)))
				FILTER (WHERE accepted_at IS NOT NULL),
				0
			) AS response_seconds_sum,
			COUNT(*) FILTER (WHERE accepted_at IS NOT NULL) AS response_seconds_samples,
			COALESCE(
				SUM(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60.0)
				FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL),
				0
			) AS job_minutes_sum,
			COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL) AS job_minutes_samples,
			NOW() AS updated_at
		FROM bookings
		WHERE helper_id IS NOT NULL
		  AND created_at >= NOW() - INTERVAL '14 days'
		GROUP BY 1, 2
		ON CONFLICT (bucket_date, helper_id)
		DO UPDATE SET
			total_assigned = EXCLUDED.total_assigned,
			total_completed = EXCLUDED.total_completed,
			total_cancelled = EXCLUDED.total_cancelled,
			response_seconds_sum = EXCLUDED.response_seconds_sum,
			response_seconds_samples = EXCLUDED.response_seconds_samples,
			job_minutes_sum = EXCLUDED.job_minutes_sum,
			job_minutes_samples = EXCLUDED.job_minutes_samples,
			updated_at = EXCLUDED.updated_at
	`); err != nil {
		return fmt.Errorf("refresh analytics_helper_daily: %w", err)
	}

	if err := tx.Commit(qCtx); err != nil {
		return fmt.Errorf("commit rollup refresh tx: %w", err)
	}

	return nil
}

// ── Read / Aggregation ────────────────────────────────────────────────────────

// GetOverview returns KPI aggregates for the past `days` days.
func (r *Repository) GetOverview(ctx context.Context, days int) (*OverviewResponse, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	resp := &OverviewResponse{
		Period: fmt.Sprintf("last_%d_days", days),
	}

	// Booking counts + revenue from hourly KPI rollups.
	err := r.db.QueryRow(qCtx, `
		SELECT
			COALESCE(SUM(total_bookings), 0)         AS total,
			COALESCE(SUM(completed_bookings), 0)     AS completed,
			COALESCE(SUM(cancelled_bookings), 0)     AS cancelled,
			COALESCE(SUM(pending_bookings), 0)       AS pending_cnt,
			COALESCE(SUM(matched_bookings), 0)       AS matched,
			COALESCE(SUM(revenue_net_cents), 0)      AS revenue
		FROM analytics_booking_kpi_hourly
		WHERE bucket_hour >= NOW() - ($1 * INTERVAL '1 day')
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

	// Client-side event counts from hourly rollup.
	clientEventCounts := map[string]int{}
	rows, err := r.db.Query(qCtx, `
		SELECT event_name, COALESCE(SUM(distinct_users), 0) AS cnt
		FROM analytics_funnel_hourly
		WHERE event_name = ANY($1)
		  AND bucket_hour >= NOW() - ($2 * INTERVAL '1 day')
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

	// Backend booking lifecycle counts from hourly rollup.
	var created, accepted, started, completed int
	if err := r.db.QueryRow(qCtx, `
		SELECT
			COALESCE(SUM(total_bookings), 0)      AS created,
			COALESCE(SUM(matched_bookings), 0)    AS accepted,
			COALESCE(SUM(started_bookings), 0)    AS started,
			COALESCE(SUM(completed_bookings), 0)  AS completed
		FROM analytics_booking_kpi_hourly
		WHERE bucket_hour >= NOW() - ($1 * INTERVAL '1 day')
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
			DATE_TRUNC('day', bucket_hour)::date::text       AS date,
			COALESCE(SUM(total_bookings), 0)                 AS created,
			COALESCE(SUM(completed_bookings), 0)             AS completed,
			COALESCE(SUM(cancelled_bookings), 0)             AS cancelled
		FROM analytics_booking_kpi_hourly
		WHERE bucket_hour >= NOW() - ($1 * INTERVAL '1 day')
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

func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	if ok := errors.As(err, &pgErr); !ok {
		return false
	}
	return pgErr.Code == "42P01"
}

// GetWorkerPerformance returns per-helper performance metrics for the past `days` days.
func (r *Repository) GetWorkerPerformance(ctx context.Context, days, limit int) ([]WorkerMetrics, error) {
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := r.db.Query(qCtx, `
		SELECT
			hd.helper_id                                                              AS helper_id,
			COALESCE(u.name, 'Unknown')                                               AS name,
			COALESCE(SUM(hd.total_assigned), 0)                                       AS total_assigned,
			COALESCE(SUM(hd.total_completed), 0)                                      AS total_completed,
			COALESCE(SUM(hd.total_cancelled), 0)                                      AS total_cancelled,
			COALESCE(
				SUM(hd.response_seconds_sum) / NULLIF(SUM(hd.response_seconds_samples), 0), 0
			)                                                                          AS avg_response_sec,
			COALESCE(
				SUM(hd.job_minutes_sum) / NULLIF(SUM(hd.job_minutes_samples), 0), 0
			)                                                                          AS avg_job_min,
			COALESCE(h.rating, 5.0)                                                    AS rating
		FROM analytics_helper_daily hd
		JOIN helpers h ON h.id = hd.helper_id
		JOIN users u ON u.id = h.id
		WHERE hd.bucket_date >= (CURRENT_DATE - $1::int)
		GROUP BY hd.helper_id, u.name, h.rating
		HAVING COALESCE(SUM(hd.total_assigned), 0) > 0
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
				SUM(assign_seconds_sum) / NULLIF(SUM(assign_seconds_samples), 0), 0
			)                                                                      AS avg_assign_sec,
			COALESCE(
				SUM(job_minutes_sum) / NULLIF(SUM(job_minutes_samples), 0), 0
			)                                                                      AS avg_job_min,
			COALESCE(
				SUM(matched_bookings) * 100.0 / NULLIF(SUM(total_bookings), 0), 0
			)                                                                      AS match_rate,
			COALESCE(SUM(auto_expired_bookings), 0)                                AS auto_expired,
			COALESCE(SUM(total_match_attempts), 0)                                 AS total_attempts
		FROM analytics_booking_kpi_hourly
		WHERE bucket_hour >= NOW() - ($1 * INTERVAL '1 day')
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
			DATE_TRUNC('day', bucket_hour)::date::text          AS date,
			COALESCE(SUM(revenue_gross_cents), 0)               AS gross,
			COALESCE(SUM(revenue_discount_cents), 0)            AS discount,
			COALESCE(SUM(revenue_net_cents), 0)                 AS net,
			COALESCE(SUM(completed_bookings), 0)                AS booking_count
		FROM analytics_booking_kpi_hourly
		WHERE bucket_hour >= NOW() - ($1 * INTERVAL '1 day')
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

