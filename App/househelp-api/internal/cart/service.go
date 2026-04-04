package cart

import (
	"context"
	"fmt"
)

// Service is the business-logic layer for the cart module.
type Service struct {
	repo *Repository
}

// NewService creates a new cart service.
func NewService(repo *Repository) *Service {
	return &Service{repo: repo}
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
