// Package appversion serves the app's force/optional-update check. It reads the
// version policy admins set in the CRM (crm_app_versions) and tells the app
// whether the installed build is below the minimum, whether the update is
// mandatory (hard block) or optional (dismissable), and which store to open.
//
// Two surfaces:
//   - Handler: public GET /api/v1/app/version-check?platform=&version= — the app
//     polls this on launch / resume.
//   - Middleware: returns 426 Upgrade Required on protected routes when a FORCED
//     policy applies, so a force-update takes effect mid-session too. It never
//     gates auth/health/version-check, and reads a 60s in-memory cache so it
//     costs no DB hit per request.
package appversion

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// CheckResult is the version-check response body.
type CheckResult struct {
	NeedsUpdate bool   `json:"needs_update"`
	Force       bool   `json:"force"`
	Message     string `json:"message,omitempty"`
	StoreURL    string `json:"store_url,omitempty"`
	MinVersion  string `json:"min_version,omitempty"`
}

type policy struct {
	minVersion   string
	force        bool
	message      string
	iosStoreURL  string
	androidURL   string
}

// Service reads version policies and caches them for the middleware.
type Service struct {
	db *pgxpool.Pool

	mu     sync.RWMutex
	cache  map[string]policy // keyed by platform: "ios" | "android" | "any"
	loaded time.Time
}

func NewService(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

// Check resolves the policy for a platform and compares the installed version.
func (s *Service) Check(ctx context.Context, platform, version string) (CheckResult, error) {
	platform = normPlatform(platform)
	p, ok, err := s.policyFor(ctx, platform)
	if err != nil {
		return CheckResult{}, err
	}
	res := CheckResult{}
	if !ok {
		return res, nil // no policy configured → never block
	}
	res.MinVersion = p.minVersion
	if version == "" || compareVersions(version, p.minVersion) >= 0 {
		return res, nil // up to date (or unknown version → don't block)
	}
	res.NeedsUpdate = true
	res.Force = p.force
	res.Message = p.message
	res.StoreURL = storeURLFor(platform, p)
	return res, nil
}

// policyFor returns the most specific applicable policy (platform row beats
// 'any'), newest first. ok=false when no row applies.
func (s *Service) policyFor(ctx context.Context, platform string) (policy, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	var (
		p                      policy
		ios, android           *string
	)
	err := s.db.QueryRow(ctx, `
		SELECT min_version, force_update, COALESCE(force_message, ''),
		       ios_store_url, android_store_url
		FROM crm_app_versions
		WHERE platform = $1 OR platform = 'any'
		ORDER BY (platform = $1) DESC, created_at DESC
		LIMIT 1`, platform).Scan(&p.minVersion, &p.force, &p.message, &ios, &android)
	if err == pgx.ErrNoRows {
		return policy{}, false, nil
	}
	if err != nil {
		return policy{}, false, err
	}
	if ios != nil {
		p.iosStoreURL = *ios
	}
	if android != nil {
		p.androidURL = *android
	}
	return p, true, nil
}

// ── 426 middleware ──────────────────────────────────────────────────────────

// Middleware returns a fiber handler that 426s a request when a FORCED policy
// applies to the caller's platform+version. Optional (non-forced) updates never
// 426 — those surface only through the version-check endpoint as a soft prompt.
// Apply it to protected app routes only.
func (s *Service) Middleware() fiber.Handler {
	return func(c *fiber.Ctx) error {
		version := c.Get("X-Client-Version")
		if version == "" {
			return c.Next() // web/admin or unversioned caller — don't gate
		}
		platform := normPlatform(c.Get("X-Client-Platform"))
		p, ok := s.cachedPolicy(c.UserContext(), platform)
		if ok && p.force && compareVersions(version, p.minVersion) < 0 {
			return c.Status(fiber.StatusUpgradeRequired).JSON(fiber.Map{
				"error":     "upgrade_required",
				"message":   p.message,
				"store_url": storeURLFor(platform, p),
				"min_version": p.minVersion,
			})
		}
		return c.Next()
	}
}

// cachedPolicy serves the middleware from a 60s in-memory snapshot so a forced
// version doesn't cost a DB hit on every request.
func (s *Service) cachedPolicy(ctx context.Context, platform string) (policy, bool) {
	s.mu.RLock()
	fresh := s.cache != nil && time.Since(s.loaded) < 60*time.Second
	s.mu.RUnlock()
	if !fresh {
		s.refresh(ctx)
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if p, ok := s.cache[platform]; ok {
		return p, true
	}
	if p, ok := s.cache["any"]; ok {
		return p, true
	}
	return policy{}, false
}

func (s *Service) refresh(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT ON (platform) platform, min_version, force_update,
		       COALESCE(force_message, ''), ios_store_url, android_store_url
		FROM crm_app_versions
		ORDER BY platform, created_at DESC`)
	if err != nil {
		log.Error().Err(err).Msg("[appversion] policy refresh failed")
		return
	}
	defer rows.Close()
	next := map[string]policy{}
	for rows.Next() {
		var plat string
		var p policy
		var ios, android *string
		if err := rows.Scan(&plat, &p.minVersion, &p.force, &p.message, &ios, &android); err != nil {
			log.Error().Err(err).Msg("[appversion] policy scan failed")
			return
		}
		if ios != nil {
			p.iosStoreURL = *ios
		}
		if android != nil {
			p.androidURL = *android
		}
		next[plat] = p
	}
	s.mu.Lock()
	s.cache = next
	s.loaded = time.Now()
	s.mu.Unlock()
}

// ── Handler ───────────────────────────────────────────────────────────────

type Handler struct{ svc *Service }

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// RegisterPublicRoutes mounts GET /version-check (no auth — the app must be able
// to recover from a forced state).
func (h *Handler) RegisterPublicRoutes(r fiber.Router) {
	r.Get("/version-check", h.Check)
}

func (h *Handler) Check(c *fiber.Ctx) error {
	platform := c.Query("platform", c.Get("X-Client-Platform"))
	version := c.Query("version", c.Get("X-Client-Version"))
	res, err := h.svc.Check(c.UserContext(), platform, version)
	if err != nil {
		log.Error().Err(err).Msg("[appversion] check failed")
		// Fail open: a check error must never strand the user.
		return c.JSON(CheckResult{NeedsUpdate: false})
	}
	return c.JSON(res)
}

// ── helpers ───────────────────────────────────────────────────────────────

func normPlatform(p string) string {
	p = strings.ToLower(strings.TrimSpace(p))
	if p == "ios" || p == "android" {
		return p
	}
	return "any"
}

func storeURLFor(platform string, p policy) string {
	if platform == "ios" {
		return p.iosStoreURL
	}
	if platform == "android" {
		return p.androidURL
	}
	// Unknown platform: prefer whichever is set.
	if p.androidURL != "" {
		return p.androidURL
	}
	return p.iosStoreURL
}

// compareVersions compares dotted numeric versions ("1.2.0" vs "1.10.0").
// Pre-release/build suffixes after '-' or '+' are ignored. Returns -1, 0, 1.
func compareVersions(a, b string) int {
	as := segments(a)
	bs := segments(b)
	n := max(len(as), len(bs))
	for i := range n {
		var av, bv int
		if i < len(as) {
			av = as[i]
		}
		if i < len(bs) {
			bv = bs[i]
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	return 0
}

func segments(v string) []int {
	v = strings.TrimSpace(v)
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			n = 0
		}
		out = append(out, n)
	}
	return out
}
