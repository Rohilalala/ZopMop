package admin

import (
	"strconv"
	"strings"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/pkg/validator"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// Handler handles HTTP requests for the admin module.
type Handler struct {
	service *Service
}

// NewHandler creates a new admin handler.
func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// RegisterRoutes mounts admin routes onto the given router group.
// All routes require the admin middleware to be applied first.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	// Dashboard.
	router.Get("/dashboard", middleware.RequirePermission(PermViewAnalytics), h.GetDashboard)

	// Users management.
	router.Get("/users", middleware.RequirePermission(PermManageUsers), h.GetUsers)
	router.Patch("/users/:id/suspend", middleware.RequirePermission(PermManageUsers), h.SuspendUser)
	router.Patch("/users/:id/unsuspend", middleware.RequirePermission(PermManageUsers), h.UnsuspendUser)

	// Helpers management.
	router.Get("/helpers", middleware.RequirePermission(PermManageUsers), h.GetHelpers)
	router.Get("/helpers/pending", middleware.RequirePermission(PermManageUsers), h.GetPendingHelpers)
	router.Patch("/helpers/:id/approve", middleware.RequirePermission(PermManageUsers), h.ApproveHelper)
	router.Patch("/helpers/:id/reject", middleware.RequirePermission(PermManageUsers), h.RejectHelper)

	// Pending refunds queue.
	router.Get("/refunds", middleware.RequirePermission(PermManageUsers), h.ListPendingRefunds)
	router.Post("/refunds/:id/settle", middleware.RequirePermission(PermManageUsers), h.SettleRefund)

	// Bookings management.
	router.Get("/bookings", middleware.RequirePermission(PermViewAnalytics), h.GetBookings)
	router.Patch("/bookings/:id/cancel", middleware.RequirePermission(PermManageUsers), h.CancelBooking)

	// Audit log.
	router.Get("/audit-log", middleware.RequirePermission(PermViewAnalytics), h.GetAuditLog)

	// Promotions management.
	router.Get("/promotions", middleware.RequirePermission(PermManagePromotions), h.GetPromotions)
	router.Post("/promotions", middleware.RequirePermission(PermManagePromotions), h.CreatePromotion)
	router.Patch("/promotions/:id", middleware.RequirePermission(PermManagePromotions), h.UpdatePromotion)
	router.Patch("/promotions/:id/disable", middleware.RequirePermission(PermManagePromotions), h.DisablePromotion)

	// Broadcast Notification
	router.Post("/notifications/broadcast", middleware.RequirePermission(PermManageUsers), h.BroadcastNotification)
}

// GetDashboard handles GET /admin/dashboard — stats overview.
func (h *Handler) GetDashboard(c *fiber.Ctx) error {
	stats, err := h.service.GetDashboardStats(c.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to get dashboard stats")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load dashboard",
		})
	}
	return c.JSON(stats)
}

// GetUsers handles GET /admin/users?page=&limit=&role=&search=.
func (h *Handler) GetUsers(c *fiber.Ctx) error {
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	role := c.Query("role")
	search := c.Query("search")

	result, err := h.service.GetAllUsers(c.Context(), page, limit, role, search)
	if err != nil {
		log.Error().Err(err).Msg("failed to get users list")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load users",
		})
	}
	return c.JSON(result)
}

// SuspendUser handles PATCH /admin/users/:id/suspend.
func (h *Handler) SuspendUser(c *fiber.Ctx) error {
	targetUserID := c.Params("id")
	if _, err := uuid.Parse(targetUserID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user id"})
	}
	adminID, _ := c.Locals("adminID").(string)

	if err := h.service.SuspendUser(c.Context(), adminID, targetUserID, c.IP()); err != nil {
		log.Error().Err(err).Str("target_user_id", targetUserID).Msg("failed to suspend user")
		// Return 404 if user was not found.
		if err.Error() == "user not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
				"error": "user not found",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to suspend user",
		})
	}

	return c.JSON(fiber.Map{"message": "user suspended"})
}

