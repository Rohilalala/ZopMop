package bff

import (
	"context"
	"encoding/json"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// GetSection serves GET /page/:page_id/section/:section_id — the lazy/paginated
// hydration endpoint clients hit when a section declares hydration:"lazy" or a
// load_more action.
func (h *Handler) GetSection(c *fiber.Ctx) error {
	pageID := c.Params("page_id")
	sectionID := c.Params("section_id")
	cursor := c.Query("cursor", "")
	limit := c.QueryInt("limit", 12)
	if limit <= 0 {
		limit = 12
	}
	if limit > 50 {
		limit = 50
	}
	snap := c.Query("snapshot_at", "")
	if snap != "" {
		if _, err := time.Parse(time.RFC3339, snap); err != nil {
			log.Debug().Str("snapshot_at", snap).Msg("[sdui] non-RFC3339 snapshot_at")
		}
	}

	rc := h.buildRequestContext(c)

	if h.LazyFetcher == nil {
		return c.Status(fiber.StatusNotImplemented).JSON(fiber.Map{
			"error": "lazy fetcher not configured",
		})
	}

	ctx := c.UserContext()
	data, nextCursor, hasMore, err := h.LazyFetcher(ctx, pageID, sectionID, cursor, limit, rc)
	if err != nil {
		LogLazySectionFailed(pageID, sectionID, err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"error": "lazy section failed",
		})
	}

	// Best-effort: try to detect the section type from the active config so the
	// client gets the canonical type label. If lookup fails, we omit type.
	sectionType := h.lookupSectionType(ctx, pageID, sectionID, string(rc.Env))

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"section_id": sectionID,
		"type":       sectionType,
		"data":       data,
		"cursor":     nextCursor,
		"has_more":   hasMore,
	})
}

// lookupSectionType inspects the active config to find a section by id and
// returns its declared type. Empty string on any miss/error.
func (h *Handler) lookupSectionType(ctx context.Context, pageID, sectionID, env string) string {
	if env == "" {
		env = string(EnvProduction)
	}
	rec, err := h.repo.GetActive(ctx, pageID, env)
	if err != nil {
		return ""
	}
	var cfg PageConfig
	if err := json.Unmarshal(rec.ConfigJSON, &cfg); err != nil {
		return ""
	}
	for _, raw := range cfg.Sections {
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			continue
		}
		if id, _ := obj["id"].(string); id == sectionID {
			if t, _ := obj["type"].(string); t != "" {
				return t
			}
		}
	}
	return ""
}
