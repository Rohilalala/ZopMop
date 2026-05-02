package booking

import (
	"context"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// ── Model ────────────────────────────────────────────────────────────────────

// BookingMessage is a single chat message between a customer and the assigned
// helper for a booking.
type BookingMessage struct {
	ID         string    `json:"id"`
	BookingID  string    `json:"booking_id"`
	SenderID   string    `json:"sender_id"`
	SenderRole string    `json:"sender_role"` // "customer" | "pro"
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"created_at"`
}

type sendMessageRequest struct {
	Body string `json:"body"`
}

// ── Repository ───────────────────────────────────────────────────────────────

// CreateMessage inserts a chat message for a booking.
func (r *Repository) CreateMessage(ctx context.Context, m *BookingMessage) error {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	err := r.db.QueryRow(queryCtx,
		`INSERT INTO booking_messages (booking_id, sender_id, sender_role, body)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, created_at`,
		m.BookingID, m.SenderID, m.SenderRole, m.Body,
	).Scan(&m.ID, &m.CreatedAt)
	if err != nil {
		return fmt.Errorf("failed to insert message: %w", err)
	}
	return nil
}

// ListMessages returns chat messages for a booking ordered oldest → newest.
func (r *Repository) ListMessages(ctx context.Context, bookingID string) ([]BookingMessage, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := r.db.Query(queryCtx,
		`SELECT id, booking_id, sender_id, sender_role, body, created_at
		 FROM booking_messages
		 WHERE booking_id = $1
		 ORDER BY created_at ASC`,
		bookingID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list messages: %w", err)
	}
	defer rows.Close()

	out := make([]BookingMessage, 0, 32)
	for rows.Next() {
		var m BookingMessage
		if err := rows.Scan(&m.ID, &m.BookingID, &m.SenderID, &m.SenderRole, &m.Body, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan message: %w", err)
		}
		out = append(out, m)
	}
	return out, nil
}

// ── Service ──────────────────────────────────────────────────────────────────

// authorizeChatParty checks the requesting user is the customer or assigned
// helper for the booking. Returns the role string ("customer" | "pro").
func (s *Service) authorizeChatParty(ctx context.Context, bookingID, userID string) (string, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var customerID string
	var helperID *string
	err := s.db.QueryRow(queryCtx,
		`SELECT customer_id, helper_id FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(&customerID, &helperID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", fmt.Errorf("booking not found")
		}
		return "", fmt.Errorf("failed to load booking: %w", err)
	}

	if customerID == userID {
		return "customer", nil
	}
	if helperID != nil && *helperID == userID {
		return "pro", nil
	}
	return "", fmt.Errorf("forbidden")
}

// SendMessage persists a chat message after authorising the sender.
func (s *Service) SendMessage(ctx context.Context, bookingID, userID, body string) (*BookingMessage, error) {
	role, err := s.authorizeChatParty(ctx, bookingID, userID)
	if err != nil {
		return nil, err
	}
	m := &BookingMessage{
		BookingID:  bookingID,
		SenderID:   userID,
		SenderRole: role,
		Body:       body,
	}
	if err := s.repo.CreateMessage(ctx, m); err != nil {
		return nil, err
	}
	return m, nil
}

// ListMessages returns the chat history after authorising the requester.
func (s *Service) ListMessages(ctx context.Context, bookingID, userID string) ([]BookingMessage, error) {
	if _, err := s.authorizeChatParty(ctx, bookingID, userID); err != nil {
		return nil, err
	}
	return s.repo.ListMessages(ctx, bookingID)
}

// ── Handlers ─────────────────────────────────────────────────────────────────

// ListMessages handles GET /bookings/:id/messages.
func (h *Handler) ListMessages(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	userID, _ := c.Locals("userID").(string)

	msgs, err := h.service.ListMessages(c.Context(), bookingID, userID)
	if err != nil {
		if err.Error() == "forbidden" {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "forbidden"})
		}
		if err.Error() == "booking not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "booking not found"})
		}
		log.Error().Err(err).Str("booking_id", bookingID).Msg("failed to list messages")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to list messages"})
	}
	return c.JSON(fiber.Map{"messages": msgs})
}

// SendMessage handles POST /bookings/:id/messages.
func (h *Handler) SendMessage(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	userID, _ := c.Locals("userID").(string)

	var req sendMessageRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
	}
	body := trimMessage(req.Body)
	if body == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "message body is required"})
	}
	if len(body) > 2000 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "message too long"})
	}

	msg, err := h.service.SendMessage(c.Context(), bookingID, userID, body)
	if err != nil {
		if err.Error() == "forbidden" {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "forbidden"})
		}
		if err.Error() == "booking not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "booking not found"})
		}
		log.Error().Err(err).Str("booking_id", bookingID).Msg("failed to send message")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to send message"})
	}
	return c.Status(fiber.StatusCreated).JSON(msg)
}

func trimMessage(s string) string {
	// Strip leading/trailing whitespace without bringing in strings package
	// dependency (already imported in handler.go via separate file).
	start, end := 0, len(s)
	for start < end && isSpace(s[start]) {
		start++
	}
	for end > start && isSpace(s[end-1]) {
		end--
	}
	return s[start:end]
}

func isSpace(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	}
	return false
}
