package bff

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/bff/migrations"
)

// AdminHandler serves /admin/* endpoints for SDUI config lifecycle + ops.
type AdminHandler struct {
	repo        *Repository
	validator   *Validator
	rdb         *redis.Client
	whitelist   *ActionWhitelist
	hydrator    *Hydrator
	resolver    *Resolver
	safeLayouts map[string]json.RawMessage
}

// NewAdminHandler wires the admin handler.
func NewAdminHandler(
	repo *Repository,
	validator *Validator,
	rdb *redis.Client,
	whitelist *ActionWhitelist,
	hydrator *Hydrator,
	resolver *Resolver,
	safeLayouts map[string]json.RawMessage,
) *AdminHandler {
	if safeLayouts == nil {
		safeLayouts = map[string]json.RawMessage{}
	}
	return &AdminHandler{
		repo:        repo,
		validator:   validator,
		rdb:         rdb,
		whitelist:   whitelist,
		hydrator:    hydrator,
		resolver:    resolver,
		safeLayouts: safeLayouts,
	}
}

// RegisterRoutes mounts the admin SDUI routes.
func (a *AdminHandler) RegisterRoutes(g fiber.Router) {
	g.Get("/pages", a.listPages)
	g.Get("/pages/:page_id/configs", a.listConfigs)
	g.Post("/pages/:page_id/configs", a.createDraft)
	g.Get("/pages/:page_id/configs/:version", a.getConfig)
	g.Patch("/pages/:page_id/configs/:version", a.patchDraft)
	g.Delete("/pages/:page_id/configs/:version", a.deleteDraft)
	g.Put("/pages/:page_id/configs/:version/stage", a.stage)
	g.Put("/pages/:page_id/configs/:version/activate", a.activate)
	g.Put("/pages/:page_id/configs/:version/rollback", a.rollback)
	g.Get("/pages/:page_id/configs/:version/preview", a.preview)
	g.Get("/pages/:page_id/audit-log", a.auditLog)

	g.Post("/pages/:page_id/kill-switch", a.killOn)
	g.Delete("/pages/:page_id/kill-switch", a.killOff)
	g.Get("/pages/:page_id/kill-switch", a.killStatus)

	g.Post("/experiments/:exp_id/kill-switch", a.expKillOn)
	g.Delete("/experiments/:exp_id/kill-switch", a.expKillOff)

	g.Get("/allowed-actions", a.listAllowed)
	g.Post("/allowed-actions", a.createAllowed)
	g.Delete("/allowed-actions/:id", a.deleteAllowed)
}

func (a *AdminHandler) actor(c *fiber.Ctx) string {
	uid, _ := c.Locals("userID").(string)
	return uid
}

func envParam(c *fiber.Ctx) string {
	env := c.Query("env", string(EnvProduction))
	if env != string(EnvProduction) && env != string(EnvStaging) {
		env = string(EnvProduction)
	}
	return env
}

// ── /admin/pages ─────────────────────────────────────────────────────────────

func (a *AdminHandler) listPages(c *fiber.Ctx) error {
	pages, err := a.repo.ListPages(c.Context())
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"pages": pages})
}

func (a *AdminHandler) listConfigs(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	env := envParam(c)
	out, err := a.repo.ListConfigs(c.Context(), pageID, env)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"configs": out})
}

type createDraftReq struct {
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	ChangeNotes  string          `json:"change_notes"`
	ExperimentID string          `json:"experiment_id"`
	Version      string          `json:"version"`
	Env          string          `json:"env"`
	ConfigJSON   json.RawMessage `json:"config_json"`
}

