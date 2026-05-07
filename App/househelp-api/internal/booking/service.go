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
	"github.com/adityarohilla/househelp-api/internal/notification"
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

// Service handles booking business logic.
type Service struct {
	repo         *Repository
	db           *pgxpool.Pool
	rdb          *redis.Client
	configSvc    *config_manager.Service
	notifSvc     *notification.Service
	matchBatcher *matching.Batcher    // nil-safe; only used for instant bookings
	matchEngine  *matching.Engine     // nil-safe; used for status queries
	maps         *googlemaps.Client   // nil-safe; used for tracking ETA + polyline
	analytics    *analytics.Service   // nil-safe; fire-and-forget event tracking
	webhooks     *webhooks.Dispatcher // nil-safe; outbound CRM webhook fan-out
	ledger       *payments.Ledger     // nil-safe; charge-row writer
	wallet       WalletDebiter        // nil-safe; payment_source="wallet" flow
}

// SetPaymentsLedger wires the payments ledger so booking confirmation can
// open a pending charge row. nil-safe — leaving it unset disables ledger
// writes (used by unit tests that don't care about the payments table).
func (s *Service) SetPaymentsLedger(l *payments.Ledger) { s.ledger = l }

// SetWallet wires the wallet service so payment_source="wallet" can debit
// inline. Optional — without it, a wallet-source request is rejected.
func (s *Service) SetWallet(w WalletDebiter) { s.wallet = w }

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
func NewService(repo *Repository, db *pgxpool.Pool, rdb *redis.Client, configSvc *config_manager.Service, notifSvc *notification.Service, batcher *matching.Batcher) *Service {
	var engine *matching.Engine
	if batcher != nil {
		engine = matching.NewEngine(db, rdb, configSvc)
	}
	return &Service{
		repo:         repo,
		db:           db,
		rdb:          rdb,
		configSvc:    configSvc,
		notifSvc:     notifSvc,
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

	// Notify assigned helper (if any) that the job was cancelled.
	if s.notifSvc != nil && booking.HelperID != nil {
		helperID := *booking.HelperID
		mw.SafeGo("booking.cancel.notify_pro", func() {
			if notifErr := s.notifSvc.NotifyProBookingCancelled(context.Background(), helperID, bookingID); notifErr != nil {
				log.Warn().Err(notifErr).Str("booking_id", bookingID).Msg("failed to send cancellation notification to pro")
			}
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

	// Notify customer that their helper is on the way.
	if s.notifSvc != nil {
		if notifErr := s.notifSvc.NotifyCustomerBookingAccepted(ctx, booking.CustomerID, helperName, bookingID); notifErr != nil {
			log.Error().Err(notifErr).Str("booking_id", bookingID).Msg("failed to send booking accepted notification to customer")
		}
	}

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

	// Calculate total price from items.
	totalPriceCents := 0
	for _, item := range cartItems {
		totalPriceCents += item.PriceCents
	}

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

		arrived, arrErr := s.repo.IsBookingArrived(ctx, bookingID)
		if arrErr != nil {
			log.Warn().Err(arrErr).Str("booking_id", bookingID).Msg("IsBookingArrived failed (run migration 038?)")
		}
		return &MatchStatusResponse{
			Status:        "matched",
			Helper:        &helper,
			BookingStatus: string(booking.Status),
			Arrived:       arrived,
		}, nil
	}

	// If the booking is cancelled, report failed immediately — check this before
	// Redis so a cancelled-but-still-in-Redis booking doesn't falsely show "searching".
	if booking.Status == StatusCancelled {
		return &MatchStatusResponse{Status: "failed", BookingStatus: string(booking.Status)}, nil
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
	res, err := s.db.Exec(ctx,
		`UPDATE bookings SET status = 'in_progress', updated_at = NOW(), started_at = NOW()
		 WHERE id = $1 AND helper_id = $2 AND status = 'accepted'`,
		bookingID, helperID,
	)
	if err != nil {
		return fmt.Errorf("failed to start booking: %w", err)
	}
	if res.RowsAffected() == 0 {
		return fmt.Errorf("booking not found or cannot be started")
	}
	s.analytics.Track(ctx, analytics.EventBookingStarted, helperID, bookingID, nil)

	s.fireWebhook(ctx, webhooks.EventOrderStarted, s.buildOrderEvent(ctx, bookingID, &helperID, string(StatusInProgress)))

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
// increments the helper's total_jobs counter.
// Only the assigned helper may call this.
func (s *Service) CompleteBooking(ctx context.Context, bookingID, helperID string) error {
	res, err := s.db.Exec(ctx,
		`UPDATE bookings SET status = 'completed', updated_at = NOW(), completed_at = NOW()
		 WHERE id = $1 AND helper_id = $2 AND status = 'in_progress'`,
		bookingID, helperID,
	)
	if err != nil {
		return fmt.Errorf("failed to complete booking: %w", err)
	}
	if res.RowsAffected() == 0 {
		return fmt.Errorf("booking not found or cannot be completed")
	}
	s.analytics.Track(ctx, analytics.EventBookingCompleted, helperID, bookingID, nil)

	s.fireWebhook(ctx, webhooks.EventOrderCompleted, s.buildOrderEvent(ctx, bookingID, &helperID, string(StatusCompleted)))

	// Increment total_jobs and notify customer — both best-effort, non-blocking.
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

	if s.notifSvc != nil {
		mw.SafeGo("booking.complete.notify_customer", func() {
			// Fetch customer ID for this booking then notify them.
			var customerID string
			qCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := s.db.QueryRow(qCtx,
				`SELECT customer_id FROM bookings WHERE id = $1`, bookingID,
			).Scan(&customerID); err == nil {
				if notifErr := s.notifSvc.NotifyCustomerBookingCompleted(context.Background(), customerID, bookingID); notifErr != nil {
					log.Warn().Err(notifErr).Str("booking_id", bookingID).Msg("failed to send completion notification to customer")
				}
			}
		})
	}

	log.Info().Str("booking_id", bookingID).Str("helper_id", helperID).Msg("booking completed")
	return nil
}
