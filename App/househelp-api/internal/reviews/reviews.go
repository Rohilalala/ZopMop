// Package reviews implements customer-submitted ratings for completed bookings.
// One review per booking. helpers.rating is recomputed by an after-insert
// trigger defined in migration 057.
package reviews

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/analytics"
)

// ErrBookingNotCompleted is returned when a customer tries to rate a booking
// whose status has not yet reached 'completed'.
var ErrBookingNotCompleted = errors.New("booking is not completed")

// ErrNotOwner is returned when the JWT user_id is not the booking customer.
var ErrNotOwner = errors.New("booking does not belong to caller")

// ErrAlreadyReviewed is returned by Create when this booking already has
// a review row. (DB enforces this with a UNIQUE constraint on booking_id.)
var ErrAlreadyReviewed = errors.New("booking already reviewed")

// CreateRequest is the body of POST /bookings/:id/review.
type CreateRequest struct {
	Rating  int    `json:"rating"`
	Comment string `json:"comment"`
}

// Review is the persisted shape returned to the client on success.
type Review struct {
	ID         string `json:"id"`
	BookingID  string `json:"booking_id"`
	CustomerID string `json:"customer_id"`
	HelperID   string `json:"helper_id"`
	Rating     int    `json:"rating"`
	Comment    string `json:"comment,omitempty"`
}

// Service holds the DB pool and analytics tracker. analytics is nil-safe.
type Service struct {
	db        *pgxpool.Pool
	analytics *analytics.Service
}

// NewService constructs a Service.
func NewService(db *pgxpool.Pool, a *analytics.Service) *Service {
	return &Service{db: db, analytics: a}
}

// Create inserts a review after verifying ownership + completed-status.
func (s *Service) Create(ctx context.Context, bookingID, customerID string, req CreateRequest) (*Review, error) {
	if req.Rating < 1 || req.Rating > 5 {
		return nil, fmt.Errorf("rating must be between 1 and 5")
	}
	if len(req.Comment) > 1000 {
		return nil, fmt.Errorf("comment too long")
	}

	var bookingCustomer, helperID, status string
	err := s.db.QueryRow(ctx, `
		SELECT customer_id::text, COALESCE(helper_id::text, ''), status
		FROM bookings WHERE id = $1::uuid
	`, bookingID).Scan(&bookingCustomer, &helperID, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("booking not found")
	}
	if err != nil {
		return nil, fmt.Errorf("load booking: %w", err)
	}
	if bookingCustomer != customerID {
		return nil, ErrNotOwner
	}
	if status != "completed" {
		return nil, ErrBookingNotCompleted
	}
	if helperID == "" {
		return nil, fmt.Errorf("booking has no helper to rate")
	}

	r := Review{BookingID: bookingID, CustomerID: customerID, HelperID: helperID, Rating: req.Rating, Comment: req.Comment}
	err = s.db.QueryRow(ctx, `
		INSERT INTO reviews (booking_id, customer_id, helper_id, rating, comment)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, NULLIF($5, ''))
		RETURNING id::text
	`, bookingID, customerID, helperID, req.Rating, strings.TrimSpace(req.Comment)).Scan(&r.ID)
	if err != nil {
		// Detect the UNIQUE(booking_id) violation and surface a friendlier error.
		if strings.Contains(err.Error(), "reviews_booking_id_key") || strings.Contains(err.Error(), "duplicate key") {
			return nil, ErrAlreadyReviewed
		}
		return nil, fmt.Errorf("insert review: %w", err)
	}

	// Clear the pending-rating flag so the customer-app banner stops surfacing
	// on home for this booking. Best-effort: a failure here doesn't fail the
	// review submission — the review row is already persisted.
	if _, uerr := s.db.Exec(ctx,
		`UPDATE bookings SET customer_rating_pending = false WHERE id = $1::uuid`,
		bookingID,
	); uerr != nil {
		log.Warn().Err(uerr).Str("booking_id", bookingID).Msg("failed to clear customer_rating_pending")
	}

	if s.analytics != nil {
		s.analytics.Track(ctx, analytics.EventRated, customerID, bookingID, map[string]string{
			"rating":    fmt.Sprintf("%d", req.Rating),
			"helper_id": helperID,
		})
	}
	return &r, nil
}

// Handler is the HTTP layer. The route is mounted under the existing
// /api/v1/bookings group so it inherits the same JWT middleware.
type Handler struct{ svc *Service }

// NewHandler constructs a Handler.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// RegisterRoutes mounts POST /:id/review onto the supplied (already-authed)
// bookings router.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	r.Post("/:id/review", h.Create)
}

// Create handles POST /bookings/:id/review.
func (h *Handler) Create(c *fiber.Ctx) error {
	var req CreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid body"})
	}
	customerID, _ := c.Locals("userID").(string)
	if customerID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
	}
	out, err := h.svc.Create(c.UserContext(), c.Params("id"), customerID, req)
	if err != nil {
		switch {
		case errors.Is(err, ErrBookingNotCompleted):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		case errors.Is(err, ErrNotOwner):
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": err.Error()})
		case errors.Is(err, ErrAlreadyReviewed):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		}
		log.Warn().Err(err).Str("booking_id", c.Params("id")).Msg("review create failed")
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(fiber.StatusCreated).JSON(out)
}
