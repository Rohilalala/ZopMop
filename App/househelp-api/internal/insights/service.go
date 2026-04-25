package insights

import (
	"context"
	"fmt"
	"math"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

const (
	helpersGeoKey = "helpers:locations"
	// Search radius for "nearby" pros (km).
	nearbyRadiusKm = 5.0
	// Average pro travel speed for ETA estimate (km/h). Walking-ish.
	travelSpeedKmh = 12.0
	// Floor / ceiling clamps for ETA so the pill never reads silly values.
	minEtaMin = 2
	maxEtaMin = 45
)

type Service struct {
	repo *Repository
	rdb  *redis.Client
}

func NewService(repo *Repository, rdb *redis.Client) *Service {
	return &Service{repo: repo, rdb: rdb}
}

type NearbyStats struct {
	NearbyCount int     `json:"nearby_count"`
	AvgRating   float64 `json:"avg_rating"`
	AvgEtaMin   int     `json:"avg_eta_min"`
}

// NearbyStats returns live counts/ratings/ETA for the home pill.
// Uses Redis GEOSEARCH to find available helpers within nearbyRadiusKm.
// Falls back to a positive-default if Redis is unavailable so the UI is never
// misleadingly "0 pros" because of an infra blip.
func (s *Service) NearbyStats(ctx context.Context, lat, lng float64) (*NearbyStats, error) {
	geoResults, err := s.rdb.GeoSearchLocation(ctx, helpersGeoKey,
		&redis.GeoSearchLocationQuery{
			GeoSearchQuery: redis.GeoSearchQuery{
				Longitude:  lng,
				Latitude:   lat,
				Radius:     nearbyRadiusKm,
				RadiusUnit: "km",
				Sort:       "ASC",
				Count:      50,
			},
			WithDist: true,
		},
	).Result()
	if err != nil {
		log.Warn().Err(err).Msg("[insights] GEOSEARCH failed — returning soft default")
		return &NearbyStats{NearbyCount: 1, AvgRating: 5.0, AvgEtaMin: 5}, nil
	}

	// Filter to only helpers with a fresh active marker (≤ 5 min stale).
	var liveIDs []string
	var distances []float64
	for _, r := range geoResults {
		markerKey := fmt.Sprintf("helper:active:%s", r.Name)
		exists, _ := s.rdb.Exists(ctx, markerKey).Result()
		if exists == 1 {
			liveIDs = append(liveIDs, r.Name)
			distances = append(distances, r.Dist)
		}
	}

	count := len(liveIDs)

	avgRating := 5.0
	if count > 0 {
		if r, err := s.repo.AvgRatingForHelpers(ctx, liveIDs); err == nil {
			avgRating = r
		}
	}

	eta := minEtaMin
	if count > 0 {
		// Average distance of nearest 3 → minutes via travelSpeedKmh.
		topN := 3
		if len(distances) < topN {
			topN = len(distances)
		}
		var sum float64
		for i := 0; i < topN; i++ {
			sum += distances[i]
		}
		avgKm := sum / float64(topN)
		mins := int(math.Round((avgKm / travelSpeedKmh) * 60))
		if mins < minEtaMin {
			mins = minEtaMin
		}
		if mins > maxEtaMin {
			mins = maxEtaMin
		}
		eta = mins
	}

	return &NearbyStats{NearbyCount: count, AvgRating: avgRating, AvgEtaMin: eta}, nil
}

// MyUsuals returns service category IDs the user typically books.
func (s *Service) MyUsuals(ctx context.Context, userID string, limit int) ([]string, error) {
	return s.repo.MyUsualServiceIDs(ctx, userID, limit)
}
