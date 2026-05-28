package booking

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/adityarohilla/househelp-api/internal/admin"
	"github.com/adityarohilla/househelp-api/internal/analytics"
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/googlemaps"
	"github.com/adityarohilla/househelp-api/internal/matching"
	mw "github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/adityarohilla/househelp-api/internal/otp"
	"github.com/adityarohilla/househelp-api/internal/payments"
	"github.com/adityarohilla/househelp-api/internal/users"
	"github.com/adityarohilla/househelp-api/internal/webhooks"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// ErrAddressNotOwned is returned when a caller attempts to create a booking
// against an address_id that does not belong to them.
var ErrAddressNotOwned = errors.New("address does not belong to caller")

// ErrTooFarAway is returned when the Google Maps walking ETA between the
// helper's last known location and the booking address exceeds
// acceptMaxWalkingMinutes. Fail-open: a Maps API error or missing client
// allows the accept so helpers aren't blocked by upstream downtime.
var ErrTooFarAway = errors.New("helper too far from booking")

// acceptMaxWalkingMinutes is the upper bound on helper→pickup walking time
// at accept-time. Slightly above matching.max_walk_minutes (default 20) so a
// helper who has drifted a few hundred metres after being matched isn't
// refused on accept due to ETA noise.
const acceptMaxWalkingMinutes = 25

// ErrSlotUnavailable is returned when the requested time slot is full or
// already taken — surfaced as 409 Conflict to the client.
var ErrSlotUnavailable = errors.New("slot already booked")

// ErrSlotTooFar is returned when the requested slot is more than two days
// out from "now" (in India local time). The customer is told to pick a
// slot within the next two days.
var ErrSlotTooFar = errors.New("bookings can only be made up to 2 days in advance")

// ErrSlotInPast is returned when the requested slot is already past — covers
// stale slot IDs and slots that lapsed while the customer was on the screen.
var ErrSlotInPast = errors.New("requested time slot is in the past")

// schedulingCutoffHourIST is the hour-of-day (India local time) at which a
// scheduled booking switches into "stealth instant" mode: the customer can
// still place it but the dispatch cron treats it as a near-instant request
// instead of waiting for the nightly batch.
const schedulingCutoffHourIST = 20 // 8pm IST

// instantBookingNightStartHour / instantBookingNightEndHour close the instant
// booking window between 20:00 and 06:00 IST. Pros are off-shift overnight,
// so no walking-time match could succeed; we reject the request up-front
// (mirrors the LivePill night gate so the UI stays consistent with the API).
const (
	instantBookingNightStartHour = 20 // 8pm IST
	instantBookingNightEndHour   = 6  // 6am IST
)

// ErrInstantBookingClosed is returned when a customer tries to place an
// instant booking outside operating hours (20:00–06:00 IST).
var ErrInstantBookingClosed = errors.New("instant booking is closed overnight")

// isInstantBookingClosed reports whether `t` (in IST) falls inside the
// nightly closed window.
// roundLogCoord rounds a lat/lng to 2 decimals (~1.1 km precision)
// for safe structured logging. Audit C-8 / F2D-1 chunk 13 — log
// retention now governs only city-block-level coordinates rather
// than home-pinpoint GPS coords. Mirrors the pattern in
// internal/matching/engine.go and internal/insights/handler.go.
func roundLogCoord(x float64) float64 { return math.Round(x*100) / 100 }

func isInstantBookingClosed(t time.Time) bool {
	hr := t.In(indiaLocation()).Hour()
	return hr >= instantBookingNightStartHour || hr < instantBookingNightEndHour
}

// stealthFireLeadTime is how far before scheduled_time the stealth dispatch
// cron fires its invite chain. Spec calls for 15 minutes.
const stealthFireLeadTime = 15 * time.Minute

// scheduledBookingMaxLeadDays caps how far ahead a customer can book.
const scheduledBookingMaxLeadDays = 2

