//go:build dev

// dev_seed.go — Phase 1 test harness. Compiled ONLY into builds passed
// `-tags dev`. The release binary built by the prod Dockerfile (no
// tag) contains the stub from dev_seed_stub.go and zero of this code.
//
// What this exists for: walking the live two-OTP payment-gated flow
// across the customer + pro apps without manually driving every
// transition (book -> dispatch -> accept -> en route -> arrive ->
// start OTP -> in_progress -> pay -> end OTP -> complete). The
// harness fast-forwards an EXISTING booking to a target state and
// emits the same FCM pushes the real path emits so both apps
// auto-flip exactly like they would in pilot.
//
// Triple-gated (this is mandatory for a "force booking state +
// issue OTP" capability — a prod leak is a security incident):
//
//   1. Build tag `dev` — this whole file is absent from the prod
//      binary. dev_seed_stub.go owns the symbol at the prod
//      compile, and is a no-op.
//
//   2. Runtime APP_ENV check — even a dev binary refuses unless
//      APP_ENV=development. Returns 404 (not 403) so the endpoint
//      doesn't even appear to exist.
//
//   3. Shared-secret header X-Dev-Seed-Key — required, matched
//      against env DEV_SEED_KEY (which must be non-empty). 403 on
//      mismatch.
//
// All three must pass. The build tag alone is the strongest gate;
// the runtime checks are belt-and-braces for the case where a dev
// binary accidentally runs in a prod-shaped env.

package booking

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/adityarohilla/househelp-api/internal/otp"
)

// devSeedStateReq is the POST /dev/bookings/:id/seed-state body.
type devSeedStateReq struct {
	// State is the target the booking should land in. One of:
	// "en_route", "in_progress", "cash_resolved", "online_resolved".
	State string `json:"state"`
}

// devSeedStateResp surfaces the booking + test-account IDs the caller
// needs to sign in to the apps + drive the rest of the flow.
type devSeedStateResp struct {
	BookingID         string  `json:"booking_id"`
	CustomerID        string  `json:"customer_id"`
	HelperID          string  `json:"helper_id"`
	HelperPhone       string  `json:"helper_phone"`
	State             string  `json:"state"`
	StartOTPIssued    bool    `json:"start_otp_issued,omitempty"`
	EndOTPIssued      bool    `json:"end_otp_issued,omitempty"`
	CashCollectedAt   *string `json:"cash_collected_at,omitempty"`
	PaymentStatus     *string `json:"payment_status,omitempty"`
}

// RegisterDevSeedRoutes wires the dev-only seed endpoints onto the
// supplied router. Called from cmd/api/main.go unconditionally; the
// prod build picks up the stub from dev_seed_stub.go and registers
// nothing.
//
// router should be the /api/v1 group BEFORE auth middleware is
// attached — the dev endpoints have their own (stronger) auth via
// the shared-secret header.
func RegisterDevSeedRoutes(router fiber.Router, db *pgxpool.Pool, otpSvc *otp.Service, notif Notifier) {
	h := &devSeedHandler{db: db, otpSvc: otpSvc, notif: notif}
	// Group prefix is "/dev-seed" not "/dev" because fiber's group
	// matching is path-prefix not segment-boundary; "/dev" would
	// intercept the unrelated /devices/register route and bounce all
	// FCM registrations with this middleware (caught empirically on
	// the iPhone install — push register failed: 404).
	dev := router.Group("/dev-seed", devGateMiddleware)
	dev.Post("/seed-helper", h.seedHelper)
	dev.Post("/bookings/:id/seed-state", h.seedState)
	log.Warn().Msg("[dev-seed] DEV seed endpoints ARMED at /api/v1/dev-seed/* — build tag `dev` is present. This MUST NOT be a prod binary.")
}

// devGateMiddleware enforces gates (2) APP_ENV=development and (3)
// X-Dev-Seed-Key matches env DEV_SEED_KEY. Gate (1) is enforced by
// the build tag on this file.
func devGateMiddleware(c *fiber.Ctx) error {
	// Accept either APP_ENV or ENV — matches the precedence in
	// pkg/config/config.go:101 (APP_ENV first, then ENV). The
	// .env.local that ships with the repo only sets ENV.
	appEnv := os.Getenv("APP_ENV")
	if appEnv == "" {
		appEnv = os.Getenv("ENV")
	}
	if appEnv != "development" {
		// 404 on purpose — the endpoint should appear nonexistent.
		return c.SendStatus(http.StatusNotFound)
	}
	configured := os.Getenv("DEV_SEED_KEY")
	if configured == "" {
		// Refuse on missing key rather than allow-all — fails closed.
		return c.Status(http.StatusServiceUnavailable).
			JSON(fiber.Map{"error": "DEV_SEED_KEY env unset"})
	}
	supplied := c.Get("X-Dev-Seed-Key")
	if supplied == "" || supplied != configured {
		return c.SendStatus(http.StatusForbidden)
	}
	return c.Next()
}

