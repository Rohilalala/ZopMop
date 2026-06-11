// Package analytics is the read-only reporting surface. Every query routes
// through the read pool. No mutations live here.
package analytics

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
)

type Service struct{ db *pgxpool.Pool }

func NewService(db *pgxpool.Pool) *Service { return &Service{db: db} }

// parseRange decodes ?from / ?to query params (RFC3339). Defaults to last 30d.
func parseRange(c *fiber.Ctx) (time.Time, time.Time) {
	to := time.Now()
	if v := c.Query("to"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			to = t
		}
	}
	from := to.AddDate(0, 0, -30)
	if v := c.Query("from"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			from = t
		}
	}
	return from, to
}

// ── Service queries ────────────────────────────────────────────────────

type DailyPoint struct {
	Date  string `json:"date"`
	Value int64  `json:"value"`
}

func (s *Service) RevenueDaily(ctx context.Context, from, to time.Time) ([]DailyPoint, error) {
	rows, err := s.db.Query(ctx, `
		WITH days AS (
		  SELECT generate_series(
		           date_trunc('day', $1::timestamptz AT TIME ZONE 'Asia/Kolkata'),
		           date_trunc('day', $2::timestamptz AT TIME ZONE 'Asia/Kolkata'),
		           interval '1 day') AS day
		)
		SELECT to_char(d.day, 'YYYY-MM-DD'), COALESCE(SUM(b.amount_paise), 0)
		FROM days d
		LEFT JOIN bookings b ON b.status = 'completed'
		  AND b.completed_at >= d.day AT TIME ZONE 'Asia/Kolkata'
		  AND b.completed_at < (d.day + interval '1 day') AT TIME ZONE 'Asia/Kolkata'
		GROUP BY d.day ORDER BY d.day
	`, from, to)
	return scanDaily(rows, err)
}

func (s *Service) OrdersDaily(ctx context.Context, from, to time.Time) ([]DailyPoint, error) {
	rows, err := s.db.Query(ctx, `
		WITH days AS (
		  SELECT generate_series(
		           date_trunc('day', $1::timestamptz AT TIME ZONE 'Asia/Kolkata'),
		           date_trunc('day', $2::timestamptz AT TIME ZONE 'Asia/Kolkata'),
		           interval '1 day') AS day
		)
		SELECT to_char(d.day, 'YYYY-MM-DD'), COALESCE(COUNT(b.id), 0)
		FROM days d
		LEFT JOIN bookings b ON b.created_at >= d.day AT TIME ZONE 'Asia/Kolkata'
		  AND b.created_at < (d.day + interval '1 day') AT TIME ZONE 'Asia/Kolkata'
		GROUP BY d.day ORDER BY d.day
	`, from, to)
	return scanDaily(rows, err)
}

func (s *Service) SignupsDaily(ctx context.Context, from, to time.Time) ([]DailyPoint, error) {
	rows, err := s.db.Query(ctx, `
		WITH days AS (
		  SELECT generate_series(
		           date_trunc('day', $1::timestamptz AT TIME ZONE 'Asia/Kolkata'),
		           date_trunc('day', $2::timestamptz AT TIME ZONE 'Asia/Kolkata'),
		           interval '1 day') AS day
		)
		SELECT to_char(d.day, 'YYYY-MM-DD'), COALESCE(COUNT(u.id), 0)
		FROM days d
		LEFT JOIN users u ON u.created_at >= d.day AT TIME ZONE 'Asia/Kolkata'
		  AND u.created_at < (d.day + interval '1 day') AT TIME ZONE 'Asia/Kolkata' AND u.deleted_at IS NULL
		GROUP BY d.day ORDER BY d.day
	`, from, to)
	return scanDaily(rows, err)
}