// haversineKm returns great-circle distance in kilometres between two
// lat/lng points. Used for ETA estimation when no routing API is wired up.
func haversineKm(lat1, lng1, lat2, lng2 float64) float64 {
	const earthRadiusKm = 6371.0
	rad := func(d float64) float64 { return d * math.Pi / 180.0 }
	dLat := rad(lat2 - lat1)
	dLng := rad(lng2 - lng1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(rad(lat1))*math.Cos(rad(lat2))*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * earthRadiusKm * math.Asin(math.Sqrt(a))
}

// indiaLocation returns the IST tz, falling back to a fixed +05:30 zone if
// the system tzdata can't load Asia/Kolkata (e.g. inside a stripped Alpine
// container that wasn't built with tzdata).
func indiaLocation() *time.Location {
	if loc, err := time.LoadLocation("Asia/Kolkata"); err == nil {
		return loc
	}
	return time.FixedZone("IST", 5*3600+30*60)
}

// ReferralCompleter hooks into booking completion to credit referral rewards.
type ReferralCompleter interface {
	MaybeCompleteOnBookingTx(ctx context.Context, tx pgx.Tx, customerID string) error
}

// WalletDebiter is the slice of internal/wallet's Service that the booking
// flow needs to spend wallet funds. Defined as an interface to avoid an
// import cycle (wallet imports nothing from booking; if we typed against
// the concrete type the dependency direction would still flip in main).
type WalletDebiter interface {
	DebitTx(
		ctx context.Context,
		tx pgx.Tx,
		userID string,
		amountPaise int64,
		kind string,
		bookingID *string,
		note string,
	) error
}

// ErrInsufficientWalletBalance is returned by CreateBooking when
// payment_source="wallet" and the user's wallet doesn't have enough.
// Handler maps this to 402 with code "insufficient_wallet_balance".
var ErrInsufficientWalletBalance = errors.New("insufficient wallet balance")

// ErrUnpaidBookings is returned when a customer has completed-but-unpaid
// bookings that block another action (account deletion, new booking
// creation). Carries the count and total amount so callers can render a
// user-actionable error.
//
// The "unpaid" predicate matches the inverse of compliance.moneyMovedPredicate
// — bookings where service was rendered but payment never settled. Today
// this means Cashfree bookings whose webhook never fired (payment_status=NULL)
// or where the gateway rejected the card post-service (payment_status='failed').
//
// Audit trail: Apple 5.1.1(v) deletion compliance + revenue leakage prevention.
type ErrUnpaidBookings struct {
	Count      int
	TotalPaise int64
}

func (e *ErrUnpaidBookings) Error() string {
	return fmt.Sprintf("customer has %d unpaid booking(s) totaling %d paise", e.Count, e.TotalPaise)
}

// Notifier is the narrow surface the booking service needs to push
// data-only messages to a user (typically the customer when the pro
// transitions through en_route/arrived/etc.). Mirrors the shape of
// internal/notification.Service.SendData so the concrete adapter is
// a one-liner in cmd/api/main.go.
type Notifier interface {
	SendData(ctx context.Context, userID string, data map[string]string) error
}

// Service handles booking business logic.
type Service struct {
	repo          *Repository
	db            *pgxpool.Pool
	rdb           *redis.Client
	configSvc     *config_manager.Service
	matchBatcher  *matching.Batcher    // nil-safe; only used for instant bookings
	matchEngine   *matching.Engine     // nil-safe; used for status queries
	maps          *googlemaps.Client   // nil-safe; used for tracking ETA + polyline
	analytics     *analytics.Service   // nil-safe; fire-and-forget event tracking
	webhooks      *webhooks.Dispatcher // nil-safe; outbound CRM webhook fan-out
	ledger        *payments.Ledger     // nil-safe; charge-row writer
	wallet        WalletDebiter        // nil-safe; payment_source="wallet" flow
	referrals     ReferralCompleter    // nil-safe; referral reward on completion
	notifications Notifier             // nil-safe; FCM data push to customer
	otpSvc        *otp.Service         // nil-safe; two-OTP gate (Phase 1 Step 1)
}

// SetNotifier wires the FCM data-push surface. nil-safe — leaving it
// unset disables customer pushes for en_route/arrived/etc.
func (s *Service) SetNotifier(n Notifier) { s.notifications = n }

// SetPaymentsLedger wires the payments ledger so booking confirmation can
// open a pending charge row. nil-safe — leaving it unset disables ledger
// writes (used by unit tests that don't care about the payments table).
func (s *Service) SetPaymentsLedger(l *payments.Ledger) { s.ledger = l }

// SetWallet wires the wallet service so payment_source="wallet" can debit
// inline. Optional — without it, a wallet-source request is rejected.
func (s *Service) SetWallet(w WalletDebiter) { s.wallet = w }

// SetReferralCompleter wires the referral service so first-booking completion
// can credit the referee and referrer rewards. nil-safe — leaving it unset
// disables referral crediting.
func (s *Service) SetReferralCompleter(rc ReferralCompleter) { s.referrals = rc }

// SetOTPService wires the booking-scoped OTP issuer used by the two-OTP
// payment-gated service flow. Required before StartBooking / CompleteBooking
// can be called in the new model — those handlers return ErrOTPServiceNotWired
// if it's nil at call time (defense-in-depth for misconfigured deploys).
func (s *Service) SetOTPService(o *otp.Service) { s.otpSvc = o }

// Phase 1 Step 1: gate errors for the two-OTP payment-gated service flow.
// The handler translates these to specific HTTP responses so the pro app can
// distinguish "wrong code" from "payment not done yet" from "service
// misconfigured", without leaking server-internal failure modes.
var (
	// ErrOTPServiceNotWired is returned when StartBooking / CompleteBooking
	// is invoked but s.otpSvc is nil. A misconfigured deploy, not a user
	// error — should never happen in prod. Maps to 503.
	ErrOTPServiceNotWired = errors.New("booking: OTP service not wired")
	// ErrStartOTPRequired is returned when StartBooking is called without
	// a code. Pro app bug or malformed request. Maps to 400.
	ErrStartOTPRequired = errors.New("booking: start OTP required")
	// ErrInvalidStartOTP is returned when the supplied start OTP does not
	// match the issued code for the booking (or none is outstanding).
	// Maps to 401 — the gate failed.
	ErrInvalidStartOTP = errors.New("booking: invalid start OTP")
	// ErrEndOTPRequired is returned when CompleteBooking is called without
	// a code. Maps to 400.
	ErrEndOTPRequired = errors.New("booking: end OTP required")
	// ErrInvalidEndOTP is returned when the supplied end OTP does not match
	// the issued code (or none is outstanding because payment hasn't
	// resolved yet). Maps to 401.
	ErrInvalidEndOTP = errors.New("booking: invalid end OTP")
	// ErrPaymentNotResolved is returned when CompleteBooking is attempted
	// but payment_status is not 'paid' AND cash_collected_at is null. The
	// End OTP cannot have been issued in this state, but we double-check
	// here as defense-in-depth. Maps to 409.
	ErrPaymentNotResolved = errors.New("booking: payment not resolved")
	// ErrOTPTooManyAttempts is returned when the per-booking, per-scope
	// service-OTP verify rate limit has been crossed (otp.ErrTooManyAttempts
	// wrapped at the booking layer). Maps to 429. The pro-app message must
	// be time-honest ("wait a moment, then try again") AND surface the
	// support contact — reloading TrackLive does NOT re-issue the OTP.
	ErrOTPTooManyAttempts = errors.New("booking: too many wrong OTP attempts")
	// ErrBookingNotFound is returned when ResolveCash targets a booking
	// that does not exist or the customer does not own. Maps to 404 (we
	// intentionally do not distinguish "missing" from "not yours" so
	// neither leaks information about other customers' bookings).
	ErrBookingNotFound = errors.New("booking: not found")
	// ErrNoHelperAssigned is returned when ResolveCash is invoked on a
	// booking that has no helper assigned yet (pending/searching). The
	// cash attribution requires a real pro to owe the money. Maps to 409.
	ErrNoHelperAssigned = errors.New("booking: no helper assigned")
	// ErrAlreadyPaidOnline is returned when ResolveCash is invoked but
	// the booking already shows payment_status='paid'. The online path
	// closed the cash option. Maps to 409.
	ErrAlreadyPaidOnline = errors.New("booking: already paid online")
	// ErrOnlinePaymentPending is the residual-race guard: a Cashfree
	// order exists for this booking with gateway_status='pending'. The
	// customer's online payment is mid-flight and may succeed at any
	// moment; allowing cash now would double-pay. Maps to 409. The
	// customer-app copy is "An online payment is processing, please wait."
	ErrOnlinePaymentPending = errors.New("booking: online payment pending")
)

// IssueStartOTP generates a fresh start OTP for the booking and stores it
// under the booking-scoped namespace in Redis. Idempotent re-issue rotates
// the outstanding code (overwrites). The caller (Step 2's "On my way"
// handler) returns the plaintext to the customer's TrackLive screen.
//
// Booking-scoped ownership: a booking can only ever have one outstanding
// start OTP at a time. A re-Issue invalidates the prior code.
func (s *Service) IssueStartOTP(ctx context.Context, bookingID string) (string, error) {
	if s.otpSvc == nil {
		return "", ErrOTPServiceNotWired
	}
	return s.otpSvc.Issue(ctx, otp.ScopeStart, bookingID)
}

// IssueEndOTP generates a fresh end OTP for the booking. Called from two
// places after payment resolves:
//
//   - The Cashfree webhook handler when it flips payment_status='paid'
//     (Step 1.B — webhook hook).
//   - The customer-initiated ResolveCash handler (Step 3) after the
//     "Yes, pay cash" confirmation.
//
// Idempotent re-issue rotates the outstanding code (overwrites). The
// caller publishes the code to the customer's TrackLive screen.
func (s *Service) IssueEndOTP(ctx context.Context, bookingID string) (string, error) {
	if s.otpSvc == nil {
		return "", ErrOTPServiceNotWired
	}
	return s.otpSvc.Issue(ctx, otp.ScopeEnd, bookingID)
}

// ResolveCash is the customer-initiated cash resolution. The customer
// reaches it from the payment-method choice screen at the end of service:
// they tap CASH, confirm "Yes, pay cash", and this is the resulting call.
//
// Phase 1 Step 3 — the cash path. The model is intentionally simple:
// no pro action, no webhook conflict logic, no auto-refund. The customer
// chooses; one successful resolution closes the other path.
//
// Guards (in order, single tx with SELECT FOR UPDATE on the booking row):
//
//  1. Booking must belong to the calling customer  → ErrBookingNotFound
//  2. Helper must be assigned                       → ErrNoHelperAssigned
//  3. Status must be 'in_progress'                  → ErrJobNotInState
//  4. payment_status must NOT already be 'paid'     → ErrAlreadyPaidOnline
//  5. cash_collected_at IS NOT NULL                 → idempotent success
//                                                      (re-Issue End OTP)
//  6. No Cashfree order with gateway_status='pending'→ ErrOnlinePaymentPending
//                                                      (the residual-race
//                                                      guard — online
//                                                      payment in flight)
//
// On success: stamp cash_collected_by_pro = helper_id (snapshot the
// assigned pro at resolve time so a future helper reassignment cannot
// silently shift the owed-money attribution) and cash_collected_at = NOW().
// Post-commit: issue the End OTP via the SAME IssueEndOTP path the
// Cashfree webhook uses. Failure is non-fatal — TrackLive self-heal
// (Step 5) covers a missed issuance on the next customer load.
//
// Payroll is NOT touched here. The pro's pay is salaried on
// online/working minutes; the cash they now owe the company is a
// separate ledger (internal/crm/cash). The two never net against
// each other. See docs/phase-1-payment-gated-flow.md.
func (s *Service) ResolveCash(ctx context.Context, bookingID, customerID string) error {
	if s.otpSvc == nil {
		return ErrOTPServiceNotWired
	}

	txCtx, txCancel := context.WithTimeout(ctx, 5*time.Second)
	defer txCancel()

	tx, err := s.db.BeginTx(txCtx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("resolve-cash begin tx: %w", err)
	}
	defer tx.Rollback(context.Background())

	// Lock the booking row for the duration of the tx so concurrent
	// resolve-cash calls and the Cashfree webhook handler serialize on
	// this booking. The webhook also takes a FOR UPDATE lock on the
	// payment row (handler.go ~line 940); even if the two locks are on
	// different tables, the BEGIN/COMMIT boundaries serialise the
	// observed state per-booking.
	var (
		helperID    *string
		status      string
		paymentStat *string
		cashAt      *time.Time
	)
	if err := tx.QueryRow(txCtx,
		`SELECT helper_id::text, status, payment_status, cash_collected_at
		   FROM bookings
		  WHERE id = $1 AND customer_id = $2
		  FOR UPDATE`,
		bookingID, customerID,
	).Scan(&helperID, &status, &paymentStat, &cashAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrBookingNotFound
		}
		return fmt.Errorf("resolve-cash load booking: %w", err)
	}
	if helperID == nil {
		return ErrNoHelperAssigned
	}
	if status != string(StatusInProgress) {
		return ErrJobNotInState
	}
	if paymentStat != nil && *paymentStat == "paid" {
		return ErrAlreadyPaidOnline
	}

	// Idempotency: a second tap from the customer (or a retry from a
	// flaky network) lands here. We are already in target state.
	//
	// Critical: do NOT unconditionally re-Issue the End OTP. otp.Issue
	// always overwrites (mints a fresh code), which would desync a
	// customer who has already read the outstanding code off TrackLive
	// and started reading it to the pro. Instead: Peek first; only
	// Issue if no code is outstanding (true self-heal). Commit first
	// to release the row lock before the Redis hop.
	if cashAt != nil {
		if err := tx.Commit(txCtx); err != nil {
			return fmt.Errorf("resolve-cash commit (idempotent): %w", err)
		}
		if _, perr := s.otpSvc.Peek(ctx, otp.ScopeEnd, bookingID); perr != nil {
			if errors.Is(perr, otp.ErrNotFound) {
				// No outstanding code — Issue to self-heal. Mirrors the
				// TrackLive self-heal contract spec'd for Step 5.
				if _, ierr := s.otpSvc.Issue(ctx, otp.ScopeEnd, bookingID); ierr != nil {
					log.Warn().Err(ierr).Str("booking_id", bookingID).
						Msg("[resolve-cash] idempotent end-OTP self-heal failed; TrackLive self-heal will retry")
				}
			} else {
				log.Warn().Err(perr).Str("booking_id", bookingID).
					Msg("[resolve-cash] idempotent end-OTP peek failed; TrackLive self-heal will retry")
			}
		}
		// A code IS outstanding — leave it. Customer already has it on
		// their screen; minting a new one here would desync the customer
		// and the pro mid-handoff.
		return nil
	}

	// Residual-race guard: a RECENT Cashfree order in 'pending' for
	// this booking means an online charge is mid-flight and may
	// succeed any second. Reject; the app shows "An online payment is
	// processing, please wait."
	//
	// Freshness bound (2 minutes): when a customer abandons the
	// Cashfree drop-in (closes the sheet), Cashfree fires
	// PAYMENT_USER_DROPPED_WEBHOOK which flips gateway_status to
	// 'failed' (see internal/payments/handler.go PAYMENT_FAILED /
	// PAYMENT_USER_DROPPED branch). The webhook typically lands
	// within ~30s, but slow UPI flows can take a couple of minutes.
	// Without the freshness bound a stuck 'pending' row would trap
	// the customer forever — they tried online, gave up, and we
	// refuse cash. With it, anything older than 2 minutes is treated
	// as abandoned and falls through to cash, which is the rule
	// recorded in docs/phase-1-payment-gated-flow.md.
	var pendingExists bool
	if err := tx.QueryRow(txCtx,
		`SELECT EXISTS (
		   SELECT 1
		     FROM payments
		    WHERE booking_id     = $1::uuid
		      AND payment_method = 'cashfree'
		      AND gateway_status = 'pending'
		      AND created_at     > NOW() - INTERVAL '2 minutes'
		 )`,
		bookingID,
	).Scan(&pendingExists); err != nil {
		return fmt.Errorf("resolve-cash check pending payment: %w", err)
	}
	if pendingExists {
		return ErrOnlinePaymentPending
	}

	// All guards passed. Stamp the cash resolution. Snapshot the
	// assigned helper_id into cash_collected_by_pro: the owes ledger
	// must be attributable even if a future code path ever rewrites
	// helper_id (e.g. reschedule reassignment), and the snapshot is
	// the durable record of "who collected this".
	if _, err := tx.Exec(txCtx,
		`UPDATE bookings
		    SET cash_collected_by_pro = $2::uuid,
		        cash_collected_at     = NOW(),
		        updated_at            = NOW()
		  WHERE id = $1`,
		bookingID, *helperID,
	); err != nil {
		return fmt.Errorf("resolve-cash stamp booking: %w", err)
	}
	if err := tx.Commit(txCtx); err != nil {
		return fmt.Errorf("resolve-cash commit: %w", err)
	}

	// Post-commit End OTP issuance. Mirrors the Cashfree webhook hook
	// (Step 1) — Redis-only side effect, non-fatal. Step 5's TrackLive
	// self-heal covers any transient failure on the next customer load.
	if _, oerr := s.otpSvc.Issue(ctx, otp.ScopeEnd, bookingID); oerr != nil {
		log.Warn().Err(oerr).Str("booking_id", bookingID).
			Msg("[resolve-cash] post-commit end-OTP issuance failed; TrackLive self-heal will retry")
	}

	// Post-commit PRO push — load-bearing for the cash loop. Without
	// this, the pro's JobDetail stays on the "waiting for payment"
	// panel after the customer pays cash; the pro never sees the End
	// OTP entry UI and can't ask the customer for the code, so the
	// loop stalls (pro standing in the kitchen, customer staring at
	// the End OTP card on their screen, neither side moving).
	//
	// The pro app's JobDetailScreen subscribes to booking_status_change
	// for its own bookingID and re-fetches GetJobDetail on receipt;
	// fresh fetch shows cash_collected_at populated, which flips the
	// OTP panel from "waiting" into End OTP entry mode.
	//
	// Non-fatal: the cash IS resolved + committed at this point. A
	// failed FCM push must not undo cash_collected_at — the customer
	// already saw success on their screen and would have no idea their
	// "successful" cash payment got rolled back. Same discipline as the
	// post-commit Issue above. The booking-detail fetch on next
	// foreground / re-mount is the recovery path.
	if s.notifications != nil {
		_ = s.notifications.SendData(ctx, *helperID, map[string]string{
			"type":       "booking_status_change",
			"booking_id": bookingID,
			"status":     string(StatusInProgress),
		})
	}
	return nil
}

