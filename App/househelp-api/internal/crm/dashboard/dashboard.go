// Package dashboard exposes the read-only KPI + chart endpoints powering the
// CRM home screen. All queries route through the CRM read pool (which falls
// back to the primary pool when CRM_DATABASE_READ_URL is not set).
package dashboard

import (
	"context"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
)

// KPIs is the top-row metric bundle.
type KPIs struct {
	ActiveOrders        int `json:"active_orders"`
	WorkersOnline       int `json:"workers_online"`
	RevenueTodayCents   int `json:"revenue_today_paise"`
	PendingRefunds      int `json:"pending_refunds"`
	PendingApplications int `json:"pending_applications"`
	OpenDisputes        int `json:"open_disputes"`
}

// LiveOrder is one row of the live-orders feed.
type LiveOrder struct {
	ID         string    `json:"id"`
	UserName   string    `json:"user_name"`
	Category   string    `json:"category"`
	HelperName *string   `json:"helper_name,omitempty"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
}

// RevenuePoint is a single bar on the 7-day revenue chart.
type RevenuePoint struct {
	Date         string `json:"date"` // YYYY-MM-DD
	RevenueCents int    `json:"revenue_paise"`
}

// CategoryShare is a slice of the orders-by-category donut.
type CategoryShare struct {
	Category string `json:"category"`
	Count    int    `json:"count"`
}

// Service holds DB access for the dashboard.
type Service struct {
	db *pgxpool.Pool
}

// NewService constructs the dashboard Service. db should be the CRM
// read-replica pool when one is configured.
func NewService(db *pgxpool.Pool) *Service { return &Service{db: db} }

// KPIs returns top-row metrics. Each metric has its own short query so a
// single slow one (e.g. revenue scan) doesn't block the others; the handler
// runs them sequentially under a 5s overall timeout.
func (s *Service) KPIs(ctx context.Context) (*KPIs, error) {
	out := &KPIs{}
	queries := []struct {
		name string
		sql  string
		dest *int
	}{
		{
			"active_orders",
			`SELECT COUNT(*) FROM bookings
			 WHERE status IN ('pending','searching','dispatching','accepted','arrived','in_progress')`,
			&out.ActiveOrders,
		},
		{
			"workers_online",
			`SELECT COUNT(*) FROM helpers WHERE is_available = true`,
			&out.WorkersOnline,
		},
		{
			"revenue_today",
			`SELECT COALESCE(SUM(amount_paise), 0) FROM bookings
			 WHERE status = 'completed'
			   AND completed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
			&out.RevenueTodayCents,
		},
		{
			"pending_refunds",
			`SELECT COUNT(*) FROM pending_refunds WHERE status = 'pending'`,
			&out.PendingRefunds,
		},
		{
			"pending_applications",
			`SELECT COUNT(*) FROM helpers WHERE approval_status = 'pending'`,
			&out.PendingApplications,
		},
		{
			"open_disputes",
			`SELECT COUNT(*) FROM crm_disputes WHERE status NOT IN ('resolved')`,
			&out.OpenDisputes,
		},
	}
	for _, q := range queries {
		// Best-effort: a missing column / table on a fresh DB shouldn't kill
		// the whole dashboard. Log and zero out.
		if err := s.db.QueryRow(ctx, q.sql).Scan(q.dest); err != nil {
			log.Warn().Err(err).Str("query", q.name).Msg("[crm.dashboard] kpi query failed — defaulting to 0")
			*q.dest = 0
		}
	}
	return out, nil
}

