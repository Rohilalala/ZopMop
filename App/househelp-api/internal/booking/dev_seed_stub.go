//go:build !dev

package booking

import (
	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/adityarohilla/househelp-api/internal/otp"
)

// RegisterDevSeedRoutes is a NO-OP in production builds.
//
// The real implementation lives in dev_seed.go behind `//go:build dev`.
// This stub keeps cmd/api/main.go compiling against a single API
// surface while the prod binary contains zero seed-endpoint code —
// the strongest gate of the triple-gate (the others are runtime env
// + shared-secret header, applied INSIDE the dev_seed.go handler).
//
// Verifying gate from a release binary: `strings api | grep -i
// "seed-state" || echo "ok"` should print "ok"; if it prints a hit,
// the dev tag leaked into the build.
func RegisterDevSeedRoutes(_ fiber.Router, _ *pgxpool.Pool, _ *otp.Service, _ Notifier) {
}