// payBookingFromWallet runs the wallet debit + payments row insert + booking
// status flip + booking.paid outbox event for a freshly created booking.
// Single tx. On ErrInsufficientBalance (translated to ErrInsufficientWalletBalance)
// the caller is expected to roll the booking back via CancelBookingWithFee.
func (s *Service) payBookingFromWallet(ctx context.Context, bookingID, userID string, netPaise int64) error {
	if s.wallet == nil || s.ledger == nil {
		return fmt.Errorf("wallet payment not configured")
	}
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		// Debit the wallet inside the tx. The wallet.DebitTx interface
		// surfaces ErrInsufficientBalance via the wallet package's error
		// sentinel; we re-export as ErrInsufficientWalletBalance so callers
		// don't have to import internal/wallet.
		bid := bookingID
		if err := s.wallet.DebitTx(ctx, tx, userID, netPaise, "spend", &bid, "Booking "+bookingID); err != nil {
			if isInsufficientBalance(err) {
				return ErrInsufficientWalletBalance
			}
			return fmt.Errorf("wallet debit: %w", err)
		}

		// Record the matching payment row. gateway='wallet', no gateway_ref.
		if _, err := tx.Exec(ctx, `
			INSERT INTO payments
			  (booking_id, user_id, amount_paise, gateway, gateway_status, webhook_received_at, reconciled)
			VALUES ($1::uuid, $2::uuid, $3, 'wallet', 'success', NOW(), TRUE)
		`, bookingID, userID, netPaise); err != nil {
			return fmt.Errorf("insert wallet payment row: %w", err)
		}

		// Stamp payment_method/payment_status on bookings so the CRM refund
		// dispatcher detects the wallet rail when the refund flow loads
		// booking metadata. The refund handler reads bookings.payment_method
		// as a fallback when pending_refunds doesn't carry it.
		if _, err := tx.Exec(ctx, `
			UPDATE bookings
			SET payment_method = 'wallet',
			    payment_status = 'paid',
			    updated_at = NOW()
			WHERE id = $1::uuid
		`, bookingID); err != nil {
			return fmt.Errorf("stamp booking payment fields: %w", err)
		}

		// Emit booking.paid in the same tx so the durable outbox row is
		// committed iff the wallet debit + payment row commit.
		payload, err := json.Marshal(map[string]any{
			"booking_id":   bookingID,
			"user_id":      userID,
			"amount_paise": netPaise,
			"gateway":      "wallet",
			"paid_at":      time.Now().UTC().Format(time.RFC3339),
		})
		if err != nil {
			return fmt.Errorf("marshal booking.paid payload: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO event_outbox (event_type, aggregate_id, payload)
			VALUES ($1, $2::uuid, $3::jsonb)
		`, "booking.paid", bookingID, payload); err != nil {
			return fmt.Errorf("insert booking.paid event: %w", err)
		}
		return nil
	})
}

// isInsufficientBalance unwraps the wallet package's ErrInsufficientBalance.
// Implemented as a string match instead of errors.Is to avoid importing
// internal/wallet (which would flip the dependency direction).
func isInsufficientBalance(err error) bool {
	return err != nil && strings.Contains(err.Error(), "insufficient balance")
}

// stampBookingDirectPay tags a freshly created booking as awaiting Cashfree
// payment. The booking is still in 'pending' status (no new enum value
// introduced — see scope decision in the bug fix); the customer-facing
// bookings list filters out rows where payment_method='cashfree' AND
// payment_status IS NOT 'paid' so they appear only after the webhook
// confirms payment. The webhook handler in internal/payments/handler.go
// flips payment_status to 'paid' inside the same tx as the ledger update.
//
// Errors are logged, never propagated: a tag glitch must not unwind a
// booking the customer already saw confirmed. Worst case the row stays
// payment_method=NULL and is treated as a legacy/COD booking — visible
// in upcoming. Better than failing the booking creation entirely.
func (s *Service) stampBookingDirectPay(ctx context.Context, bookingID string) {
	if _, err := s.db.Exec(ctx,
		`UPDATE bookings SET payment_method = 'cashfree', updated_at = NOW()
		 WHERE id = $1::uuid AND payment_method IS NULL`,
		bookingID,
	); err != nil {
		log.Warn().Err(err).Str("booking_id", bookingID).Msg("failed to stamp booking payment_method='cashfree'")
	}
}

// recordPaymentIntent inserts a pending payment row for a freshly created
// booking and emits payment.initiated. Errors are logged, never propagated —
// a ledger glitch must not unwind a booking the customer already saw confirmed.
func (s *Service) recordPaymentIntent(ctx context.Context, bookingID, customerID string, amountCents int) {
	if s.ledger == nil {
		return
	}
	if _, err := s.ledger.CreatePayment(ctx, &bookingID, customerID, int64(amountCents), "cod", nil); err != nil {
		log.Warn().Err(err).Str("booking_id", bookingID).Msg("payments ledger insert failed")
		return
	}
	if s.analytics != nil {
		s.analytics.Track(ctx, analytics.EventPaymentInitiated, customerID, bookingID, map[string]string{
			"amount_paise": fmt.Sprintf("%d", amountCents),
			"gateway":      "cod",
		})
	}
}

// SetMapsClient attaches a Google Maps client for tracking and ETA.
func (s *Service) SetMapsClient(c *googlemaps.Client) { s.maps = c }

// SetAnalytics attaches the analytics service for event tracking.
func (s *Service) SetAnalytics(svc *analytics.Service) { s.analytics = svc }

// SetWebhooks attaches the outbound webhook dispatcher (nil-safe — leaving it
// unset is the correct default in unit tests).
func (s *Service) SetWebhooks(d *webhooks.Dispatcher) { s.webhooks = d }

// fireWebhook is a nil-safe wrapper so unit tests don't need a real dispatcher.
func (s *Service) fireWebhook(ctx context.Context, event string, payload any) {
	if s.webhooks == nil {
		return
	}
	s.webhooks.Dispatch(ctx, event, payload)
}

// NewService creates a new booking service.
func NewService(repo *Repository, db *pgxpool.Pool, rdb *redis.Client, configSvc *config_manager.Service, batcher *matching.Batcher) *Service {
	var engine *matching.Engine
	if batcher != nil {
		engine = matching.NewEngine(db, rdb, configSvc)
	}
	return &Service{
		repo:         repo,
		db:           db,
		rdb:          rdb,
		configSvc:    configSvc,
		matchBatcher: batcher,
		matchEngine:  engine,
	}
}

// CreateBooking validates the service category, applies promo if present,
// and creates the booking record.
func (s *Service) CreateBooking(ctx context.Context, req *CreateBookingRequest, customerID string) (*Booking, error) {
	// Reject after 8pm / before 6am IST. Pros are off-shift overnight; the
	// matcher has nothing to invite, so the booking is closed at the API
	// boundary instead of being silently routed to the stealth path.
	if isInstantBookingClosed(time.Now()) {
		return nil, ErrInstantBookingClosed
	}

	// Check max active bookings from config.
	maxActiveStr, err := s.configSvc.GetConfig(ctx, config_manager.ConfigBookingMaxActivePerCustomer)
	if err != nil {
		log.Warn().Err(err).Msg("failed to get max active bookings config, using default")
		maxActiveStr = "1"
	}
	maxActive, parseErr := strconv.Atoi(maxActiveStr)
	if parseErr != nil {
		maxActive = 1
	}

	activeCount, err := s.repo.GetActiveBookingsCount(ctx, customerID)
	if err != nil {
		return nil, fmt.Errorf("failed to check active bookings: %w", err)
	}
	if activeCount >= maxActive {
		return nil, fmt.Errorf("maximum active bookings limit reached")
	}

	// Block re-booking when the customer has completed-but-unpaid Cashfree
	// bookings. Same predicate as the SoftDeleteUser guard — single source
	// of truth in Repository.GetUnpaidBookingsForCustomer. Revenue-leak
	// prevention: without this, a customer whose Cashfree webhook silently
	// failed could keep racking up bookings indefinitely.
	unpaidCount, unpaidTotal, err := s.repo.GetUnpaidBookingsForCustomer(ctx, customerID)
	if err != nil {
		return nil, fmt.Errorf("check unpaid bookings: %w", err)
	}
	if unpaidCount > 0 {
		return nil, &ErrUnpaidBookings{Count: unpaidCount, TotalPaise: unpaidTotal}
	}

	// Validate that the service category exists and is active.
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var basePriceCents int
	var isActive bool
	err = s.db.QueryRow(queryCtx,
		`SELECT base_price_cents, is_active FROM service_categories WHERE id = $1`,
		req.ServiceCategoryID,
	).Scan(&basePriceCents, &isActive)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("service category not found")
		}
		return nil, fmt.Errorf("failed to validate service category: %w", err)
	}
	if !isActive {
		return nil, fmt.Errorf("service category is not available")
	}

	// Calculate price (base price + platform fee from config).
	pricingConfig, pricingErr := s.configSvc.GetPricingConfig(ctx)
	if pricingErr != nil {
		log.Warn().Err(pricingErr).Msg("failed to get pricing config, using base price only")
		pricingConfig = &config_manager.PricingConfig{BaseFeeCents: 2000, SurgeMultiplier: 1.0}
	}

	totalPriceCents := basePriceCents + pricingConfig.BaseFeeCents
	if pricingConfig.SurgeEnabled && pricingConfig.SurgeMultiplier > 1.0 {
		totalPriceCents = int(float64(totalPriceCents) * pricingConfig.SurgeMultiplier)
	}

	discountCents := 0
	var promoCode *string

	// Apply promo code if present.
	if req.PromoCode != "" {
		promo, promoErr := s.ValidatePromoCode(ctx, req.PromoCode, totalPriceCents)
		if promoErr != nil {
			return nil, fmt.Errorf("invalid promo code: %w", promoErr)
		}
		if promo != nil {
			promoCode = &req.PromoCode
			if promo.DiscountType == "percent" {
				discountCents = totalPriceCents * promo.DiscountValue / 100
			} else { // fixed
				discountCents = promo.DiscountValue
			}
			if discountCents > totalPriceCents {
				discountCents = totalPriceCents
			}
		}
	}

	booking := &Booking{
		CustomerID:        customerID,
		ServiceCategoryID: req.ServiceCategoryID,
		Address:           req.Address,
		Lat:               req.Lat,
		Lng:               req.Lng,
		AmountPaise:        totalPriceCents,
		PromoCode:         promoCode,
		DiscountPaise:     discountCents,
	}

	if err := s.repo.CreateBooking(ctx, booking); err != nil {
		return nil, err
	}

	// Atomically increment promo code usage after booking is successfully created.
	if promoCode != nil && *promoCode != "" {
		if err := s.repo.IncrementPromoCodeUsage(ctx, *promoCode); err != nil {
			log.Warn().Err(err).Str("promo_code", *promoCode).Msg("failed to increment promo code usage")
			// Don't fail the booking creation if usage increment fails (booking already created)
		}
	}

	log.Info().
		Str("booking_id", booking.ID).
		Str("customer_id", customerID).
		Int("amount_paise", totalPriceCents).
		Int("discount_paise", discountCents).
		Msg("booking created")

	// Track booking creation event.
	s.analytics.Track(ctx, analytics.EventBookingCreated, customerID, booking.ID, map[string]string{
		"service_category_id": req.ServiceCategoryID,
		"amount_paise":         fmt.Sprintf("%d", totalPriceCents),
		"has_promo":           fmt.Sprintf("%v", promoCode != nil),
	})

	netPaise := totalPriceCents - discountCents

	if req.PaymentSource == "wallet" {
		if err := s.payBookingFromWallet(ctx, booking.ID, customerID, int64(netPaise)); err != nil {
			// Roll back the booking on wallet-debit failure so we don't
			// leave a pending unpaid row in the matching pipeline. Free
			// cancellation (fee=0) — customer never saw a confirmation.
			if cancelErr := s.repo.CancelBookingWithFee(ctx, booking.ID, "system", 0); cancelErr != nil {
				log.Error().Err(cancelErr).Str("booking_id", booking.ID).
					Msg("failed to roll back booking after wallet payment failure")
			}
			if errors.Is(err, ErrInsufficientWalletBalance) {
				return nil, ErrInsufficientWalletBalance
			}
			return nil, fmt.Errorf("wallet payment failed: %w", err)
		}
	} else {
		// Default / "direct" path: stamp payment_method='cashfree' so the
		// customer-facing bookings list filters this row out until the
		// webhook stamps payment_status='paid'. Without this tag the row
		// shows up in 'upcoming' the moment the user taps Confirm Booking,
		// before the SDK sheet opens. recordPaymentIntent stays for the
		// legacy ledger row (gateway='cod' placeholder, harmless).
		s.stampBookingDirectPay(ctx, booking.ID)
		s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise)
	}

	s.fireWebhook(ctx, webhooks.EventOrderCreated, webhooks.OrderEvent{
		OrderID:           booking.ID,
		Status:            string(StatusPending),
		CustomerID:        customerID,
		ServiceCategoryID: req.ServiceCategoryID,
		AmountPaise:        int64(totalPriceCents),
		OccurredAt:        time.Now().UTC(),
	})

	// ── Matching (instant bookings only) ──────────────────────────────────────
	// Track demand for the heatmap and enqueue into the batch matcher.
	// Scheduled bookings are NOT enqueued here — they are matched closer to
	// their scheduled_time by a separate pre-dispatch job.
	matching.TrackDemand(ctx, s.rdb, req.Lat, req.Lng)
	if s.matchBatcher != nil {
		s.matchBatcher.Enqueue(matching.BatchEntry{
			BookingID:  booking.ID,
			CustomerID: customerID,
			Lat:        req.Lat,
			Lng:        req.Lng,
			CellID:     matching.LatLngToCell(req.Lat, req.Lng),
			EnqueuedAt: time.Now(),
		})
	}

	return booking, nil
}

// GetBooking retrieves a booking with IDOR protection. For active bookings
// (pending/accepted) it also computes the can_cancel_free / free_cancel_until
// fields the customer-app needs to render the cancel CTA copy.
func (s *Service) GetBooking(ctx context.Context, bookingID, requestingUserID string) (*Booking, error) {
	b, err := s.repo.GetBookingByID(ctx, bookingID, requestingUserID)
	if err != nil {
		return nil, err
	}
	if b.Status == StatusPending || b.Status == StatusAccepted {
		start := CancellationStartTime(b)
		deadline := FreeCancelDeadline(start).UTC()
		canFree := IsFreeCancellation(start, time.Now())
		b.CanCancelFree = &canFree
		b.FreeCancelUntil = &deadline
	}
	return b, nil
}

// GetBookingDetail returns the enriched booking shape used by TrackLiveScreen:
// the base booking + the assigned helper (when present, with phone masking
// driven by the booking lifecycle stage) + every booking_services row.
//
// Phone masking rule: middle-mask (98XXXXX210) while the booking has not
// yet been accepted by a pro. Once the pro accepts, the customer is given
// the full 10-digit number so they can call. Cancelled / terminal-state
// bookings keep the unmasked number — at that point the privacy window
// is moot and customers may still need to follow up.
func (s *Service) GetBookingDetail(ctx context.Context, bookingID, requestingUserID string) (*BookingDetail, error) {
	b, err := s.GetBooking(ctx, bookingID, requestingUserID)
	if err != nil {
		return nil, err
	}
	detail := &BookingDetail{Booking: *b}

	if b.HelperID != nil {
		h, herr := s.repo.GetBookingDetailHelper(ctx, *b.HelperID)
		if herr != nil {
			return nil, herr
		}
		if h != nil {
			// Mask the phone for the customer pre-accept. Once the booking
			// is accepted (or has moved past), reveal the full number.
			if b.AcceptedAt == nil && b.Status == StatusPending {
				h.Phone = MaskPhone(h.Phone)
			}
			detail.Helper = h
		}
	}

	services, serr := s.repo.GetBookingDetailServices(ctx, bookingID)
	if serr != nil {
		return nil, serr
	}
	detail.Services = services
	return detail, nil
}

// CancelBooking cancels a booking. Free if requested more than 30m before
// the scheduled start time; otherwise stamps a cancellation fee. Returns the
// outcome so the caller can echo the fee back to the user.
func (s *Service) CancelBooking(ctx context.Context, bookingID, userID string) (*CancelBookingResponse, error) {
	booking, err := s.repo.GetBookingByID(ctx, bookingID, userID)
	if err != nil {
		return nil, err
	}

	// Truth-table guard. IsCancellable encodes the full rule (status +
	// the accepted-substate timestamps) so this site can't drift from
	// the policy and so cancel_truth_table_test.go can pin it from
	// outside the SQL transaction. See model.go for the rationale +
	// docs/phase-1-payment-gated-flow.md for the escape-hatch model
	// that depends on in_progress cancel being unavailable.
	if !IsCancellable(booking) {
		return nil, fmt.Errorf("booking cannot be cancelled in current status")
	}

	start := CancellationStartTime(booking)
	feeCents := 0
	if !IsFreeCancellation(start, time.Now()) {
		feeCents = DefaultCancellationFeeCents
		log.Info().
			Str("booking_id", bookingID).
			Str("user_id", userID).
			Int("fee_cents", feeCents).
			Msg("booking cancelled outside free window; fee applied")
	}

	if err := s.repo.CancelBookingWithFee(ctx, bookingID, "customer", feeCents); err != nil {
		return nil, err
	}

	s.analytics.Track(ctx, analytics.EventBookingCancelled, userID, bookingID, map[string]string{
		"cancelled_by": "customer",
		"status_was":   string(booking.Status),
	})

	s.fireWebhook(ctx, webhooks.EventOrderCancelled, webhooks.OrderCancelledEvent{
		OrderEvent: webhooks.OrderEvent{
			OrderID:           bookingID,
			Status:            string(StatusCancelled),
			CustomerID:        booking.CustomerID,
			HelperID:          booking.HelperID,
			ServiceCategoryID: booking.ServiceCategoryID,
			AmountPaise:        int64(booking.AmountPaise),
			OccurredAt:        time.Now().UTC(),
		},
		CancelledBy: "customer",
	})

	// Clear Redis match keys so helpers immediately stop seeing this invite.
	if s.matchEngine != nil {
		mw.SafeGo("booking.cancel.clear_match", func() {
			s.matchEngine.ClearMatchOnAccept(context.Background(), bookingID, "")
		})
	}

	log.Info().Str("booking_id", bookingID).Str("user_id", userID).Msg("booking cancelled")
	return &CancelBookingResponse{
		Message:                "booking cancelled",
		CancellationFeeApplied: feeCents > 0,
		CancellationFeeCents:   feeCents,
	}, nil
}

// AcceptBooking allows a helper to accept a pending booking.
func (s *Service) AcceptBooking(ctx context.Context, bookingID, helperID string) error {
	// Get the pending booking without IDOR checks (no helper assigned yet).
	booking, err := s.repo.GetPendingBookingByID(ctx, bookingID)
	if err != nil {
		return err
	}

	maxActiveStr, err := s.configSvc.GetConfig(ctx, config_manager.ConfigBookingMaxActivePerHelper)
	if err != nil {
		log.Warn().Err(err).Msg("failed to get max helper active bookings config, using default")
		maxActiveStr = "3"
	}
	maxActive, parseErr := strconv.Atoi(maxActiveStr)
	if parseErr != nil {
		maxActive = 3
	}

	helperName := ""
	helperRow := s.db.QueryRow(ctx, "SELECT COALESCE(name, '') FROM users WHERE id = $1 AND "+users.AliveCondition, helperID)
	if err := helperRow.Scan(&helperName); err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to fetch helper name for notification")
		helperName = "a helper"
	}

	// Walking-ETA guard. Reuse the same Google Maps walking-time call the
	// matching engine uses (filterByWalkingTime). Fail-open on every error
	// path — Maps outage must not block helpers from accepting.
	if s.maps != nil {
		var helperLat, helperLng float64
		gotCoords := false
		if s.rdb != nil {
			geoPos, geoErr := s.rdb.GeoPos(ctx, "helpers:locations", helperID).Result()
			if geoErr == nil && len(geoPos) > 0 && geoPos[0] != nil {
				helperLat = geoPos[0].Latitude
				helperLng = geoPos[0].Longitude
				gotCoords = true
			}
		}
		if !gotCoords {
			coordCtx, coordCancel := context.WithTimeout(ctx, 2*time.Second)
			var lat, lng *float64
			if err := s.db.QueryRow(coordCtx,
				`SELECT current_lat, current_lng FROM helpers WHERE id = $1`,
				helperID,
			).Scan(&lat, &lng); err == nil && lat != nil && lng != nil {
				helperLat = *lat
				helperLng = *lng
				gotCoords = true
			}
			coordCancel()
		}

		if gotCoords {
			etaCtx, etaCancel := context.WithTimeout(ctx, 5*time.Second)
			mins, mapsErr := s.maps.GetTravelMinutes(etaCtx, helperLat, helperLng, booking.Lat, booking.Lng)
			etaCancel()
			switch {
			case mapsErr != nil || mins == 0:
				// Fail-open: Maps unavailable or returned a sentinel zero.
				log.Warn().Err(mapsErr).Str("helper_id", helperID).
					Str("booking_id", bookingID).
					Msg("[booking] walking-ETA guard skipped — Maps unavailable")
			case mins > acceptMaxWalkingMinutes:
				log.Info().Str("helper_id", helperID).Str("booking_id", bookingID).
					Int("walking_minutes", mins).
					Msg("[booking] accept blocked — too far away")
				return ErrTooFarAway
			}
		}
	}

	if err := s.repo.AcceptBooking(ctx, bookingID, helperID, maxActive); err != nil {
		return err
	}

	s.analytics.Track(ctx, analytics.EventBookingAccepted, helperID, bookingID, map[string]string{
		"customer_id": booking.CustomerID,
	})

	helperRef := helperID
	s.fireWebhook(ctx, webhooks.EventOrderAssigned, webhooks.OrderEvent{
		OrderID:           bookingID,
		Status:            string(StatusAccepted),
		CustomerID:        booking.CustomerID,
		HelperID:          &helperRef,
		ServiceCategoryID: booking.ServiceCategoryID,
		AmountPaise:        int64(booking.AmountPaise),
		OccurredAt:        time.Now().UTC(),
	})

	log.Info().Str("booking_id", bookingID).Str("helper_id", helperID).Msg("booking accepted by helper")
	return nil
}

// GetCartItemsForUser fetches cart items for a user and converts them to BookingServiceItems.
func (s *Service) GetCartItemsForUser(ctx context.Context, userID string) ([]BookingServiceItem, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	rows, err := s.db.Query(queryCtx,
		`SELECT ci.service_id, sc.name, ci.duration_minutes, ci.price_cents
		 FROM cart_items ci
		 JOIN cart c ON c.id = ci.cart_id
		 JOIN service_categories sc ON sc.id = ci.service_id
		 WHERE c.user_id = $1
		 ORDER BY ci.created_at ASC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch cart items: %w", err)
	}
	defer rows.Close()

	var items []BookingServiceItem
	for rows.Next() {
		var item BookingServiceItem
		if err := rows.Scan(&item.ServiceID, &item.ServiceName, &item.DurationMinutes, &item.PriceCents); err != nil {
			return nil, fmt.Errorf("failed to scan cart item: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// GetSlotScheduledTime returns the start timestamp for a time slot as RFC3339.
func (s *Service) GetSlotScheduledTime(ctx context.Context, slotID string) (string, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var scheduledTime string
	err := s.db.QueryRow(queryCtx,
		`SELECT to_char((slot_date + start_time) AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC',
		               'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		 FROM time_slots WHERE id = $1 AND is_active = true`,
		slotID,
	).Scan(&scheduledTime)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", fmt.Errorf("time slot not found or unavailable")
		}
		return "", fmt.Errorf("failed to get slot time: %w", err)
	}
	return scheduledTime, nil
}

// ClearUserCart removes all items from the user's cart after a successful booking.
func (s *Service) ClearUserCart(ctx context.Context, userID string) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if _, err := s.db.Exec(queryCtx,
		`DELETE FROM cart_items WHERE cart_id = (SELECT id FROM cart WHERE user_id = $1)`,
		userID,
	); err != nil {
		log.Warn().Err(err).Str("user_id", userID).Msg("failed to clear cart after booking")
	}
}

// classifyScheduling decides whether a scheduled booking is "normal" (sits in
// the nightly 10pm cron's queue) or "stealth instant" (the customer placed
// it after the 8pm IST cutoff and the stealth dispatch cron handles it
// closer to fire time). Also enforces the 2-day lead-time cap.
//
// Returns isStealth, fireAt (non-nil only when isStealth=true), or an error
// matching ErrSlotInPast / ErrSlotTooFar. scheduledTime must be a parsable
// RFC3339 timestamp.
func (s *Service) classifyScheduling(scheduledTimeRFC3339 string) (bool, *time.Time, error) {
	scheduled, err := time.Parse(time.RFC3339, scheduledTimeRFC3339)
	if err != nil {
		return false, nil, fmt.Errorf("invalid scheduled time: %w", err)
	}
	loc := indiaLocation()
	scheduled = scheduled.In(loc)
	now := time.Now().In(loc)

	if scheduled.Before(now) {
		return false, nil, ErrSlotInPast
	}

	// Cap = midnight at end of (today + maxLeadDays). 2 days from "today"
	// means the customer can pick today, tomorrow, or day-after-tomorrow.
	maxDay := time.Date(
		now.Year(), now.Month(), now.Day()+scheduledBookingMaxLeadDays, 23, 59, 59, 0, loc,
	)
	if scheduled.After(maxDay) {
		return false, nil, ErrSlotTooFar
	}

	if now.Hour() >= schedulingCutoffHourIST {
		// Past 8pm IST — customer is allowed to book (Cutoff Rule §2 of the
		// spec) but the booking goes into the stealth path. fire_at fires
		// the invite chain a bit before the slot starts.
		fire := scheduled.Add(-stealthFireLeadTime).UTC()
		return true, &fire, nil
	}
	return false, nil, nil
}

// resolveLocality looks up the customer's chosen address and tries to pin it
// to one of the active localities. Match strategy: token-set containment.
// Each locality.name is split into lowercase alphanumeric tokens, the
// address text is split the same way, and a locality matches when every one
// of its tokens appears as an exact element in the address's token set.
// Longest locality (by character length) wins on ties so "DLF Phase 5" beats
// "DLF Phase 1" when both could match.
//
// Substring matching was the v1 approach but missed real-world addresses
// like "DLF Cyber City, Phase 2, Gurugram" — "DLF Phase 2" is not a
// substring there, but the token set {dlf, cyber, city, phase, 2, gurugram}
// is a superset of {dlf, phase, 2}.
//
// Returns nil (not an error) when nothing matches — the dispatch crons will
// fall back to "any pro" mode.
func (s *Service) resolveLocality(ctx context.Context, addressID string) (*string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	var addressText string
	err := s.db.QueryRow(ctx,
		`SELECT COALESCE(full_address, '') FROM user_addresses WHERE id = $1::uuid`,
		addressID,
	).Scan(&addressText)
	if err != nil {
		return nil, fmt.Errorf("locality lookup: load address: %w", err)
	}
	if addressText == "" {
		return nil, nil
	}

	addrTokens := tokenizeForLocality(addressText)
	addrSet := make(map[string]struct{}, len(addrTokens))
	for _, t := range addrTokens {
		addrSet[t] = struct{}{}
	}

	rows, err := s.db.Query(ctx,
		`SELECT name FROM localities WHERE active = true ORDER BY length(name) DESC`)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("locality lookup: list: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("locality lookup: scan: %w", err)
		}
		nameTokens := tokenizeForLocality(name)
		if len(nameTokens) == 0 {
			continue
		}
		all := true
		for _, t := range nameTokens {
			if _, ok := addrSet[t]; !ok {
				all = false
				break
			}
		}
		if all {
			return &name, nil
		}
	}
	return nil, rows.Err()
}

// tokenizeForLocality splits s into lowercase tokens of [a-z0-9]. Anything
// else (whitespace, commas, periods, hyphens, etc.) is a separator. Empty
// tokens are dropped. ASCII-only — addresses come from Google Places + the
// pro/customer manual entry, which today never round-trip non-ASCII glyphs.
func tokenizeForLocality(s string) []string {
	out := make([]string, 0, 8)
	cur := make([]byte, 0, 16)
	flush := func() {
		if len(cur) > 0 {
			out = append(out, string(cur))
			cur = cur[:0]
		}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z':
			cur = append(cur, c+32)
		case (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'):
			cur = append(cur, c)
		default:
			flush()
		}
	}
	flush()
	return out
}

// KeepLookingBooking extends the stealth-search window by another 15 minutes.
// Only valid when the booking is currently in 'pending_customer_action' and
// the caller is the customer who placed it.
//
// Implementation: bump fire_at to NOW (so the next stealth-dispatch tick
// picks it up) and reset status to 'pending'. The next cron run will flip
// it back to 'searching' and rerun the invite chain.
func (s *Service) KeepLookingBooking(ctx context.Context, bookingID, userID string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var customerID string
	var status string
	var isStealth bool
	err := s.db.QueryRow(ctx,
		`SELECT customer_id::text, status, is_stealth_instant FROM bookings WHERE id = $1::uuid`,
		bookingID,
	).Scan(&customerID, &status, &isStealth)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("booking not found")
		}
		return err
	}
	if customerID != userID {
		return fmt.Errorf("forbidden")
	}
	if status != "pending_customer_action" || !isStealth {
		return fmt.Errorf("booking not in pending_customer_action")
	}
	_, err = s.db.Exec(ctx, `
		UPDATE bookings
		SET status     = 'pending',
		    fire_at    = now(),
		    updated_at = now()
		WHERE id = $1::uuid
	`, bookingID)
	return err
}