// UnsuspendUser handles PATCH /admin/users/:id/unsuspend.
func (h *Handler) UnsuspendUser(c *fiber.Ctx) error {
	targetUserID := c.Params("id")
	if _, err := uuid.Parse(targetUserID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user id"})
	}
	adminID, _ := c.Locals("adminID").(string)

	if err := h.service.UnsuspendUser(c.Context(), adminID, targetUserID, c.IP()); err != nil {
		log.Error().Err(err).Str("target_user_id", targetUserID).Msg("failed to unsuspend user")
		// Return 404 if user was not found.
		if err.Error() == "user not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
				"error": "user not found",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to unsuspend user",
		})
	}

	return c.JSON(fiber.Map{"message": "user unsuspended"})
}

// GetHelpers handles GET /admin/helpers.
func (h *Handler) GetHelpers(c *fiber.Ctx) error {
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	minRating, _ := strconv.ParseFloat(c.Query("min_rating", "0"), 64)

	var available *bool
	if avail := c.Query("available"); avail != "" {
		b := avail == "true"
		available = &b
	}

	result, err := h.service.GetAllHelpers(c.Context(), page, limit, available, minRating)
	if err != nil {
		log.Error().Err(err).Msg("failed to get helpers list")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load helpers",
		})
	}
	return c.JSON(result)
}

// GetPendingHelpers handles GET /admin/helpers/pending.
func (h *Handler) GetPendingHelpers(c *fiber.Ctx) error {
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))

	result, err := h.service.ListPendingHelpers(c.Context(), page, limit)
	if err != nil {
		log.Error().Err(err).Msg("failed to get pending helpers")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load pending helpers",
		})
	}
	return c.JSON(result)
}

// ApproveHelper handles PATCH /admin/helpers/:id/approve.
func (h *Handler) ApproveHelper(c *fiber.Ctx) error {
	helperID := c.Params("id")
	if _, err := uuid.Parse(helperID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid helper id"})
	}
	adminID, _ := c.Locals("adminID").(string)

	if err := h.service.ApproveHelper(c.Context(), helperID, adminID, c.IP()); err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to approve helper")
		if err.Error() == "helper not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "helper not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to approve helper"})
	}
	return c.JSON(fiber.Map{"message": "helper approved"})
}

// RejectHelper handles PATCH /admin/helpers/:id/reject.
func (h *Handler) RejectHelper(c *fiber.Ctx) error {
	helperID := c.Params("id")
	if _, err := uuid.Parse(helperID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid helper id"})
	}
	adminID, _ := c.Locals("adminID").(string)

	if err := h.service.RejectHelper(c.Context(), helperID, adminID, c.IP()); err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to reject helper")
		if err.Error() == "helper not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "helper not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to reject helper"})
	}
	return c.JSON(fiber.Map{"message": "helper rejected"})
}

// ListPendingRefunds handles GET /admin/refunds?status=pending|settled.
func (h *Handler) ListPendingRefunds(c *fiber.Ctx) error {
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	status := c.Query("status")

	if status != "" && status != "pending" && status != "settled" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid status filter"})
	}

	result, err := h.service.ListPendingRefunds(c.Context(), status, page, limit)
	if err != nil {
		log.Error().Err(err).Msg("failed to list pending refunds")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to load refunds"})
	}
	return c.JSON(result)
}

// SettleRefund handles POST /admin/refunds/:id/settle.
func (h *Handler) SettleRefund(c *fiber.Ctx) error {
	refundID := c.Params("id")
	if _, err := uuid.Parse(refundID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid refund id"})
	}
	adminID, _ := c.Locals("adminID").(string)

	pr, err := h.service.SettleRefund(c.Context(), refundID, adminID, c.IP())
	if err != nil {
		log.Error().Err(err).Str("refund_id", refundID).Msg("failed to settle refund")
		if err.Error() == "refund not found or already settled" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": err.Error()})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to settle refund"})
	}
	return c.JSON(pr)
}

