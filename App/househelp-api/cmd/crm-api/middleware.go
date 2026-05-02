package main

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// requestID stamps each request with an X-Request-ID. Reuses the inbound
// header if present (so requests from the SPA are easier to trace) and
// otherwise generates a UUID.
func requestID() fiber.Handler {
	return func(c *fiber.Ctx) error {
		id := c.Get("X-Request-ID")
		if id == "" {
			id = uuid.NewString()
		}
		c.Locals("requestID", id)
		c.Set("X-Request-ID", id)
		return c.Next()
	}
}

// securityHeaders sets a strict baseline. CSP is intentionally not set here —
// the CRM frontend talks to this API cross-origin, so CSP belongs on the
// frontend, not the API.
func securityHeaders(production bool) fiber.Handler {
	return func(c *fiber.Ctx) error {
		c.Set("X-Content-Type-Options", "nosniff")
		c.Set("X-Frame-Options", "DENY")
		c.Set("Referrer-Policy", "no-referrer")
		c.Set("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
		if production {
			c.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
		}
		return c.Next()
	}
}

// corsMiddleware allows the CRM SPA origin (and only that). Wildcard origins
// are rejected — refusing to start the binary in that case is preferable but
// kept loose here so dev (no allowed origins set) still works without crashing.
func corsMiddleware(allowed []string) fiber.Handler {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		o = strings.TrimSpace(o)
		if o != "" && o != "*" {
			allowedSet[o] = struct{}{}
		}
	}
	return func(c *fiber.Ctx) error {
		origin := c.Get("Origin")
		if origin != "" {
			if _, ok := allowedSet[origin]; ok {
				c.Set("Access-Control-Allow-Origin", origin)
				c.Set("Vary", "Origin")
				c.Set("Access-Control-Allow-Credentials", "true")
				c.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-ID")
				c.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				c.Set("Access-Control-Max-Age", "600")
			}
		}
		if c.Method() == fiber.MethodOptions {
			return c.SendStatus(fiber.StatusNoContent)
		}
		return c.Next()
	}
}

// requestLogger emits one structured log line per request.
func requestLogger() fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		err := c.Next()
		latency := time.Since(start)
		log.Info().
			Str("method", c.Method()).
			Str("path", c.Path()).
			Int("status", c.Response().StatusCode()).
			Dur("latency", latency).
			Str("ip", c.IP()).
			Str("req_id", c.Get("X-Request-ID")).
			Msg("[crm] req")
		return err
	}
}
