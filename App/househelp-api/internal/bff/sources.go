package bff

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/insights"
	"github.com/adityarohilla/househelp-api/internal/services"
	"github.com/adityarohilla/househelp-api/internal/users"
)

// SourceRegistry is the canonical map from $ref keys to SourceDef. Keys are
// fixed at startup; the validator rejects any $ref not in this map.
type SourceRegistry map[string]SourceDef

// BatchRegistry maps batch names (e.g. "insights") to a BatchDef.
type BatchRegistry map[string]BatchDef

// PromoSlide is the wire shape for a promo carousel slide. Mirrors the
// PromoSlide TypeScript interface.
type PromoSlide struct {
	Key      string         `json:"key"`
	Eyebrow  string         `json:"eyebrow"`
	Title    string         `json:"title"`
	Body     string         `json:"body"`
	CTA      string         `json:"cta"`
	BG       string         `json:"bg"`
	Accent   string         `json:"accent"`
	Emoji    string         `json:"emoji"`
	Action   map[string]any `json:"action"`
	ImageURL string         `json:"image_url,omitempty"`
}

// SourceDeps holds the live dependencies needed by every Fetch closure.
type SourceDeps struct {
	DB           *pgxpool.Pool
	Insights     *insights.Service
	Services     *services.Catalog
}

// BuildRegistries constructs the complete SourceRegistry + BatchRegistry from
// the given deps. Called once at startup; the result must be treated immutable.
func BuildRegistries(deps SourceDeps) (SourceRegistry, BatchRegistry) {
	batches := BatchRegistry{
		"insights": insightsBatch(deps.Insights),
		"i18n":     i18nBatch(),
	}

	reg := SourceRegistry{
		"user.first_name": {
			Key:        "user.first_name",
			ReturnType: "string",
			TTL:        5 * time.Minute,
			Timeout:    300 * time.Millisecond,
			Critical:   false,
			Priority:   PriorityMedium,
			UserScoped: true,
			Fetch:      fetchUserFirstName(deps.DB),
		},
		"user.has_bookings": {
			Key:        "user.has_bookings",
			ReturnType: "bool",
			TTL:        2 * time.Minute,
			Timeout:    300 * time.Millisecond,
			Critical:   false,
			Priority:   PriorityMedium,
			UserScoped: true,
			Fetch:      fetchUserHasBookings(deps.DB),
		},
		"user.usuals": {
			Key:        "user.usuals",
			ReturnType: "[]Service",
			TTL:        2 * time.Minute,
			Timeout:    400 * time.Millisecond,
			Critical:   false,
			Priority:   PriorityMedium,
			UserScoped: true,
			Fetch:      fetchUserUsuals(deps),
		},
		"insights.nearby_count": {
			Key:        "insights.nearby_count",
			ReturnType: "number",
			TTL:        15 * time.Second,
			Timeout:    300 * time.Millisecond,
			Critical:   false,
			Priority:   PriorityHigh,
			Batch:      "insights",
		},
		"insights.avg_eta_min": {
			Key:        "insights.avg_eta_min",
			ReturnType: "number",
			TTL:        15 * time.Second,
			Timeout:    300 * time.Millisecond,
			Critical:   false,
			Priority:   PriorityHigh,
			Batch:      "insights",
		},
		"insights.avg_rating": {
			Key:        "insights.avg_rating",
			ReturnType: "number",
			TTL:        15 * time.Second,
			Timeout:    300 * time.Millisecond,
			Critical:   false,
			Priority:   PriorityHigh,
			Batch:      "insights",
		},
		"services.popular": {
			Key:        "services.popular",
			ReturnType: "[]Service",
			TTL:        5 * time.Minute,
			Timeout:    400 * time.Millisecond,
			Critical:   false,
			Priority:   PriorityMedium,
			Fetch:      fetchPopularServices(deps.Services),
		},
		"promos.active": {
			Key:        "promos.active",
			ReturnType: "[]PromoSlide",
			TTL:        10 * time.Minute,
			Timeout:    300 * time.Millisecond,
			Critical:   false,
			Priority:   PriorityHigh,
			Fetch:      fetchActivePromos(deps.DB),
		},
	}

	return reg, batches
}