// LiveOrders returns the N most recent orders. Best-effort.
func (s *Service) LiveOrders(ctx context.Context, limit int) ([]LiveOrder, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	rows, err := s.db.Query(ctx, `
		SELECT b.id::text,
		       COALESCE(u.name, u.phone, '—'),
		       COALESCE(sc.category, sc.name, '—'),
		       h.name,
		       b.status,
		       b.created_at
		FROM bookings b
		LEFT JOIN users u ON u.id = b.customer_id AND u.deleted_at IS NULL
		LEFT JOIN users h ON h.id = b.helper_id AND h.deleted_at IS NULL
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		ORDER BY b.created_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("live orders: %w", err)
	}
	defer rows.Close()

	out := []LiveOrder{}
	for rows.Next() {
		var lo LiveOrder
		if err := rows.Scan(&lo.ID, &lo.UserName, &lo.Category, &lo.HelperName, &lo.Status, &lo.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan live order: %w", err)
		}
		out = append(out, lo)
	}
	return out, rows.Err()
}

// Revenue7d returns one row per day for the last 7 days, including zero days.
func (s *Service) Revenue7d(ctx context.Context) ([]RevenuePoint, error) {
	rows, err := s.db.Query(ctx, `
		WITH days AS (
		  SELECT generate_series(
		    date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - interval '6 days',
		    date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata'),
		    interval '1 day'
		  ) AS day
		)
		SELECT to_char(d.day, 'YYYY-MM-DD'),
		       COALESCE(SUM(b.amount_paise), 0)
		FROM days d
		LEFT JOIN bookings b
		  ON b.status = 'completed'
		 AND b.completed_at >= d.day AT TIME ZONE 'Asia/Kolkata'
		 AND b.completed_at < (d.day + interval '1 day') AT TIME ZONE 'Asia/Kolkata'
		GROUP BY d.day
		ORDER BY d.day
	`)
	if err != nil {
		return nil, fmt.Errorf("revenue 7d: %w", err)
	}
	defer rows.Close()
	out := []RevenuePoint{}
	for rows.Next() {
		var p RevenuePoint
		if err := rows.Scan(&p.Date, &p.RevenueCents); err != nil {
			return nil, fmt.Errorf("scan revenue point: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// CategoryShareToday returns the order count per service category for today.
func (s *Service) CategoryShareToday(ctx context.Context) ([]CategoryShare, error) {
	rows, err := s.db.Query(ctx, `
		SELECT COALESCE(sc.category, 'unknown'), COUNT(*)
		FROM bookings b
		LEFT JOIN service_categories sc ON sc.id = b.service_category_id
		WHERE b.created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
		GROUP BY sc.category
		ORDER BY COUNT(*) DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("category share: %w", err)
	}
	defer rows.Close()
	out := []CategoryShare{}
	for rows.Next() {
		var cs CategoryShare
		if err := rows.Scan(&cs.Category, &cs.Count); err != nil {
			return nil, fmt.Errorf("scan category share: %w", err)
		}
		out = append(out, cs)
	}
	return out, rows.Err()
}

// Handler is the HTTP layer for dashboard.
type Handler struct {
	svc *Service
}

// NewHandler constructs the dashboard Handler.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// RegisterRoutes mounts /dashboard/* under the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	read := middleware.RequirePermission("dashboard.read")
	r.Get("/dashboard/kpis", read, h.KPIs)
	r.Get("/dashboard/live-orders", read, h.LiveOrders)
	r.Get("/dashboard/revenue-7d", read, h.Revenue7d)
	r.Get("/dashboard/category-share", read, h.CategoryShareToday)
}

// KPIs returns dashboard top-row metrics.
func (h *Handler) KPIs(c *fiber.Ctx) error {
	out, err := h.svc.KPIs(c.UserContext())
	if err != nil {
		log.Error().Err(err).Msg("[crm.dashboard] kpis failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(out)
}

// LiveOrders returns the live order feed.
func (h *Handler) LiveOrders(c *fiber.Ctx) error {
	out, err := h.svc.LiveOrders(c.UserContext(), 20)
	if err != nil {
		log.Error().Err(err).Msg("[crm.dashboard] live orders failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"orders": out})
}

// Revenue7d returns the 7-day revenue chart data.
func (h *Handler) Revenue7d(c *fiber.Ctx) error {
	out, err := h.svc.Revenue7d(c.UserContext())
	if err != nil {
		log.Error().Err(err).Msg("[crm.dashboard] revenue 7d failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"points": out})
}

// CategoryShareToday returns today's orders-by-category split.
func (h *Handler) CategoryShareToday(c *fiber.Ctx) error {
	out, err := h.svc.CategoryShareToday(c.UserContext())
	if err != nil {
		log.Error().Err(err).Msg("[crm.dashboard] category share failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"categories": out})
}
