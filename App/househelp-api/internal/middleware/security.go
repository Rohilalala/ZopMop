package middleware

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/requestid"
	"github.com/gofiber/helmet/v2"
	"github.com/rs/zerolog/log"
)

// SecurityHeaders applies Helmet security headers to every response.
//
// In addition to Helmet defaults (X-Frame-Options, X-Content-Type-Options,
// Referrer-Policy, etc.) we set:
//   - Strict-Transport-Security: force HTTPS for 1 year incl. subdomains.
//     Only applied in production — local dev runs over plain HTTP.
//   - Content-Security-Policy: JSON APIs render no HTML, so the strictest
//     default-src 'none' policy is safe and prevents any accidental HTML
//     error page from loading attacker-controlled scripts/frames.
//   - X-Permitted-Cross-Domain-Policies: none.
func SecurityHeaders(isProduction bool) fiber.Handler {
	cfg := helmet.Config{
		ContentSecurityPolicy:     "default-src 'none'; frame-ancestors 'none'",
		XFrameOptions:             "DENY",
		ContentTypeNosniff:        "nosniff",
		ReferrerPolicy:            "no-referrer",
		CrossOriginOpenerPolicy:   "same-origin",
		CrossOriginResourcePolicy: "same-site",
	}
	if isProduction {
		cfg.HSTSMaxAge = 31536000
		cfg.HSTSExcludeSubdomains = false
		cfg.HSTSPreloadEnabled = true
	}
	return helmet.New(cfg)
}

// CORS configures Cross-Origin Resource Sharing locked to specific origins.
// An empty allowlist is treated as "no origins permitted" — Fiber's default
// for an empty AllowOrigins is "*", which is unsafe when ALLOWED_ORIGINS is
// accidentally unset. We emit a warning and lock the policy to a sentinel
// origin no client will actually use, so cross-origin requests are rejected
// until the operator configures the list explicitly.
func CORS(allowedOrigins []string) fiber.Handler {
	// Filter empty entries so "a, , b" env values don't silently widen policy.
	filtered := make([]string, 0, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		if o := strings.TrimSpace(origin); o != "" {
			filtered = append(filtered, o)
		}
	}

	originsStr := strings.Join(filtered, ",")
	if originsStr == "" {
		log.Warn().Msg(
			"ALLOWED_ORIGINS is empty — locking CORS to reject all cross-origin requests. " +
				"Set ALLOWED_ORIGINS to the comma-separated list of trusted origins.",
		)
		// Sentinel that no real browser origin will ever match.
		originsStr = "https://cors-disabled.invalid"
	}

	return cors.New(cors.Config{
		AllowOrigins:     originsStr,
		AllowMethods:     "GET,POST,PUT,PATCH,DELETE,OPTIONS",
		AllowHeaders:     "Origin,Content-Type,Accept,Authorization,X-Request-ID,X-Csrf-Token",
		ExposeHeaders:    "X-Request-ID",
		AllowCredentials: true,
		MaxAge:           3600,
	})
}

// RequestID adds a unique X-Request-ID to every request.
func RequestID() fiber.Handler {
	return requestid.New(requestid.Config{
		Header: "X-Request-ID",
	})
}

// RequestLogger logs all 4xx/5xx responses with request ID, method, path,
// status code, and latency the request took to process.
func RequestLogger() fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()

		// Process request.
		err := c.Next()

		latency := time.Since(start)
		status := c.Response().StatusCode()

		// Log 4xx and 5xx responses.
		if status >= 400 {
			logger := log.Warn()
			if status >= 500 {
				logger = log.Error()
			}

			logger.
				Str("request_id", c.GetRespHeader("X-Request-ID")).
				Str("method", c.Method()).
				Str("path", c.Path()).
				Int("status", status).
				Dur("latency", latency).
				Str("ip", c.IP()).
				Msg("request completed with error status")
		}

		return err
	}
}
