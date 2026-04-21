package cart

import (
	"context"
	"fmt"

	"github.com/adityarohilla/househelp-api/internal/analytics"
)

// Service is the business-logic layer for the cart module.
type Service struct {
	repo      cartRepository
	analytics analyticsTracker
}

type cartRepository interface {
	GetCartByUserID(ctx context.Context, userID string) (*Cart, error)
	GetServicePrice(ctx context.Context, serviceID string, durationMinutes int) (int, error)
	GetOrCreateCart(ctx context.Context, userID string) (*Cart, error)
	AddItem(ctx context.Context, cartID, serviceID string, durationMinutes, priceCents int) (*CartItem, error)
	RemoveItem(ctx context.Context, cartID, itemID string) error
	ClearCart(ctx context.Context, cartID string) error
}

type analyticsTracker interface {
	Track(ctx context.Context, eventName, userID, bookingID string, props map[string]string)
}

// NewService creates a new cart service.
func NewService(repo cartRepository) *Service {
	return &Service{repo: repo}
}

func (s *Service) SetAnalytics(a analyticsTracker) {
	s.analytics = a
}

// GetCart returns the user's cart, creating one lazily.
func (s *Service) GetCart(ctx context.Context, userID string) (*Cart, error) {
	return s.repo.GetCartByUserID(ctx, userID)
}

// AddItem adds a service to the user's cart (upserts by service_id).
func (s *Service) AddItem(ctx context.Context, userID string, req AddItemRequest) (*Cart, error) {
	priceCents, err := s.repo.GetServicePrice(ctx, req.ServiceID, req.DurationMinutes)
	if err != nil {
		return nil, fmt.Errorf("invalid service: %w", err)
	}

	cart, err := s.repo.GetOrCreateCart(ctx, userID)
	if err != nil {
		return nil, err
	}

	if _, err := s.repo.AddItem(ctx, cart.ID, req.ServiceID, req.DurationMinutes, priceCents); err != nil {
		return nil, err
	}
	if s.analytics != nil {
		s.analytics.Track(ctx, analytics.EventCartItemAdded, userID, "", map[string]string{
			"service_id":       req.ServiceID,
			"duration_minutes": fmt.Sprintf("%d", req.DurationMinutes),
		})
	}

	return s.repo.GetCartByUserID(ctx, userID)
}

// RemoveItem removes a cart item by its ID.
func (s *Service) RemoveItem(ctx context.Context, userID, itemID string) (*Cart, error) {
	cart, err := s.repo.GetCartByUserID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if cart.ID == "" {
		return cart, nil
	}

	if err := s.repo.RemoveItem(ctx, cart.ID, itemID); err != nil {
		return nil, err
	}
	if s.analytics != nil {
		s.analytics.Track(ctx, analytics.EventCartItemRemoved, userID, "", map[string]string{
			"item_id": itemID,
		})
	}

	return s.repo.GetCartByUserID(ctx, userID)
}

// Clear empties the user's cart.
func (s *Service) Clear(ctx context.Context, userID string) error {
	cart, err := s.repo.GetCartByUserID(ctx, userID)
	if err != nil || cart.ID == "" {
		return err
	}
	return s.repo.ClearCart(ctx, cart.ID)
}