func (a *AdminHandler) createDraft(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	var req createDraftReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body: " + err.Error()})
	}
	if req.Version == "" {
		return c.Status(400).JSON(fiber.Map{"error": "version required"})
	}
	if len(req.ConfigJSON) == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "config_json required"})
	}
	env := req.Env
	if env == "" {
		env = string(EnvProduction)
	}
	rec := ConfigRecord{
		PageID:       pageID,
		Version:      req.Version,
		Env:          env,
		ConfigJSON:   req.ConfigJSON,
		Name:         req.Name,
		Description:  req.Description,
		ChangeNotes:  req.ChangeNotes,
		ExperimentID: req.ExperimentID,
		CreatedBy:    a.actor(c),
	}
	out, err := a.repo.CreateDraft(c.Context(), rec)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	_ = a.repo.AppendAuditLog(c.Context(), pageID, &out.ID, "created", a.actor(c), "", out.ConfigJSON)
	return c.Status(201).JSON(out)
}

func (a *AdminHandler) getConfig(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	version := c.Params("version")
	env := envParam(c)
	out, err := a.repo.GetByVersion(c.Context(), pageID, version, env)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(404).JSON(fiber.Map{"error": "not found"})
		}
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	c.Set("ETag", out.ETag)
	return c.JSON(out)
}

type patchReq struct {
	Name         *string         `json:"name,omitempty"`
	Description  *string         `json:"description,omitempty"`
	ChangeNotes  *string         `json:"change_notes,omitempty"`
	ExperimentID *string         `json:"experiment_id,omitempty"`
	ConfigJSON   json.RawMessage `json:"config_json,omitempty"`
}

func (a *AdminHandler) patchDraft(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	version := c.Params("version")
	env := envParam(c)
	ifMatch := c.Get("If-Match")
	var req patchReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body: " + err.Error()})
	}
	patch := ConfigPatch{
		Name:         req.Name,
		Description:  req.Description,
		ChangeNotes:  req.ChangeNotes,
		ExperimentID: req.ExperimentID,
		ConfigJSON:   req.ConfigJSON,
	}
	out, err := a.repo.UpdateDraft(c.Context(), pageID, version, env, ifMatch, patch)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			return c.Status(404).JSON(fiber.Map{"error": "not found"})
		case errors.Is(err, ErrETagMismatch):
			return c.Status(412).JSON(fiber.Map{"error": "etag mismatch"})
		case errors.Is(err, ErrInvalidStatus):
			return c.Status(409).JSON(fiber.Map{"error": "config not in draft state"})
		}
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	c.Set("ETag", out.ETag)
	return c.JSON(out)
}

func (a *AdminHandler) deleteDraft(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	version := c.Params("version")
	env := envParam(c)
	if err := a.repo.DeleteDraft(c.Context(), pageID, version, env); err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			return c.Status(404).JSON(fiber.Map{"error": "not found"})
		case errors.Is(err, ErrInvalidStatus):
			return c.Status(409).JSON(fiber.Map{"error": "config not in draft state"})
		}
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	_ = a.repo.AppendAuditLog(c.Context(), pageID, nil, "deleted", a.actor(c), "draft "+version, nil)
	return c.SendStatus(204)
}

func (a *AdminHandler) stage(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	version := c.Params("version")
	env := envParam(c)
	rec, err := a.repo.GetByVersion(c.Context(), pageID, version, env)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(404).JSON(fiber.Map{"error": "not found"})
		}
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	res, vErr := a.validator.Validate(c.Context(), rec.ConfigJSON)
	if vErr != nil {
		return c.Status(500).JSON(fiber.Map{"error": "validate: " + vErr.Error()})
	}
	if !res.OK() {
		return c.Status(400).JSON(fiber.Map{
			"error":    "validation failed",
			"errors":   res.Errors,
			"warnings": res.Warnings,
		})
	}
	out, err := a.repo.Stage(c.Context(), pageID, version, env, a.actor(c))
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			return c.Status(404).JSON(fiber.Map{"error": "not found"})
		case errors.Is(err, ErrInvalidStatus):
			return c.Status(409).JSON(fiber.Map{"error": "config not in draft state"})
		}
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	c.Set("ETag", out.ETag)
	return c.JSON(fiber.Map{
		"config":   out,
		"warnings": res.Warnings,
	})
}

