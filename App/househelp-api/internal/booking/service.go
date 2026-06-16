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
	"github.com/adityarohilla/househelp-api/internal/payments"
	"github.com/adityarohilla/househelp-api/internal/users"
	"github.com/adityarohilla/househelp-api/internal/wallet"
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

// ErrSlotTooSoon is returned when a regular slot is requested closer than
// MinSlotLeadMin (default 45 min) from now. The 15–45 minute gap is
// intentionally not bookable as a slot — the customer is told to use ASAP
// instead (spec §3.1). Handler maps it to 400 with code "slot_too_soon".
var ErrSlotTooSoon = errors.New("slot too soon — use ASAP for sooner")

// roundLogCoord rounds a lat/lng to 2 decimals (~1.1 km precision)
// for safe structured logging. Audit C-8 / F2D-1 chunk 13 — log
// retention now governs only city-block-level coordinates rather
// than home-pinpoint GPS coords. Mirrors the pattern in
// internal/matching/engine.go and internal/insights/handler.go.
func roundLogCoord(x float64) float64 { return math.Round(x*100) / 100 }

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

// SyncAssigner is the narrow slice of the unified matching.Assigner the booking
// service needs for the ASAP synchronous-assignment path (spec §3.2, §5). Typed
// as an interface so booking depends on matching only via this surface and the
// AssignResult value type — no import cycle (matching imports nothing from
// booking). Wired in cmd/api/main.go after the assigner is constructed.
type SyncAssigner interface {
	AssignOne(ctx context.Context, bookingID, excludeProID string) (*matching.AssignResult, error)
}

// ASAPResult is the success payload of an ASAP booking: the created booking row
// plus the customer-facing arrival promise (winning pro's walking ETA + pad)
// and the assigned helper's name. Marshalled straight back to the caller.
//
// Booking is `any` so both entrypoints fit: the legacy single-service path
// (CreateBooking) returns a *Booking, the cart path a *ScheduledBooking.
type ASAPResult struct {
	Booking           any    `json:"booking"`
	Assigned          bool   `json:"assigned"`
	PromiseETAMinutes int    `json:"promise_eta_minutes"`
	HelperName        string `json:"helper_name"`
}

// EarliestSlot is the "book this instead" suggestion returned alongside
// ErrNoProsAvailable — the first regular slot today/tomorrow that still has
// window capacity.
type EarliestSlot struct {
	SlotID        string `json:"slot_id"`
	Date          string `json:"date"`
	StartTime     string `json:"start_time"`
	EndTime       string `json:"end_time"`
	ScheduledTime string `json:"scheduled_time"` // RFC3339 (UTC)
}

// ErrNoProsAvailable is returned by the ASAP path when no pro can take the job
// right now. It carries the earliest bookable regular slot (nil if none is free
// today/tomorrow) so the handler can offer "book it instead" in one round-trip.
// The just-created booking is already marked cancelled/no_pros_found by the
// time this surfaces (audit trail, spec §5.5). Handler maps to 409
// "no_pros_available".
type ErrNoProsAvailable struct {
	Earliest *EarliestSlot
}

func (e *ErrNoProsAvailable) Error() string { return "no pros available right now" }

// Service handles booking business logic.
type Service struct {
	repo          *Repository
	db            *pgxpool.Pool
	rdb           *redis.Client
	configSvc     *config_manager.Service
	matchEngine   *matching.Engine     // nil-safe; legacy Redis invite-set surface
	maps          *googlemaps.Client   // nil-safe; used for tracking ETA + polyline
	analytics     *analytics.Service   // nil-safe; fire-and-forget event tracking
	webhooks      *webhooks.Dispatcher // nil-safe; outbound CRM webhook fan-out
	ledger        *payments.Ledger     // nil-safe; charge-row writer
	wallet        WalletDebiter        // nil-safe; payment_source="wallet" flow
	referrals     ReferralCompleter    // nil-safe; referral reward on completion
	notifications Notifier             // nil-safe; FCM data push to customer
	assigner      SyncAssigner         // nil-safe; ASAP synchronous force-assign
	walletRepo    *wallet.Repository   // nil-safe; ASAP no-pro refund rail
}

// SetSyncAssigner wires the unified assigner for the ASAP synchronous-assign
// path. nil-safe — without it, an ASAP create can't place a pro and reports
// no-pros-available (the 60s cron is still the safety net for any row left
// pending). Wired in cmd/api/main.go after the assigner is built.
func (s *Service) SetSyncAssigner(a SyncAssigner) { s.assigner = a }

// SetWalletRepo wires the wallet repository so the ASAP no-pro terminal path
// can route a refund when the just-created booking was already paid. nil-safe —
// without it the cancel still happens, only the refund record is skipped.
func (s *Service) SetWalletRepo(r *wallet.Repository) { s.walletRepo = r }

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

