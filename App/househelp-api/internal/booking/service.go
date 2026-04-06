package booking

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/adityarohilla/househelp-api/internal/admin"
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/googlemaps"
	"github.com/adityarohilla/househelp-api/internal/matching"
	"github.com/adityarohilla/househelp-api/internal/notification"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// Service handles booking business logic.
type Service struct {
	repo         *Repository
	db           *pgxpool.Pool
	rdb          *redis.Client
	configSvc    *config_manager.Service
	notifSvc     *notification.Service
	matchBatcher *matching.Batcher  // nil-safe; only used for instant bookings
	matchEngine  *matching.Engine   // nil-safe; used for status queries
	maps         *googlemaps.Client // nil-safe; used for tracking ETA + polyline
}

// SetMapsClient attaches a Google Maps client for tracking and ETA.
func (s *Service) SetMapsClient(c *googlemaps.Client) { s.maps = c }

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
		PriceCents:        totalPriceCents,
		PromoCode:         promoCode,
		DiscountCents:     discountCents,
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
		Int("price_cents", totalPriceCents).
		Int("discount_cents", discountCents).
		Msg("booking created")

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

// GetBooking retrieves a booking with IDOR protection.
func (s *Service) GetBooking(ctx context.Context, bookingID, requestingUserID string) (*Booking, error) {
	return s.repo.GetBookingByID(ctx, bookingID, requestingUserID)
}

// CancelBooking cancels a booking after checking the cancellation window from config_manager.
func (s *Service) CancelBooking(ctx context.Context, bookingID, userID string) error {
	// Get the booking (with IDOR check).
	booking, err := s.repo.GetBookingByID(ctx, bookingID, userID)
	if err != nil {
		return err
	}

	// Only pending or accepted bookings can be cancelled.
	if booking.Status != StatusPending && booking.Status != StatusAccepted {
		return fmt.Errorf("booking cannot be cancelled in current status")
	}

	// Check cancellation window from config.
	windowStr, cfgErr := s.configSvc.GetConfig(ctx, config_manager.ConfigBookingCancellationWindowMinutes)
	if cfgErr != nil {
		log.Warn().Err(cfgErr).Msg("failed to get cancellation window config, using default")
		windowStr = "5"
	}
	windowMinutes, parseErr := strconv.Atoi(windowStr)
	if parseErr != nil {
		windowMinutes = 5
	}

	// Check if still within free cancellation window.
	deadline := booking.CreatedAt.Add(time.Duration(windowMinutes) * time.Minute)
	if time.Now().After(deadline) {
		// TODO: In production, charge a cancellation fee here using the payment service.
		log.Warn().
			Str("booking_id", bookingID).
			Str("user_id", userID).
			Msg("booking cancelled outside free cancellation window; fee should be charged")
	}

	if err := s.repo.UpdateBookingStatus(ctx, bookingID, StatusCancelled); err != nil {
		return fmt.Errorf("failed to cancel booking: %w", err)
	}

	// Clear Redis match keys so helpers immediately stop seeing this invite.
	if s.matchEngine != nil {
		go s.matchEngine.ClearMatchOnAccept(context.Background(), bookingID, "")
	}

	// Notify assigned helper (if any) that the job was cancelled.
	if s.notifSvc != nil && booking.HelperID != nil {
		go func() {
			if notifErr := s.notifSvc.NotifyProBookingCancelled(context.Background(), *booking.HelperID, bookingID); notifErr != nil {
				log.Warn().Err(notifErr).Str("booking_id", bookingID).Msg("failed to send cancellation notification to pro")
			}
		}()
	}

	log.Info().Str("booking_id", bookingID).Str("user_id", userID).Msg("booking cancelled")
	return nil
}

