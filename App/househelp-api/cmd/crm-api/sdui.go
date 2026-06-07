package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/bff"
	"github.com/adityarohilla/househelp-api/internal/insights"
	"github.com/adityarohilla/househelp-api/internal/services"
)

// registerSDUIAdmin wires the EXISTING bff admin handler (internal/bff) into
// crm-api so the CRM SPA can manage SDUI page configs. Business logic is reused
// verbatim — this only constructs the handler's dependencies from crm-api's
// pools/redis and mounts the routes under the CRM's authed group.
//
// The handler reads c.Locals("userID") (audit-log actor) and c.Locals("role")
// (preview-as-other-user gate), which the user-app middleware sets but the CRM
// JWT middleware does not. sduiLocalsBridge maps the CRM admin identity onto
// those keys so audit attribution and preview behave correctly.
//
// Preview: crm-api builds a FULL resolver + hydrator (insights + services
// sources are constructible from dbPool/rdb, both of which crm-api already
// holds), so preview hydrates $refs exactly like cmd/api. No degraded fallback.
func registerSDUIAdmin(authed fiber.Router, dbPool *pgxpool.Pool, rdb *redis.Client) {
	repo := bff.NewRepository(dbPool)
	whitelist := bff.NewActionWhitelist(dbPool, rdb)
	circuit := bff.NewCircuit()

	// Sources are constructed from crm-api's own deps. insights + services only
	// need the DB pool (+ rdb for insights), so preview hydration works fully.
	insightsSvc := insights.NewService(insights.NewRepository(dbPool), rdb)
	servicesCatalog := services.NewService(services.NewRepository(dbPool))

	reg, batches := bff.BuildRegistries(bff.SourceDeps{
		DB:       dbPool,
		Insights: insightsSvc,
		Services: servicesCatalog,
	})
	circuit.InitForRegistry(reg)

	validator, err := bff.NewValidator("schemas/sdui_page_config.json", reg, whitelist)
	if err != nil {
		log.Fatal().Err(err).Msg("[crm.sdui] failed to load page config schema")
	}

	hydrator := bff.NewHydrator(reg, batches, circuit, rdb, "v1")
	resolver := bff.NewResolver(reg, func(string) (json.RawMessage, error) {
		return nil, fmt.Errorf("includes not configured")
	}, "", "")

	safeLayouts := loadSafeLayouts()

	adminHandler := bff.NewAdminHandler(
		repo, validator, rdb, whitelist,
		hydrator, resolver, safeLayouts,
	)

	// Mount under the CRM authed group (JWT + per-admin limiter already applied
	// upstream). The locals bridge sits in front so the bff handler sees the
	// userID/role it expects. Final paths: /admin/pages, /admin/pages/:page_id/
	// configs, .../stage, .../activate, .../rollback, .../preview,
	// /admin/pages/:page_id/audit-log, /admin/pages/:page_id/kill-switch,
	// /admin/experiments/:exp_id/kill-switch, /admin/allowed-actions.
	adminHandler.RegisterRoutes(authed.Group("", sduiLocalsBridge()))
}

// sduiLocalsBridge maps the CRM admin identity (set by crmmw.JWT under
// crmAdminID / crmAdminRole) onto the userID / role locals the bff admin
// handler reads. Every CRM admin is treated as "admin" so the preview
// handler's elevated "preview as another user" path stays available — routes
// are already JWT-gated upstream, so no extra authorization is granted.
func sduiLocalsBridge() fiber.Handler {
	return func(c *fiber.Ctx) error {
		if uid, ok := c.Locals("crmAdminID").(string); ok && uid != "" {
			c.Locals("userID", uid)
		}
		c.Locals("role", "admin")
		return c.Next()
	}
}

// loadSafeLayouts loads optional fallback layouts from static/safe_layouts.
// Mirrors cmd/api: the directory is not shipped in the crm-api image, so a
// missing dir is logged and treated as "no safe layouts" rather than an error.
func loadSafeLayouts() map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	candidates := []string{
		"static/safe_layouts",
		"./static/safe_layouts",
		"../static/safe_layouts",
		"../../static/safe_layouts",
	}
	var dir string
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			dir = c
			break
		}
	}
	if dir == "" {
		log.Warn().Msg("[crm.sdui] safe_layouts directory not found")
		return out
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		log.Warn().Err(err).Msg("[crm.sdui] read safe layouts dir")
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			log.Warn().Err(err).Str("file", e.Name()).Msg("[crm.sdui] read safe layout failed")
			continue
		}
		key := strings.TrimSuffix(e.Name(), ".json")
		out[key] = json.RawMessage(raw)
	}
	return out
}