// CreateScheduledBooking creates a booking using cart items + time slot.
// The cart must be non-empty. Items are converted to BookingServiceItems and
// the cart is cleared on success.
//
// Cutoff handling — see classifyScheduling. Slots more than 2 days out are
// rejected; slots placed after 8pm IST get the stealth-instant treatment.
func (s *Service) CreateScheduledBooking(
	ctx context.Context,
	customerID string,
	req *CreateScheduledBookingRequest,
	cartItems []BookingServiceItem,
	scheduledTime string,
) (*ScheduledBooking, error) {
	if len(cartItems) == 0 {
		return nil, fmt.Errorf("cart is empty")
	}

	// Hard cap: max simultaneous active bookings per customer. Same gate as
	// instant CreateBooking — covers Zop, app, and any future entrypoint.
	maxActiveStr, _ := s.configSvc.GetConfig(ctx, config_manager.ConfigBookingMaxActivePerCustomer)
	maxActive, parseErr := strconv.Atoi(maxActiveStr)
	if parseErr != nil || maxActive <= 0 {
		maxActive = 2
	}
	activeCount, countErr := s.repo.GetActiveBookingsCount(ctx, customerID)
	if countErr != nil {
		return nil, fmt.Errorf("failed to check active bookings: %w", countErr)
	}
	if activeCount >= maxActive {
		return nil, fmt.Errorf("maximum active bookings limit reached")
	}

	// Block re-booking when the customer has completed-but-unpaid Cashfree
	// bookings. Mirror of the gate in CreateBooking — same predicate, same
	// error type, same handler mapping.
	unpaidCount, unpaidTotal, unpaidErr := s.repo.GetUnpaidBookingsForCustomer(ctx, customerID)
	if unpaidErr != nil {
		return nil, fmt.Errorf("check unpaid bookings: %w", unpaidErr)
	}
	if unpaidCount > 0 {
		return nil, &ErrUnpaidBookings{Count: unpaidCount, TotalPaise: unpaidTotal}
	}

	isStealth, fireAt, schedErr := s.classifyScheduling(scheduledTime)
	if schedErr != nil {
		return nil, schedErr
	}

	// SECURITY: ensure the address being booked actually belongs to the caller.
	// Without this, any authed user can submit another user's address_id.
	{
		ownCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		var ownsAddress bool
		err := s.db.QueryRow(ownCtx,
			`SELECT EXISTS(SELECT 1 FROM user_addresses WHERE id=$1 AND user_id=$2)`,
			req.AddressID, customerID,
		).Scan(&ownsAddress)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("address ownership check: %w", err)
		}
		if !ownsAddress {
			return nil, ErrAddressNotOwned
		}
	}

	locality, locErr := s.resolveLocality(ctx, req.AddressID)
	if locErr != nil {
		// Don't fail the booking on a locality lookup hiccup — log and let
		// the dispatch chain fall back to "no locality" mode.
		log.Warn().Err(locErr).Str("address_id", req.AddressID).Msg("[booking] locality resolve failed")
		locality = nil
	}

	// Calculate total price from items + platform fee (matches cart display).
	totalPriceCents := 0
	for _, item := range cartItems {
		totalPriceCents += item.PriceCents
	}
	pricingCfg, pricingErr := s.configSvc.GetPricingConfig(ctx)
	if pricingErr != nil {
		log.Warn().Err(pricingErr).Msg("[booking] pricing config unavailable, using default platform fee")
		pricingCfg = &config_manager.PricingConfig{BaseFeeCents: 2000, SurgeMultiplier: 1.0}
	}
	totalPriceCents += pricingCfg.BaseFeeCents

	discountCents := 0
	var promoCode *string

	if req.PromoCode != "" {
		promo, promoErr := s.ValidatePromoCode(ctx, req.PromoCode, totalPriceCents)
		if promoErr != nil {
			return nil, fmt.Errorf("invalid promo code: %w", promoErr)
		}
		if promo != nil {
			promoCode = &req.PromoCode
			if promo.DiscountType == "percent" {
				discountCents = totalPriceCents * promo.DiscountValue / 100
			} else {
				discountCents = promo.DiscountValue
			}
			if discountCents > totalPriceCents {
				discountCents = totalPriceCents
			}
		}
	}

	booking, err := s.repo.CreateScheduledBooking(
		ctx, customerID, req.AddressID, req.TimeSlotID,
		scheduledTime, cartItems,
		totalPriceCents, discountCents, promoCode,
		isStealth, fireAt, locality,
	)
	if err != nil {
		return nil, err
	}

	if promoCode != nil {
		if err := s.repo.IncrementPromoCodeUsage(ctx, *promoCode); err != nil {
			log.Warn().Err(err).Str("promo_code", *promoCode).Msg("failed to increment promo code usage")
		}
	}

	s.analytics.Track(ctx, analytics.EventBookingCreated, customerID, booking.ID, map[string]string{
		"type":         "scheduled",
		"amount_paise": fmt.Sprintf("%d", totalPriceCents),
		"has_promo":    fmt.Sprintf("%v", promoCode != nil),
	})

	netPaise := totalPriceCents - discountCents
	if req.PaymentSource == "wallet" {
		if err := s.payBookingFromWallet(ctx, booking.ID, customerID, int64(netPaise)); err != nil {
			if cancelErr := s.repo.CancelBookingWithFee(ctx, booking.ID, "system", 0); cancelErr != nil {
				log.Error().Err(cancelErr).Str("booking_id", booking.ID).
					Msg("failed to roll back scheduled booking after wallet payment failure")
			}
			if errors.Is(err, ErrInsufficientWalletBalance) {
				return nil, ErrInsufficientWalletBalance
			}
			return nil, fmt.Errorf("wallet payment failed: %w", err)
		}
	} else {
		s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise)
	}

	log.Info().
		Str("booking_id", booking.ID).
		Str("customer_id", customerID).
		Int("services", len(cartItems)).
		Int("amount_paise", totalPriceCents).
		Msg("scheduled booking created")

	return booking, nil
}

