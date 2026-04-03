package middleware

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/requestid"
	"github.com/gofiber/helmet/v2"
	"github.com/rs/zerolog/log"
)

// SecurityHeaders applies Helmet security headers to every response.
func SecurityHeaders() fiber.Handler {
	return helmet.New()
}

// CORS configures Cross-Origin Resource Sharing locked to specific origins.
func CORS(allowedOrigins []string) fiber.Handler {
	originsStr := ""
	for i, origin := range allowedOrigins {
		if i > 0 {
			originsStr += ","
		}
		originsStr += origin
	}

	return cors.New(cors.Config{
		AllowOrigins:     originsStr,
		AllowMethods:     "GET,POST,PUT,PATCH,DELETE,OPTIONS",
		AllowHeaders:     "Origin,Content-Type,Accept,Authorization,X-Request-ID",
		AllowCredentials: false,
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
