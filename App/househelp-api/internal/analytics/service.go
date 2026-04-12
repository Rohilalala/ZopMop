package analytics

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Service provides analytics tracking and reporting.
// All Track calls are fire-and-forget (run in goroutines) so they never
// add latency to the main request path.
type Service struct {
	repo *Repository
}

// NewService creates a new analytics service.
func NewService(db *pgxpool.Pool) *Service {
	return &Service{repo: NewRepository(db)}
}

// ── Event tracking ────────────────────────────────────────────────────────────

// Track records an analytics event asynchronously.
// userID and bookingID may be empty strings (stored as NULL).
// props may be nil.
func (s *Service) Track(ctx context.Context, eventName, userID, bookingID string, props map[string]string) {
	if s == nil {
		return
	}
	go func() {
		trackCtx := context.Background()
		s.repo.TrackEvent(trackCtx, eventName, userID, bookingID, props)
	}()
}

// TrackClientEvent validates and records an event submitted by the mobile app.
// Returns an error if the event name is not on the whitelist.
func (s *Service) TrackClientEvent(ctx context.Context, req *ClientEventRequest, userID string) error {
	if !AllowedClientEvents[req.EventName] {
		return fmt.Errorf("unknown event: %s", req.EventName)
	}

	go func() {
		s.repo.TrackEvent(context.Background(), req.EventName, userID, req.BookingID, req.Properties)
	}()
	return nil
}

// ── Reporting ─────────────────────────────────────────────────────────────────

// GetOverview returns KPI aggregates.
func (s *Service) GetOverview(ctx context.Context, days int) (*OverviewResponse, error) {
	days = clampDays(days)
	result, err := s.repo.GetOverview(ctx, days)
	if err != nil {
		log.Error().Err(err).Int("days", days).Msg("[analytics] GetOverview failed")
		return nil, err
	}
	return result, nil
}

// GetFunnel returns the booking conversion funnel.
func (s *Service) GetFunnel(ctx context.Context, days int) (*FunnelResponse, error) {
	days = clampDays(days)
	result, err := s.repo.GetFunnel(ctx, days)
	if err != nil {
		log.Error().Err(err).Int("days", days).Msg("[analytics] GetFunnel failed")
		return nil, err
	}
	return result, nil
}

// GetBookingTrends returns daily booking counts.
func (s *Service) GetBookingTrends(ctx context.Context, days int) ([]BookingTrendDay, error) {
	days = clampDays(days)
	result, err := s.repo.GetBookingTrends(ctx, days)
	if err != nil {
		log.Error().Err(err).Int("days", days).Msg("[analytics] GetBookingTrends failed")
		return nil, err
	}
	return result, nil
}

// GetWorkerPerformance returns per-helper metrics.
func (s *Service) GetWorkerPerformance(ctx context.Context, days, limit int) ([]WorkerMetrics, error) {
	days = clampDays(days)
	if limit < 1 || limit > 100 {
		limit = 20
	}
	result, err := s.repo.GetWorkerPerformance(ctx, days, limit)
	if err != nil {
		log.Error().Err(err).Int("days", days).Msg("[analytics] GetWorkerPerformance failed")
		return nil, err
	}
	return result, nil
}

// GetOperationalMetrics returns system timing and efficiency data.
func (s *Service) GetOperationalMetrics(ctx context.Context, days int) (*OperationalMetrics, error) {
	days = clampDays(days)
	result, err := s.repo.GetOperationalMetrics(ctx, days)
	if err != nil {
		log.Error().Err(err).Int("days", days).Msg("[analytics] GetOperationalMetrics failed")
		return nil, err
	}
	return result, nil
}

// GetRevenueTrends returns daily revenue aggregates.
func (s *Service) GetRevenueTrends(ctx context.Context, days int) ([]RevenueTrendDay, error) {
	days = clampDays(days)
	result, err := s.repo.GetRevenueTrends(ctx, days)
	if err != nil {
		log.Error().Err(err).Int("days", days).Msg("[analytics] GetRevenueTrends failed")
		return nil, err
	}
	return result, nil
}

// clampDays constrains the days parameter to [1, 90].
func clampDays(days int) int {
	if days < 1 {
		return 7
	}
	if days > 90 {
		return 90
	}
	return days
}