type devSeedHandler struct {
	db     *pgxpool.Pool
	otpSvc *otp.Service
	notif  Notifier
}

// seedHelper creates (or upserts) the dev test helper account so the
// pro app can sign in to it via the normal auth flow without the
// "first-verify is always customer" trap (auth/service.go ~ line 490).
// Phone is read from DEV_TEST_HELPER_PHONE (default +919999000002).
// Idempotent — safe to call repeatedly.
func (h *devSeedHandler) seedHelper(c *fiber.Ctx) error {
	phone := os.Getenv("DEV_TEST_HELPER_PHONE")
	if phone == "" {
		phone = "+919999000002"
	}
	ctx, cancel := context.WithTimeout(c.UserContext(), 5*time.Second)
	defer cancel()

	helperID, err := ensureTestHelper(ctx, h.db, phone)
	if err != nil {
		log.Error().Err(err).Msg("[dev-seed] seedHelper failed")
		return c.Status(http.StatusInternalServerError).
			JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{
		"helper_id":    helperID,
		"helper_phone": phone,
		"otp_code":     "999999",
		"note":         "sign in to the pro app with this phone + 999999. Requires OTP_DEV_MODE=true on the backend (devModeOTPVal accepts 999999 for any dev- verificationId — auth/messagecentral.go:43).",
	})
}

