package slots

import "context"

// Service is the business-logic layer for time slots.
type Service struct {
	repo *Repository
}

// NewService creates a new slots service.
func NewService(repo *Repository) *Service {
	return &Service{repo: repo}
}

// GetByDate returns available slots for a date string "YYYY-MM-DD".
func (s *Service) GetByDate(ctx context.Context, date string) ([]TimeSlot, error) {
	return s.repo.GetByDate(ctx, date)
}

// IncrementBooking marks a slot as having one more booking.
func (s *Service) IncrementBooking(ctx context.Context, slotID string) error {
	return s.repo.IncrementBooking(ctx, slotID)
}
