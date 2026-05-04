package location

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	helpersLocationKey = "helpers:locations"
	locationExpiry     = 5 * time.Minute
)

// Service handles location tracking via Redis GEO.
type Service struct {
	rdb *redis.Client
}

// NewService creates a new location service.
func NewService(rdb *redis.Client) *Service {
	return &Service{rdb: rdb}
}

// UpdateHelperLocation stores or updates a helper's live location in Redis.
// Uses a Redis pipeline to atomically update GEOADD and TTL marker in one operation.
func (s *Service) UpdateHelperLocation(ctx context.Context, helperID string, lat, lng float64) error {
	// Use pipeline to ensure both operations succeed together (atomic at application level).
	pipe := s.rdb.Pipeline()
	
	// Add location to geo set for spatial queries.
	pipe.GeoAdd(ctx, helpersLocationKey, &redis.GeoLocation{
		Name:      helperID,
		Longitude: lng,
		Latitude:  lat,
	})
	
	// Set TTL marker so stale locations are detected.
	markerKey := fmt.Sprintf("helper:active:%s", helperID)
	pipe.Set(ctx, markerKey, "1", locationExpiry)
	
	// Execute both commands together.
	_, err := pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("failed to update helper location: %w", err)
	}

	return nil
}

// RemoveHelperLocation removes the helper from the geo set and clears the
// active marker. Called when a helper goes offline so the matching engine
// stops considering them, even if a stale GEO entry was present.
func (s *Service) RemoveHelperLocation(ctx context.Context, helperID string) error {
	pipe := s.rdb.Pipeline()
	pipe.ZRem(ctx, helpersLocationKey, helperID)
	pipe.Del(ctx, fmt.Sprintf("helper:active:%s", helperID))
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("failed to remove helper location: %w", err)
	}
	return nil
}

// GetHelperLocation retrieves a helper's current location from Redis.
func (s *Service) GetHelperLocation(ctx context.Context, helperID string) (*LocationResponse, error) {
	positions, err := s.rdb.GeoPos(ctx, helpersLocationKey, helperID).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get helper location: %w", err)
	}

	if len(positions) == 0 || positions[0] == nil {
		return nil, fmt.Errorf("helper location not found")
	}

	return &LocationResponse{
		HelperID: helperID,
		Lat:      positions[0].Latitude,
		Lng:      positions[0].Longitude,
	}, nil
}
