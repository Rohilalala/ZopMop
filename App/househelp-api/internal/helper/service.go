package helper

import (
	"context"
	"fmt"

	"github.com/adityarohilla/househelp-api/internal/location"
	"github.com/adityarohilla/househelp-api/internal/matching"
	"github.com/redis/go-redis/v9"
)

// Service is the business-logic layer for the helper module.
type Service struct {
	repo        *Repository
	locSvc      *location.Service
	matchEngine *matching.Engine
	rdb         *redis.Client
}

// NewService creates a new helper service.
func NewService(repo *Repository, locSvc *location.Service, engine *matching.Engine, rdb *redis.Client) *Service {
	return &Service{repo: repo, locSvc: locSvc, matchEngine: engine, rdb: rdb}
}

// GetProfile returns the authenticated helper's profile.
func (s *Service) GetProfile(ctx context.Context, helperID string) (*Profile, error) {
	return s.repo.GetProfile(ctx, helperID)
}

// GetInvites returns the list of booking invites for this helper.
// The matching engine stores booking IDs in Redis; we enrich them with DB details.
func (s *Service) GetInvites(ctx context.Context, helperID string) ([]Invite, error) {
	bookingIDs, err := s.matchEngine.GetHelperInvites(ctx, helperID)
	if err != nil {
		return nil, err
	}
	if len(bookingIDs) == 0 {
		return []Invite{}, nil
	}
	return s.repo.GetBookingInviteDetails(ctx, bookingIDs)
}

// DeclineInvite removes a booking from the helper's Redis invite set.
func (s *Service) DeclineInvite(ctx context.Context, helperID, bookingID string) error {
	key := fmt.Sprintf("match:h:%s", helperID)
	return s.rdb.SRem(ctx, key, bookingID).Err()
}

// UpdateLocation updates the helper's location in Redis (for matching) and Postgres.
// Calling this also marks the helper as available.
func (s *Service) UpdateLocation(ctx context.Context, helperID string, lat, lng float64) error {
	// Update Redis GEO + TTL marker (used by the matching engine).
	if err := s.locSvc.UpdateHelperLocation(ctx, helperID, lat, lng); err != nil {
		return err
	}
	// Persist to Postgres (current_lat/lng + hex cell).
	cellID := matching.LatLngToCell(lat, lng)
	return s.repo.UpdateLocation(ctx, helperID, lat, lng, cellID)
}

// SetAvailability toggles the helper's is_available flag.
// When going offline, clears the Redis TTL marker so they're excluded from matching.
// When going online, seeds Redis geo + active marker from the last known location
// so the helper appears immediately in nearby searches without waiting for a
// location ping from the app.
func (s *Service) SetAvailability(ctx context.Context, helperID string, available bool) error {
	if err := s.repo.SetAvailability(ctx, helperID, available); err != nil {
		return err
	}

	if !available {
		// Clear active marker when going offline to exclude from matching immediately.
		markerKey := fmt.Sprintf("helper:active:%s", helperID)
		s.rdb.Del(ctx, markerKey).Err()
		return nil
	}

	// Going online — seed Redis from last known DB location so the pro is
	// visible in nearby searches before their next location ping arrives.
	lat, lng, ok := s.repo.GetLastLocation(ctx, helperID)
	if !ok {
		return nil
	}
	return s.locSvc.UpdateHelperLocation(ctx, helperID, lat, lng)
}
