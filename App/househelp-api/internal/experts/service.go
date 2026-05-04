package experts

import (
	"context"
	"errors"
	"fmt"
)

// ErrLimitReached is returned when adding would push the user past
// MaxExpertsPerUser.
var ErrLimitReached = errors.New("experts list is full")

// Service is the experts business layer.
type Service struct {
	repo *Repository
}

// NewService wires a Service.
func NewService(repo *Repository) *Service { return &Service{repo: repo} }

// List returns the user's preferred helpers (max MaxExpertsPerUser rows).
func (s *Service) List(ctx context.Context, userID string) ([]Expert, error) {
	return s.repo.List(ctx, userID)
}

// Add validates + inserts a preferred helper. Errors:
//   - ErrHelperUnknown   — helperID is not a real active pro
//   - ErrLimitReached    — user already has MaxExpertsPerUser helpers
//   - ErrAlreadyAdded    — pair already exists
func (s *Service) Add(ctx context.Context, userID, helperID string) error {
	exists, err := s.repo.HelperExists(ctx, helperID)
	if err != nil {
		return err
	}
	if !exists {
		return ErrHelperUnknown
	}

	// Race window: between Count and Add a parallel request could push the
	// user over the limit. Acceptable for v1 — the cap is a soft UX guard,
	// not a security boundary. Tighten with a SELECT FOR UPDATE on the user
	// row if abuse shows up.
	n, err := s.repo.Count(ctx, userID)
	if err != nil {
		return err
	}
	if n >= MaxExpertsPerUser {
		return ErrLimitReached
	}

	return s.repo.Add(ctx, userID, helperID)
}

// Remove drops a preferred helper.
func (s *Service) Remove(ctx context.Context, userID, helperID string) error {
	return s.repo.Remove(ctx, userID, helperID)
}

// PreferredHelperIDs returns the user's preferred helper IDs in
// oldest-first order. Consumed by the scheduled-dispatch invite chain.
func (s *Service) PreferredHelperIDs(ctx context.Context, userID string) ([]string, error) {
	ids, err := s.repo.PreferredHelperIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("preferred helper ids: %w", err)
	}
	return ids, nil
}