// CreateInstantBookingFromCart is the cart-based instant booking entrypoint
// used by the Zop AI assistant's `create_instant_booking` tool. The legacy
// `CreateBooking` path is single-service and prices off `service_categories`
// + `BaseFeeCents` + surge — the LLM never sees those add-ons, so its
// rendered total would diverge from the booking total. We need the same
// cart-derived totals as `CreateScheduledBooking`, BUT the booking must hit
// the matcher batcher in real time (not the nightly scheduled cron). This
// method bridges the two: insert via the cart-aware repo, stamp lat/lng/
// address onto the row from the chosen saved address, then enqueue into
// the batcher exactly like `CreateBooking` does.
func (s *Service) CreateInstantBookingFromCart(
	ctx context.Context,
	customerID, addressID, timeSlotID, scheduledTime string,
	cartItems []BookingServiceItem,
	promoCode string,
	paymentSource string,
) (*ScheduledBooking, error) {
	if isInstantBookingClosed(time.Now()) {
		return nil, ErrInstantBookingClosed
	}
	if len(cartItems) == 0 {
		return nil, fmt.Errorf("cart is empty")
	}

	maxActiveStr, _ := s.configSvc.GetConfig(ctx, config_manager.ConfigBookingMaxActivePerCustomer)
	maxActive, parseErr := strconv.Atoi(maxActiveStr)
	if parseErr != nil || maxActive <= 0 {
		maxActive = 2
	}
	activeCount, countErr := s.repo.GetActiveBookingsCount(ctx, customerID)
	if countErr != nil {
		return nil, fmt.Errorf("failed to check active bookings: %w", countErr)
	}
	if activeCount >= maxActive {
		return nil, fmt.Errorf("maximum active bookings limit reached")
	}

	// Address ownership + coords come from user_addresses. The matcher needs
	// real lat/lng; the repo's INSERT writes 0,0 by default.
	var lat, lng float64
	var addressText string
	addrCtx, addrCancel := context.WithTimeout(ctx, 5*time.Second)
	addrErr := s.db.QueryRow(addrCtx,
		`SELECT lat, lon, COALESCE(full_address, '')
		 FROM user_addresses WHERE id = $1::uuid AND user_id = $2::uuid`,
		addressID, customerID,
	).Scan(&lat, &lng, &addressText)
	addrCancel()
	if addrErr != nil {
		if errors.Is(addrErr, pgx.ErrNoRows) {
			return nil, ErrAddressNotOwned
		}
		return nil, fmt.Errorf("address lookup: %w", addrErr)
	}

	locality, locErr := s.resolveLocality(ctx, addressID)
	if locErr != nil {
		log.Warn().Err(locErr).Str("address_id", addressID).Msg("[booking] locality resolve failed")
		locality = nil
	}

	totalPriceCents := 0
	for _, item := range cartItems {
		totalPriceCents += item.PriceCents
	}
	pricingCfgI, pricingErrI := s.configSvc.GetPricingConfig(ctx)
	if pricingErrI != nil {
		log.Warn().Err(pricingErrI).Msg("[booking] pricing config unavailable, using default platform fee")
		pricingCfgI = &config_manager.PricingConfig{BaseFeeCents: 2000, SurgeMultiplier: 1.0}
	}
	totalPriceCents += pricingCfgI.BaseFeeCents

	discountCents := 0
	var promoCodePtr *string
	if promoCode != "" {
		promo, perr := s.ValidatePromoCode(ctx, promoCode, totalPriceCents)
		if perr != nil {
			return nil, fmt.Errorf("invalid promo code: %w", perr)
		}
		if promo != nil {
			promoCodePtr = &promoCode
			if promo.DiscountType == "percent" {
				discountCents = totalPriceCents * promo.DiscountValue / 100
			} else {
				discountCents = promo.DiscountValue
			}
			if discountCents > totalPriceCents {
				discountCents = totalPriceCents
			}
		}
	}

	// Insert with isStealthInstant=false + fireAt=nil so the stealth/
	// scheduled crons leave it alone — the matcher batcher owns this row.
	booking, err := s.repo.CreateScheduledBooking(
		ctx, customerID, addressID, timeSlotID,
		scheduledTime, cartItems,
		totalPriceCents, discountCents, promoCodePtr,
		false, nil, locality,
	)
	if err != nil {
		return nil, err
	}

	// Stamp coords + address onto the row so the batcher's pending-bookings
	// rescan picks up real lat/lng (FetchPendingUnmatched reads them) and
	// the customer-facing match status renders the correct address.
	if _, err := s.db.Exec(ctx,
		`UPDATE bookings SET lat = $1, lng = $2, address = $3 WHERE id = $4::uuid`,
		lat, lng, addressText, booking.ID,
	); err != nil {
		log.Warn().Err(err).Str("booking_id", booking.ID).
			Msg("[booking] failed to stamp coords on instant booking — matcher may miss it")
	}

	if promoCodePtr != nil {
		if err := s.repo.IncrementPromoCodeUsage(ctx, *promoCodePtr); err != nil {
			log.Warn().Err(err).Str("promo_code", *promoCodePtr).Msg("failed to increment promo code usage")
		}
	}

	s.analytics.Track(ctx, analytics.EventBookingCreated, customerID, booking.ID, map[string]string{
		"type":         "instant_cart",
		"amount_paise": fmt.Sprintf("%d", totalPriceCents),
		"has_promo":    fmt.Sprintf("%v", promoCodePtr != nil),
	})

	netPaise := totalPriceCents - discountCents
	if paymentSource == "wallet" {
		if err := s.payBookingFromWallet(ctx, booking.ID, customerID, int64(netPaise)); err != nil {
			if cancelErr := s.repo.CancelBookingWithFee(ctx, booking.ID, "system", 0); cancelErr != nil {
				log.Error().Err(cancelErr).Str("booking_id", booking.ID).
					Msg("failed to roll back instant cart booking after wallet payment failure")
			}
			if errors.Is(err, ErrInsufficientWalletBalance) {
				return nil, ErrInsufficientWalletBalance
			}
			return nil, fmt.Errorf("wallet payment failed: %w", err)
		}
	} else {
		s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise)
	}

	matching.TrackDemand(ctx, s.rdb, lat, lng)
	if s.matchBatcher != nil {
		s.matchBatcher.Enqueue(matching.BatchEntry{
			BookingID:  booking.ID,
			CustomerID: customerID,
			Lat:        lat,
			Lng:        lng,
			CellID:     matching.LatLngToCell(lat, lng),
			EnqueuedAt: time.Now(),
		})
	}

	log.Info().
		Str("booking_id", booking.ID).
		Str("customer_id", customerID).
		Int("services", len(cartItems)).
		Int("amount_paise", totalPriceCents).
		Float64("lat", roundLogCoord(lat)).Float64("lng", roundLogCoord(lng)).
		Msg("instant booking created via cart")

	return booking, nil
}

