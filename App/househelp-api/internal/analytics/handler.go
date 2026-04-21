package analytics

import (
	"errors"
	"strconv"

	"github.com/adityarohilla/househelp-api/internal/admin"
	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Handler serves analytics HTTP endpoints.
type Handler struct {
	svc *Service
}

// NewHandler creates a new analytics handler.
func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

// RegisterAdminRoutes mounts admin-only analytics endpoints under /admin/analytics.
// Requires PermViewAnalytics.
func (h *Handler) RegisterAdminRoutes(router fiber.Router) {
	g := router.Group("/analytics", middleware.RequirePermission(admin.PermViewAnalytics))
	g.Get("/overview", h.GetOverview)
	g.Get("/funnel", h.GetFunnel)
	g.Get("/bookings", h.GetBookingTrends)
	g.Get("/workers", h.GetWorkerPerformance)
	g.Get("/operations", h.GetOperationalMetrics)
	g.Get("/revenue", h.GetRevenueTrends)
}

// RegisterClientRoutes mounts the client event ingestion endpoint.
// Requires a valid JWT (authenticated users only); rate limiting is applied
// by the caller using the auth-scoped limiter.
func (h *Handler) RegisterClientRoutes(router fiber.Router) {
	router.Post("/analytics/events", h.TrackClientEvent)
	router.Post("/events", h.TrackCanonicalEvent)
}

// ── Admin endpoints ───────────────────────────────────────────────────────────

// GetOverview handles GET /admin/analytics/overview?days=7
func (h *Handler) GetOverview(c *fiber.Ctx) error {
	days := parseDays(c, 7)
	result, err := h.svc.GetOverview(c.Context(), days)
	if err != nil {
		log.Error().Err(err).Msg("[analytics] GetOverview error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load overview"})
	}
	return c.JSON(result)
}

// GetFunnel handles GET /admin/analytics/funnel?days=30
func (h *Handler) GetFunnel(c *fiber.Ctx) error {
	days := parseDays(c, 30)
	result, err := h.svc.GetFunnel(c.Context(), days)
	if err != nil {
		log.Error().Err(err).Msg("[analytics] GetFunnel error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load funnel"})
	}
	return c.JSON(result)
}

// GetBookingTrends handles GET /admin/analytics/bookings?days=30
func (h *Handler) GetBookingTrends(c *fiber.Ctx) error {
	days := parseDays(c, 30)
	result, err := h.svc.GetBookingTrends(c.Context(), days)
	if err != nil {
		log.Error().Err(err).Msg("[analytics] GetBookingTrends error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load booking trends"})
	}
	return c.JSON(fiber.Map{"days": days, "trends": result})
}

// GetWorkerPerformance handles GET /admin/analytics/workers?days=30&limit=20
func (h *Handler) GetWorkerPerformance(c *fiber.Ctx) error {
	days := parseDays(c, 30)
	limit, _ := strconv.Atoi(c.Query("limit", "20"))

	result, err := h.svc.GetWorkerPerformance(c.Context(), days, limit)
	if err != nil {
		log.Error().Err(err).Msg("[analytics] GetWorkerPerformance error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load worker metrics"})
	}
	return c.JSON(fiber.Map{"days": days, "workers": result})
}

// GetOperationalMetrics handles GET /admin/analytics/operations?days=7
func (h *Handler) GetOperationalMetrics(c *fiber.Ctx) error {
	days := parseDays(c, 7)
	result, err := h.svc.GetOperationalMetrics(c.Context(), days)
	if err != nil {
		log.Error().Err(err).Msg("[analytics] GetOperationalMetrics error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load operational metrics"})
	}
	return c.JSON(result)
}

// GetRevenueTrends handles GET /admin/analytics/revenue?days=30
func (h *Handler) GetRevenueTrends(c *fiber.Ctx) error {
	days := parseDays(c, 30)
	result, err := h.svc.GetRevenueTrends(c.Context(), days)
	if err != nil {
		log.Error().Err(err).Msg("[analytics] GetRevenueTrends error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load revenue trends"})
	}
	return c.JSON(fiber.Map{"days": days, "revenue": result})
}

// ── Client endpoint ───────────────────────────────────────────────────────────

// TrackClientEvent handles POST /api/v1/analytics/events.
// Body: { "event_name": "service.viewed", "booking_id": "...", "properties": {} }
func (h *Handler) TrackClientEvent(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)

	var req ClientEventRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	if req.EventName == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "event_name is required"})
	}

	if err := h.svc.TrackClientEvent(c.Context(), &req, userID); err != nil {
		if errors.Is(err, ErrUnknownClientEvent) {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "unknown event name"})
		}
		log.Error().Err(err).Msg("[analytics] TrackClientEvent error")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to track event"})
	}

	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"ok": true})
}

// TrackCanonicalEvent handles POST /api/v1/events.
func (h *Handler) TrackCanonicalEvent(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)

	var req CanonicalEventRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if err := h.svc.TrackCanonicalEvent(c.Context(), &req, userID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"ok": true})
}

// ── helpers ───────────────────────────────────────────────────────────────────

func parseDays(c *fiber.Ctx, defaultVal int) int {
	d, err := strconv.Atoi(c.Query("days", strconv.Itoa(defaultVal)))
	if err != nil || d < 1 {
		return defaultVal
	}
	return d
}