// CancelBooking handles PATCH /admin/bookings/:id/cancel.
func (h *Handler) CancelBooking(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if bookingID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing booking id"})
	}
	if _, err := uuid.Parse(bookingID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	adminID, ok := c.Locals("adminID").(string)
	if !ok || adminID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	if err := h.service.CancelBooking(c.Context(), adminID, bookingID, c.IP()); err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Msg("admin cancel booking failed")
		status := fiber.StatusInternalServerError
		message := "failed to cancel booking"
		switch {
		case err.Error() == "booking not found":
			status = fiber.StatusNotFound
			message = "booking not found"
		case strings.HasPrefix(err.Error(), "invalid status transition"):
			status = fiber.StatusBadRequest
			message = "booking cannot be cancelled in current status"
		}
		return c.Status(status).JSON(fiber.Map{"error": message})
	}
	return c.JSON(fiber.Map{"ok": true})
}

// GetBookings handles GET /admin/bookings.
func (h *Handler) GetBookings(c *fiber.Ctx) error {
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	status := c.Query("status")
	search := c.Query("search")

	result, err := h.service.GetBookingsList(c.Context(), page, limit, status, search)
	if err != nil {
		log.Error().Err(err).Msg("failed to get bookings list")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load bookings",
		})
	}
	return c.JSON(result)
}

// GetAuditLog handles GET /admin/audit-log.
func (h *Handler) GetAuditLog(c *fiber.Ctx) error {
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	targetType := c.Query("target_type")

	result, err := h.service.GetAuditLog(c.Context(), page, limit, targetType)
	if err != nil {
		log.Error().Err(err).Msg("failed to get audit log")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load audit log",
		})
	}
	return c.JSON(result)
}

// GetPromotions handles GET /admin/promotions.
func (h *Handler) GetPromotions(c *fiber.Ctx) error {
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))

	result, err := h.service.GetAllPromotions(c.Context(), page, limit)
	if err != nil {
		log.Error().Err(err).Msg("failed to get promotions")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to load promotions",
		})
	}
	return c.JSON(result)
}

// CreatePromotion handles POST /admin/promotions.
func (h *Handler) CreatePromotion(c *fiber.Ctx) error {
	var req PromotionRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	promo := req.ToPromotion()
	adminID, _ := c.Locals("adminID").(string)
	if err := h.service.CreatePromotion(c.Context(), &promo, adminID, c.IP()); err != nil {
		log.Error().Err(err).Msg("failed to create promotion")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to create promotion",
		})
	}

	return c.Status(fiber.StatusCreated).JSON(promo)
}

// UpdatePromotion handles PATCH /admin/promotions/:id.
func (h *Handler) UpdatePromotion(c *fiber.Ctx) error {
	promoID := c.Params("id")
	if _, err := uuid.Parse(promoID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid promotion id"})
	}

	var req PromotionRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "invalid request body",
		})
	}
	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	promo := req.ToPromotion()
	promo.ID = promoID

	adminID, _ := c.Locals("adminID").(string)
	if err := h.service.UpdatePromotion(c.Context(), &promo, adminID, c.IP()); err != nil {
		log.Error().Err(err).Msg("failed to update promotion")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to update promotion",
		})
	}

	return c.JSON(promo)
}

// DisablePromotion handles PATCH /admin/promotions/:id/disable.
func (h *Handler) DisablePromotion(c *fiber.Ctx) error {
	promoID := c.Params("id")
	if _, err := uuid.Parse(promoID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid promotion id"})
	}
	adminID, _ := c.Locals("adminID").(string)

	if err := h.service.DisablePromotion(c.Context(), promoID, adminID, c.IP()); err != nil {
		log.Error().Err(err).Msg("failed to disable promotion")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "failed to disable promotion",
		})
	}

	return c.JSON(fiber.Map{"message": "promotion disabled"})
}

// BroadcastNotification handles POST /admin/notifications/broadcast.
// Body: { "title": "...", "body": "...", "target": "customers|pros|all" }
func (h *Handler) BroadcastNotification(c *fiber.Ctx) error {
	var req BroadcastNotificationRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}

	if req.Target == "" {
		req.Target = "customers"
	}

	if err := validator.Validate.Struct(req); err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error":  "validation failed",
			"fields": validator.FormatValidationErrors(err),
		})
	}

	if err := h.service.Broadcast(c.Context(), req.Title, req.Body, req.Target); err != nil {
		log.Error().Err(err).Str("target", req.Target).Msg("failed to broadcast notification")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to broadcast notification"})
	}

	return c.JSON(fiber.Map{"message": "broadcast initiated", "target": req.Target})
}