// ValidatePromoCode validates a promo code and returns the discount.
func (s *Service) ValidatePromoCode(ctx context.Context, code string, orderAmountCents int) (*admin.Promotion, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var promo admin.Promotion
	err := s.db.QueryRow(queryCtx,
		`SELECT id, code, discount_type, discount_value, min_order_cents, max_uses, uses_count,
		        is_active, expires_at, created_by, created_at
		 FROM promotions
		 WHERE code = $1 AND is_active = true`,
		code,
	).Scan(
		&promo.ID, &promo.Code, &promo.DiscountType, &promo.DiscountValue,
		&promo.MinOrderCents, &promo.MaxUses, &promo.UsesCount,
		&promo.IsActive, &promo.ExpiresAt, &promo.CreatedBy, &promo.CreatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, fmt.Errorf("promo code not found or expired")
		}
		return nil, fmt.Errorf("failed to validate promo code: %w", err)
	}

	// Check expiry.
	if promo.ExpiresAt != nil && time.Now().After(*promo.ExpiresAt) {
		return nil, fmt.Errorf("promo code has expired")
	}

	// Check max uses.
	if promo.MaxUses > 0 && promo.UsesCount >= promo.MaxUses {
		return nil, fmt.Errorf("promo code usage limit reached")
	}

	// Check minimum order amount.
	if orderAmountCents < promo.MinOrderCents {
		return nil, fmt.Errorf("order amount below minimum for this promo code")
	}

	return &promo, nil
}

// GetMatchStatus returns the current matching state for a booking.
// Called by the customer's mobile client to poll for an assigned helper.
func (s *Service) GetMatchStatus(ctx context.Context, bookingID, customerID string) (*MatchStatusResponse, error) {
	// Fetch the booking — IDOR check ensures only the customer can query it.
	booking, err := s.repo.GetBookingByID(ctx, bookingID, customerID)
	if err != nil {
		return nil, err
	}

	// If a helper has already accepted, return matched + helper details.
	if booking.HelperID != nil {
		queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		var helper MatchedHelper
		err := s.db.QueryRow(queryCtx,
			`SELECT u.id, COALESCE(u.name,''), COALESCE(u.phone,''),
			        COALESCE(h.rating,5.0),
			        COALESCE(u.avatar_url,''),
			        COALESCE(h.total_jobs,0)
			 FROM users u
			 JOIN helpers h ON h.id = u.id
			 WHERE u.id = $1`,
			*booking.HelperID,
		).Scan(&helper.ID, &helper.Name, &helper.Phone, &helper.Rating, &helper.PhotoURL, &helper.TotalJobs)
		if err != nil {
			log.Warn().Err(err).Str("helper_id", *booking.HelperID).Msg("could not fetch helper details")
		}

		// Prefer Redis GEO (updated every ~10s by WebSocket) over stale Postgres columns.
		geoPos, geoErr := s.rdb.GeoPos(ctx, "helpers:locations", *booking.HelperID).Result()
		if geoErr == nil && len(geoPos) > 0 && geoPos[0] != nil {
			helper.Lat = geoPos[0].Latitude
			helper.Lng = geoPos[0].Longitude
		} else {
			// Fallback to Postgres.
			_ = s.db.QueryRow(queryCtx,
				`SELECT COALESCE(current_lat, 0), COALESCE(current_lng, 0) FROM helpers WHERE id = $1`,
				*booking.HelperID,
			).Scan(&helper.Lat, &helper.Lng)
		}

		// ETA = straight-line distance / 25 km/h average Delhi speed, rounded
		// to nearest integer minute. Helper coords were just populated from
		// Redis (preferred) or Postgres (fallback) above; if both lookups
		// failed they're zero-valued and we fall back to a 30-min default.
		if helper.Lat != 0 || helper.Lng != 0 {
			distKm := haversineKm(helper.Lat, helper.Lng, booking.Lat, booking.Lng)
			helper.ETAMinutes = int(math.Round(distKm / 25.0 * 60.0))
			if helper.ETAMinutes < 1 {
				helper.ETAMinutes = 1
			}
		} else {
			helper.ETAMinutes = 30
		}

		return &MatchStatusResponse{
			Status:        "matched",
			Helper:        &helper,
			BookingStatus: string(booking.Status),
			EnRoute:       booking.EnRouteAt != nil,
			Arrived:       booking.ArrivedAt != nil,
			InProgress:    booking.StartedAt != nil,
			Completed:     booking.CompletedAt != nil,
		}, nil
	}

	// If the booking is cancelled, report failed immediately — check this before
	// Redis so a cancelled-but-still-in-Redis booking doesn't falsely show "searching".
	if booking.Status == StatusCancelled {
		// Distinguish "no pro available" (invite chain exhausted, server-side
		// cancel) from a user-initiated cancel so the customer app can surface
		// the right CTAs. invite_exhausted_at is set by the dispatch worker
		// only when the chain has rolled through every eligible pro.
		bookingStatus := string(booking.Status)
		var inviteExhaustedAt *time.Time
		_ = s.db.QueryRow(ctx,
			`SELECT invite_exhausted_at FROM bookings WHERE id = $1`, bookingID,
		).Scan(&inviteExhaustedAt)
		if inviteExhaustedAt != nil {
			bookingStatus = "no_pro_available"
		}
		return &MatchStatusResponse{Status: "failed", BookingStatus: bookingStatus}, nil
	}

	// Booking not yet accepted. Check if it's still in the match window via Redis.
	if s.matchEngine != nil {
		matches, _ := s.matchEngine.GetBookingMatches(ctx, bookingID)
		if len(matches) > 0 {
			// Helpers have been notified but none accepted yet.
			return &MatchStatusResponse{Status: "searching"}, nil
		}
	}

	// Still pending with no Redis data — matching window may have expired.
	createdAt := booking.CreatedAt
	if time.Since(createdAt) > 120*time.Second {
		return &MatchStatusResponse{Status: "failed"}, nil
	}

	return &MatchStatusResponse{Status: "searching"}, nil
}

// GetHelperInvites returns the booking IDs this helper has been invited to accept.
// It validates each invite against Postgres and silently prunes any that are no
// longer pending (cancelled, accepted by another helper, timed out, etc.).
func (s *Service) GetHelperInvites(ctx context.Context, helperID string) ([]string, error) {
	if s.matchEngine == nil {
		return []string{}, nil
	}
	ids, err := s.matchEngine.GetHelperInvites(ctx, helperID)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return []string{}, nil
	}

	validIDs := make([]string, 0, len(ids))
	staleIDs := make([]string, 0)

	// Single round-trip batch validation (audit D3-F1). The previous
	// implementation issued one SELECT per invite — for a 30-pending-
	// invite helper that was 30 round-trips per poll tick. The query
	// returns only IDs still in StatusPending; anything not returned
	// (cancelled, accepted, taken, deleted) is stale.
	validSet := make(map[string]struct{}, len(ids))
	rows, qErr := s.db.Query(ctx,
		`SELECT id::text FROM bookings WHERE id = ANY($1::uuid[]) AND status = $2`,
		ids, string(StatusPending),
	)
	if qErr != nil {
		// Treat all as stale on query failure — the caller's next poll
		// will re-fetch the canonical Redis set anyway, so this fails
		// safe rather than serving stale "valid" entries.
		log.Warn().Err(qErr).Str("helper_id", helperID).Msg("[booking.GetHelperInvites] batch validation query failed")
		staleIDs = append(staleIDs, ids...)
	} else {
		for rows.Next() {
			var id string
			if scanErr := rows.Scan(&id); scanErr == nil {
				validSet[id] = struct{}{}
			}
		}
		rows.Close()

		for _, bookingID := range ids {
			if _, ok := validSet[bookingID]; ok {
				validIDs = append(validIDs, bookingID)
			} else {
				staleIDs = append(staleIDs, bookingID)
			}
		}
	}

	// Remove stale invites from Redis so they never show up again.
	if len(staleIDs) > 0 {
		mw.SafeGo("booking.invites.prune_stale", func() {
			s.matchEngine.RemoveHelperInvites(context.Background(), helperID, staleIDs)
		})
	}

	return validIDs, nil
}

