package helper

import (
	"errors"

	"github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// RequireApproved returns a Fiber middleware that allows the request
// only when the authenticated helper's approval_status is 'approved'.
// Any other value (pending, rejected, missing helpers row) returns
// 403 with code HELPER_NOT_APPROVED so the mobile UI can distinguish
// "awaiting review" from "rejected, contact support."
//
// Must be chained AFTER auth middleware (which sets userID in locals)
// and AFTER middleware.RequireRole("pro"). Reading the status on every
// request rather than from a JWT claim or cache is intentional: the
// audit (F9) flagged JWT-baked is_suspended for going stale up to
// 24h after admin action; the same shape would apply to baked
// approval_status. PK lookup on helpers.id is sub-millisecond;
// freshness wins over the negligible per-request cost. Audit
// C-8 / A1-F3 chunk 15.
//
// Approval-rare routes (own profile read, locality edit) intentionally
// do NOT chain this middleware — pending helpers need to see their
// status and update minor fields while waiting for admin review.
// See cmd/api/main.go + internal/helper/handler.go for the route
// split.
func RequireApproved(repo *Repository) fiber.Handler {
	return func(c *fiber.Ctx) error {
		helperID, _ := c.Locals(middleware.LocalsKeyUserID).(string)
		if helperID == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "authentication required",
				"code":  "INVALID_HELPER_ID",
			})
		}

		status, err := repo.GetApprovalStatus(c.UserContext(), helperID)
		if err != nil {
			// Missing helpers row for an authenticated pro role —
			// data drift; fail closed. Don't leak the underlying
			// pg error to the client.
			if errors.Is(err, pgx.ErrNoRows) {
				log.Warn().Str("helper_id", helperID).Msg("[helper.RequireApproved] no helpers row for authenticated pro; rejecting")
			} else {
				log.Error().Err(err).Str("helper_id", helperID).Msg("[helper.RequireApproved] failed to load approval status; rejecting")
			}
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error":  "helper not approved",
				"code":   "HELPER_NOT_APPROVED",
				"status": "unknown",
			})
		}

		if status != "approved" {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"error":  "helper not approved",
				"code":   "HELPER_NOT_APPROVED",
				"status": status,
			})
		}
		return c.Next()
	}
}
