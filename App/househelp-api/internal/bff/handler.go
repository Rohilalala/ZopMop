package bff

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/bff/migrations"
)

// LazyFetcher is the closure injected by main.go to satisfy
// GET /page/:page_id/section/:section_id requests. Returns the section data,
// next-cursor, has_more flag, and an optional error.
type LazyFetcher func(
	ctx context.Context,
	pageID, sectionID, cursor string,
	limit int,
	rc RequestContext,
) (data any, nextCursor string, hasMore bool, err error)

// Handler serves the public SDUI client endpoints.
type Handler struct {
	repo        *Repository
	validator   *Validator
	hydrator    *Hydrator
	resolver    *Resolver
	rdb         *redis.Client
	safeLayouts map[string]json.RawMessage
	LazyFetcher LazyFetcher
}

// NewHandler wires the public-facing handler. safeLayouts is keyed by page_id
// (filename without .json) and holds the go:embed fallback config bytes.
func NewHandler(
	repo *Repository,
	validator *Validator,
	hydrator *Hydrator,
	resolver *Resolver,
	rdb *redis.Client,
	safeLayouts map[string]json.RawMessage,
) *Handler {
	if safeLayouts == nil {
		safeLayouts = map[string]json.RawMessage{}
	}
	return &Handler{
		repo:        repo,
		validator:   validator,
		hydrator:    hydrator,
		resolver:    resolver,
		rdb:         rdb,
		safeLayouts: safeLayouts,
	}
}

// RegisterRoutes mounts the SDUI client routes on the provided router.
func (h *Handler) RegisterRoutes(r fiber.Router) {
	r.Get("/page/:page_id", h.GetPage)
	r.Get("/page/:page_id/section/:section_id", h.GetSection)
}

// GetPage implements the full BFF processing pipeline (spec §10).
func (h *Handler) GetPage(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	start := time.Now()
	rc := h.buildRequestContext(c)

	// 3. Env gate.
	envHeader := c.Get("X-Sdui-Env")
	env := EnvProduction
	if envHeader == "staging" {
		role, _ := c.Locals("role").(string)
		if role != "admin" {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error": "staging env requires admin role",
			})
		}
		env = EnvStaging
	}
	rc.Env = env

	ctx := c.UserContext()

	// 1. Page kill switch.
	if h.rdb != nil {
		if exists, err := h.rdb.Exists(ctx, "sdui:kill:"+pageID).Result(); err == nil && exists > 0 {
			LogKillSwitchHit(pageID)
			c.Set("Warning", "199 - kill-switch active")
			c.Set("Cache-Control", "no-store")
			LogPageLatency(pageID, time.Since(start).Milliseconds())
			return h.serveSafeLayout(c, pageID)
		}
	}

	// 4. Load active config.
	cfgRec, err := h.repo.GetActive(ctx, pageID, string(env))
	if err != nil {
		log.Warn().Err(err).Str("page_id", pageID).Msg("[sdui] no active config — serving safe layout")
		c.Set("Warning", "199 - no active config")
		c.Set("Cache-Control", "no-store")
		LogResolve(pageID, "", time.Since(start), false, err)
		LogPageLatency(pageID, time.Since(start).Milliseconds())
		return h.serveSafeLayout(c, pageID)
	}

	// 1b. Experiment kill-switch (if config has experiment_id).
	if cfgRec.ExperimentID != "" && h.rdb != nil {
		if exists, err := h.rdb.Exists(ctx, "sdui:kill:exp:"+cfgRec.ExperimentID).Result(); err == nil && exists > 0 {
			LogKillSwitchHit(pageID)
			c.Set("Warning", "199 - experiment kill-switch active")
			c.Set("Cache-Control", "no-store")
			LogPageLatency(pageID, time.Since(start).Milliseconds())
			return h.serveSafeLayout(c, pageID)
		}
	}

	// 5. Apply schema migrations (best-effort).
	rawJSON := cfgRec.ConfigJSON
	migrated, _, mErr := migrations.Migrate(rawJSON, cfgRec.SchemaVersion, cfgRec.SchemaVersion)
	if mErr != nil {
		log.Warn().Err(mErr).Str("page_id", pageID).Msg("[sdui] migration failed; using original")
		migrated = rawJSON
	}

	// 2. Version gate (parse min_client_version).
	var probe PageConfig
	if err := json.Unmarshal(migrated, &probe); err == nil && probe.MinClientVersion != "" && rc.AppVersion != "" {
		if !semverGTE(rc.AppVersion, probe.MinClientVersion) {
			c.Set("Warning", "199 - client below min_client_version")
			c.Set("Cache-Control", "no-store")
			LogPageLatency(pageID, time.Since(start).Milliseconds())
			return h.serveSafeLayout(c, pageID)
		}
	}

	// Run hydrate + resolve pipeline; on any failure fall back to last_good then safe.
	page, perr := h.runPipeline(ctx, rc, migrated, cfgRec.Version)
	if perr != nil {
		log.Warn().Err(perr).Str("page_id", pageID).Msg("[sdui] pipeline failed")
		LogResolve(pageID, cfgRec.Version, time.Since(start), false, perr)

		// Try last_good.
		if lg, ok := h.readLastGood(ctx, pageID); ok {
			c.Set("Warning", "199 - serving stale last_good")
			c.Set("Cache-Control", "no-store")
			c.Set("Content-Type", "application/json")
			LogPageLatency(pageID, time.Since(start).Milliseconds())
			return c.Status(fiber.StatusOK).Send(lg)
		}

		c.Set("Warning", "199 - serving safe layout")
		c.Set("Cache-Control", "no-store")
		LogPageLatency(pageID, time.Since(start).Milliseconds())
		return h.serveSafeLayout(c, pageID)
	}

	// 15. ETag handling.
	if inm := c.Get("If-None-Match"); inm != "" && inm == page.ConfigHash {
		c.Set("ETag", page.ConfigHash)
		c.Set("Cache-Control", "no-store")
		LogResolve(pageID, cfgRec.Version, time.Since(start), false, nil)
		LogPageLatency(pageID, time.Since(start).Milliseconds())
		return c.SendStatus(fiber.StatusNotModified)
	}

	body, mErr2 := json.Marshal(page)
	if mErr2 != nil {
		log.Error().Err(mErr2).Str("page_id", pageID).Msg("[sdui] marshal page failed")
		c.Set("Warning", "199 - marshal failed")
		c.Set("Cache-Control", "no-store")
		return h.serveSafeLayout(c, pageID)
	}

	// 16. Cache last_good.
	if h.rdb != nil {
		_ = h.rdb.Set(ctx, "sdui:page:"+pageID+":last_good", body, 24*time.Hour).Err()
		_ = h.rdb.Set(ctx, "sdui:page:"+pageID+":etag", page.ConfigHash, 24*time.Hour).Err()
	}

	c.Set("ETag", page.ConfigHash)
	c.Set("Cache-Control", "no-store")
	c.Set("Content-Type", "application/json")
	LogResolve(pageID, cfgRec.Version, time.Since(start), false, nil)
	LogPageLatency(pageID, time.Since(start).Milliseconds())
	return c.Status(fiber.StatusOK).Send(body)
}