// GetTracking returns the helper's live location, ETA and route polyline for an
// active booking.  Both the customer and the assigned helper may call this.
func (s *Service) GetTracking(ctx context.Context, bookingID, requestingUserID string) (*TrackingResponse, error) {
	booking, err := s.repo.GetBookingByID(ctx, bookingID, requestingUserID)
	if err != nil {
		return nil, err
	}
	if booking.Status != StatusAccepted && booking.Status != StatusInProgress {
		return nil, fmt.Errorf("tracking not available for booking in status %s", booking.Status)
	}
	if booking.HelperID == nil {
		return nil, fmt.Errorf("no helper assigned to this booking")
	}

	// Fetch helper's live location — prefer Redis GEO (updated by WebSocket every ~10s)
	// over Postgres current_lat/lng which is only updated by REST PUT /helpers/me/location.
	var helperLat, helperLng float64
	geoPos, geoErr := s.rdb.GeoPos(ctx, "helpers:locations", *booking.HelperID).Result()
	if geoErr == nil && len(geoPos) > 0 && geoPos[0] != nil {
		helperLat = geoPos[0].Latitude
		helperLng = geoPos[0].Longitude
	} else {
		// Fallback to Postgres (populated by REST PUT /helpers/me/location).
		qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_ = s.db.QueryRow(qCtx,
			`SELECT COALESCE(current_lat,0), COALESCE(current_lng,0)
			 FROM helpers WHERE id = $1`,
			*booking.HelperID,
		).Scan(&helperLat, &helperLng)
	}

	resp := &TrackingResponse{
		HelperLat:     helperLat,
		HelperLng:     helperLng,
		CustomerLat:   booking.Lat,
		CustomerLng:   booking.Lng,
		LastUpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}

	// Enrich with Google Maps directions if available.
	if s.maps != nil && helperLat != 0 && helperLng != 0 {
		dir, dirErr := s.maps.GetDirections(ctx, helperLat, helperLng, booking.Lat, booking.Lng)
		if dirErr == nil && dir != nil {
			resp.ETAMinutes = dir.DurationMinutes
			resp.EncodedPolyline = dir.EncodedPolyline
		}
	}

	// Phase 1 Step 2 — surface the outstanding service OTPs. Peek is
	// read-only; the codes survive repeated TrackLive loads. ErrNotFound
	// is the expected "no code yet" state for both — silently skip.
	//
	// Phase 1 Step 5a.1 — TrackLive self-heal. Both Issue points
	// upstream (MarkEnRoute, Cashfree webhook, ResolveCash) are
	// post-commit best-effort; a Redis hiccup at the moment of Issue
	// silently strands the code. Every TrackLive load is the recovery
	// surface: check the precondition, then Issue only when Peek
	// returned ErrNotFound (genuine absence). Pure-function decisions
	// in self_heal.go pin the truth table for both scopes; the
	// guards short-circuit the common path so a code that exists
	// triggers ZERO writes per push tick (WS pushes every 5s, every
	// in-flight booking — turning this into a write storm would matter).
	if s.otpSvc != nil {
		var startCode, endCode string
		if code, oerr := s.otpSvc.Peek(ctx, otp.ScopeStart, bookingID); oerr == nil {
			startCode = code
		}
		if code, oerr := s.otpSvc.Peek(ctx, otp.ScopeEnd, bookingID); oerr == nil {
			endCode = code
		}

		// Start OTP self-heal. Skip path is the common one — code
		// present OR en_route_at not yet set — and emits zero writes.
		if DecideStartOTPSelfHeal(booking, startCode) == SelfHealIssue {
			if newCode, ierr := s.otpSvc.Issue(ctx, otp.ScopeStart, bookingID); ierr == nil {
				startCode = newCode
			} else {
				log.Warn().Err(ierr).Str("booking_id", bookingID).
					Msg("[tracking] start-OTP self-heal Issue failed; will retry next push tick")
			}
		}

		// End OTP self-heal. Requires status='in_progress' AND payment
		// resolved (paid OR cash). Pull payment_status + cash_collected_at
		// with a tight timeout; both columns live on bookings but are
		// not on the Booking struct exposed via GetBookingByID yet.
		// Only issue this extra round-trip when there's actually a
		// chance the heal applies — the if-guards above already
		// eliminated the common case.
		if booking.Status == StatusInProgress && endCode == "" {
			var paymentStatus *string
			var cashCollectedAt *time.Time
			sqlCtx, sqlCancel := context.WithTimeout(ctx, 2*time.Second)
			sqlErr := s.db.QueryRow(sqlCtx,
				`SELECT payment_status, cash_collected_at FROM bookings WHERE id = $1`,
				bookingID,
			).Scan(&paymentStatus, &cashCollectedAt)
			sqlCancel()
			if sqlErr == nil {
				paid := paymentStatus != nil && *paymentStatus == "paid"
				cashCollected := cashCollectedAt != nil
				if DecideEndOTPSelfHeal(booking, endCode, paid, cashCollected) == SelfHealIssue {
					if newCode, ierr := s.otpSvc.Issue(ctx, otp.ScopeEnd, bookingID); ierr == nil {
						endCode = newCode
					} else {
						log.Warn().Err(ierr).Str("booking_id", bookingID).
							Msg("[tracking] end-OTP self-heal Issue failed; will retry next push tick")
					}
				}
			} else {
				log.Warn().Err(sqlErr).Str("booking_id", bookingID).
					Msg("[tracking] payment-state lookup for end-OTP self-heal failed; will retry next push tick")
			}
		}

		resp.StartOTPCode = startCode
		resp.EndOTPCode = endCode
	}

	return resp, nil
}

// StartBooking transitions a booking from accepted → in_progress.
// Only the assigned helper may call this (marks "I've arrived").
// MarkArrived stamps arrived_at on the booking when the assigned pro taps
// "I've Arrived". Distinct from StartBooking (which transitions to
// in_progress). Status remains "accepted" until the job actually starts.
func (s *Service) MarkArrived(ctx context.Context, bookingID, helperID string) error {
	at, err := s.repo.MarkArrived(ctx, bookingID, helperID)
	if err != nil {
		log.Warn().Err(err).Str("booking_id", bookingID).Str("helper_id", helperID).Msg("MarkArrived failed")
		return err
	}
	log.Info().Str("booking_id", bookingID).Str("helper_id", helperID).Time("arrived_at", at).Msg("pro arrived at customer")
	return nil
}

// StartBooking transitions an accepted booking to in_progress, gated on
// the pro submitting the correct start OTP that the customer reads off
// their TrackLive screen.
//
// Phase 1 Step 1: this is one of two security-critical gates in the
// two-OTP payment-gated service flow. The OTP code itself lives in Redis
// under otp:start:<bookingID> (see internal/otp); on a successful verify
// we stamp start_otp_verified_at on the bookings row so the lifecycle is
// queryable from the DB without consulting Redis.
//
// The verify is one-time-use (internal/otp consumes the code on success),
// so a single accepted code cannot be replayed.
func (s *Service) StartBooking(ctx context.Context, bookingID, helperID, startOTPCode string) error {
	if s.otpSvc == nil {
		return ErrOTPServiceNotWired
	}
	if startOTPCode == "" {
		return ErrStartOTPRequired
	}
	// Gate before mutating: an invalid code must not leave any trace on
	// the booking row. Verify is one-time-use on success.
	if err := s.otpSvc.Verify(ctx, otp.ScopeStart, bookingID, startOTPCode); err != nil {
		if errors.Is(err, otp.ErrTooManyAttempts) {
			return ErrOTPTooManyAttempts
		}
		if errors.Is(err, otp.ErrNotFound) || errors.Is(err, otp.ErrMismatch) {
			return ErrInvalidStartOTP
		}
		return fmt.Errorf("start OTP verify: %w", err)
	}
	var customerID string
	if err := s.db.QueryRow(ctx,
		`UPDATE bookings SET status = 'in_progress', updated_at = NOW(), started_at = NOW(),
		                    start_otp_verified_at = NOW()
		 WHERE id = $1 AND helper_id = $2 AND status = 'accepted'
		 RETURNING customer_id::text`,
		bookingID, helperID,
	).Scan(&customerID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("booking not found or cannot be started")
		}
		return fmt.Errorf("failed to start booking: %w", err)
	}
	s.analytics.Track(ctx, analytics.EventBookingStarted, helperID, bookingID, nil)

	s.fireWebhook(ctx, webhooks.EventOrderStarted, s.buildOrderEvent(ctx, bookingID, &helperID, string(StatusInProgress)))

	// Post-commit customer push — booking_status_change so the customer's
	// TrackLive subscription (pushRouter.ts -> emitShiftEvent ->
	// TrackLiveScreen.onShiftEvent + ActiveBookingPill.onShiftEvent)
	// re-fetches GetBookingDetail and flips from "accepted/arrived" UI
	// into the in_progress payment-CTA layout. Non-fatal: the booking is
	// already started + committed; a failed FCM push must not undo that.
	// Same discipline as the post-commit OTP issuance below and the
	// existing MarkEnRoute / MarkArrived pushes in jobs.go.
	if s.notifications != nil {
		_ = s.notifications.SendData(ctx, customerID, map[string]string{
			"type":       "booking_status_change",
			"booking_id": bookingID,
			"status":     string(StatusInProgress),
		})
	}

	log.Info().Str("booking_id", bookingID).Str("helper_id", helperID).Msg("booking started (in_progress)")
	return nil
}