func scanDaily(rows interface {
	Next() bool
	Scan(...any) error
	Close()
	Err() error
}, err error) ([]DailyPoint, error) {
	if err != nil {
		return nil, fmt.Errorf("daily query: %w", err)
	}
	defer rows.Close()
	out := []DailyPoint{}
	for rows.Next() {
		var p DailyPoint
		if err := rows.Scan(&p.Date, &p.Value); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

type Summary struct {
	Orders          int   `json:"orders"`
	CompletedOrders int   `json:"completed_orders"`
	CancelledOrders int   `json:"cancelled_orders"`
	RevenueCents    int64 `json:"revenue_paise"`
	NewUsers        int   `json:"new_users"`
	NewWorkers      int   `json:"new_workers"`
	AvgOrderCents   int64 `json:"avg_order_paise"`
}

func (s *Service) Summary(ctx context.Context, from, to time.Time) (*Summary, error) {
	var sum Summary
	err := s.db.QueryRow(ctx, `
		SELECT
		  COUNT(*),
		  COUNT(*) FILTER (WHERE status = 'completed'),
		  COUNT(*) FILTER (WHERE status = 'cancelled'),
		  COALESCE(SUM(amount_paise) FILTER (WHERE status = 'completed'), 0),
		  COALESCE(AVG(amount_paise) FILTER (WHERE status = 'completed'), 0)::bigint
		FROM bookings
		WHERE created_at >= $1 AND created_at <= $2
	`, from, to).Scan(&sum.Orders, &sum.CompletedOrders, &sum.CancelledOrders, &sum.RevenueCents, &sum.AvgOrderCents)
	if err != nil {
		return nil, fmt.Errorf("summary bookings: %w", err)
	}
	if err := s.db.QueryRow(ctx, `
		SELECT COUNT(*) FILTER (WHERE role = 'customer'), COUNT(*) FILTER (WHERE role = 'pro')
		FROM users WHERE created_at >= $1 AND created_at <= $2 AND deleted_at IS NULL
	`, from, to).Scan(&sum.NewUsers, &sum.NewWorkers); err != nil {
		return nil, fmt.Errorf("summary users: %w", err)
	}
	return &sum, nil
}

type CategoryRow struct {
	Category     string `json:"category"`
	Orders       int    `json:"orders"`
	RevenueCents int64  `json:"revenue_paise"`
}

func (s *Service) ByCategory(ctx context.Context, from, to time.Time) ([]CategoryRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT COALESCE(sc.name, '—'),
		       COUNT(*),
		       COALESCE(SUM(b.amount_paise) FILTER (WHERE b.status = 'completed'), 0)
		FROM bookings b
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		WHERE b.created_at >= $1 AND b.created_at <= $2
		GROUP BY sc.name
		ORDER BY COUNT(*) DESC
	`, from, to)
	if err != nil {
		return nil, fmt.Errorf("by category: %w", err)
	}
	defer rows.Close()
	out := []CategoryRow{}
	for rows.Next() {
		var r CategoryRow
		if err := rows.Scan(&r.Category, &r.Orders, &r.RevenueCents); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ── Handler ────────────────────────────────────────────────────────────

type Handler struct{ svc *Service }

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/analytics")
	read := middleware.RequirePermission("analytics.read")
	g.Get("/summary", read, h.Summary)
	g.Get("/revenue-daily", read, h.RevenueDaily)
	g.Get("/orders-daily", read, h.OrdersDaily)
	g.Get("/signups-daily", read, h.SignupsDaily)
	g.Get("/by-category", read, h.ByCategory)
}

func (h *Handler) Summary(c *fiber.Ctx) error {
	from, to := parseRange(c)
	out, err := h.svc.Summary(c.UserContext(), from, to)
	return jsonOrErr(c, out, err)
}
func (h *Handler) RevenueDaily(c *fiber.Ctx) error {
	from, to := parseRange(c)
	out, err := h.svc.RevenueDaily(c.UserContext(), from, to)
	return jsonOrErr(c, fiber.Map{"points": out}, err)
}
func (h *Handler) OrdersDaily(c *fiber.Ctx) error {
	from, to := parseRange(c)
	out, err := h.svc.OrdersDaily(c.UserContext(), from, to)
	return jsonOrErr(c, fiber.Map{"points": out}, err)
}
func (h *Handler) SignupsDaily(c *fiber.Ctx) error {
	from, to := parseRange(c)
	out, err := h.svc.SignupsDaily(c.UserContext(), from, to)
	return jsonOrErr(c, fiber.Map{"points": out}, err)
}
func (h *Handler) ByCategory(c *fiber.Ctx) error {
	from, to := parseRange(c)
	out, err := h.svc.ByCategory(c.UserContext(), from, to)
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func jsonOrErr(c *fiber.Ctx, payload any, err error) error {
	if err != nil {
		log.Error().Err(err).Msg("[crm.analytics] query failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(payload)
}

// _ keeps strconv import alive for future limit/offset params.
var _ = strconv.Atoi