// runPipeline executes hydrate + resolve and returns a ResolvedPage.
func (h *Handler) runPipeline(ctx context.Context, rc RequestContext, raw json.RawMessage, version string) (*ResolvedPage, error) {
	var cfg PageConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse config_json: %w", err)
	}

	refKeys := extractRefKeys(cfg.Sections)

	hydrated, missing, hErr := h.hydrator.Hydrate(ctx, rc, refKeys)
	if hErr != nil {
		return nil, fmt.Errorf("hydrate: %w", hErr)
	}

	page, rErr := h.resolver.Resolve(ctx, rc, &cfg, hydrated, missing)
	if rErr != nil {
		return nil, fmt.Errorf("resolve: %w", rErr)
	}
	if version != "" {
		page.ConfigVersion = version
	}
	if page.SnapshotAt == "" {
		page.SnapshotAt = time.Now().UTC().Format(time.RFC3339)
	}
	return page, nil
}

// readLastGood returns the cached SduiPage JSON for pageID if present.
func (h *Handler) readLastGood(ctx context.Context, pageID string) ([]byte, bool) {
	if h.rdb == nil {
		return nil, false
	}
	v, err := h.rdb.Get(ctx, "sdui:page:"+pageID+":last_good").Bytes()
	if err != nil {
		return nil, false
	}
	if len(v) == 0 {
		return nil, false
	}
	return v, true
}

// serveSafeLayout writes the embedded fallback for pageID. If none exists,
// returns a minimal empty page envelope so clients always get valid JSON.
func (h *Handler) serveSafeLayout(c *fiber.Ctx, pageID string) error {
	c.Set("Content-Type", "application/json")
	if raw, ok := h.safeLayouts[pageID]; ok && len(raw) > 0 {
		return c.Status(fiber.StatusOK).Send(raw)
	}
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"page_id":            pageID,
		"version":            "safe",
		"min_client_version": "0.0.0",
		"config_hash":        "safe",
		"snapshot_at":        time.Now().UTC().Format(time.RFC3339),
		"config_version":     "safe",
		"sections":           []any{},
	})
}

// buildRequestContext constructs a RequestContext from headers + query string.
func (h *Handler) buildRequestContext(c *fiber.Ctx) RequestContext {
	uid, _ := c.Locals("userID").(string)
	width := 0
	if w := c.Get("X-Screen-Width"); w != "" {
		if n, err := strconv.Atoi(w); err == nil {
			width = n
		}
	}
	lat := c.QueryFloat("lat", 0)
	lon := c.QueryFloat("lon", 0)
	return RequestContext{
		UserID:      uid,
		Lat:         lat,
		Lon:         lon,
		Locale:      c.Get("Accept-Language"),
		ScreenWidth: width,
		AppVersion:  c.Get("X-Client-Version"),
		Env:         EnvProduction,
	}
}

// extractRefKeys walks the section tree and returns every $ref key it sees.
// Mirrors validator.walkRefs but operates on raw bytes.
func extractRefKeys(sections []json.RawMessage) []string {
	out := []string{}
	for _, raw := range sections {
		var node any
		if err := json.Unmarshal(raw, &node); err != nil {
			continue
		}
		walkExtractRefs(node, &out)
	}
	return out
}

func walkExtractRefs(node any, out *[]string) {
	switch v := node.(type) {
	case map[string]any:
		if rk, ok := v["$ref"]; ok {
			if s, ok := rk.(string); ok && s != "" {
				*out = append(*out, s)
			}
			return
		}
		for _, child := range v {
			walkExtractRefs(child, out)
		}
	case []any:
		for _, child := range v {
			walkExtractRefs(child, out)
		}
	}
}

// Compile-time check: ensure errors import is referenced when needed.
var _ = errors.New