// AcceptBooking allows a helper to accept a pending booking.
func (s *Service) AcceptBooking(ctx context.Context, bookingID, helperID string) error {
	// Get the pending booking without IDOR checks (no helper assigned yet).
	booking, err := s.repo.GetPendingBookingByID(ctx, bookingID)
	if err != nil {
		return err
	}

	// Check helper's active booking limit.
	maxActiveStr, err := s.configSvc.GetConfig(ctx, config_manager.ConfigBookingMaxActivePerHelper)
	if err != nil {
		log.Warn().Err(err).Msg("failed to get max helper active bookings config, using default")
		maxActiveStr = "3"
	}
	maxActive, parseErr := strconv.Atoi(maxActiveStr)
	if parseErr != nil {
		maxActive = 3
	}

	activeCount, err := s.repo.GetActiveBookingsCountForHelper(ctx, helperID)
	if err != nil {
		return fmt.Errorf("failed to check helper active bookings: %w", err)
	}
	if activeCount >= maxActive {
		return fmt.Errorf("helper already has maximum active bookings")
	}

	// Look up helper name for notification.
	helperName := ""
	helperRow := s.db.QueryRow(ctx, "SELECT COALESCE(name, '') FROM users WHERE id = $1", helperID)
	if err := helperRow.Scan(&helperName); err != nil {
		log.Error().Err(err).Str("helper_id", helperID).Msg("failed to fetch helper name for notification")
		helperName = "a helper"
	}

	if err := s.repo.AcceptBooking(ctx, bookingID, helperID); err != nil {
		return fmt.Errorf("failed to accept booking: %w", err)
	}

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

// CreateScheduledBooking creates a booking using cart items + time slot.
// The cart must be non-empty. Items are converted to BookingServiceItems and
// the cart is cleared on success.
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
	)
	if err != nil {
		return nil, err
	}

	if promoCode != nil {
		if err := s.repo.IncrementPromoCodeUsage(ctx, *promoCode); err != nil {
			log.Warn().Err(err).Str("promo_code", *promoCode).Msg("failed to increment promo code usage")
		}
	}

	log.Info().
		Str("booking_id", booking.ID).
		Str("customer_id", customerID).
		Int("services", len(cartItems)).
		Int("price_cents", totalPriceCents).
		Msg("scheduled booking created")

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
			        COALESCE(h.rating,5.0)
			 FROM users u
			 JOIN helpers h ON h.id = u.id
			 WHERE u.id = $1`,
			*booking.HelperID,
		).Scan(&helper.ID, &helper.Name, &helper.Phone, &helper.Rating)
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

		helper.ETAMinutes = 30 // default ETA; production would compute from routing
		return &MatchStatusResponse{Status: "matched", Helper: &helper}, nil
	}

	// If the booking is cancelled, report failed immediately — check this before
	// Redis so a cancelled-but-still-in-Redis booking doesn't falsely show "searching".
	if booking.Status == StatusCancelled {
		return &MatchStatusResponse{Status: "failed"}, nil
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

	for _, bookingID := range ids {
		var status string
		qErr := s.db.QueryRow(ctx,
			`SELECT status FROM bookings WHERE id = $1`, bookingID,
		).Scan(&status)
		if qErr != nil || status != string(StatusPending) {
			staleIDs = append(staleIDs, bookingID)
		} else {
			validIDs = append(validIDs, bookingID)
		}
	}

	// Remove stale invites from Redis so they never show up again.
	if len(staleIDs) > 0 {
		go s.matchEngine.RemoveHelperInvites(context.Background(), helperID, staleIDs)
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
func (s *Service) StartBooking(ctx context.Context, bookingID, helperID string) error {
	res, err := s.db.Exec(ctx,
		`UPDATE bookings SET status = 'in_progress', updated_at = NOW()
		 WHERE id = $1 AND helper_id = $2 AND status = 'accepted'`,
		bookingID, helperID,
	)
	if err != nil {
		return fmt.Errorf("failed to start booking: %w", err)
	}
	if res.RowsAffected() == 0 {
		return fmt.Errorf("booking not found or cannot be started")
	}
	log.Info().Str("booking_id", bookingID).Str("helper_id", helperID).Msg("booking started (in_progress)")
	return nil
}

// CompleteBooking transitions a booking from in_progress → completed and
// increments the helper's total_jobs counter.
// Only the assigned helper may call this.
func (s *Service) CompleteBooking(ctx context.Context, bookingID, helperID string) error {
	res, err := s.db.Exec(ctx,
		`UPDATE bookings SET status = 'completed', updated_at = NOW()
		 WHERE id = $1 AND helper_id = $2 AND status = 'in_progress'`,
		bookingID, helperID,
	)
	if err != nil {
		return fmt.Errorf("failed to complete booking: %w", err)
	}
	if res.RowsAffected() == 0 {
		return fmt.Errorf("booking not found or cannot be completed")
	}

	// Increment total_jobs and notify customer — both best-effort, non-blocking.
	go func() {
		uCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, dbErr := s.db.Exec(uCtx,
			`UPDATE helpers SET total_jobs = total_jobs + 1 WHERE id = $1`,
			helperID,
		); dbErr != nil {
			log.Warn().Err(dbErr).Str("helper_id", helperID).Msg("failed to increment total_jobs")
		}
	}()

	if s.notifSvc != nil {
		go func() {
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
		}()
	}

	log.Info().Str("booking_id", bookingID).Str("helper_id", helperID).Msg("booking completed")
	return nil
}