// payBookingSplit debits min(walletBalance, netPaise) from the customer's
// wallet inside one tx, records the wallet payment row, stamps
// wallet_applied_paise + payment_method='cashfree' (the remainder is charged
// via the Cashfree order, which subtracts wallet_applied_paise). payment_status
// stays unpaid until the gateway webhook confirms the remainder. Returns the
// applied paise. If the wallet balance is 0 it applies 0 and the caller falls
// back to the plain direct/Cashfree path. requestedApply (the client's
// wallet_apply hint) caps the applied amount when > 0.
func (s *Service) payBookingSplit(ctx context.Context, bookingID, userID string, netPaise, requestedApply int64) (int64, error) {
	if s.wallet == nil || s.ledger == nil {
		return 0, fmt.Errorf("wallet payment not configured")
	}
	if s.walletRepo == nil {
		return 0, fmt.Errorf("wallet repository not configured")
	}
	var applied int64
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		bal, err := s.walletRepo.GetBalanceTx(ctx, tx, userID) // FOR UPDATE inside the tx
		if err != nil {
			return fmt.Errorf("read wallet balance: %w", err)
		}
		applied = min64(bal, netPaise)
		if requestedApply > 0 {
			applied = min64(applied, requestedApply)
		}
		if applied <= 0 {
			return nil // nothing to apply; caller treats as plain direct
		}
		bid := bookingID
		if err := s.wallet.DebitTx(ctx, tx, userID, applied, "spend", &bid, "Booking "+bookingID+" (partial)"); err != nil {
			if isInsufficientBalance(err) { // should not happen — applied<=bal
				return ErrInsufficientWalletBalance
			}
			return fmt.Errorf("wallet debit (split): %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO payments (booking_id, user_id, amount_paise, gateway, gateway_status, webhook_received_at, reconciled)
			VALUES ($1::uuid, $2::uuid, $3, 'wallet', 'success', NOW(), TRUE)
		`, bookingID, userID, applied); err != nil {
			return fmt.Errorf("insert split wallet payment row: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE bookings SET wallet_applied_paise = $2, payment_method = 'cashfree', updated_at = NOW()
			WHERE id = $1::uuid
		`, bookingID, applied); err != nil {
			return fmt.Errorf("stamp split booking: %w", err)
		}
		return nil
	})
	return applied, err
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// markSplitFullyPaid handles the split full-cover edge: when payBookingSplit's
// applied amount reached the whole net (the wallet covered it all), there is no
// Cashfree remainder, so the booking is fully paid. Flip payment_status='paid'
// and emit booking.paid (mirroring payBookingFromWallet's tail) so the row
// dispatches like a wallet-only booking. Errors are logged, never propagated —
// the wallet was already debited; failing here would strand a paid booking.
func (s *Service) markSplitFullyPaid(ctx context.Context, bookingID string) {
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE bookings SET payment_status = 'paid', updated_at = NOW() WHERE id = $1::uuid
		`, bookingID); err != nil {
			return fmt.Errorf("mark split paid: %w", err)
		}
		payload, err := json.Marshal(map[string]any{
			"booking_id": bookingID,
			"gateway":    "wallet",
			"paid_at":    time.Now().UTC().Format(time.RFC3339),
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
	if err != nil {
		log.Error().Err(err).Str("booking_id", bookingID).Msg("failed to mark split booking fully paid")
	}
}

// refundSplitWalletOnCancel credits back the wallet portion of a split booking
// whose Cashfree remainder never settled. The plain refund rail
// (wallet.RecordBookingRefundTx) only moves money when payment_status='paid',
// so an unpaid split would otherwise strand the wallet_applied_paise the
// customer already spent at create time — this returns it. Idempotent: it
// zeroes wallet_applied_paise under the row lock so a re-cancel can't
// double-refund, and no-ops once the booking is fully paid (the gateway refund
// path owns the paid case).
func (s *Service) refundSplitWalletOnCancel(ctx context.Context, bookingID string) error {
	if s.walletRepo == nil {
		return nil
	}
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		var customerID string
		var applied int64
		var status *string
		if err := tx.QueryRow(ctx, `
			SELECT customer_id::text, COALESCE(wallet_applied_paise, 0), payment_status
			FROM bookings WHERE id = $1::uuid FOR UPDATE`, bookingID).Scan(&customerID, &applied, &status); err != nil {
			return err
		}
		if applied <= 0 || (status != nil && *status == "paid") {
			return nil // nothing to refund, or fully paid (the gateway refund path handles paid)
		}
		bid := bookingID
		if _, err := s.walletRepo.ApplyTransactionTx(ctx, tx, wallet.WalletTx{
			UserID:      customerID,
			AmountPaise: applied,
			Kind:        wallet.KindRefundCredit,
			BookingID:   &bid,
			Note:        "Split booking cancelled — wallet portion returned",
		}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE bookings SET wallet_applied_paise = 0, updated_at = NOW() WHERE id = $1::uuid`, bookingID); err != nil {
			return err
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

// stampBookingCOD tags a freshly created booking as cash-on-delivery. Unlike
// the Cashfree path there is no prepay gate: the row stays in 'pending' and is
// force-assigned inline by the caller. payment_method='cod' keeps the row
// visible in the customer-facing 'upcoming' list (the filter only hides unpaid
// Cashfree rows) and tells the cancel-refund router that nothing was collected.
// Errors are logged, never propagated — a tag glitch must not unwind a booking
// the customer already saw confirmed.
func (s *Service) stampBookingCOD(ctx context.Context, bookingID string) {
	if _, err := s.db.Exec(ctx,
		`UPDATE bookings SET payment_method = 'cod', updated_at = NOW()
		 WHERE id = $1::uuid AND payment_method IS NULL`,
		bookingID,
	); err != nil {
		log.Warn().Err(err).Str("booking_id", bookingID).Msg("failed to stamp booking payment_method='cod'")
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
func NewService(repo *Repository, db *pgxpool.Pool, rdb *redis.Client, configSvc *config_manager.Service, engine *matching.Engine) *Service {
	return &Service{
		repo:        repo,
		db:          db,
		rdb:         rdb,
		configSvc:   configSvc,
		matchEngine: engine,
	}
}

// assignASAP runs the synchronous force-assign for a freshly created ASAP
// booking (spec §3.2, §5): it asks the unified assigner to place a pro right
// now. On success it returns the arrival promise (winning pro's walking ETA +
// AsapEtaPadMin) and the helper's name. When no pro is free it marks the
// just-created booking cancelled/no_pros_found (audit trail + refund, spec
// §5.5), then returns ErrNoProsAvailable carrying the earliest bookable regular
// slot so the customer gets an immediate "book it instead" answer.
//
// A nil assigner (unconfigured) is treated as "no pro available" — the 60s cron
// remains the safety net for the pending row, but the synchronous answer is
// honest about not having placed anyone.
func (s *Service) assignASAP(ctx context.Context, bookingID, customerID, addressID string) (*ASAPResult, error) {
	var (
		res *matching.AssignResult
		err error
	)
	if s.assigner != nil {
		res, err = s.assigner.AssignOne(ctx, bookingID, "")
	} else {
		err = matching.ErrNoEligiblePro
	}

	if err == nil {
		pad := matching.LoadDispatchConfig(ctx, s.configSvc).AsapEtaPadMin
		return &ASAPResult{
			Assigned:          true,
			PromiseETAMinutes: res.EtaMin + pad,
			HelperName:        res.HelperName,
		}, nil
	}

	// ErrAlreadyClaimed: another writer (cron tick, racing ASAP) took the row
	// between create and assign — it IS placed, just not by us. Treat as a
	// no-pros answer for this synchronous caller rather than a 500; the customer
	// already has a confirmed booking visible in their list.
	//
	// Any OTHER error (a Maps/DB fault surfacing through AssignOne, which the
	// assigner is designed to fail-open on, so reaching here is exceptional):
	// the booking row already exists and — on the wallet rail — the customer has
	// already been DEBITED. Returning a bare 500 here would leave them charged
	// with a pending/paid row and a confusing failure. Route it through the same
	// terminal no-pro path (cancel + refund-if-paid) so the synchronous answer is
	// coherent and the customer is never left charged-on-error. Logged so the
	// underlying fault is still visible.
	if !errors.Is(err, matching.ErrNoEligiblePro) && !errors.Is(err, matching.ErrAlreadyClaimed) {
		log.Error().Err(err).Str("booking_id", bookingID).
			Msg("[booking] asap assign errored (non-terminal) — cancelling + refunding the just-created row")
	}

	// No pro right now (or an assign fault) → terminal: cancel the just-created
	// row (audit trail), refund if it was paid, then surface the earliest regular
	// slot.
	s.markASAPNoPro(ctx, bookingID)
	earliest := s.earliestAvailableSlot(ctx, addressID)
	return nil, &ErrNoProsAvailable{Earliest: earliest}
}

// markASAPNoPro flips a just-created ASAP booking to cancelled/no_pros_found and
// routes a refund if money was collected — mirrors the assigner cron's terminal
// path (spec §5.5) so the two agree. Best-effort: a cancel/refund glitch is
// logged, never propagated, because the caller is already returning
// ErrNoProsAvailable to the customer.
func (s *Service) markASAPNoPro(ctx context.Context, bookingID string) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		log.Warn().Err(err).Str("booking_id", bookingID).Msg("[booking] asap no-pro: begin tx failed")
		return
	}
	defer tx.Rollback(ctx)

	var (
		customerID    string
		paymentMethod *string
		paymentID     *string
		paymentStatus *string
		amountPaise   int64
		discountPaise int64
	)
	// Guarded by status='pending' AND helper_id IS NULL so a row the cron or a
	// racing assign already placed is left untouched.
	err = tx.QueryRow(ctx, `
		UPDATE bookings
		SET    status              = 'cancelled',
		       cancelled_by        = 'no_pros_found',
		       invite_exhausted_at = now(),
		       cancelled_at        = now(),
		       updated_at          = now()
		WHERE  id = $1::uuid AND status = 'pending' AND helper_id IS NULL
		RETURNING customer_id::text, payment_method, payment_id, payment_status,
		          amount_paise, COALESCE(discount_paise, 0)
	`, bookingID).Scan(&customerID, &paymentMethod, &paymentID, &paymentStatus,
		&amountPaise, &discountPaise)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			log.Warn().Err(err).Str("booking_id", bookingID).Msg("[booking] asap no-pro: cancel failed")
		}
		return // already placed/cancelled — nothing to do.
	}

	if s.walletRepo != nil {
		refundAmount := amountPaise - discountPaise
		if rErr := RecordNoProRefund(ctx, tx, s.walletRepo, customerID, bookingID,
			paymentMethod, paymentID, paymentStatus, refundAmount,
			"Auto-refunded: no pro available for ASAP booking"); rErr != nil {
			log.Warn().Err(rErr).Str("booking_id", bookingID).Msg("[booking] asap no-pro: refund record failed")
			return
		}
	}

	if cErr := tx.Commit(ctx); cErr != nil {
		log.Warn().Err(cErr).Str("booking_id", bookingID).Msg("[booking] asap no-pro: commit failed")
		return
	}

	// Return the wallet portion of an unpaid split booking. RecordNoProRefund
	// above only moves money for paid rows, so a split (payment_status NULL,
	// wallet_applied_paise > 0) needs this separate, idempotent credit-back.
	if rErr := s.refundSplitWalletOnCancel(ctx, bookingID); rErr != nil {
		log.Warn().Err(rErr).Str("booking_id", bookingID).Msg("[booking] asap no-pro: split wallet refund failed")
	}
}

