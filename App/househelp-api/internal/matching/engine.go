package matching

import (
	"context"
	"fmt"

	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// Engine handles the matching logic to find nearest available helpers.
type Engine struct {
	db        *pgxpool.Pool
	rdb       *redis.Client
	configSvc *config_manager.Service
}

// NewEngine creates a new matching engine.
func NewEngine(db *pgxpool.Pool, rdb *redis.Client, configSvc *config_manager.Service) *Engine {
	return &Engine{
		db:        db,
		rdb:       rdb,
		configSvc: configSvc,
	}
}

// FindNearestHelpers finds available helpers within the given radius.
//
// Implementation approach:
// 1. Use Redis GEOSEARCH to find helpers with live locations within radius.
//    - Helpers continuously update their position via the location WebSocket.
//    - Redis stores positions using GEOADD with key "helpers:locations".
//    - GEOSEARCH BYLONLAT <lng> <lat> BYRADIUS <radius> km ASC returns sorted results.
//
// 2. Cross-reference with PostgreSQL to filter:
//    - Only helpers where is_available = true
//    - Only helpers with rating >= min_rating (from config_manager)
//    - Only helpers not currently in an active booking
//
// 3. Return up to max_helpers_notified (from config_manager) helpers sorted by distance.
//
// 4. If no helpers found within initial radius, the booking service waits
//    matching.timeout_seconds and then retries with matching.max_radius_km.
//
// The config_manager dynamically provides radius, timeout, and max_helpers values
// so admins can tune matching behavior without code deploys.
func (e *Engine) FindNearestHelpers(ctx context.Context, lat, lng, radiusKm float64) ([]HelperMatch, error) {
	// Get config values dynamically.
	matchingConfig, err := e.configSvc.GetMatchingConfig(ctx)
	if err != nil {
		log.Warn().Err(err).Msg("failed to get matching config, using provided radius")
	}

	// Defensive check: ensure matchingConfig is not nil before accessing fields.
	if matchingConfig == nil {
		log.Warn().Msg("matching config is nil, using hardcoded defaults")
		matchingConfig = &config_manager.MatchingConfig{
			RadiusKm:           15.0,
			MaxRadiusKm:        30.0,
			TimeoutSeconds:     30,
			MaxHelpersNotified: 3,
		}
	}

	if radiusKm <= 0 {
		radiusKm = matchingConfig.RadiusKm
	}

	maxHelpers := matchingConfig.MaxHelpersNotified

	// TODO: Implement Redis GEOSEARCH + PostgreSQL filter pipeline.
	//
	// Step 1: Redis GEOSEARCH
	// results, err := e.rdb.GeoSearchLocation(ctx, "helpers:locations", &redis.GeoSearchLocationQuery{
	//     GeoSearchQuery: redis.GeoSearchQuery{
	//         Longitude:  lng,
	//         Latitude:   lat,
	//         Radius:     radiusKm,
	//         RadiusUnit: "km",
	//         Sort:       "ASC",
	//         Count:      maxHelpers * 3, // Fetch more to allow filtering.
	//     },
	//     WithCoord: true,
	//     WithDist:  true,
	// }).Result()
	//
	// Step 2: Fetch helper IDs from results
	// Step 3: Filter by availability, rating, and active booking status in PostgreSQL
	// Step 4: Sort by distance, return top maxHelpers

	log.Info().
		Float64("lat", lat).
		Float64("lng", lng).
		Float64("radius_km", radiusKm).
		Int("max_helpers", maxHelpers).
		Msg("FindNearestHelpers called (stub)")

	return nil, fmt.Errorf("matching engine not yet implemented")
}
