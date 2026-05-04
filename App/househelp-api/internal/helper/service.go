package helper

import (
	"context"
	"fmt"
	"time"

	"github.com/adityarohilla/househelp-api/internal/analytics"
	"github.com/adityarohilla/househelp-api/internal/location"
	"github.com/adityarohilla/househelp-api/internal/matching"
	"github.com/adityarohilla/househelp-api/internal/webhooks"
	"github.com/redis/go-redis/v9"
)

// Service is the business-logic layer for the helper module.
type Service struct {
	repo        *Repository
	locSvc      *location.Service
	matchEngine *matching.Engine
	rdb         *redis.Client
	webhooks    *webhooks.Dispatcher // nil-safe; outbound CRM webhook fan-out
	analytics   *analytics.Service   // nil-safe; emits helper.went_online/offline
}

// NewService creates a new helper service.
func NewService(repo *Repository, locSvc *location.Service, engine *matching.Engine, rdb *redis.Client) *Service {
	return &Service{repo: repo, locSvc: locSvc, matchEngine: engine, rdb: rdb}
}

// SetWebhooks attaches the outbound webhook dispatcher (nil-safe — leaving it
// unset is the correct default in unit tests).
func (s *Service) SetWebhooks(d *webhooks.Dispatcher) { s.webhooks = d }

// SetAnalytics attaches the analytics tracker. Used by SetAvailability to emit
// helper.went_online / helper.went_offline events on real transitions only.
func (s *Service) SetAnalytics(a *analytics.Service) { s.analytics = a }

// fireWebhook is a nil-safe wrapper so unit tests don't need a real dispatcher.
func (s *Service) fireWebhook(ctx context.Context, event string, payload any) {
	if s.webhooks == nil {
		return
	}
	s.webhooks.Dispatch(ctx, event, payload)
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
	changed, err := s.repo.SetAvailability(ctx, helperID, available)
	if err != nil {
		return err
	}

	if !available {
		// Remove from Redis GEO set + clear active marker so the matching
		// engine cannot return this helper. ZREM keeps the geo index in
		// sync with PG (is_available=false). The active marker check is a
		// secondary safety net.
		if err := s.locSvc.RemoveHelperLocation(ctx, helperID); err != nil {
			// Non-fatal: the active marker check still excludes them.
			// Log via repo error path is sufficient.
			_ = err
		}
		if changed {
			s.fireWebhook(ctx, webhooks.EventWorkerOffline, webhooks.WorkerStatusEvent{
				HelperID:   helperID,
				IsOnline:   false,
				OccurredAt: time.Now().UTC(),
			})
			if s.analytics != nil {
				s.analytics.Track(ctx, analytics.EventHelperOffline, helperID, "", nil)
			}
		}
		return nil
	}

	// Going online — seed Redis from last known DB location so the pro is
	// visible in nearby searches before their next location ping arrives.
	lat, lng, ok := s.repo.GetLastLocation(ctx, helperID)
	payload := webhooks.WorkerStatusEvent{
		HelperID:   helperID,
		IsOnline:   true,
		OccurredAt: time.Now().UTC(),
	}
	if ok {
		latVal, lngVal := lat, lng
		payload.Lat = &latVal
		payload.Lng = &lngVal
	}
	if changed {
		s.fireWebhook(ctx, webhooks.EventWorkerOnline, payload)
		if s.analytics != nil {
			s.analytics.Track(ctx, analytics.EventHelperOnline, helperID, "", nil)
		}
	}

	if !ok {
		return nil
	}
	return s.locSvc.UpdateHelperLocation(ctx, helperID, lat, lng)
}

// UpdateLocality validates that the supplied locality matches one of the
// active rows in the localities table, then writes it onto helpers.locality.
// Empty string clears the locality. The dispatch crons use this field to
// match invites to the right pros (see internal/matching/dispatch.go).
func (s *Service) UpdateLocality(ctx context.Context, helperID, locality string) error {
	return s.repo.UpdateLocality(ctx, helperID, locality)
}
