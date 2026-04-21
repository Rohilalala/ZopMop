package analytics

import (
	"context"
	"fmt"
	"math"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// Service provides analytics tracking and reporting.
// All Track calls are fire-and-forget (run in goroutines) so they never
// add latency to the main request path.
type Service struct {
	repo     *Repository
	writer   eventWriter
	dispatch func(func())
}

// NewService creates a new analytics service.
func NewService(db *pgxpool.Pool) *Service {
	repo := NewRepository(db)
	return &Service{
		repo:   repo,
		writer: repo,
		dispatch: func(trackFn func()) {
			go trackFn()
		},
	}
}

// ── Event tracking ────────────────────────────────────────────────────────────

type eventWriter interface {
	TrackEvent(ctx context.Context, eventName, userID, bookingID string, props map[string]interface{})
}

// Track records an analytics event asynchronously.
// userID and bookingID may be empty strings (stored as NULL).
// props may be nil.
func (s *Service) Track(ctx context.Context, eventName, userID, bookingID string, props map[string]string) {
	_ = ctx
	if !s.canTrack() {
		return
	}
	trackProperties := toInterfaceMap(props)
	s.dispatchTracking(func() {
		trackCtx := context.Background()
		s.writer.TrackEvent(trackCtx, eventName, userID, bookingID, trackProperties)
	})
}

// TrackClientEvent validates and records an event submitted by the mobile app.
// Returns an error if the event name is not on the whitelist.
func (s *Service) TrackClientEvent(ctx context.Context, req *ClientEventRequest, userID string) error {
	_ = ctx
	if req == nil {
		return fmt.Errorf("request body is required")
	}
	eventName := strings.TrimSpace(req.EventName)
	if !AllowedClientEvents[eventName] {
		return fmt.Errorf("unknown event: %s", eventName)
	}
	if ContainsSensitiveStringKeys(req.Properties) {
		return fmt.Errorf("sensitive keys are not allowed")
	}
	cleanProperties := StripSensitiveStringKeys(req.Properties)
	if !s.canTrack() {
		return nil
	}
	trackProperties := toInterfaceMap(cleanProperties)
	s.dispatchTracking(func() {
		s.writer.TrackEvent(context.Background(), eventName, userID, req.BookingID, trackProperties)
	})
	return nil
}

// TrackCanonicalEvent validates and records an event submitted via canonical ingestion.
func (s *Service) TrackCanonicalEvent(ctx context.Context, req *CanonicalEventRequest, authenticatedUserID string) error {
	_ = ctx
	if err := ValidateCanonicalEvent(req); err != nil {
		return err
	}
	if !AllowedClientEvents[req.EventName] {
		return fmt.Errorf("unknown event: %s", req.EventName)
	}
	if strings.TrimSpace(authenticatedUserID) == "" {
		return fmt.Errorf("authenticated user is required")
	}
	if req.UserID != authenticatedUserID {
		return fmt.Errorf("user_id does not match authenticated user")
	}

	cleanMetadata := StripSensitiveKeys(req.Metadata)
	cleanProperties := StripSensitiveKeys(req.Properties)
	locationLat := roundCoordinate(*req.Location.Lat)
	locationLng := roundCoordinate(*req.Location.Lng)

	trackProperties := map[string]interface{}{
		"event_id":      req.EventID,
		"event_version": req.EventVersion,
		"timestamp":     req.Timestamp.UTC(),
		"device":        req.Device,
		"location_lat":  locationLat,
		"location_lng":  locationLng,
		"location_area": req.Location.Area,
		"metadata":      cleanMetadata,
		"properties":    cleanProperties,
	}
	if req.HelperID != nil && strings.TrimSpace(*req.HelperID) != "" {
		trackProperties["helper_id"] = strings.TrimSpace(*req.HelperID)
	}

	bookingID := ""
	if rawBookingID, ok := cleanProperties["booking_id"]; ok {
		if id, ok := rawBookingID.(string); ok {
			bookingID = strings.TrimSpace(id)
		}
	}

	if !s.canTrack() {
		return nil
	}
	s.dispatchTracking(func() {
		s.writer.TrackEvent(context.Background(), req.EventName, req.UserID, bookingID, trackProperties)
	})
	return nil
}

func (s *Service) canTrack() bool {
	return s != nil && s.writer != nil
}

func (s *Service) dispatchTracking(trackFn func()) {
	if s.dispatch == nil {
		go trackFn()
		return
	}
	s.dispatch(trackFn)
}

func toInterfaceMap(props map[string]string) map[string]interface{} {
	if len(props) == 0 {
		return map[string]interface{}{}
	}
	trackProperties := make(map[string]interface{}, len(props))
	for key, value := range props {
		trackProperties[key] = value
	}
	return trackProperties
}

func roundCoordinate(value float64) float64 {
	return math.Round(value*1000) / 1000
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
