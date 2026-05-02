// Package growth bundles five small modules: push composer, in-app inbox,
// lost-user campaign rules, loyalty config + balances, and waitlists. They
// share enough infrastructure that splitting into five packages would be
// more ceremony than value.
//
// Push send is NOT wired to FCM here — the CRM persists messages to
// crm_push_messages with status='scheduled'/'sent'; a separate worker (or
// the existing notification.Service) is expected to drain that table and
// fire the actual pushes. Pivoting to direct FCM dispatch is a one-line
// change: replace the dispatchStub call.
package growth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
)

// ── Push ───────────────────────────────────────────────────────────────

type PushMsg struct {
	ID             string     `json:"id"`
	Title          string     `json:"title"`
	Body           string     `json:"body"`
	ImageURL       *string    `json:"image_url,omitempty"`
	DeepLink       *string    `json:"deep_link,omitempty"`
	TargetKind     string     `json:"target_kind"`
	EstimatedReach int        `json:"estimated_reach"`
	ScheduledAt    *time.Time `json:"scheduled_at,omitempty"`
	SentAt         *time.Time `json:"sent_at,omitempty"`
	Status         string     `json:"status"`
	CreatedAt      time.Time  `json:"created_at"`
}

type PushCreateRequest struct {
	Title       string     `json:"title"`
	Body        string     `json:"body"`
	ImageURL    string     `json:"image_url"`
	DeepLink    string     `json:"deep_link"`
	TargetKind  string     `json:"target_kind"` // users / pros / both / specific
	UserIDs     []string   `json:"user_ids"`    // when target_kind='specific'
	ScheduledAt *time.Time `json:"scheduled_at"`
}

// ── Lost-user campaigns ────────────────────────────────────────────────

type LostUserCampaign struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	InactiveDays    int       `json:"inactive_days"`
	TriggerKind     string    `json:"trigger_kind"`
	PromoCode       *string   `json:"promo_code,omitempty"`
	PushTitle       *string   `json:"push_title,omitempty"`
	PushBody        *string   `json:"push_body,omitempty"`
	IsActive        bool      `json:"is_active"`
	TriggeredCount  int       `json:"triggered_count"`
	ConversionCount int       `json:"conversion_count"`
	CreatedAt       time.Time `json:"created_at"`
}

// ── Loyalty ────────────────────────────────────────────────────────────

type LoyaltyConfig struct {
	IsEnabled            bool            `json:"is_enabled"`
	PointsPer100INR      int             `json:"points_per_100_inr"`
	PointsPerRedeemINR   int             `json:"points_per_redeem_inr"`
	BonusRules           json.RawMessage `json:"bonus_rules"`
	UpdatedAt            time.Time       `json:"updated_at"`
}

// ── Waitlist ───────────────────────────────────────────────────────────

type Waitlist struct {
	ID          string    `json:"id"`
	City        string    `json:"city"`
	Category    *string   `json:"category,omitempty"`
	Description *string   `json:"description,omitempty"`
	IsActive    bool      `json:"is_active"`
	EntryCount  int       `json:"entry_count"`
	CreatedAt   time.Time `json:"created_at"`
}

// ── Service ────────────────────────────────────────────────────────────

type Service struct {
	read, write *pgxpool.Pool
}

func NewService(read, write *pgxpool.Pool) *Service {
	return &Service{read: read, write: write}
}

// ── Push: list / create / cancel ───────────────────────────────────────

