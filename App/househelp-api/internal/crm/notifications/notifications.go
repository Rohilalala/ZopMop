// Package notifications is the per-admin CRM notification centre. Module
// callers push entries via Recorder.Push; the SPA polls the bell-icon feed
// and marks entries read individually.
//
// This is intentionally separate from `crm/alerts` — alerts are the legacy
// dashboard system feed, notifications are addressable, urgent-flaggable and
// linked to a specific record (entity_type + entity_id).
package notifications

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
)

// Severity classifies a notification. `urgent` rows render red and are
// excluded from any UI auto-dismiss.
type Severity string

const (
	SeverityInfo    Severity = "info"
	SeverityWarning Severity = "warning"
	SeverityUrgent  Severity = "urgent"
)

func (s Severity) valid() bool {
	return s == SeverityInfo || s == SeverityWarning || s == SeverityUrgent
}

// Notification is a single feed row.
type Notification struct {
	ID         int64      `json:"id"`
	Title      string     `json:"title"`
	Body       string     `json:"body"`
	Severity   Severity   `json:"severity"`
	EntityType *string    `json:"entity_type,omitempty"`
	EntityID   *string    `json:"entity_id,omitempty"`
	ReadAt     *time.Time `json:"read_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

// Recorder writes notifications. Failures are logged, never propagated —
// notification writes must not break the operation that emitted them.
type Recorder struct {
	db *pgxpool.Pool
}

// NewRecorder constructs a Recorder.
func NewRecorder(db *pgxpool.Pool) *Recorder { return &Recorder{db: db} }

// Push inserts one notification. entityType/entityID may be empty.
func (r *Recorder) Push(ctx context.Context, sev Severity, title, body, entityType, entityID string) {
	if r == nil || r.db == nil {
		return
	}
	if !sev.valid() {
		sev = SeverityInfo
	}
	var (
		etArg any = nil
		eiArg any = nil
	)
	if entityType != "" {
		etArg = entityType
	}
	if entityID != "" {
		eiArg = entityID
	}
	if _, err := r.db.Exec(ctx, `
		INSERT INTO crm_notifications (title, body, severity, entity_type, entity_id)
		VALUES ($1, $2, $3, $4, $5)
	`, title, body, string(sev), etArg, eiArg); err != nil {
		log.Error().Err(err).Int("title_len", len(title)).Msg("[crm.notifications] push failed")
	}
}

// Service handles reads + mark-read writes.
type Service struct {
	db *pgxpool.Pool
}

// NewService constructs the Service.
func NewService(db *pgxpool.Pool) *Service { return &Service{db: db} }

// List returns the most recent notifications for the calling admin. limit
// clamped to [1, 200]. onlyUnread filters to rows the admin has NOT read.
// Read-state is per-admin (read_by JSONB array), so one admin marking read
// never clears another admin's feed. The returned ReadAt reflects whether
// THIS admin has read the row (NOW() sentinel when read, nil when unread).
func (s *Service) List(ctx context.Context, adminID string, limit int, onlyUnread bool) ([]Notification, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `
		SELECT id, title, body, severity, entity_type, entity_id,
		       (read_by ? $1) AS is_read, created_at
		FROM crm_notifications
	`
	if onlyUnread {
		q += ` WHERE NOT (read_by ? $1) `
	}
	q += ` ORDER BY created_at DESC LIMIT $2 `

	rows, err := s.db.Query(ctx, q, adminID, limit)
	if err != nil {
		return nil, fmt.Errorf("list notifications: %w", err)
	}
	defer rows.Close()

	out := []Notification{}
	for rows.Next() {
		var (
			n      Notification
			isRead bool
		)
		if err := rows.Scan(&n.ID, &n.Title, &n.Body, &n.Severity, &n.EntityType, &n.EntityID, &isRead, &n.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan notification: %w", err)
		}
		if isRead {
			n.ReadAt = &n.CreatedAt // non-nil signals "read" to the UI; exact ts not tracked per-admin
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// UnreadCount returns the number of notifications the calling admin has not read.
func (s *Service) UnreadCount(ctx context.Context, adminID string) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT COUNT(*) FROM crm_notifications WHERE NOT (read_by ? $1)`, adminID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("unread count: %w", err)
	}
	return n, nil
}

