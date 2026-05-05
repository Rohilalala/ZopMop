package booking

import (
	"context"
	"fmt"
	"strconv"
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

// ListMessages returns the most recent `limit` chat messages for a booking,
// ordered oldest → newest in the returned slice. We page from the tail so a
// client can render the latest screen without dragging back a multi-thousand
// message history. Older messages can be fetched by supplying `before`
// (the oldest created_at the client has already received).
func (r *Repository) ListMessages(ctx context.Context, bookingID string, limit int, before time.Time) ([]BookingMessage, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if limit <= 0 || limit > 200 {
		limit = 50
	}

	// Tail-window query: pull the newest `limit` messages older than `before`,
	// then reverse on the client side via the closing slice flip below so
	// callers still see them oldest→newest.
	args := []any{bookingID, limit}
	q := `SELECT id, booking_id, sender_id, sender_role, body, created_at
	      FROM booking_messages
	      WHERE booking_id = $1`
	if !before.IsZero() {
		q += ` AND created_at < $3`
		args = append(args, before)
	}
	q += ` ORDER BY created_at DESC LIMIT $2`

	rows, err := r.db.Query(queryCtx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list messages: %w", err)
	}
	defer rows.Close()

	tmp := make([]BookingMessage, 0, limit)
	for rows.Next() {
		var m BookingMessage
		if err := rows.Scan(&m.ID, &m.BookingID, &m.SenderID, &m.SenderRole, &m.Body, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan message: %w", err)
		}
		tmp = append(tmp, m)
	}
	// Reverse to oldest→newest for the caller (we queried DESC for the LIMIT).
	out := make([]BookingMessage, len(tmp))
	for i := range tmp {
		out[len(tmp)-1-i] = tmp[i]
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
// Pagination params bubble straight through to the repo.
func (s *Service) ListMessages(ctx context.Context, bookingID, userID string, limit int, before time.Time) ([]BookingMessage, error) {
	if _, err := s.authorizeChatParty(ctx, bookingID, userID); err != nil {
		return nil, err
	}
	return s.repo.ListMessages(ctx, bookingID, limit, before)
}

// ── Handlers ─────────────────────────────────────────────────────────────────

// ListMessages handles GET /bookings/:id/messages.
// Optional ?limit=N (default 50, max 200) and ?before=RFC3339 timestamp for
// pagination. With no params the client gets the last 50 messages.
func (h *Handler) ListMessages(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if !validateBookingIDParam(bookingID) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid booking id"})
	}
	userID, _ := c.Locals("userID").(string)

	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	var before time.Time
	if v := c.Query("before"); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			before = t
		}
	}

	msgs, err := h.service.ListMessages(c.UserContext(), bookingID, userID, limit, before)
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

	msg, err := h.service.SendMessage(c.UserContext(), bookingID, userID, body)
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