// earliestAvailableSlot returns the first regular slot today or tomorrow whose
// live window-recount capacity is > 0, for the address's locality. Returns nil
// when nothing is free in that horizon (the customer just sees "no pros" with
// no suggestion). Best-effort: any lookup error yields nil.
func (s *Service) earliestAvailableSlot(ctx context.Context, addressID string) *EarliestSlot {
	now := time.Now().In(indiaLocation())
	for dayOffset := 0; dayOffset <= 1; dayOffset++ {
		date := now.AddDate(0, 0, dayOffset).Format("2006-01-02")
		resp, err := s.GetSlotAvailability(ctx, addressID, date)
		if err != nil {
			log.Warn().Err(err).Str("address_id", addressID).Str("date", date).
				Msg("[booking] earliest-slot availability lookup failed")
			return nil
		}
		for _, p := range resp.Periods {
			for _, sl := range p.Slots {
				if !sl.IsAvailable || sl.AvailableCapacity <= 0 {
					continue
				}
				scheduled, sErr := s.GetSlotScheduledTime(ctx, sl.ID)
				if sErr != nil {
					continue
				}
				// Only suggest a slot the customer can actually book. The slots
				// repository future-filter is now+30m, but a regular booking
				// requires MinSlotLeadMin (45m) of lead (validateSlotTime →
				// ErrSlotTooSoon). Without this guard the 409 "book it instead"
				// suggestion can be a 30–45m slot that CreateScheduledBooking then
				// rejects, dead-ending the customer. Skip any candidate that
				// wouldn't pass the same gate creation enforces.
				if s.validateSlotTime(scheduled) != nil {
					continue
				}
				return &EarliestSlot{
					SlotID:        sl.ID,
					Date:          sl.SlotDate,
					StartTime:     sl.StartTime,
					EndTime:       sl.EndTime,
					ScheduledTime: scheduled,
				}
			}
		}
	}
	return nil
}

