package middleware

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/csrf"
)

// CSRF returns Fiber's double-submit CSRF middleware configured for
// cookie-authenticated browser clients.
//
// How the protection works:
//   - The server issues a non-HttpOnly csrf_ cookie on any request. The client
//     reads the cookie value via JavaScript and echoes it in the
//     X-Csrf-Token header on every state-changing request.
//   - An attacker-controlled origin cannot read the cookie (SameSite=Strict
//     blocks cross-site sends; even if not, the attacker can't read the value
//     to populate the header). The server rejects the request when the
//     header value does not match the cookie.
//
// Skip conditions:
//   - Safe methods (GET/HEAD/OPTIONS) are not checked — Fiber skips these by
//     default.
//   - Requests presenting an Authorization: Bearer header are skipped because
//     the Bearer flow (mobile app) is not vulnerable to CSRF: browsers do not
//     auto-attach Bearer headers cross-origin, and the mobile app is not a
//     browser context.
func CSRF(isProduction bool) fiber.Handler {
	return csrf.New(csrf.Config{
		KeyLookup:      "header:X-Csrf-Token",
		CookieName:     "csrf_",
		CookiePath:     "/",
		CookieSameSite: "Strict",
		CookieSecure:   isProduction,
		CookieHTTPOnly: false, // MUST be readable by JS for the double-submit.
		Expiration:     1 * time.Hour,
		Next: func(c *fiber.Ctx) bool {
			// Bearer-auth flow is CSRF-immune — browsers do not auto-send
			// Authorization headers cross-origin.
			if c.Get("Authorization") != "" {
				return true
			}
			// Login/logout endpoints cannot be CSRF-protected because the
			// client has no session yet when it calls them. They are still
			// safe: auth endpoints are IP-rate-limited (SensitivePublicRateLimit)
			// and the OTP flow requires knowledge of a phone + one-time code.
			path := c.Path()
			return strings.HasPrefix(path, "/api/v1/auth/")
		},
	})
}
