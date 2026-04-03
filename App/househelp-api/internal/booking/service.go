package booking

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/adityarohilla/househelp-api/internal/admin"
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/notification"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// Service handles booking business logic.
type Service struct {
	repo      *Repository
	db        *pgxpool.Pool
	rdb       *redis.Client
	configSvc *config_manager.Service
	notifSvc  *notification.Service
}

// NewService creates a new booking service.
func NewService(repo *Repository, db *pgxpool.Pool, rdb *redis.Client, configSvc *config_manager.Service, notifSvc *notification.Service) *Service {
	return &Service{
		repo:      repo,
		db:        db,
		rdb:       rdb,
		configSvc: configSvc,
		notifSvc:  notifSvc,
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

	// Notify customer that booking was accepted.
	if s.notifSvc != nil {
		if notifErr := s.notifSvc.NotifyBookingAccepted(ctx, booking.CustomerID, helperName, bookingID); notifErr != nil {
			log.Error().Err(notifErr).Str("booking_id", bookingID).Msg("failed to send booking accepted notification")
		}
	}

	log.Info().Str("booking_id", bookingID).Str("helper_id", helperID).Msg("booking accepted by helper")
	return nil
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
