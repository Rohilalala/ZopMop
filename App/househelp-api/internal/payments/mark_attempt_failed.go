// Phase 1 Step 5d.2.d — POST /payments/cashfree/orders/:orderID/mark-attempt-failed.
//
// Fired by the customer app when the Cashfree Drop SDK's on_failure callback
// runs (user dropped, payment refused, card declined, UPI timeout). Flips the
// payment row's gateway_status from 'pending' -> 'failed' so the subsequent
// ResolveCash POST sees no pending Cashfree order on the booking and accepts
// the cash fallback on the first attempt (instead of hammering the 2-min
// residual-race guard for ~30s waiting on a webhook that never lands).
//
// THIS ENDPOINT IS PAYMENTS-ROW-ONLY BY DESIGN.
//
// It touches exactly:
//   - SELECT user_id, gateway_status FROM payments WHERE id=$1  (read for auth)
//   - UPDATE payments SET gateway_status='failed' WHERE id=$1
//     AND gateway_status='pending' RETURNING gateway_status     (conditional flip)
//   - optional re-SELECT gateway_status when the conditional update touches 0
//     rows because a webhook landed in the race window
//
// (payments table has no updated_at column on the Phase 1 schema — the
// gateway_status flip stands on its own. If a future migration adds one,
// the UPDATE should set it too; pin via grep on this comment.)
//
// It NEVER:
//   - writes to bookings (no booking state change, no payment_status flip)
//   - touches Redis (no OTP issue, no OTP revoke)
//   - calls notifications.SendData (no FCM push)
//   - writes to event_outbox (no booking.* event)
//   - calls the booking service or imports anything from internal/booking
//
// The "stale Cashfree order on an already-cash-resolved booking" scenario is
// inherently safe: a single payments-row UPDATE that the booking row doesn't
// see and the OTP layer doesn't observe.
//
// WEBHOOK-WINS RACE: the conditional WHERE gateway_status='pending' is the
// atomic gate. If a real Cashfree success webhook lands first (gateway_status
// flips to 'success'), the conditional UPDATE matches 0 rows; we re-read
// and return the actual 'success' status. The frontend reads the returned
// gateway_status and skips the cash fallback when it sees 'success'. The
// webhook is authoritative because it's HMAC-signed by Cashfree; the
// callback is a client-controlled signal and must defer.
//
// AUTH: customer-only. JWT-derived userID must match the payments row's
// user_id. Helpers, admins, and unauthenticated callers are all rejected
// with 403 / 401. The orderID alone is not a capability — a leaked ID
// can't kill another customer's pending Cashfree session.

package payments

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"
)

// markAttemptFailedOutcome is the pure-function decision returned by
// decideMarkAttemptFailedOutcome. Pinned by truth-table test so a refactor
// can't silently re-open the webhook-wins race.
type markAttemptFailedOutcome struct {
	// AfterStatus is what gateway_status will be after the call. For terminal
	// pre-states (success / failed), this equals the pre-state — the request
	// is a no-op observation. For 'pending' the conditional UPDATE flips it.
	AfterStatus string
	// WillUpdate is true iff the handler should issue the UPDATE. False for
	// already-terminal states; the existing row is returned as-is.
	WillUpdate bool
}

// decideMarkAttemptFailedOutcome is the state-machine decider. Pure function
// of the current gateway_status string; testable without a DB.
//
// Truth table — pinned by mark_attempt_failed_test.go:
//
//	current     | after   | will_update | reason
//	------------+---------+-------------+------------------------------------
//	pending     | failed  | true        | SDK callback flips it
//	success     | success | false       | webhook won; do not overwrite
//	failed      | failed  | false       | idempotent re-call; no-op
//	refunded    | refunded| false       | admin-only terminal; don't touch
//	(other)     | (input) | false       | unknown future status; observe only
//
// 'refunded' is treated as terminal here even though Phase 1 only writes it
// via the admin/CRM refund path — defense in depth so a future state never
// gets clobbered by a stale SDK callback.
func decideMarkAttemptFailedOutcome(current string) markAttemptFailedOutcome {
	switch current {
	case "pending":
		return markAttemptFailedOutcome{AfterStatus: "failed", WillUpdate: true}
	case "success", "failed", "refunded":
		return markAttemptFailedOutcome{AfterStatus: current, WillUpdate: false}
	default:
		// Unknown / future status. Observe the existing value; do not write.
		return markAttemptFailedOutcome{AfterStatus: current, WillUpdate: false}
	}
}

// markAttemptFailedResponse is the JSON body returned by the handler. The
// frontend reads .gateway_status to decide whether the SDK callback or the
// Cashfree success webhook won the race:
//   - "failed"  -> webhook didn't land; proceed to cash fallback (resolveCash)
//   - "success" -> webhook beat the SDK callback; payment is real, skip cash
//                  fallback, jump to the paid-online flow on TrackLive
type markAttemptFailedResponse struct {
	OrderID       string `json:"order_id"`
	GatewayStatus string `json:"gateway_status"`
}

