// Package zones manages service_zones (existing table) + crm_surge_rules.
// Zones use circle (lat/lon/radius_km) — polygon support is a future
// migration. The CRM exposes them as cards with edit/disable controls.
package zones

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/crm/audit"
	"github.com/adityarohilla/househelp-api/internal/crm/middleware"
	"github.com/adityarohilla/househelp-api/internal/webhooks"
)

var ErrNotFound = errors.New("zone not found")

type Zone struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	City      string    `json:"city"`
	Lat       float64   `json:"lat"`
	Lon       float64   `json:"lon"`
	RadiusKM  float64   `json:"radius_km"`
	IsActive  bool      `json:"is_active"`
	CreatedAt time.Time `json:"created_at"`
}

type ZoneRequest struct {
	Name     string  `json:"name"`
	City     string  `json:"city"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	RadiusKM float64 `json:"radius_km"`
}

type SurgeRule struct {
	ID         string     `json:"id"`
	ZoneID     string     `json:"zone_id"`
	Multiplier float64    `json:"multiplier"`
	StartsAt   *time.Time `json:"starts_at,omitempty"`
	EndsAt     *time.Time `json:"ends_at,omitempty"`
	Reason     *string    `json:"reason,omitempty"`
	IsActive   bool       `json:"is_active"`
	CreatedAt  time.Time  `json:"created_at"`
}

type SurgeRuleRequest struct {
	ZoneID     string     `json:"zone_id"`
	Multiplier float64    `json:"multiplier"`
	StartsAt   *time.Time `json:"starts_at"`
	EndsAt     *time.Time `json:"ends_at"`
	Reason     string     `json:"reason"`
}

type Repository struct{ read, write *pgxpool.Pool }

func NewRepository(read, write *pgxpool.Pool) *Repository { return &Repository{read: read, write: write} }

func (r *Repository) ListZones(ctx context.Context) ([]Zone, error) {
	rows, err := r.read.Query(ctx, `
		SELECT id::text, name, city, lat::float8, lon::float8, radius_km::float8, is_active, created_at
		FROM service_zones ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list zones: %w", err)
	}
	defer rows.Close()
	out := []Zone{}
	for rows.Next() {
		var z Zone
		if err := rows.Scan(&z.ID, &z.Name, &z.City, &z.Lat, &z.Lon, &z.RadiusKM, &z.IsActive, &z.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, z)
	}
	return out, rows.Err()
}

func validateZone(req ZoneRequest) error {
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.City) == "" {
		return fmt.Errorf("name and city required")
	}
	if req.Lat == 0 && req.Lon == 0 {
		return fmt.Errorf("lat / lon required")
	}
	if req.RadiusKM <= 0 || req.RadiusKM > 100 {
		return fmt.Errorf("radius_km must be (0, 100]")
	}
	return nil
}

func (r *Repository) CreateZone(ctx context.Context, req ZoneRequest) (string, error) {
	if err := validateZone(req); err != nil {
		return "", err
	}
	id := ""
	err := r.write.QueryRow(ctx, `
		INSERT INTO service_zones (name, city, lat, lon, radius_km)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id::text
	`, req.Name, req.City, req.Lat, req.Lon, req.RadiusKM).Scan(&id)
	return id, err
}

func (r *Repository) UpdateZone(ctx context.Context, id string, req ZoneRequest) error {
	if err := validateZone(req); err != nil {
		return err
	}
	res, err := r.write.Exec(ctx, `
		UPDATE service_zones SET name=$2, city=$3, lat=$4, lon=$5, radius_km=$6
		WHERE id = $1::uuid
	`, id, req.Name, req.City, req.Lat, req.Lon, req.RadiusKM)
	if err != nil {
		return fmt.Errorf("update zone: %w", err)
	}
	if res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *Repository) SetZoneActive(ctx context.Context, id string, active bool) error {
	res, err := r.write.Exec(ctx, `UPDATE service_zones SET is_active = $2 WHERE id = $1::uuid`, id, active)
	if err != nil || res.RowsAffected() == 0 {
		return fmt.Errorf("set zone active: %w", err)
	}
	return nil
}