func (a *AdminHandler) activate(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	version := c.Params("version")
	env := envParam(c)
	ifMatch := c.Get("If-Match")
	out, err := a.repo.Activate(c.Context(), pageID, version, env, a.actor(c), ifMatch)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			return c.Status(404).JSON(fiber.Map{"error": "not found"})
		case errors.Is(err, ErrETagMismatch):
			return c.Status(412).JSON(fiber.Map{"error": "etag mismatch"})
		case errors.Is(err, ErrInvalidStatus):
			return c.Status(409).JSON(fiber.Map{"error": "config not in staged state"})
		}
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	// Cache invalidation post-commit.
	if a.rdb != nil {
		ctx := c.Context()
		_ = a.rdb.Del(ctx, "sdui:page:"+pageID+":last_good").Err()
		_ = a.rdb.Del(ctx, "sdui:page:"+pageID+":etag").Err()
	}
	c.Set("ETag", out.ETag)
	return c.JSON(out)
}

func (a *AdminHandler) rollback(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	env := envParam(c)
	out, err := a.repo.Rollback(c.Context(), pageID, env, a.actor(c))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(404).JSON(fiber.Map{"error": "no archived config to roll back to"})
		}
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	if a.rdb != nil {
		ctx := c.Context()
		_ = a.rdb.Del(ctx, "sdui:page:"+pageID+":last_good").Err()
		_ = a.rdb.Del(ctx, "sdui:page:"+pageID+":etag").Err()
	}
	c.Set("ETag", out.ETag)
	return c.JSON(out)
}

func (a *AdminHandler) preview(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	version := c.Params("version")
	env := envParam(c)

	role, _ := c.Locals("role").(string)
	requestedUser := c.Query("user_id", "")
	actor := a.actor(c)
	if role != "admin" || requestedUser == "" {
		// Force preview as self if non-super-admin or unspecified.
		requestedUser = actor
	}

	rec, err := a.repo.Preview(c.Context(), pageID, version, env)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(404).JSON(fiber.Map{"error": "not found"})
		}
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}

	rc := RequestContext{
		UserID:     requestedUser,
		Lat:        c.QueryFloat("lat", 0),
		Lon:        c.QueryFloat("lon", 0),
		Locale:     c.Get("Accept-Language"),
		AppVersion: c.Get("X-Client-Version"),
		Env:        Env(env),
	}

	migrated, _, _ := migrations.Migrate(rec.ConfigJSON, rec.SchemaVersion, rec.SchemaVersion)

	var cfg PageConfig
	if err := json.Unmarshal(migrated, &cfg); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "parse: " + err.Error()})
	}
	refKeys := extractRefKeys(cfg.Sections)
	hydrated, missing, hErr := a.hydrator.Hydrate(c.Context(), rc, refKeys)
	if hErr != nil {
		log.Warn().Err(hErr).Msg("[sdui] preview hydrate partial")
	}
	page, rErr := a.resolver.Resolve(c.Context(), rc, &cfg, hydrated, missing)
	if rErr != nil {
		return c.Status(500).JSON(fiber.Map{"error": "resolve: " + rErr.Error()})
	}
	page.ConfigVersion = rec.Version

	_ = a.repo.AppendAuditLog(
		c.Context(), pageID, &rec.ID, "previewed", actor,
		"preview as user="+requestedUser, rec.ConfigJSON,
	)

	return c.JSON(page)
}

func (a *AdminHandler) auditLog(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	limit := c.QueryInt("limit", 100)
	out, err := a.repo.ListAuditLog(c.Context(), pageID, limit)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"entries": out})
}

// ── kill switches ────────────────────────────────────────────────────────────