// buildOrderEvent loads the small set of fields needed for an order.* webhook
// payload. Best-effort: if the lookup fails the payload is still emitted with
// the IDs we already have.
func (s *Service) buildOrderEvent(ctx context.Context, bookingID string, helperID *string, status string) webhooks.OrderEvent {
	ev := webhooks.OrderEvent{
		OrderID:    bookingID,
		Status:     status,
		HelperID:   helperID,
		OccurredAt: time.Now().UTC(),
	}
	qCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var (
		customerID        string
		serviceCategoryID string
		priceCents        int
	)
	if err := s.db.QueryRow(qCtx,
		`SELECT customer_id, service_category_id, amount_paise FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(&customerID, &serviceCategoryID, &priceCents); err != nil {
		log.Warn().Err(err).Str("booking_id", bookingID).Msg("[webhooks] enrich order event failed")
		return ev
	}
	ev.CustomerID = customerID
	ev.ServiceCategoryID = serviceCategoryID
	ev.AmountPaise = int64(priceCents)
	return ev
}

// GetCustomerScheduledBookings returns paginated bookings in the richer
// ScheduledBooking shape — includes service items, scheduled_time, and
// address_id. Used by surfaces (e.g. Zop) that need full booking detail.
func (s *Service) GetCustomerScheduledBookings(ctx context.Context, customerID, status string, page, limit int) ([]ScheduledBooking, error) {
	return s.repo.GetCustomerBookingsByStatus(ctx, customerID, status, page, limit)
}

// GetCustomerBookings returns paginated bookings for a customer. Service-level
// wrapper around the repo call so callers (e.g. Zop AI) don't reach into the
// repo directly.
func (s *Service) GetCustomerBookings(ctx context.Context, customerID string, page, limit int) ([]Booking, error) {
	return s.repo.GetCustomerBookings(ctx, customerID, page, limit)
}

// RescheduleBooking moves a booking to a new time slot. Capacity on the new
// slot is enforced via FOR UPDATE inside a single transaction; the old slot's
// counter is decremented in the same tx so the swap is atomic.
//
// Returns 404-style error for missing bookings, 403-style for IDOR, 400 for
// terminal-state bookings, and ErrSlotUnavailable when the requested slot is
// at capacity (handler maps to 409).
func (s *Service) RescheduleBooking(
	ctx context.Context,
	bookingID, customerID, newTimeSlotID, newScheduledTime string,
) (*Booking, error) {
	b, err := s.repo.GetBookingByID(ctx, bookingID, customerID)
	if err != nil {
		return nil, err
	}
	if b.Status == StatusCompleted || b.Status == StatusCancelled {
		return nil, fmt.Errorf("booking cannot be rescheduled in current status")
	}

	newScheduled, err := time.Parse(time.RFC3339, newScheduledTime)
	if err != nil {
		return nil, fmt.Errorf("invalid scheduled time: %w", err)
	}

	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	tx, err := s.db.Begin(queryCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback(queryCtx)

	// Look up old slot ID from the booking row inside the tx so we have a
	// consistent view. nil/empty is allowed — booking may pre-date the
	// scheduled-flow.
	var oldSlotID *string
	if err := tx.QueryRow(queryCtx,
		`SELECT time_slot_id FROM bookings WHERE id = $1 FOR UPDATE`,
		bookingID,
	).Scan(&oldSlotID); err != nil {
		return nil, fmt.Errorf("failed to load booking row: %w", err)
	}

	// Lock slot rows in deterministic order (string-sort by ID) so two
	// concurrent reschedules swapping the same pair of slots can't deadlock.
	lockOrder := []string{newTimeSlotID}
	if oldSlotID != nil && *oldSlotID != "" && *oldSlotID != newTimeSlotID {
		lockOrder = append(lockOrder, *oldSlotID)
	}
	if len(lockOrder) == 2 && lockOrder[0] > lockOrder[1] {
		lockOrder[0], lockOrder[1] = lockOrder[1], lockOrder[0]
	}
	for _, sid := range lockOrder {
		if _, err := tx.Exec(queryCtx,
			`SELECT 1 FROM time_slots WHERE id = $1 FOR UPDATE`, sid,
		); err != nil {
			return nil, fmt.Errorf("failed to lock time slot: %w", err)
		}
	}

	// Capacity check on the new slot.
	var currentBookings, maxBookings int
	var isActive bool
	err = tx.QueryRow(queryCtx,
		`SELECT current_bookings, max_bookings, is_active FROM time_slots WHERE id = $1`,
		newTimeSlotID,
	).Scan(&currentBookings, &maxBookings, &isActive)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSlotUnavailable
		}
		return nil, fmt.Errorf("failed to load new time slot: %w", err)
	}
	if !isActive || currentBookings >= maxBookings {
		return nil, fmt.Errorf("requested slot is fully booked")
	}

	// Decrement old slot only if it differs from the new one — moving a
	// booking onto its existing slot would otherwise net to zero anyway, but
	// it'd be wasted writes.
	if oldSlotID != nil && *oldSlotID != "" && *oldSlotID != newTimeSlotID {
		if _, err := tx.Exec(queryCtx,
			`UPDATE time_slots SET current_bookings = GREATEST(current_bookings - 1, 0) WHERE id = $1`,
			*oldSlotID,
		); err != nil {
			return nil, fmt.Errorf("failed to release old slot: %w", err)
		}
		if _, err := tx.Exec(queryCtx,
			`UPDATE time_slots SET current_bookings = current_bookings + 1 WHERE id = $1`,
			newTimeSlotID,
		); err != nil {
			return nil, fmt.Errorf("failed to reserve new slot: %w", err)
		}
	}

	if _, err := tx.Exec(queryCtx,
		`UPDATE bookings
		   SET time_slot_id = $1, scheduled_time = $2, updated_at = NOW()
		 WHERE id = $3`,
		newTimeSlotID, newScheduled, bookingID,
	); err != nil {
		return nil, fmt.Errorf("failed to update booking: %w", err)
	}

	if err := tx.Commit(queryCtx); err != nil {
		return nil, fmt.Errorf("failed to commit reschedule: %w", err)
	}

	updated, err := s.repo.GetBookingByID(ctx, bookingID, customerID)
	if err != nil {
		return nil, err
	}

	if s.analytics != nil {
		s.analytics.Track(ctx, analytics.EventBookingCreated, customerID, bookingID, map[string]string{
			"event":            "rescheduled",
			"new_time_slot_id": newTimeSlotID,
			"new_scheduled_at": newScheduledTime,
		})
	}

	log.Info().
		Str("booking_id", bookingID).
		Str("customer_id", customerID).
		Str("new_slot_id", newTimeSlotID).
		Str("new_time", newScheduledTime).
		Msg("booking rescheduled")

	return updated, nil
}

// CompleteBooking transitions a booking from in_progress → completed and
// increments the helper's total_jobs counter. Only the assigned helper may
// call this.
//
// Phase 1 Step 1: gated on TWO conditions, both required:
//
//  1. The pro submits the correct end OTP that the customer reads off their
//     TrackLive screen. The end OTP is only issued AFTER payment resolves
//     (Cashfree webhook 'paid' OR pro-marked cash) — see IssueEndOTP. The
//     OTP code lives in Redis under otp:end:<bookingID>.
//
//  2. Defense-in-depth: payment_status='paid' (Cashfree settled) OR
//     cash_collected_at IS NOT NULL (cash path taken). The End OTP cannot
//     be issued without this state, but we re-check at completion time so
//     a misconfigured deploy or a stale Redis entry cannot land a booking
//     in completed-and-unpaid through this path. The admin force-complete
//     route (CRM) is the only sanctioned escape that bypasses this gate.
func (s *Service) CompleteBooking(ctx context.Context, bookingID, helperID, endOTPCode string) error {
	if s.otpSvc == nil {
		return ErrOTPServiceNotWired
	}
	if endOTPCode == "" {
		return ErrEndOTPRequired
	}
	// Verify before mutating; one-time consume on success.
	if err := s.otpSvc.Verify(ctx, otp.ScopeEnd, bookingID, endOTPCode); err != nil {
		if errors.Is(err, otp.ErrTooManyAttempts) {
			return ErrOTPTooManyAttempts
		}
		if errors.Is(err, otp.ErrNotFound) || errors.Is(err, otp.ErrMismatch) {
			return ErrInvalidEndOTP
		}
		return fmt.Errorf("end OTP verify: %w", err)
	}

	txCtx, txCancel := context.WithTimeout(ctx, 5*time.Second)
	defer txCancel()

	tx, err := s.db.BeginTx(txCtx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("failed to begin complete tx: %w", err)
	}
	defer tx.Rollback(context.Background())

	var (
		customerID  string
		startedAt   *time.Time
		completedAt time.Time
	)
	// Single UPDATE both transitions status and stamps end_otp_verified_at,
	// gated on payment_status='paid' OR a recorded cash collection. The
	// in_progress-only WHERE clause + the payment gate together mean this
	// query updates 0 rows if either condition fails — we then have to
	// distinguish which one to give the pro a useful error.
	if err := tx.QueryRow(txCtx,
		`UPDATE bookings SET status = 'completed', updated_at = NOW(), completed_at = NOW(),
		                    customer_rating_pending = true,
		                    end_otp_verified_at = NOW()
		 WHERE id = $1 AND helper_id = $2 AND status = 'in_progress'
		   AND (payment_status = 'paid' OR cash_collected_at IS NOT NULL)
		 RETURNING customer_id::text, started_at, completed_at`,
		bookingID, helperID,
	).Scan(&customerID, &startedAt, &completedAt); err != nil {
		if err == pgx.ErrNoRows {
			// Disambiguate: was it the state predicate (booking missing /
			// wrong helper / not in_progress), or the payment predicate
			// (still unpaid)? A separate SELECT tells the pro app whether
			// to surface "complete this booking first elsewhere" vs
			// "customer hasn't paid yet".
			var status string
			var paymentStatus *string
			var cashAt *time.Time
			selErr := s.db.QueryRow(ctx,
				`SELECT status, payment_status, cash_collected_at
				 FROM bookings WHERE id = $1 AND helper_id = $2`,
				bookingID, helperID,
			).Scan(&status, &paymentStatus, &cashAt)
			if selErr == nil && status == "in_progress" &&
				(paymentStatus == nil || *paymentStatus != "paid") && cashAt == nil {
				return ErrPaymentNotResolved
			}
			return fmt.Errorf("booking not found or cannot be completed")
		}
		return fmt.Errorf("failed to complete booking: %w", err)
	}

	// Compute actual duration + earnings snapshot. If started_at is
	// nil (data drift), fall back to total_duration_minutes from the
	// booking row so the pro is never under-paid.
	actualMin := 0
	if startedAt != nil {
		actualMin = int(completedAt.Sub(*startedAt).Minutes())
	}
	if actualMin <= 0 {
		_ = tx.QueryRow(txCtx,
			`SELECT COALESCE(total_duration_minutes, 60) FROM bookings WHERE id = $1`,
			bookingID,
		).Scan(&actualMin)
	}
	earnings := ComputeBookingEarnings(actualMin, completedAt)
	if _, err := tx.Exec(txCtx,
		`UPDATE bookings
		    SET actual_duration_minutes = $2,
		        pro_earnings_paise      = $3
		  WHERE id = $1`,
		bookingID, actualMin, earnings.TotalPaise,
	); err != nil {
		return fmt.Errorf("failed to write earnings snapshot: %w", err)
	}

	// Mark any still-pending booking_services rows completed too —
	// pro tapped "finish job" so all line items are considered done.
	if _, err := tx.Exec(txCtx,
		`UPDATE booking_services
		    SET status       = 'completed',
		        completed_at = COALESCE(completed_at, now())
		  WHERE booking_id = $1 AND status NOT IN ('completed', 'skipped')`,
		bookingID,
	); err != nil {
		return fmt.Errorf("failed to flush booking_services: %w", err)
	}

	if p, merr := json.Marshal(map[string]any{"booking_id": bookingID, "customer_id": customerID, "helper_id": helperID}); merr == nil {
		_, _ = tx.Exec(txCtx,
			`INSERT INTO event_outbox (event_type, aggregate_id, payload)
			 VALUES ('booking.completed', $1::uuid, $2::jsonb)`,
			bookingID, p)
	}

	if s.referrals != nil {
		if rerr := s.referrals.MaybeCompleteOnBookingTx(txCtx, tx, customerID); rerr != nil {
			return fmt.Errorf("referral completion: %w", rerr)
		}
	}

	if err := tx.Commit(txCtx); err != nil {
		return fmt.Errorf("failed to commit complete tx: %w", err)
	}

	s.analytics.Track(ctx, analytics.EventBookingCompleted, helperID, bookingID, nil)
	s.fireWebhook(ctx, webhooks.EventOrderCompleted, s.buildOrderEvent(ctx, bookingID, &helperID, string(StatusCompleted)))

	// Post-commit customer push — booking_status_change so the customer's
	// TrackLive subscription re-fetches GetBookingDetail and renders the
	// completed/rating state (or the customer's home indicator drops the
	// active-booking pill). Non-fatal: the booking is already completed +
	// committed; a failed FCM push must not roll that back. Same
	// discipline as MarkEnRoute / MarkArrived above and StartBooking.
	if s.notifications != nil {
		_ = s.notifications.SendData(ctx, customerID, map[string]string{
			"type":       "booking_status_change",
			"booking_id": bookingID,
			"status":     string(StatusCompleted),
		})
	}

	mw.SafeGo("booking.complete.increment_jobs", func() {
		uCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, dbErr := s.db.Exec(uCtx,
			`UPDATE helpers SET total_jobs = total_jobs + 1 WHERE id = $1`,
			helperID,
		); dbErr != nil {
			log.Warn().Err(dbErr).Str("helper_id", helperID).Msg("failed to increment total_jobs")
		}
	})

	log.Info().Str("booking_id", bookingID).Str("helper_id", helperID).Msg("booking completed")
	return nil
}