// MarkRead appends adminID to one notification's read_by array. Idempotent.
func (s *Service) MarkRead(ctx context.Context, adminID string, id int64) error {
	res, err := s.db.Exec(ctx, `
		UPDATE crm_notifications
		SET read_by = CASE WHEN read_by ? $2 THEN read_by ELSE read_by || to_jsonb($2::text) END
		WHERE id = $1
	`, id, adminID)
	if err != nil {
		return fmt.Errorf("mark read: %w", err)
	}
	if res.RowsAffected() == 0 {
		return errors.New("notification not found")
	}
	return nil
}

// MarkAllRead appends adminID to every notification's read_by array,
// scoping the bulk mark to the calling admin only.
func (s *Service) MarkAllRead(ctx context.Context, adminID string) error {
	_, err := s.db.Exec(ctx, `
		UPDATE crm_notifications
		SET read_by = read_by || to_jsonb($1::text)
		WHERE NOT (read_by ? $1)
	`, adminID)
	if err != nil {
		return fmt.Errorf("mark all read: %w", err)
	}
	return nil
}

// Handler is the HTTP layer.
type Handler struct {
	svc *Service
}

// NewHandler constructs a Handler.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// RegisterRoutes mounts /notifications/* under the authed admin group.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	read := middleware.RequirePermission("notifications.read")
	r.Get("/notifications", read, h.List)
	r.Get("/notifications/unread-count", read, h.UnreadCount)
	r.Post("/notifications/:id/read", h.MarkRead)
	r.Post("/notifications/read-all", h.MarkAllRead)
}

// List handles GET /notifications?limit=&unread=true.
func (h *Handler) List(c *fiber.Ctx) error {
	adminID, _ := c.Locals("crmAdminID").(string)
	if adminID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthenticated"})
	}
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	onlyUnread := strings.EqualFold(c.Query("unread"), "true")
	out, err := h.svc.List(c.UserContext(), adminID, limit, onlyUnread)
	if err != nil {
		log.Error().Err(err).Msg("[crm.notifications] list failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"items": out})
}

// UnreadCount handles GET /notifications/unread-count.
func (h *Handler) UnreadCount(c *fiber.Ctx) error {
	adminID, _ := c.Locals("crmAdminID").(string)
	if adminID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthenticated"})
	}
	n, err := h.svc.UnreadCount(c.UserContext(), adminID)
	if err != nil {
		log.Error().Err(err).Msg("[crm.notifications] unread-count failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"unread": n})
}

// MarkRead handles POST /notifications/:id/read.
func (h *Handler) MarkRead(c *fiber.Ctx) error {
	adminID, _ := c.Locals("crmAdminID").(string)
	if adminID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthenticated"})
	}
	id, err := strconv.ParseInt(c.Params("id"), 10, 64)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := h.svc.MarkRead(c.UserContext(), adminID, id); err != nil {
		if err.Error() == "notification not found" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "notification not found"})
		}
		log.Error().Err(err).Int64("id", id).Msg("[crm.notifications] mark read failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"ok": true})
}

// MarkAllRead handles POST /notifications/read-all.
func (h *Handler) MarkAllRead(c *fiber.Ctx) error {
	adminID, _ := c.Locals("crmAdminID").(string)
	if adminID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthenticated"})
	}
	if err := h.svc.MarkAllRead(c.UserContext(), adminID); err != nil {
		log.Error().Err(err).Msg("[crm.notifications] mark-all-read failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(fiber.Map{"ok": true})
}