// seedState fast-forwards an existing booking to the target state.
// Booking must already exist (created via normal Cart flow on the
// customer app); the harness only transitions, it does not create.
func (h *devSeedHandler) seedState(c *fiber.Ctx) error {
	bookingID := c.Params("id")
	if bookingID == "" {
		return c.Status(http.StatusBadRequest).
			JSON(fiber.Map{"error": "booking id required"})
	}
	var req devSeedStateReq
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return c.Status(http.StatusBadRequest).
			JSON(fiber.Map{"error": "bad json body"})
	}
	state := strings.TrimSpace(req.State)
	switch state {
	case "en_route", "in_progress", "cash_resolved", "online_resolved":
	default:
		return c.Status(http.StatusBadRequest).
			JSON(fiber.Map{"error": "state must be en_route|in_progress|cash_resolved|online_resolved"})
	}

	helperPhone := os.Getenv("DEV_TEST_HELPER_PHONE")
	if helperPhone == "" {
		helperPhone = "+919999000002"
	}

	ctx, cancel := context.WithTimeout(c.UserContext(), 10*time.Second)
	defer cancel()

	helperID, err := ensureTestHelper(ctx, h.db, helperPhone)
	if err != nil {
		log.Error().Err(err).Msg("[dev-seed] ensureTestHelper failed")
		return c.Status(http.StatusInternalServerError).
			JSON(fiber.Map{"error": err.Error()})
	}

	// Load + verify the booking exists.
	var customerID string
	if err := h.db.QueryRow(ctx,
		`SELECT customer_id::text FROM bookings WHERE id = $1::uuid`,
		bookingID,
	).Scan(&customerID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return c.Status(http.StatusNotFound).
				JSON(fiber.Map{"error": "booking not found"})
		}
		return c.Status(http.StatusInternalServerError).
			JSON(fiber.Map{"error": err.Error()})
	}

	// Apply the transition. Each state path:
	//   1. UPDATE the booking row (timestamps + helper + payment fields)
	//   2. Consume / issue the appropriate Redis OTP scope
	//   3. Emit booking_status_change FCM data push to relevant party
	startIssued, endIssued := false, false
	switch state {
	case "en_route":
		if _, err := h.db.Exec(ctx, `
			UPDATE bookings
			   SET status            = 'accepted',
			       helper_id         = $2::uuid,
			       en_route_at       = NOW(),
			       arrived_at        = NULL,
			       started_at        = NULL,
			       completed_at      = NULL,
			       payment_status    = NULL,
			       payment_method    = NULL,
			       cash_collected_at = NULL,
			       end_otp_verified_at = NULL,
			       updated_at        = NOW()
			 WHERE id = $1::uuid`,
			bookingID, helperID,
		); err != nil {
			return devSeedDBError(c, err)
		}
		if h.otpSvc != nil {
			_ = h.otpSvc.Revoke(ctx, otp.ScopeEnd, bookingID)
			if _, ierr := h.otpSvc.Issue(ctx, otp.ScopeStart, bookingID); ierr == nil {
				startIssued = true
			} else {
				log.Warn().Err(ierr).Msg("[dev-seed] issue start OTP failed")
			}
		}
		_ = h.notif.SendData(ctx, customerID, map[string]string{
			"type":       "booking_status_change",
			"booking_id": bookingID,
			"status":     "pro_en_route",
		})

	case "in_progress":
		// Consume any existing Start OTP (verified-equivalent), in_progress
		// stamps started_at + start_otp_verified_at to mimic the real
		// StartBooking transition.
		if _, err := h.db.Exec(ctx, `
			UPDATE bookings
			   SET status              = 'in_progress',
			       helper_id           = $2::uuid,
			       en_route_at         = COALESCE(en_route_at, NOW() - INTERVAL '30 minutes'),
			       arrived_at          = COALESCE(arrived_at, NOW() - INTERVAL '15 minutes'),
			       started_at          = NOW(),
			       start_otp_verified_at = NOW(),
			       completed_at        = NULL,
			       payment_status      = NULL,
			       payment_method      = NULL,
			       cash_collected_at   = NULL,
			       end_otp_verified_at = NULL,
			       updated_at          = NOW()
			 WHERE id = $1::uuid`,
			bookingID, helperID,
		); err != nil {
			return devSeedDBError(c, err)
		}
		if h.otpSvc != nil {
			_ = h.otpSvc.Revoke(ctx, otp.ScopeStart, bookingID)
			_ = h.otpSvc.Revoke(ctx, otp.ScopeEnd, bookingID)
		}
		_ = h.notif.SendData(ctx, customerID, map[string]string{
			"type":       "booking_status_change",
			"booking_id": bookingID,
			"status":     string(StatusInProgress),
		})

	case "cash_resolved":
		if _, err := h.db.Exec(ctx, `
			UPDATE bookings
			   SET status                = 'in_progress',
			       helper_id             = $2::uuid,
			       en_route_at           = COALESCE(en_route_at, NOW() - INTERVAL '30 minutes'),
			       arrived_at            = COALESCE(arrived_at, NOW() - INTERVAL '15 minutes'),
			       started_at            = COALESCE(started_at, NOW() - INTERVAL '5 minutes'),
			       start_otp_verified_at = COALESCE(start_otp_verified_at, NOW() - INTERVAL '5 minutes'),
			       completed_at          = NULL,
			       cash_collected_at     = NOW(),
			       cash_collected_by_pro = $2::uuid,
			       payment_status        = NULL,
			       payment_method        = NULL,
			       end_otp_verified_at   = NULL,
			       updated_at            = NOW()
			 WHERE id = $1::uuid`,
			bookingID, helperID,
		); err != nil {
			return devSeedDBError(c, err)
		}
		if h.otpSvc != nil {
			_ = h.otpSvc.Revoke(ctx, otp.ScopeStart, bookingID)
			if _, ierr := h.otpSvc.Issue(ctx, otp.ScopeEnd, bookingID); ierr == nil {
				endIssued = true
			} else {
				log.Warn().Err(ierr).Msg("[dev-seed] issue end OTP failed")
			}
		}
		_ = h.notif.SendData(ctx, customerID, map[string]string{
			"type":       "booking_status_change",
			"booking_id": bookingID,
			"status":     string(StatusInProgress),
		})
		_ = h.notif.SendData(ctx, helperID, map[string]string{
			"type":       "booking_status_change",
			"booking_id": bookingID,
			"status":     string(StatusInProgress),
		})

	case "online_resolved":
		// Insert a synthetic settled payments row so the booking detail
		// + chargeability guard see payment_status='paid' from a
		// recognisable record. gateway_status='success' mirrors the
		// real Cashfree webhook write.
		if _, err := h.db.Exec(ctx, `
			INSERT INTO payments
			  (booking_id, user_id, amount_paise, gateway, gateway_status, webhook_received_at, reconciled)
			SELECT id, customer_id, amount_paise, 'cashfree', 'success', NOW(), TRUE
			  FROM bookings WHERE id = $1::uuid
			ON CONFLICT DO NOTHING`,
			bookingID,
		); err != nil {
			// best-effort — the chargeability guard reads booking
			// fields, the payments row is documentation only.
			log.Warn().Err(err).Msg("[dev-seed] synthetic payments insert failed (non-fatal)")
		}
		if _, err := h.db.Exec(ctx, `
			UPDATE bookings
			   SET status                = 'in_progress',
			       helper_id             = $2::uuid,
			       en_route_at           = COALESCE(en_route_at, NOW() - INTERVAL '30 minutes'),
			       arrived_at            = COALESCE(arrived_at, NOW() - INTERVAL '15 minutes'),
			       started_at            = COALESCE(started_at, NOW() - INTERVAL '5 minutes'),
			       start_otp_verified_at = COALESCE(start_otp_verified_at, NOW() - INTERVAL '5 minutes'),
			       completed_at          = NULL,
			       payment_status        = 'paid',
			       payment_method        = 'cashfree',
			       cash_collected_at     = NULL,
			       end_otp_verified_at   = NULL,
			       updated_at            = NOW()
			 WHERE id = $1::uuid`,
			bookingID, helperID,
		); err != nil {
			return devSeedDBError(c, err)
		}
		if h.otpSvc != nil {
			_ = h.otpSvc.Revoke(ctx, otp.ScopeStart, bookingID)
			if _, ierr := h.otpSvc.Issue(ctx, otp.ScopeEnd, bookingID); ierr == nil {
				endIssued = true
			} else {
				log.Warn().Err(ierr).Msg("[dev-seed] issue end OTP failed")
			}
		}
		_ = h.notif.SendData(ctx, customerID, map[string]string{
			"type":       "booking_status_change",
			"booking_id": bookingID,
			"status":     string(StatusInProgress),
		})
		_ = h.notif.SendData(ctx, helperID, map[string]string{
			"type":       "booking_status_change",
			"booking_id": bookingID,
			"status":     string(StatusInProgress),
		})
	}

	// Re-read for the response (cash_collected_at + payment_status).
	resp := devSeedStateResp{
		BookingID:      bookingID,
		CustomerID:     customerID,
		HelperID:       helperID,
		HelperPhone:    helperPhone,
		State:          state,
		StartOTPIssued: startIssued,
		EndOTPIssued:   endIssued,
	}
	var cashAt *time.Time
	var paymentStatus *string
	_ = h.db.QueryRow(ctx,
		`SELECT cash_collected_at, payment_status FROM bookings WHERE id = $1::uuid`,
		bookingID,
	).Scan(&cashAt, &paymentStatus)
	if cashAt != nil {
		s := cashAt.UTC().Format(time.RFC3339)
		resp.CashCollectedAt = &s
	}
	resp.PaymentStatus = paymentStatus

	log.Info().
		Str("booking_id", bookingID).
		Str("state", state).
		Bool("start_otp_issued", startIssued).
		Bool("end_otp_issued", endIssued).
		Msg("[dev-seed] booking transitioned")

	return c.JSON(resp)
}