func (a *AdminHandler) killOn(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	if a.rdb == nil {
		return c.Status(500).JSON(fiber.Map{"error": "redis unavailable"})
	}
	if err := a.rdb.Set(c.Context(), "sdui:kill:"+pageID, "1", 24*time.Hour).Err(); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	_ = a.repo.AppendAuditLog(c.Context(), pageID, nil, "kill_switch", a.actor(c), "enabled", nil)
	return c.JSON(fiber.Map{"page_id": pageID, "kill_switch": true})
}

func (a *AdminHandler) killOff(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	if a.rdb == nil {
		return c.Status(500).JSON(fiber.Map{"error": "redis unavailable"})
	}
	if err := a.rdb.Del(c.Context(), "sdui:kill:"+pageID).Err(); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	_ = a.repo.AppendAuditLog(c.Context(), pageID, nil, "kill_switch", a.actor(c), "disabled", nil)
	return c.JSON(fiber.Map{"page_id": pageID, "kill_switch": false})
}

func (a *AdminHandler) killStatus(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	if a.rdb == nil {
		return c.JSON(fiber.Map{"page_id": pageID, "kill_switch": false})
	}
	exists, _ := a.rdb.Exists(c.Context(), "sdui:kill:"+pageID).Result()
	return c.JSON(fiber.Map{"page_id": pageID, "kill_switch": exists > 0})
}

func (a *AdminHandler) expKillOn(c *fiber.Ctx) error {
	expID := c.Params("exp_id")
	if a.rdb == nil {
		return c.Status(500).JSON(fiber.Map{"error": "redis unavailable"})
	}
	if err := a.rdb.Set(c.Context(), "sdui:kill:exp:"+expID, "1", 24*time.Hour).Err(); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	_ = a.repo.AppendAuditLog(c.Context(), "_experiment", nil, "kill_switch", a.actor(c), "exp:"+expID+" enabled", nil)
	return c.JSON(fiber.Map{"experiment_id": expID, "kill_switch": true})
}

func (a *AdminHandler) expKillOff(c *fiber.Ctx) error {
	expID := c.Params("exp_id")
	if a.rdb == nil {
		return c.Status(500).JSON(fiber.Map{"error": "redis unavailable"})
	}
	if err := a.rdb.Del(c.Context(), "sdui:kill:exp:"+expID).Err(); err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	_ = a.repo.AppendAuditLog(c.Context(), "_experiment", nil, "kill_switch", a.actor(c), "exp:"+expID+" disabled", nil)
	return c.JSON(fiber.Map{"experiment_id": expID, "kill_switch": false})
}

// ── allowed-actions CRUD ─────────────────────────────────────────────────────

func (a *AdminHandler) listAllowed(c *fiber.Ctx) error {
	out, err := a.repo.ListAllowedActions(c.Context())
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"actions": out})
}

type allowedReq struct {
	Endpoint string   `json:"endpoint"`
	Methods  []string `json:"methods"`
}

func (a *AdminHandler) createAllowed(c *fiber.Ctx) error {
	var req allowedReq
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body: " + err.Error()})
	}
	if req.Endpoint == "" || len(req.Methods) == 0 {
		return c.Status(400).JSON(fiber.Map{"error": "endpoint and methods required"})
	}
	for i, m := range req.Methods {
		req.Methods[i] = strings.ToUpper(m)
	}
	out, err := a.repo.InsertAllowedAction(c.Context(), req.Endpoint, req.Methods, a.actor(c))
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	a.whitelist.Invalidate(c.Context())
	return c.Status(201).JSON(out)
}

func (a *AdminHandler) deleteAllowed(c *fiber.Ctx) error {
	idStr := c.Params("id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid id"})
	}
	if err := a.repo.DeleteAllowedAction(c.Context(), id); err != nil {
		if errors.Is(err, ErrNotFound) {
			return c.Status(404).JSON(fiber.Map{"error": "not found"})
		}
		return c.Status(500).JSON(fiber.Map{"error": err.Error()})
	}
	a.whitelist.Invalidate(c.Context())
	return c.SendStatus(204)
}