func (r *Repository) ListSurge(ctx context.Context) ([]SurgeRule, error) {
	rows, err := r.read.Query(ctx, `
		SELECT id::text, zone_id::text, multiplier::float8, starts_at, ends_at, reason, is_active, created_at
		FROM crm_surge_rules ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("list surge: %w", err)
	}
	defer rows.Close()
	out := []SurgeRule{}
	for rows.Next() {
		var s SurgeRule
		if err := rows.Scan(&s.ID, &s.ZoneID, &s.Multiplier, &s.StartsAt, &s.EndsAt, &s.Reason, &s.IsActive, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r *Repository) CreateSurge(ctx context.Context, req SurgeRuleRequest, createdBy string) (string, error) {
	if req.Multiplier <= 0 || req.Multiplier > 5 {
		return "", fmt.Errorf("multiplier must be (0, 5]")
	}
	id := ""
	err := r.write.QueryRow(ctx, `
		INSERT INTO crm_surge_rules (zone_id, multiplier, starts_at, ends_at, reason, created_by)
		VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), NULLIF($6, '')::uuid)
		RETURNING id::text
	`, req.ZoneID, req.Multiplier, req.StartsAt, req.EndsAt, req.Reason, createdBy).Scan(&id)
	return id, err
}

func (r *Repository) DeleteSurge(ctx context.Context, id string) error {
	res, err := r.write.Exec(ctx, `DELETE FROM crm_surge_rules WHERE id = $1::uuid`, id)
	if err != nil || res.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

type Handler struct {
	repo       *Repository
	recorder   *audit.Recorder
	dispatcher *webhooks.Dispatcher
}

func NewHandler(repo *Repository, recorder *audit.Recorder) *Handler {
	return &Handler{repo: repo, recorder: recorder}
}

// SetDispatcher wires the outbound webhook dispatcher.
func (h *Handler) SetDispatcher(d *webhooks.Dispatcher) { h.dispatcher = d }

func (h *Handler) fireWebhook(ctx context.Context, event string, payload any) {
	if h.dispatcher == nil {
		return
	}
	h.dispatcher.Dispatch(ctx, event, payload)
}

func (h *Handler) RegisterRoutes(r fiber.Router) {
	g := r.Group("/zones")
	g.Get("/",       middleware.RequirePermission("zones.read"), h.ListZones)
	g.Post("/",      middleware.RequirePermission("zones.create"), h.CreateZone)
	g.Put("/:id",    middleware.RequirePermission("zones.update"), h.UpdateZone)
	g.Post("/:id/toggle", middleware.RequirePermission("zones.toggle"), h.ToggleZone)

	g.Get("/surge",       middleware.RequirePermission("surge.read"), h.ListSurge)
	g.Post("/surge",      middleware.RequirePermission("surge.create"), h.CreateSurge)
	g.Delete("/surge/:id", middleware.RequirePermission("surge.delete"), h.DeleteSurge)
}

func (h *Handler) ListZones(c *fiber.Ctx) error {
	out, err := h.repo.ListZones(c.UserContext())
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) CreateZone(c *fiber.Ctx) error {
	var req ZoneRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	id, err := h.repo.CreateZone(c.UserContext(), req)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "zone.create", id, nil, req)
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) UpdateZone(c *fiber.Ctx) error {
	var req ZoneRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	id := c.Params("id")
	if err := h.repo.UpdateZone(c.UserContext(), id, req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "zone.update", id, nil, req)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) ToggleZone(c *fiber.Ctx) error {
	var body struct{ Active bool `json:"active"` }
	_ = c.BodyParser(&body)
	id := c.Params("id")
	if err := h.repo.SetZoneActive(c.UserContext(), id, body.Active); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "zone.toggle", id, nil, body.Active)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) ListSurge(c *fiber.Ctx) error {
	out, err := h.repo.ListSurge(c.UserContext())
	return jsonOrErr(c, fiber.Map{"items": out}, err)
}

func (h *Handler) CreateSurge(c *fiber.Ctx) error {
	var req SurgeRuleRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	id, err := h.repo.CreateSurge(c.UserContext(), req, adminID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "surge.create", id, nil, req)
	h.fireWebhook(c.UserContext(), webhooks.EventAdminSurgeActivated, webhooks.AdminSurgeActivatedEvent{
		SurgeID:    id,
		Zone:       req.ZoneID,
		Multiplier: req.Multiplier,
		AdminID:    adminID,
		OccurredAt: time.Now().UTC(),
	})
	return c.JSON(fiber.Map{"id": id})
}

func (h *Handler) DeleteSurge(c *fiber.Ctx) error {
	id := c.Params("id")
	if err := h.repo.DeleteSurge(c.UserContext(), id); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	h.audit(c, "surge.delete", id, nil, nil)
	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) audit(c *fiber.Ctx, action, target string, before, after any) {
	if h.recorder == nil {
		return
	}
	adminID, _ := c.Locals("crmAdminID").(string)
	adminEmail, _ := c.Locals("crmAdminEmail").(string)
	h.recorder.Log(c.UserContext(), audit.Entry{
		AdminID: adminID, AdminEmail: adminEmail, Action: action, Module: "zones",
		TargetType: "zone", TargetID: target, Before: before, After: after,
		IPAddress: c.IP(), UserAgent: c.Get("User-Agent"), RequestID: c.Get("X-Request-ID"),
	})
}

func jsonOrErr(c *fiber.Ctx, payload any, err error) error {
	if err != nil {
		log.Error().Err(err).Msg("[crm.zones] query failed")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "internal error"})
	}
	return c.JSON(payload)
}