// ensureTestHelper upserts a users row (role='pro') + helpers row for
// the supplied phone. Idempotent. Returns the user.id (same as
// helpers.id by FK convention).
func ensureTestHelper(ctx context.Context, db *pgxpool.Pool, phone string) (string, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(context.Background())

	var helperID string
	// users row first. role='pro' so first-verify on the pro app's
	// auth flow finds the existing user instead of auto-creating it
	// with role='customer' (auth/service.go ~ line 490).
	if err := tx.QueryRow(ctx, `
		INSERT INTO users (phone, role, has_accepted_privacy_policy, privacy_policy_accepted_at, phone_verified_at)
		VALUES ($1, 'pro', TRUE, NOW(), NOW())
		ON CONFLICT (phone) DO UPDATE SET role = 'pro'
		RETURNING id::text`,
		phone,
	).Scan(&helperID); err != nil {
		return "", fmt.Errorf("upsert users: %w", err)
	}

	// helpers row. Minimum fields; approval_status='approved' so the
	// helper-approval middleware lets job routes through.
	if _, err := tx.Exec(ctx, `
		INSERT INTO helpers (id, approval_status, services, weekly_hours_target, address)
		VALUES ($1::uuid, 'approved', '{}'::text[], 0, 'Dev test helper')
		ON CONFLICT (id) DO UPDATE SET approval_status = 'approved'`,
		helperID,
	); err != nil {
		return "", fmt.Errorf("upsert helpers: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	return helperID, nil
}

func devSeedDBError(c *fiber.Ctx, err error) error {
	log.Error().Err(err).Msg("[dev-seed] DB update failed")
	return c.Status(http.StatusInternalServerError).
		JSON(fiber.Map{"error": err.Error()})
}