// MarkAttemptFailed handles POST /payments/cashfree/orders/:orderID/mark-attempt-failed.
//
// Contract:
//
//	401 — no JWT
//	403 — JWT user_id != payments.user_id (orderID alone is not a capability)
//	404 — orderID not found
//	200 — { order_id, gateway_status }
//	500 — DB error
//	503 — payments handler not wired (db nil)
//
// Idempotent: same orderID called N times returns the same gateway_status.
// Auth-first: the SELECT runs before any UPDATE, so an unauthorized caller
// cannot flip the row's status before being rejected.
func (h *Handler) MarkAttemptFailed(c *fiber.Ctx) error {
	if h.db == nil {
		return c.Status(http.StatusServiceUnavailable).
			JSON(fiber.Map{"error": "payments not configured"})
	}

	userID, _ := c.Locals("userID").(string)
	if userID == "" {
		return c.Status(http.StatusUnauthorized).
			JSON(fiber.Map{"error": "authentication required"})
	}

	orderID := c.Params("orderID")
	if orderID == "" {
		return c.Status(http.StatusBadRequest).
			JSON(fiber.Map{"error": "order id required"})
	}

	ctx, cancel := context.WithTimeout(c.UserContext(), 5*time.Second)
	defer cancel()

	// 1. Auth read. Pull user_id + current gateway_status in one round trip.
	//    Done BEFORE any write so an unauthorized caller cannot flip
	//    gateway_status and then get bounced — auth precedes mutation.
	var rowUserID, currentStatus string
	if err := h.db.QueryRow(ctx,
		`SELECT user_id::text, gateway_status FROM payments WHERE id = $1::uuid`,
		orderID,
	).Scan(&rowUserID, &currentStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return c.Status(http.StatusNotFound).
				JSON(fiber.Map{"error": "order not found"})
		}
		log.Error().Err(err).Str("order_id", orderID).
			Msg("[mark-attempt-failed] auth-read failed")
		return c.Status(http.StatusInternalServerError).
			JSON(fiber.Map{"error": "internal error"})
	}

	// 2. Auth gate. Only the order's owning customer can mark it failed.
	//    Defends against a leaked orderID being used to kill another
	//    customer's pending session. Helpers + admins are also rejected;
	//    admins have a separate CRM endpoint if reconciliation is ever
	//    needed.
	if rowUserID != userID {
		return c.Status(http.StatusForbidden).
			JSON(fiber.Map{"error": "forbidden"})
	}

	// 3. Decider — pure function of current status. Pinned by truth table.
	outcome := decideMarkAttemptFailedOutcome(currentStatus)
	if !outcome.WillUpdate {
		// Idempotent / webhook-already-won / unknown-status path. Return
		// the observed status as-is; no DB write.
		return c.JSON(markAttemptFailedResponse{
			OrderID:       orderID,
			GatewayStatus: outcome.AfterStatus,
		})
	}

	// 4. Conditional UPDATE. WHERE gateway_status='pending' is the atomic
	//    webhook-wins gate: if the webhook lands in the race window between
	//    step 1 and step 4, the UPDATE matches 0 rows and we re-read.
	var afterStatus string
	err := h.db.QueryRow(ctx,
		`UPDATE payments
		    SET gateway_status = 'failed'
		  WHERE id = $1::uuid AND gateway_status = 'pending'
		  RETURNING gateway_status`,
		orderID,
	).Scan(&afterStatus)

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Webhook-wins race: the row was 'pending' at step 1 but is no
			// longer 'pending' now. Re-read and return the actual status.
			var raced string
			if rerr := h.db.QueryRow(ctx,
				`SELECT gateway_status FROM payments WHERE id = $1::uuid`,
				orderID,
			).Scan(&raced); rerr != nil {
				log.Error().Err(rerr).Str("order_id", orderID).
					Msg("[mark-attempt-failed] race-recovery read failed")
				return c.Status(http.StatusInternalServerError).
					JSON(fiber.Map{"error": "internal error"})
			}
			return c.JSON(markAttemptFailedResponse{
				OrderID:       orderID,
				GatewayStatus: raced,
			})
		}
		log.Error().Err(err).Str("order_id", orderID).
			Msg("[mark-attempt-failed] conditional update failed")
		return c.Status(http.StatusInternalServerError).
			JSON(fiber.Map{"error": "internal error"})
	}

	return c.JSON(markAttemptFailedResponse{
		OrderID:       orderID,
		GatewayStatus: afterStatus,
	})
}
