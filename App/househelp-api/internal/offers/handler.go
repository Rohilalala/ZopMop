// Package offers exposes the consumer-facing GET /api/v1/offers endpoint.
// It reads from the promotions table (written by the CRM) and returns only
// the promos that are active, in-window, and visible to the requesting user.
package offers

import (
	"context"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Offer is the consumer-facing representation of a promotion.
type Offer struct {
	ID            string     `json:"id"`
	Code          string     `json:"code"`
	Title         string     `json:"title"`
	Description   string     `json:"description"`
	DiscountLabel string     `json:"discount_label"`
	ExpiresAt     *time.Time `json:"expires_at,omitempty"`
	MinOrderCents int        `json:"min_order_cents"`
	MaxPerUser    int        `json:"max_per_user"`
	Stackable     bool       `json:"stackable"`
	Categories    []string   `json:"categories"`
}

// Handler serves the consumer offers endpoint.
type Handler struct{ db *pgxpool.Pool }

func NewHandler(db *pgxpool.Pool) *Handler { return &Handler{db: db} }

// RegisterRoutes mounts GET /offers.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	r.Get("/offers", h.List)
}

// List handles GET /api/v1/offers.
// Returns active promotions visible to the authenticated user.
func (h *Handler) List(c *fiber.Ctx) error {
	userID, _ := c.Locals("userID").(string)

	offers, err := listForUser(c.UserContext(), h.db, userID)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("[offers] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"offers": offers})
}

// listForUser queries active promotions visible to the given user.
// Audience rules:
//   - "all"          → everyone
//   - "user_segment" → only users in audience_user_ids
//   - "new_users"    → users with no non-cancelled bookings
//   - "vip"          → users with role = "vip" (future)
//   - "role"         → users whose role matches audience_role column (future)
func listForUser(ctx context.Context, db *pgxpool.Pool, userID string) ([]Offer, error) {
	rows, err := db.Query(ctx, `
		SELECT
			id::text,
			code,
			COALESCE(name, code)        AS title,
			COALESCE(description, '')   AS description,
			discount_type,
			discount_value,
			min_order_cents,
			max_per_user,
			expires_at,
			categories,
			stackable
		FROM promotions
		WHERE is_active = TRUE
		  AND (starts_at IS NULL OR starts_at <= NOW())
		  AND (expires_at IS NULL OR expires_at > NOW())
		  AND (max_uses = 0 OR uses_count < max_uses)
		  AND (
		      audience = 'all'
		   OR (audience = 'user_segment' AND $1::uuid = ANY(audience_user_ids))
		   OR (audience = 'new_users' AND NOT EXISTS (
		          SELECT 1 FROM bookings
		          WHERE user_id = $1::uuid
		            AND status NOT IN ('cancelled', 'pending_customer_action')
		       ))
		  )
		ORDER BY
		  CASE WHEN expires_at IS NOT NULL THEN 0 ELSE 1 END,
		  expires_at ASC NULLS LAST
		LIMIT 50
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("offers query: %w", err)
	}
	defer rows.Close()

	var out []Offer
	for rows.Next() {
		var o Offer
		var discountType string
		var discountValue int
		if err := rows.Scan(
			&o.ID, &o.Code, &o.Title, &o.Description,
			&discountType, &discountValue,
			&o.MinOrderCents, &o.MaxPerUser,
			&o.ExpiresAt, &o.Categories, &o.Stackable,
		); err != nil {
			return nil, fmt.Errorf("scan offer: %w", err)
		}
		o.DiscountLabel = formatDiscount(discountType, discountValue)
		out = append(out, o)
	}
	if out == nil {
		out = []Offer{}
	}
	return out, rows.Err()
}

func formatDiscount(discountType string, value int) string {
	switch discountType {
	case "percent":
		return fmt.Sprintf("%d%% OFF", value)
	case "fixed":
		rupees := value / 100
		if value%100 == 0 {
			return fmt.Sprintf("₹%d OFF", rupees)
		}
		return fmt.Sprintf("₹%d.%02d OFF", rupees, value%100)
	default:
		return fmt.Sprintf("%d OFF", value)
	}
}