func (s *Service) ListPush(ctx context.Context, limit int) ([]PushMsg, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.read.Query(ctx, `
		SELECT id::text, title, body, image_url, deep_link, target_kind,
		       estimated_reach, scheduled_at, sent_at, status, created_at
		FROM crm_push_messages ORDER BY created_at DESC LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("list push: %w", err)
	}
	defer rows.Close()
	out := []PushMsg{}
	for rows.Next() {
		var m PushMsg
		if err := rows.Scan(&m.ID, &m.Title, &m.Body, &m.ImageURL, &m.DeepLink, &m.TargetKind,
			&m.EstimatedReach, &m.ScheduledAt, &m.SentAt, &m.Status, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// estimateReach approximates how many users a target_kind would address.
// Cheap COUNT() — fine because the read pool is dedicated.
func (s *Service) estimateReach(ctx context.Context, kind string, userIDs []string) (int, error) {
	switch kind {
	case "users":
		var n int
		err := s.read.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE role='customer' AND deleted_at IS NULL`).Scan(&n)
		return n, err
	case "pros":
		var n int
		err := s.read.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE role='pro' AND deleted_at IS NULL`).Scan(&n)
		return n, err
	case "both":
		var n int
		err := s.read.QueryRow(ctx, `SELECT COUNT(*) FROM users WHERE role IN ('customer','pro') AND deleted_at IS NULL`).Scan(&n)
		return n, err
	case "specific":
		return len(userIDs), nil
	}
	return 0, nil
}

func (s *Service) CreatePush(ctx context.Context, req PushCreateRequest, createdBy string) (*PushMsg, error) {
	if req.Title == "" || req.Body == "" || req.TargetKind == "" {
		return nil, errors.New("title, body, target_kind required")
	}
	if req.ScheduledAt != nil && req.ScheduledAt.Before(time.Now().Add(-time.Minute)) {
		return nil, errors.New("scheduled_at must not be in the past")
	}
	reach, err := s.estimateReach(ctx, req.TargetKind, req.UserIDs)
	if err != nil {
		return nil, fmt.Errorf("estimate reach: %w", err)
	}
	status := "draft"
	if req.ScheduledAt != nil {
		status = "scheduled"
	}
	filter, _ := json.Marshal(map[string]any{"user_ids": req.UserIDs})
	id := ""
	err = s.write.QueryRow(ctx, `
		INSERT INTO crm_push_messages (
		  title, body, image_url, deep_link, target_kind, target_filter,
		  estimated_reach, scheduled_at, status, created_by
		)
		VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6::jsonb,
		        $7, $8, $9, NULLIF($10, '')::uuid)
		RETURNING id::text
	`, req.Title, req.Body, req.ImageURL, req.DeepLink, req.TargetKind, filter,
		reach, req.ScheduledAt, status, createdBy).Scan(&id)
	if err != nil {
		return nil, fmt.Errorf("create push: %w", err)
	}
	return s.GetPush(ctx, id)
}

func (s *Service) GetPush(ctx context.Context, id string) (*PushMsg, error) {
	var m PushMsg
	err := s.read.QueryRow(ctx, `
		SELECT id::text, title, body, image_url, deep_link, target_kind,
		       estimated_reach, scheduled_at, sent_at, status, created_at
		FROM crm_push_messages WHERE id = $1::uuid
	`, id).Scan(&m.ID, &m.Title, &m.Body, &m.ImageURL, &m.DeepLink, &m.TargetKind,
		&m.EstimatedReach, &m.ScheduledAt, &m.SentAt, &m.Status, &m.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errors.New("not found")
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// SendPush dispatches a push immediately. Stub: marks the row sent without
// actually invoking FCM. Replace dispatchStub with notification.Service.Send
// when wiring in.
func (s *Service) SendPush(ctx context.Context, id string) error {
	if err := s.dispatchStub(ctx, id); err != nil {
		return err
	}
	res, err := s.write.Exec(ctx, `
		UPDATE crm_push_messages SET status='sent', sent_at=now()
		WHERE id = $1::uuid AND status IN ('draft','scheduled')
	`, id)
	if err != nil {
		return fmt.Errorf("mark sent: %w", err)
	}
	if res.RowsAffected() == 0 {
		return errors.New("push already sent or not found")
	}
	return nil
}

func (s *Service) dispatchStub(ctx context.Context, id string) error {
	log.Info().Str("push_id", id).Msg("[crm.push] STUB dispatch — no FCM wired")
	_ = ctx
	return nil
}

// ── Lost-user campaigns ────────────────────────────────────────────────

func (s *Service) ListLostUser(ctx context.Context) ([]LostUserCampaign, error) {
	rows, err := s.read.Query(ctx, `
		SELECT id::text, name, inactive_days, trigger_kind, promo_code, push_title, push_body,
		       is_active, triggered_count, conversion_count, created_at
		FROM crm_lost_user_campaigns ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list lost-user: %w", err)
	}
	defer rows.Close()
	out := []LostUserCampaign{}
	for rows.Next() {
		var c LostUserCampaign
		if err := rows.Scan(&c.ID, &c.Name, &c.InactiveDays, &c.TriggerKind, &c.PromoCode,
			&c.PushTitle, &c.PushBody, &c.IsActive, &c.TriggeredCount, &c.ConversionCount, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

type LostUserRequest struct {
	Name         string `json:"name"`
	InactiveDays int    `json:"inactive_days"`
	TriggerKind  string `json:"trigger_kind"`
	PromoCode    string `json:"promo_code"`
	PushTitle    string `json:"push_title"`
	PushBody     string `json:"push_body"`
	IsActive     bool   `json:"is_active"`
}

func (s *Service) CreateLostUser(ctx context.Context, req LostUserRequest, createdBy string) (string, error) {
	if req.Name == "" || req.InactiveDays <= 0 {
		return "", errors.New("name and inactive_days required")
	}
	id := ""
	err := s.write.QueryRow(ctx, `
		INSERT INTO crm_lost_user_campaigns (name, inactive_days, trigger_kind, promo_code,
		  push_title, push_body, is_active, created_by)
		VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, NULLIF($8, '')::uuid)
		RETURNING id::text
	`, req.Name, req.InactiveDays, req.TriggerKind, req.PromoCode, req.PushTitle, req.PushBody,
		req.IsActive, createdBy).Scan(&id)
	return id, err
}

func (s *Service) ToggleLostUser(ctx context.Context, id string, active bool) error {
	res, err := s.write.Exec(ctx, `UPDATE crm_lost_user_campaigns SET is_active = $2 WHERE id = $1::uuid`, id, active)
	if err != nil || res.RowsAffected() == 0 {
		return fmt.Errorf("toggle lost-user: %w", err)
	}
	return nil
}

// ── Loyalty ────────────────────────────────────────────────────────────

func (s *Service) GetLoyalty(ctx context.Context) (*LoyaltyConfig, error) {
	var c LoyaltyConfig
	err := s.read.QueryRow(ctx, `
		SELECT is_enabled, points_per_100_inr, points_per_redeem_inr, bonus_rules, updated_at
		FROM crm_loyalty_config ORDER BY updated_at DESC LIMIT 1
	`).Scan(&c.IsEnabled, &c.PointsPer100INR, &c.PointsPerRedeemINR, &c.BonusRules, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Return a zero-value default; the SPA renders an "enable" flow.
		return &LoyaltyConfig{
			IsEnabled: false, PointsPer100INR: 1, PointsPerRedeemINR: 100,
			BonusRules: json.RawMessage(`[]`), UpdatedAt: time.Now(),
		}, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *Service) SetLoyalty(ctx context.Context, c LoyaltyConfig, updatedBy string) error {
	if c.PointsPerRedeemINR <= 0 {
		return errors.New("points_per_redeem_inr must be > 0")
	}
	if c.PointsPer100INR <= 0 {
		return errors.New("points_per_100_inr must be > 0")
	}
	if len(c.BonusRules) == 0 {
		c.BonusRules = json.RawMessage(`[]`)
	}
	_, err := s.write.Exec(ctx, `
		INSERT INTO crm_loyalty_config (is_enabled, points_per_100_inr, points_per_redeem_inr, bonus_rules, updated_by)
		VALUES ($1, $2, $3, $4::jsonb, NULLIF($5, '')::uuid)
	`, c.IsEnabled, c.PointsPer100INR, c.PointsPerRedeemINR, c.BonusRules, updatedBy)
	return err
}

// ── Waitlist ───────────────────────────────────────────────────────────

func (s *Service) ListWaitlists(ctx context.Context) ([]Waitlist, error) {
	rows, err := s.read.Query(ctx, `
		SELECT w.id::text, w.city, w.category, w.description, w.is_active, w.created_at,
		       (SELECT COUNT(*) FROM crm_waitlist_entries WHERE waitlist_id = w.id)
		FROM crm_waitlists w
		ORDER BY w.created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list waitlists: %w", err)
	}
	defer rows.Close()
	out := []Waitlist{}
	for rows.Next() {
		var w Waitlist
		if err := rows.Scan(&w.ID, &w.City, &w.Category, &w.Description, &w.IsActive, &w.CreatedAt, &w.EntryCount); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

type WaitlistRequest struct {
	City        string `json:"city"`
	Category    string `json:"category"`
	Description string `json:"description"`
}

func (s *Service) CreateWaitlist(ctx context.Context, req WaitlistRequest) (string, error) {
	if req.City == "" {
		return "", errors.New("city required")
	}
	id := ""
	err := s.write.QueryRow(ctx, `
		INSERT INTO crm_waitlists (city, category, description)
		VALUES ($1, NULLIF($2, ''), NULLIF($3, ''))
		RETURNING id::text
	`, req.City, req.Category, req.Description).Scan(&id)
	return id, err
}

// ── Handler ────────────────────────────────────────────────────────────

type Handler struct {
	svc      *Service
	recorder *audit.Recorder
}

func NewHandler(svc *Service, recorder *audit.Recorder) *Handler {
	return &Handler{svc: svc, recorder: recorder}
}

func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/growth")
	g.Get("/push",                h.ListPush)
	g.Post("/push",               h.CreatePush)
	g.Post("/push/:id/send",      h.SendPush)
	g.Get("/lost-user",           h.ListLostUser)
	g.Post("/lost-user",          h.CreateLostUser)
	g.Post("/lost-user/:id/toggle", h.ToggleLostUser)
	g.Get("/loyalty",             h.GetLoyalty)
	g.Put("/loyalty",             h.SetLoyalty)
	g.Get("/waitlist",            h.ListWaitlists)
	g.Post("/waitlist",           h.CreateWaitlist)
}

func (h *Handler) ListPush(c *fiber.Ctx) error {
	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	out, err := h.svc.ListPush(c.Context(), limit)
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) CreatePush(c *fiber.Ctx) error {
	var req PushCreateRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	out, err := h.svc.CreatePush(c.Context(), req, adminID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "growth.push.create", out.ID, nil, req)
	return c.JSON(out)
}

func (h *Handler) SendPush(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.svc.SendPush(c.Context(), id); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "growth.push.send", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) ListLostUser(c *fiber.Ctx) error {
	out, err := h.svc.ListLostUser(c.Context())
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) CreateLostUser(c *fiber.Ctx) error {
	var req LostUserRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	id, err := h.svc.CreateLostUser(c.Context(), req, adminID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "growth.lost_user.create", id, nil, req)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) ToggleLostUser(c *fiber.Ctx) error {
	var body struct{ Active bool `json:"active"` }
	_ = c.BodyParser(&body)
	id := c.Params("id")
	if err := h.svc.ToggleLostUser(c.Context(), id, body.Active); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "growth.lost_user.toggle", id, nil, body.Active)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) GetLoyalty(c *fiber.Ctx) error {
	out, err := h.svc.GetLoyalty(c.Context())
	return jsonOrErr(c, out, err)
}

func (h *Handler) SetLoyalty(c *fiber.Ctx) error {
	var req LoyaltyConfig
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	if err := h.svc.SetLoyalty(c.Context(), req, adminID); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "growth.loyalty.set", "", nil, req)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) ListWaitlists(c *fiber.Ctx) error {
	out, err := h.svc.ListWaitlists(c.Context())
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) CreateWaitlist(c *fiber.Ctx) error {
	var req WaitlistRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	id, err := h.svc.CreateWaitlist(c.Context(), req)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "growth.waitlist.create", id, nil, req)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.Context(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "growth",
		TargetType: "growth", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}

func jsonOrErr(c *fiber.Ctx, payload any, err error) error {
	if err != nil {
		log.Error().Err(err).Msg("[crm.growth] query failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(payload)
}
