package reengagement

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository struct {
	db *pgxpool.Pool
}

func NewRepository(db *pgxpool.Pool) *Repository {
	return &Repository{db: db}
}

func (r *Repository) ListMoppingDropoffCandidates(ctx context.Context, now time.Time, delay time.Duration) ([]Candidate, error) {
	if r == nil || r.db == nil {
		return nil, nil
	}
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := r.db.Query(qCtx, `
		WITH latest_view AS (
			SELECT DISTINCT ON (ae.user_id)
				ae.user_id::text AS user_id,
				DATE_TRUNC('minute', ae.created_at) AS window_start,
				COALESCE(NULLIF(ae.properties->>'service_name', ''), 'Mopping') AS service_name,
				ae.created_at
			FROM analytics_events ae
			WHERE ae.event_name = 'service.viewed'
			  AND ae.user_id IS NOT NULL
			  AND LOWER(COALESCE(ae.properties->>'service_slug', '')) = 'mopping'
			  AND ae.created_at <= $1 - $2::interval
			ORDER BY ae.user_id, ae.created_at DESC
		)
		SELECT lv.user_id, lv.window_start, lv.service_name
		FROM latest_view lv
		WHERE NOT EXISTS (
			SELECT 1
			FROM analytics_events br
			WHERE br.user_id::text = lv.user_id
			  AND br.event_name = 'booking_requested'
			  AND br.created_at >= lv.created_at
			  AND br.created_at < lv.created_at + $2::interval
		)
	`, now.UTC(), toPGInterval(delay))
	if err != nil {
		return nil, fmt.Errorf("list mopping dropoff candidates: %w", err)
	}
	defer rows.Close()

	var result []Candidate
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.UserID, &c.WindowStart, &c.ServiceName); err != nil {
			return nil, fmt.Errorf("scan mopping dropoff candidate: %w", err)
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

func (r *Repository) ListCartAbandonmentCandidates(ctx context.Context, now time.Time, delay time.Duration) ([]Candidate, error) {
	if r == nil || r.db == nil {
		return nil, nil
	}
	qCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := r.db.Query(qCtx, `
		WITH cart_state AS (
			SELECT
				c.user_id::text AS user_id,
				DATE_TRUNC('minute', c.updated_at) AS window_start,
				COUNT(ci.id)::int AS cart_count,
				MIN(sc.name) AS service_name,
				c.updated_at
			FROM cart c
			JOIN cart_items ci ON ci.cart_id = c.id
			JOIN service_categories sc ON sc.id = ci.service_id
			WHERE c.updated_at <= $1 - $2::interval
			GROUP BY c.user_id, c.updated_at
		)
		SELECT cs.user_id, cs.window_start, cs.cart_count, cs.service_name
		FROM cart_state cs
		WHERE NOT EXISTS (
			SELECT 1
			FROM analytics_events br
			WHERE br.user_id::text = cs.user_id
			  AND br.event_name = 'booking_requested'
			  AND br.created_at >= cs.updated_at
			  AND br.created_at < cs.updated_at + $2::interval
		)
		  AND NOT EXISTS (
			SELECT 1
			FROM bookings b
			WHERE b.customer_id::text = cs.user_id
			  AND b.created_at >= cs.updated_at
			  AND b.created_at < cs.updated_at + $2::interval
		)
	`, now.UTC(), toPGInterval(delay))
	if err != nil {
		return nil, fmt.Errorf("list cart abandonment candidates: %w", err)
	}
	defer rows.Close()

	var result []Candidate
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.UserID, &c.WindowStart, &c.CartCount, &c.ServiceName); err != nil {
			return nil, fmt.Errorf("scan cart abandonment candidate: %w", err)
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

func (r *Repository) RecordSent(ctx context.Context, userID, scenario string, windowStart time.Time, payload map[string]string) (bool, error) {
	if r == nil || r.db == nil {
		return false, nil
	}
	qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return false, fmt.Errorf("marshal payload: %w", err)
	}

	tag, err := r.db.Exec(qCtx, `
		INSERT INTO reengagement_notifications (user_id, scenario, window_start, payload)
		VALUES ($1::uuid, $2, $3, $4::jsonb)
		ON CONFLICT (user_id, scenario, window_start) DO NOTHING
	`, userID, scenario, windowStart.UTC(), payloadJSON)
	if err != nil {
		return false, fmt.Errorf("record reengagement send: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

func toPGInterval(d time.Duration) string {
	if d <= 0 {
		return "0 seconds"
	}
	return fmt.Sprintf("%d seconds", int(d/time.Second))
}