// IsI18nKey reports whether a $ref key targets the i18n batch.
func IsI18nKey(key string) bool {
	return strings.HasPrefix(key, "i18n.")
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

func fetchUserFirstName(db *pgxpool.Pool) func(ctx context.Context, rc RequestContext) (any, error) {
	return func(ctx context.Context, rc RequestContext) (any, error) {
		if rc.UserID == "" {
			return "", nil
		}
		var name *string
		// users table has a single 'name' column (no first/last split).
		// SPLIT_PART preserves the API shape (BFF key "user.first_name")
		// downstream consumers expect (audit D1-1).
		err := db.QueryRow(ctx, `SELECT split_part(coalesce(name, ''), ' ', 1) FROM users WHERE id = $1 AND `+users.AliveCondition, rc.UserID).Scan(&name)
		if err != nil {
			return nil, fmt.Errorf("user.first_name: %w", err)
		}
		if name == nil {
			return "", nil
		}
		return *name, nil
	}
}

func fetchUserHasBookings(db *pgxpool.Pool) func(ctx context.Context, rc RequestContext) (any, error) {
	return func(ctx context.Context, rc RequestContext) (any, error) {
		if rc.UserID == "" {
			return false, nil
		}
		var has bool
		err := db.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM bookings WHERE user_id = $1 LIMIT 1)`,
			rc.UserID,
		).Scan(&has)
		if err != nil {
			return nil, fmt.Errorf("user.has_bookings: %w", err)
		}
		return has, nil
	}
}

func fetchUserUsuals(deps SourceDeps) func(ctx context.Context, rc RequestContext) (any, error) {
	return func(ctx context.Context, rc RequestContext) (any, error) {
		if rc.UserID == "" || deps.Insights == nil {
			return []services.Service{}, nil
		}
		ids, err := deps.Insights.MyUsuals(ctx, rc.UserID, 6)
		if err != nil {
			return nil, fmt.Errorf("user.usuals ids: %w", err)
		}
		if len(ids) == 0 {
			return []services.Service{}, nil
		}
		all, err := deps.Services.List(ctx)
		if err != nil {
			return nil, fmt.Errorf("user.usuals services: %w", err)
		}
		index := make(map[string]services.Service, len(all))
		for _, s := range all {
			index[s.ID] = s
		}
		out := make([]services.Service, 0, len(ids))
		for _, id := range ids {
			if s, ok := index[id]; ok {
				out = append(out, s)
			}
		}
		return out, nil
	}
}

func fetchPopularServices(catalog *services.Catalog) func(ctx context.Context, rc RequestContext) (any, error) {
	return func(ctx context.Context, rc RequestContext) (any, error) {
		if catalog == nil {
			return []services.Service{}, nil
		}
		list, err := catalog.List(ctx)
		if err != nil {
			return nil, fmt.Errorf("services.popular: %w", err)
		}
		return list, nil
	}
}

// fetchActivePromos returns hero carousel slides from the banners table.
// banners is the canonical editorial source; home_promos was dropped in migration 080.
func fetchActivePromos(db *pgxpool.Pool) func(ctx context.Context, rc RequestContext) (any, error) {
	return func(ctx context.Context, rc RequestContext) (any, error) {
		queryCtx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
		defer cancel()

		rows, err := db.Query(queryCtx, `
			SELECT
				id::text,
				title,
				COALESCE(subtitle, '')   AS body,
				COALESCE(cta_label, '')  AS cta,
				COALESCE(tap_action, '') AS tap_action,
				image_url
			FROM banners
			WHERE is_active = TRUE
			  AND (starts_at IS NULL OR starts_at <= NOW())
			  AND (ends_at   IS NULL OR ends_at   >  NOW())
			ORDER BY display_order ASC, created_at ASC
			LIMIT 10
		`)
		if err != nil {
			return nil, fmt.Errorf("promos.active: %w", err)
		}
		defer rows.Close()

		out := make([]PromoSlide, 0, 8)
		for rows.Next() {
			var s PromoSlide
			var tapAction string
			if err := rows.Scan(&s.Key, &s.Title, &s.Body, &s.CTA, &tapAction, &s.ImageURL); err != nil {
				return nil, fmt.Errorf("scan banner: %w", err)
			}
			// Default visual fields — admins can override via banners.accent_color
			// if that column is added later; for now use brand defaults.
			s.Eyebrow = ""
			s.Emoji = ""
			s.BG = "#1A1A2E"
			s.Accent = "#F5A300"
			screen := tapAction
			if screen == "" {
				screen = "Offers"
			}
			s.Action = map[string]any{
				"trigger": "tap",
				"type":    "navigate",
				"screen":  screen,
			}
			out = append(out, s)
		}
		return out, rows.Err()
	}
}

func insightsBatch(svc *insights.Service) BatchDef {
	return BatchDef{
		Fetch: func(ctx context.Context, rc RequestContext, keys []string) (map[string]any, error) {
			out := make(map[string]any, len(keys))
			if svc == nil {
				for _, k := range keys {
					out[k] = nil
				}
				return out, nil
			}
			stats, err := svc.NearbyStats(ctx, rc.Lat, rc.Lon)
			if err != nil || stats == nil {
				for _, k := range keys {
					out[k] = nil
				}
				return out, err
			}
			for _, k := range keys {
				switch k {
				case "insights.nearby_count":
					out[k] = stats.NearbyCount
				case "insights.avg_eta_min":
					out[k] = stats.AvgEtaMin
				case "insights.avg_rating":
					out[k] = stats.AvgRating
				default:
					out[k] = nil
				}
			}
			return out, nil
		},
	}
}

// i18nBatch: stub — returns the key suffix as the value. Real i18n integration
// is a follow-up; this keeps the registry shape stable.
func i18nBatch() BatchDef {
	return BatchDef{
		Fetch: func(ctx context.Context, rc RequestContext, keys []string) (map[string]any, error) {
			out := make(map[string]any, len(keys))
			for _, k := range keys {
				out[k] = strings.TrimPrefix(k, "i18n.")
			}
			return out, nil
		},
	}
}
