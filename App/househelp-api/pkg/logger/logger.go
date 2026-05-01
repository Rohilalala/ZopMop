package logger

import (
	"os"
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
