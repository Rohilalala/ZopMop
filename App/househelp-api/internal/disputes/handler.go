// Package disputes exposes the customer-facing dispute filing endpoint.
// The CRM read/update surface lives in internal/crm/trustsafety.
package disputes

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// validReasons is the fixed picker set shown to customers. Backend validates
// against this list so the CRM gets clean, filterable reason codes.
var validReasons = map[string]bool{
	"service_quality":   true,
	"helper_behavior":   true,
	"late_arrival":      true,
	"no_show":           true,
	"property_damage":   true,
	"payment_issue":     true,
	"other":             true,
}

// Handler provides POST /api/v1/disputes.
type Handler struct{ db *pgxpool.Pool }

func NewHandler(db *pgxpool.Pool) *Handler { return &Handler{db: db} }

func (h *Handler) RegisterRoutes(r fiber.Router) {
	r.Post("/disputes", h.Create)
}

type createRequest struct {
	BookingID   string `json:"booking_id"`
	Reason      string `json:"reason"`
	Description string `json:"description"`
}

// Create files a dispute on behalf of the authenticated customer.
// The booking must belong to the user and be in a terminal state
// (completed or cancelled).
func (h *Handler) Create(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "authentication required"})
	}

	var req createRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}

	req.Reason = strings.TrimSpace(req.Reason)
	req.Description = strings.TrimSpace(req.Description)
	req.BookingID = strings.TrimSpace(req.BookingID)

	if req.BookingID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "booking_id required"})
	}
	if !validReasons[req.Reason] {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error":   "invalid reason",
			"allowed": allowedReasons(),
		})
	}
	if len(req.Description) < 10 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "description must be at least 10 characters"})
	}
	if len(req.Description) > 2000 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "description too long (max 2000)"})
	}

	ctx, cancel := context.WithTimeout(c.UserContext(), 5*time.Second)
	defer cancel()

	// Verify booking belongs to user and is in a terminal state.
	var bookingStatus, helperID string
	err := h.db.QueryRow(ctx,
		`SELECT status, COALESCE(helper_id::text, '') FROM bookings WHERE id = $1::uuid AND customer_id = $2::uuid`,
		req.BookingID, userID,
	).Scan(&bookingStatus, &helperID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "booking not found"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}

	if bookingStatus != "completed" && bookingStatus != "cancelled" {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"error": "disputes can only be filed on completed or cancelled bookings",
		})
	}

	// Check for existing open dispute on this booking (prevent duplicates).
	var exists bool
	_ = h.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM crm_disputes WHERE booking_id = $1::uuid AND source = 'customer' AND status NOT IN ('resolved','closed'))`,
		req.BookingID,
	).Scan(&exists)
	if exists {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "an open dispute already exists for this booking"})
	}

	var disputeID string
	workerArg := ""
	if helperID != "" {
		workerArg = helperID
	}
	err = h.db.QueryRow(ctx, `
		INSERT INTO crm_disputes
		  (booking_id, customer_id, worker_id, source, reason, description, severity, sla_due_at)
		VALUES
		  ($1::uuid, $2::uuid, NULLIF($3, '')::uuid, 'customer', $4, $5, 'medium', NOW() + INTERVAL '48 hours')
		RETURNING id::text
	`, req.BookingID, userID, workerArg, req.Reason, req.Description).Scan(&disputeID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to file dispute"})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"id":      disputeID,
		"message": "Your dispute has been filed. Our team will review it within 48 hours.",
	})
}

func allowedReasons() []string {
	return []string{
		"service_quality",
		"helper_behavior",
		"late_arrival",
		"no_show",
		"property_damage",
		"payment_issue",
		"other",
	}
}
