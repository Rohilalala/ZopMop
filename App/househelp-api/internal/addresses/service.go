package addresses

import "context"

// Service handles business logic for user addresses.
type Service struct {
	repo *Repository
}

// NewService creates a new addresses service.
func NewService(repo *Repository) *Service {
	return &Service{repo: repo}
}

// ListByUser returns all saved addresses for a user.
func (s *Service) ListByUser(ctx context.Context, userID string) ([]Address, error) {
	return s.repo.ListByUser(ctx, userID)
}

// Create saves a new address for a user.
func (s *Service) Create(ctx context.Context, userID string, req CreateAddressRequest) (*Address, error) {
	return s.repo.Create(ctx, userID, req)
}

// Update modifies an existing address, verifying ownership.
func (s *Service) Update(ctx context.Context, userID, addressID string, req UpdateAddressRequest) (*Address, error) {
	return s.repo.Update(ctx, userID, addressID, req)
}

// Delete removes an address, verifying ownership.
func (s *Service) Delete(ctx context.Context, userID, addressID string) error {
	return s.repo.Delete(ctx, userID, addressID)
}