// CreateBooking validates the service category, applies promo if present,
// creates the booking as an ASAP (scheduled_time = now), and synchronously
// force-assigns a pro (spec §3.2, §5). No 8 PM blackout: the assignment attempt
// IS the gate — if an online pro is free now the booking confirms with an
// arrival promise, otherwise it's cancelled/no_pros_found and ErrNoProsAvailable
// is returned.
func (s *Service) CreateBooking(ctx context.Context, req *CreateBookingRequest, customerID string) (*ASAPResult, error) {
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

	// ASAP = now: stamp scheduled_time so the assigner (which requires a
	// non-null scheduled_time for its lead/slot math) can place this row right
	// away. The legacy repo INSERT leaves scheduled_time NULL.
	if _, err := s.db.Exec(ctx,
		`UPDATE bookings SET scheduled_time = now(), updated_at = now() WHERE id = $1::uuid`,
		booking.ID,
	); err != nil {
		log.Warn().Err(err).Str("booking_id", booking.ID).Msg("[booking] failed to stamp ASAP scheduled_time")
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

	// unpaidCashfree: true when this row is tagged payment_method='cashfree' but
	// not yet paid. Such a row MUST NOT be synchronously force-assigned — a pro
	// would be dispatched before the customer completes the Cashfree SDK sheet
	// (and would be stranded if they abandon payment). The 60s assigner cron
	// (ClaimDue) keeps the payment gate and places the row once the webhook
	// stamps payment_status='paid' (assigner.go:171). The wallet path debits
	// synchronously, so it stays paid and assigns inline.
	unpaidCashfree := false

	switch req.PaymentSource {
	case "wallet":
		if err := s.payBookingFromWallet(ctx, booking.ID, customerID, int64(netPaise)); err != nil {
			// Rollback after a failed wallet debit: nothing was collected, so
			// there is no refund to route (nil walletRepo) and fee is 0. Leaving
			// a pending unpaid row in the matching pipeline would be worse.
			if _, cancelErr := s.repo.CancelBookingWithFee(ctx, booking.ID, "system", 0, nil); cancelErr != nil {
				log.Error().Err(cancelErr).Str("booking_id", booking.ID).
					Msg("failed to roll back booking after wallet payment failure")
			}
			if errors.Is(err, ErrInsufficientWalletBalance) {
				return nil, ErrInsufficientWalletBalance
			}
			return nil, fmt.Errorf("wallet payment failed: %w", err)
		}
	case "cod":
		// Cash on delivery: no money moves at booking time. Stamp
		// payment_method='cod' (keeps the row visible in 'upcoming' — the list
		// filter only hides unpaid Cashfree rows) and fall through to the
		// synchronous assign below. No prepay gate to wait on, so unpaidCashfree
		// stays false and the pro is dispatched immediately.
		s.stampBookingCOD(ctx, booking.ID)
		s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise)
	case "split":
		// Partial wallet + Cashfree remainder: debit min(balance, net) inline,
		// stamp wallet_applied_paise + payment_method='cashfree'. If the wallet
		// happened to cover the whole net, treat it as wallet-only (paid +
		// dispatch); otherwise leave the remainder unpaid so the Cashfree gate
		// holds dispatch until the webhook confirms it.
		applied, err := s.payBookingSplit(ctx, booking.ID, customerID, int64(netPaise), req.WalletApplyPaise)
		if err != nil {
			if _, cancelErr := s.repo.CancelBookingWithFee(ctx, booking.ID, "system", 0, nil); cancelErr != nil {
				log.Error().Err(cancelErr).Str("booking_id", booking.ID).Msg("rollback after split wallet debit failed")
			}
			return nil, fmt.Errorf("split payment failed: %w", err)
		}
		if applied >= int64(netPaise) {
			// Wallet covered the whole net — treat as wallet-only: stamp paid, dispatch.
			s.markSplitFullyPaid(ctx, booking.ID)
		} else {
			s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise-int(applied))
			unpaidCashfree = true
		}
	default:
		// Default / "direct" path: stamp payment_method='cashfree' so the
		// customer-facing bookings list filters this row out until the
		// webhook stamps payment_status='paid'. Without this tag the row
		// shows up in 'upcoming' the moment the user taps Confirm Booking,
		// before the SDK sheet opens. recordPaymentIntent stays for the
		// legacy ledger row (gateway='cod' placeholder, harmless).
		s.stampBookingDirectPay(ctx, booking.ID)
		s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise)
		unpaidCashfree = true
	}

	s.fireWebhook(ctx, webhooks.EventOrderCreated, webhooks.OrderEvent{
		OrderID:           booking.ID,
		Status:            string(StatusPending),
		CustomerID:        customerID,
		ServiceCategoryID: req.ServiceCategoryID,
		AmountPaise:        int64(totalPriceCents),
		OccurredAt:        time.Now().UTC(),
	})

	matching.TrackDemand(ctx, s.rdb, req.Lat, req.Lng)

	// Cashfree-pending: do NOT dispatch a pro before payment. Return a
	// not-yet-assigned result; the post-payment cron (ClaimDue, which keeps the
	// payment gate) places this row once the webhook stamps it paid.
	if unpaidCashfree {
		return &ASAPResult{Booking: booking, Assigned: false}, nil
	}

	// Paid (wallet) → synchronously force-assign. The batch matcher is gone
	// (spec §9) — the assignment attempt itself is the gate.
	//
	// Legacy single-service path has no saved-address UUID, so the no-pro
	// earliest-slot suggestion can't be locality-resolved (empty addressID →
	// nil suggestion); the cart ASAP path carries one.
	result, err := s.assignASAP(ctx, booking.ID, customerID, "")
	if err != nil {
		return nil, err
	}
	result.Booking = booking
	return result, nil
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

	if booking.Status != StatusPending && booking.Status != StatusAccepted {
		return nil, fmt.Errorf("booking cannot be cancelled in current status")
	}

	// Cancellation is always free — no fee on any cancel, regardless of timing
	// (product policy; see IsFreeCancellation, which always reports free). The
	// free-cancel window/deadline are retained only for GetBooking's display copy.
	feeCents := 0

	// appliedFee is the fee actually settled — clamped to what the customer
	// paid (so a flat fee can't exceed a small booking and silently forfeit it)
	// and 0 for unpaid/COD rows. The refund is routed inside the same tx via
	// the canonical wallet rail (instant wallet credit / Cashfree queue).
	appliedFee, err := s.repo.CancelBookingWithFee(ctx, bookingID, "customer", feeCents, s.walletRepo)
	if err != nil {
		return nil, err
	}

	// Return the wallet portion of an unpaid split booking (the plain refund
	// rail above only moves money for paid rows). No-ops for non-split rows.
	if rErr := s.refundSplitWalletOnCancel(ctx, bookingID); rErr != nil {
		log.Warn().Err(rErr).Str("booking_id", bookingID).Msg("split wallet refund on customer cancel failed")
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
		CancellationFeeApplied: appliedFee > 0,
		CancellationFeeCents:   appliedFee,
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

// validateSlotTime enforces the three regular-slot lead-time rules (spec §3.1,
// §3.3) on a scheduled booking's start time:
//
//   - past                         → ErrSlotInPast
//   - < now + MinSlotLeadMin (45m) → ErrSlotTooSoon (use ASAP for sooner)
//   - > 2 days out                 → ErrSlotTooFar
//
// No stealth / 8pm-cutoff branch — the unified assigner handles every booking
// just-in-time, so a "normal vs stealth" distinction no longer exists.
// scheduledTime must be a parsable RFC3339 timestamp; all comparisons are
// anchored in Asia/Kolkata.
func (s *Service) validateSlotTime(scheduledTimeRFC3339 string) error {
	scheduled, err := time.Parse(time.RFC3339, scheduledTimeRFC3339)
	if err != nil {
		return fmt.Errorf("invalid scheduled time: %w", err)
	}
	loc := indiaLocation()
	scheduled = scheduled.In(loc)
	now := time.Now().In(loc)

	if scheduled.Before(now) {
		return ErrSlotInPast
	}

	// Minimum lead: a regular slot must be at least MinSlotLeadMin (45m, =
	// dispatchLead + travelBuffer) out. The 15–45 minute gap is intentionally
	// not slot-bookable — sooner-than-45m requests go through ASAP.
	minLead := matching.LoadDispatchConfig(context.Background(), s.configSvc).MinSlotLeadMin
	if scheduled.Before(now.Add(time.Duration(minLead) * time.Minute)) {
		return ErrSlotTooSoon
	}

	// Cap = midnight at end of (today + maxLeadDays). 2 days from "today"
	// means the customer can pick today, tomorrow, or day-after-tomorrow.
	maxDay := time.Date(
		now.Year(), now.Month(), now.Day()+scheduledBookingMaxLeadDays, 23, 59, 59, 0, loc,
	)
	if scheduled.After(maxDay) {
		return ErrSlotTooFar
	}

	return nil
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

// CreateScheduledBooking creates a booking using cart items + time slot.
// The cart must be non-empty. Items are converted to BookingServiceItems and
// the cart is cleared on success.
//
// Slot lead-time rules — see validateSlotTime: a regular slot must be at least
// MinSlotLeadMin out and no more than 2 days ahead. Closer-than-45m requests
// belong on the ASAP path, not here.
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

	if schedErr := s.validateSlotTime(scheduledTime); schedErr != nil {
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

	// Capacity gating resolves to a concrete locality (admin-managed fallback on
	// a miss) so the gate applies. resolveGateLocality never returns an error;
	// the branch is defensive and reuses the configured fallback locality.
	gateLocality, locErr := s.resolveGateLocality(ctx, req.AddressID)
	if locErr != nil {
		log.Warn().Err(locErr).Str("address_id", req.AddressID).Msg("[booking] locality resolve failed")
		gateLocality = PilotLocality
	}
	locality := &gateLocality

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

	// Unified assigner: no stealth/fire-at distinction — every booking is
	// dispatched just-in-time by the 60s assigner cron at scheduled_time−lead.
	booking, err := s.repo.CreateScheduledBooking(
		ctx, customerID, req.AddressID, req.TimeSlotID,
		scheduledTime, cartItems,
		totalPriceCents, discountCents, promoCode,
		false, nil, locality,
		true, // enforce live slot-capacity gate for the scheduled flow
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
	switch req.PaymentSource {
	case "wallet":
		if err := s.payBookingFromWallet(ctx, booking.ID, customerID, int64(netPaise)); err != nil {
			// Rollback after a failed wallet debit: nothing was collected, so
			// there is no refund to route (nil walletRepo) and fee is 0.
			if _, cancelErr := s.repo.CancelBookingWithFee(ctx, booking.ID, "system", 0, nil); cancelErr != nil {
				log.Error().Err(cancelErr).Str("booking_id", booking.ID).
					Msg("failed to roll back scheduled booking after wallet payment failure")
			}
			if errors.Is(err, ErrInsufficientWalletBalance) {
				return nil, ErrInsufficientWalletBalance
			}
			return nil, fmt.Errorf("wallet payment failed: %w", err)
		}
	case "split":
		// Partial wallet + Cashfree remainder. Scheduled bookings don't
		// sync-assign — the JIT cron + ClaimDue payment gate (which requires
		// payment_status='paid' for cashfree rows) holds dispatch until the
		// webhook confirms the remainder, so no unpaidCashfree flag is needed.
		// If the wallet covered the whole net, mark it paid so the gate clears.
		applied, err := s.payBookingSplit(ctx, booking.ID, customerID, int64(netPaise), req.WalletApplyPaise)
		if err != nil {
			if _, cancelErr := s.repo.CancelBookingWithFee(ctx, booking.ID, "system", 0, nil); cancelErr != nil {
				log.Error().Err(cancelErr).Str("booking_id", booking.ID).Msg("rollback after split wallet debit failed")
			}
			return nil, fmt.Errorf("split payment failed: %w", err)
		}
		if applied >= int64(netPaise) {
			s.markSplitFullyPaid(ctx, booking.ID)
		} else {
			s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise-int(applied))
		}
	default:
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

// CreateInstantBookingFromCart is the cart-based ASAP booking entrypoint used by
// the Zop AI assistant's `create_instant_booking` tool. The legacy
// `CreateBooking` path is single-service and prices off `service_categories`
// + `BaseFeeCents` + surge — the LLM never sees those add-ons, so its
// rendered total would diverge from the booking total. This method uses the
// same cart-derived totals as `CreateScheduledBooking`.
//
// ASAP semantics (spec §3.2, §5): scheduled_time = now (the passed timeSlotID/
// scheduledTime are ignored for timing), slot capacity is bypassed
// (enforceCapacity=false), and a pro is force-assigned synchronously. Success
// returns the arrival promise; no pro free now returns ErrNoProsAvailable with
// the earliest regular slot, after cancelling the just-created row (spec §5.5).
func (s *Service) CreateInstantBookingFromCart(
	ctx context.Context,
	customerID, addressID, timeSlotID, scheduledTime string,
	cartItems []BookingServiceItem,
	promoCode string,
	paymentSource string,
) (*ASAPResult, error) {
	if len(cartItems) == 0 {
		return nil, fmt.Errorf("cart is empty")
	}

	// ASAP = now: override any slot-derived scheduledTime the caller passed — the
	// pro leaves immediately (UTC RFC3339 so the repo's timestamp parse + the
	// assigner's lead/slot math line up). The caller's timeSlotID is still passed
	// through to the repo (it loads the slot row for slot_date / is_active); for
	// ASAP it doesn't gate capacity (enforceCapacity=false) and the assigner
	// keys off scheduled_time, so the slot_id on the row is cosmetic.
	scheduledTime = time.Now().UTC().Format(time.RFC3339)

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

	// Insert with isStealthInstant=false + fireAt=nil (no stealth path exists
	// anymore). enforceCapacity=false: ASAP bypasses the slot-capacity gate —
	// the synchronous assignment attempt is the real capacity check (spec §3.2).
	booking, err := s.repo.CreateScheduledBooking(
		ctx, customerID, addressID, timeSlotID,
		scheduledTime, cartItems,
		totalPriceCents, discountCents, promoCodePtr,
		false, nil, locality,
		false, // instant/cart path: not slot-gated
	)
	if err != nil {
		return nil, err
	}

	// Stamp coords + address onto the row so the assigner's Maps ETA uses real
	// lat/lng and the customer-facing detail renders the correct address.
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

	// unpaidCashfree mirrors the legacy CreateBooking gate: a direct/Cashfree
	// booking is NOT paid until the SDK sheet completes and the webhook stamps
	// payment_status='paid'. Such a row MUST NOT be force-assigned synchronously
	// — a pro would be dispatched before the customer pays (and stranded if they
	// abandon the sheet). Stamp payment_method='cashfree' so the customer-facing
	// list hides it until paid and the 60s assigner cron's payment gate (ClaimDue,
	// payment_method <> 'cashfree' OR payment_status='paid') places it post-webhook.
	unpaidCashfree := false
	switch paymentSource {
	case "wallet":
		if err := s.payBookingFromWallet(ctx, booking.ID, customerID, int64(netPaise)); err != nil {
			// Rollback after a failed wallet debit: nothing was collected, so
			// there is no refund to route (nil walletRepo) and fee is 0.
			if _, cancelErr := s.repo.CancelBookingWithFee(ctx, booking.ID, "system", 0, nil); cancelErr != nil {
				log.Error().Err(cancelErr).Str("booking_id", booking.ID).
					Msg("failed to roll back instant cart booking after wallet payment failure")
			}
			if errors.Is(err, ErrInsufficientWalletBalance) {
				return nil, ErrInsufficientWalletBalance
			}
			return nil, fmt.Errorf("wallet payment failed: %w", err)
		}
	case "cod":
		// Cash on delivery: no prepay gate, assign immediately. Stamp
		// payment_method='cod' so the row stays visible and the cancel-refund
		// router treats it as nothing-collected. unpaidCashfree stays false.
		s.stampBookingCOD(ctx, booking.ID)
		s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise)
	case "split":
		// Partial wallet + Cashfree remainder (see CreateBooking's split case).
		// This entrypoint carries no wallet_apply hint, so apply whatever balance
		// is available up to net (requestedApply=0).
		applied, err := s.payBookingSplit(ctx, booking.ID, customerID, int64(netPaise), 0)
		if err != nil {
			if _, cancelErr := s.repo.CancelBookingWithFee(ctx, booking.ID, "system", 0, nil); cancelErr != nil {
				log.Error().Err(cancelErr).Str("booking_id", booking.ID).Msg("rollback after split wallet debit failed")
			}
			return nil, fmt.Errorf("split payment failed: %w", err)
		}
		if applied >= int64(netPaise) {
			s.markSplitFullyPaid(ctx, booking.ID)
		} else {
			s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise-int(applied))
			unpaidCashfree = true
		}
	default:
		s.stampBookingDirectPay(ctx, booking.ID)
		s.recordPaymentIntent(ctx, booking.ID, customerID, netPaise)
		unpaidCashfree = true
	}

	matching.TrackDemand(ctx, s.rdb, lat, lng)

	log.Info().
		Str("booking_id", booking.ID).
		Str("customer_id", customerID).
		Int("services", len(cartItems)).
		Int("amount_paise", totalPriceCents).
		Float64("lat", roundLogCoord(lat)).Float64("lng", roundLogCoord(lng)).
		Msg("ASAP booking created via cart")

	// Cashfree-pending: do NOT dispatch a pro before payment. Return a
	// not-yet-assigned result; the post-payment cron (ClaimDue, which keeps the
	// payment gate) places this row once the webhook stamps it paid. The mobile
	// app then opens the Cashfree sheet; only paid wallet bookings dispatch inline.
	if unpaidCashfree {
		return &ASAPResult{Booking: booking, Assigned: false}, nil
	}

	// Paid (wallet) → synchronous force-assign. Success → arrival promise; no pro
	// → the row is cancelled (no_pros_found) and ErrNoProsAvailable carries the
	// earliest slot.
	result, err := s.assignASAP(ctx, booking.ID, customerID, addressID)
	if err != nil {
		return nil, err
	}
	result.Booking = booking
	return result, nil
}

// ValidatePromoCode validates a promo code and returns the discount.
func (s *Service) ValidatePromoCode(ctx context.Context, code string, orderAmountCents int) (*admin.Promotion, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var promo admin.Promotion
	// created_by is nullable (migration 107 orphans pre-CRM promo authors to
	// NULL; the column was never NOT NULL). Promotion.CreatedBy is a plain
	// string, so scanning a NULL row would 500 every booking that uses such a
	// promo. COALESCE to '' — the creator is irrelevant to validation here.
	err := s.db.QueryRow(queryCtx,
		`SELECT id, code, discount_type, discount_value, min_order_cents, max_uses, uses_count,
		        is_active, expires_at, COALESCE(created_by::text, ''), created_at
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

	// Booking not yet accepted — matching window may have expired.
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
		// Fallback to Postgres (populated by the location WS Postgres mirror
		// and REST PUT /helpers/me/location). Skip NULL coords — COALESCE(..,0)
		// here used to surface (0,0) for a pro who never streamed, dropping the
		// customer's live marker into the Gulf of Guinea and fitting the map
		// across ~8000 km. Leave helperLat/Lng at 0 and let the !=0 guards below
		// suppress the marker/directions instead.
		qCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_ = s.db.QueryRow(qCtx,
			`SELECT current_lat, current_lng
			   FROM helpers
			  WHERE id = $1 AND current_lat IS NOT NULL AND current_lng IS NOT NULL`,
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

func (s *Service) StartBooking(ctx context.Context, bookingID, helperID string) error {
	var customerID string
	err := s.db.QueryRow(ctx,
		`UPDATE bookings SET status = 'in_progress', updated_at = NOW(), started_at = NOW()
		 WHERE id = $1 AND helper_id = $2 AND status = 'accepted'
		 RETURNING customer_id::text`,
		bookingID, helperID,
	).Scan(&customerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Stale/duplicate Start tap (already in_progress, reassigned,
			// or cancelled) — sentinel so the handler maps it to 409 like
			// EnRoute/Arrived, avoiding the app retry-storm + "backend down".
			return ErrJobNotInState
		}
		return fmt.Errorf("failed to start booking: %w", err)
	}
	s.analytics.Track(ctx, analytics.EventBookingStarted, helperID, bookingID, nil)

	s.fireWebhook(ctx, webhooks.EventOrderStarted, s.buildOrderEvent(ctx, bookingID, &helperID, string(StatusInProgress)))

	// Customer push — best-effort. Without this the customer's TrackLive
	// state machine never advances past "arrived" until a background→
	// foreground refetch. pushRouter handles 'job_started'.
	if s.notifications != nil {
		_ = s.notifications.SendData(ctx, customerID, map[string]string{
			"type":       "job_started",
			"booking_id": bookingID,
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
// slot is enforced via the live window-recount gate (availableForSlot) under a
// (locality, date) advisory xact lock — the same gate CreateScheduledBooking
// runs — so a reschedule can't slip past the last seat. There is no counter to
// decrement: the old window is released implicitly the moment scheduled_time
// moves and the booking drops out of the live committed re-count. If the
// booking was already assigned, it is reset to pending/unassigned so the
// assigner re-places it for the new time (spec §7).
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
	// Terminal states and already-started jobs cannot be rescheduled. A job is
	// "started" once the pro has arrived (arrived_at) or service is in_progress —
	// yanking it back to pending would clear the pro mid-service and orphan the
	// in-flight job. Only a not-yet-started (pending / accepted-pre-arrival)
	// booking is reschedulable (spec §7 re-dispatch).
	if b.Status == StatusCompleted || b.Status == StatusCancelled ||
		b.Status == StatusInProgress || b.ArrivedAt != nil {
		return nil, fmt.Errorf("booking cannot be rescheduled in current status")
	}

	// Enforce the same time-window rules as a fresh booking (spec §3.1/§3.3):
	// not in the past, ≥ MinSlotLeadMin out, ≤ 2-day horizon. Without this a
	// reschedule could move a booking into the past (the assigner then claims and
	// terminally cancels it) or beyond the planning window (polluting capacity).
	if err := s.validateSlotTime(newScheduledTime); err != nil {
		return nil, err
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

	// Load the booking row inside the tx for a consistent view: its persisted
	// locality drives the capacity gate, and helper_id tells us whether the
	// booking was already assigned (so the move must release the pro for
	// re-dispatch at the new time). The time_slots counters are retired — the
	// gate is the live window-recount (availableForSlot), identical to
	// CreateScheduledBooking.
	var bookingLocality *string
	var assignedHelperID *string
	if err := tx.QueryRow(queryCtx,
		`SELECT locality, helper_id FROM bookings WHERE id = $1 FOR UPDATE`,
		bookingID,
	).Scan(&bookingLocality, &assignedHelperID); err != nil {
		return nil, fmt.Errorf("failed to load booking row: %w", err)
	}

	// Resolve the new slot's IST date (used for both the advisory-lock key and
	// the leave count) and confirm it's bookable at all.
	var slotDate string
	var isActive bool
	err = tx.QueryRow(queryCtx,
		`SELECT to_char(slot_date, 'YYYY-MM-DD'), is_active FROM time_slots WHERE id = $1`,
		newTimeSlotID,
	).Scan(&slotDate, &isActive)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSlotUnavailable
		}
		return nil, fmt.Errorf("failed to load new time slot: %w", err)
	}
	if !isActive {
		return nil, ErrSlotUnavailable
	}

	// Capacity gate on the NEW window: advisory xact lock keyed by
	// (locality, date) — the SAME key CreateScheduledBooking uses, so a
	// reschedule and a fresh booking into the same locality+date serialise
	// against each other and can't both slip past the last seat (the slot id is
	// deliberately excluded; overlapping windows cross slot boundaries — audit
	// fix b939794). No old-slot release is needed: the old booking drops out of
	// the live committed re-count the instant its scheduled_time moves.
	//
	// Fall back to PilotLocality when the booking carries no locality (e.g. an
	// ASAP-origin row), mirroring resolveGateLocality so the gate always applies
	// during the pilot and reschedule/create enforce identical capacity rules.
	gateLocality := PilotLocality
	if bookingLocality != nil && *bookingLocality != "" {
		gateLocality = *bookingLocality
	}
	lockKey := gateLocality + "|" + slotDate
	if _, err := tx.Exec(queryCtx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		lockKey,
	); err != nil {
		return nil, fmt.Errorf("failed to acquire slot capacity lock: %w", err)
	}
	// Exclude this booking from the recount so its own not-yet-moved old
	// window can't block a move into an overlapping (e.g. adjacent) slot.
	avail, err := s.repo.availableForSlotExcluding(queryCtx, tx, gateLocality, newTimeSlotID, slotDate, bookingID)
	if err != nil {
		return nil, fmt.Errorf("failed to compute slot capacity: %w", err)
	}
	if avail <= 0 {
		return nil, ErrSlotUnavailable
	}

	// Move the booking. If it was already assigned, release the pro and reset to
	// pending/unassigned so the assigner re-places it for the new time (spec §7).
	if assignedHelperID != nil {
		if _, err := tx.Exec(queryCtx,
			`UPDATE bookings
			   SET time_slot_id = $1, scheduled_time = $2,
			       helper_id = NULL, status = 'pending', matched_at = NULL,
			       updated_at = NOW()
			 WHERE id = $3`,
			newTimeSlotID, newScheduled, bookingID,
		); err != nil {
			return nil, fmt.Errorf("failed to update booking: %w", err)
		}
	} else if _, err := tx.Exec(queryCtx,
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
// increments the helper's total_jobs counter.
// Only the assigned helper may call this.
func (s *Service) CompleteBooking(ctx context.Context, bookingID, helperID string) error {
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
	if err := tx.QueryRow(txCtx,
		`UPDATE bookings SET status = 'completed', updated_at = NOW(), completed_at = NOW(),
		                    customer_rating_pending = true
		 WHERE id = $1 AND helper_id = $2 AND status = 'in_progress'
		 RETURNING customer_id::text, started_at, completed_at`,
		bookingID, helperID,
	).Scan(&customerID, &startedAt, &completedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Stale/duplicate Complete tap (already completed, reassigned,
			// or cancelled) — sentinel so the handler maps it to 409 like
			// EnRoute/Arrived, avoiding the app retry-storm + "backend down".
			return ErrJobNotInState
		}
		return fmt.Errorf("failed to complete booking: %w", err)
	}

	// Actual elapsed time — recorded for analytics/disputes only. Pay is
	// based on BOOKED duration, not actual: a pro booked for 30 min is paid
	// for 30 even if the job took 19. There is no per-booking piece-rate /
	// peak / weekend snapshot anymore — the only pay basis is time (online +
	// working minutes), aggregated by the payroll engine.
	actualMin := 0
	if startedAt != nil {
		actualMin = int(completedAt.Sub(*startedAt).Minutes())
	}
	if actualMin < 0 {
		actualMin = 0
	}

	// Booked duration = the working-minutes the pro is credited for this job.
	bookedMin := 0
	_ = tx.QueryRow(txCtx,
		`SELECT COALESCE(total_duration_minutes, 60) FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(&bookedMin)

	if _, err := tx.Exec(txCtx,
		`UPDATE bookings SET actual_duration_minutes = $2 WHERE id = $1`,
		bookingID, actualMin,
	); err != nil {
		return fmt.Errorf("failed to write actual duration: %w", err)
	}

	// Credit the BOOKED minutes to the pro's open shift session as working
	// time — payroll's AggregateActivity reads shift_sessions.job_minutes for
	// the ₹80/hr work bonus, and nothing else writes it. The credit is capped
	// at the session's elapsed online time so job_minutes can never exceed
	// online_minutes (working ⊆ online; payroll also caps defensively).
	// Non-fatal: a missing open session (offline race) must not block
	// completion — the pro simply accrues no working-minutes for this job.
	if tag, jmErr := tx.Exec(txCtx,
		`UPDATE shift_sessions ss
		    SET job_minutes = ss.job_minutes + LEAST(
		          $2,
		          GREATEST(0, (EXTRACT(EPOCH FROM (now() - ss.online_at))::int / 60) - ss.job_minutes)
		        )
		  WHERE ss.id = (
		        SELECT ss2.id FROM shift_sessions ss2
		         WHERE ss2.pro_id = $1::uuid AND ss2.offline_at IS NULL
		         ORDER BY ss2.online_at DESC
		         LIMIT 1
		  )`,
		helperID, bookedMin,
	); jmErr != nil {
		return fmt.Errorf("failed to credit job minutes: %w", jmErr)
	} else if tag.RowsAffected() == 0 {
		log.Warn().Str("helper_id", helperID).Str("booking_id", bookingID).
			Msg("no open shift session to credit job_minutes — work bonus for this job will not accrue")
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
