package logger

import (
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// Init configures the global zerolog logger.
// In development mode: pretty console output.
// In production mode: structured JSON output.
// Secrets are never logged; callers must ensure sensitive data is excluded.
func Init(env string) {
	zerolog.TimeFieldFormat = time.RFC3339
	zerolog.SetGlobalLevel(zerolog.InfoLevel)

	if env == "development" {
		zerolog.SetGlobalLevel(zerolog.DebugLevel)
		log.Logger = zerolog.New(zerolog.ConsoleWriter{
			Out:        os.Stdout,
			TimeFormat: "15:04:05",
		}).With().Timestamp().Caller().Logger()
		return
	}

	// Production: structured JSON to stdout.
	log.Logger = zerolog.New(os.Stdout).With().
		Timestamp().
		Str("service", "househelp-api").
		Logger()
}

// MaskPhone returns a redacted form of the given phone number suitable for
// log fields. Anything 4 chars or shorter is fully masked; otherwise only
// the trailing 4 digits are preserved (e.g. "+919876543210" → "***3210").
func MaskPhone(phone string) string {
	if len(phone) <= 4 {
		return "***"
	}
	return "***" + phone[len(phone)-4:]
}

// MaskEmail returns a redacted email suitable for log fields. The local
// part is reduced to its first character; the domain is preserved for
// ops triage. e.g. "john@example.com" → "j***@example.com". Empty or
// invalid input (no '@', or '@' at index 0) returns "***".
func MaskEmail(email string) string {
	if email == "" {
		return "***"
	}
	atIdx := strings.IndexByte(email, '@')
	if atIdx < 1 {
		return "***"
	}
	return string(email[0]) + "***" + email[atIdx:]
}

// MaskVPA returns a redacted UPI handle. Domain visible for fraud /
// gateway-side analysis; the user-chosen handle is hidden. e.g.
// "aditya@okhdfcbank" → "***@okhdfcbank". Empty or no '@' returns "***".
func MaskVPA(vpa string) string {
	if vpa == "" {
		return "***"
	}
	atIdx := strings.IndexByte(vpa, '@')
	if atIdx < 0 {
		return "***"
	}
	return "***" + vpa[atIdx:]
}

// Stub returns the first n characters of s plus "..." — used for tokens,
// session IDs, idempotency keys, and other opaque strings where a short
// prefix aids correlation but the full value would leak credentials.
// n <= 0 defaults to 8. Strings shorter than n are returned in full plus
// "..." (no fewer chars are visible than the input contained anyway).
func Stub(s string, n int) string {
	if n <= 0 {
		n = 8
	}
	if len(s) <= n {
		return s + "..."
	}
	return s[:n] + "..."
}
