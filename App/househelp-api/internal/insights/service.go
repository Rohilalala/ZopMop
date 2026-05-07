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
	// LIVEPILL DISPLAY ONLY — not used by the matching engine, the booking
	// service, or anything else. The pill is a marketing/awareness surface
	// ("N pros nearby") and a 3 km halo reads as a pleasant "live in your
	// neighbourhood" signal rather than the strict walking budget the
	// matcher actually uses (matching.max_walk_minutes, see matching/engine.go).
	// Do NOT reuse this constant for eligibility decisions — change one
	// number, break two unrelated features.
	pillRadiusKm = 3.0
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
// Uses Redis GEOSEARCH to find available helpers within pillRadiusKm.
// Falls back to a positive-default if Redis is unavailable so the UI is never
// misleadingly "0 pros" because of an infra blip.
func (s *Service) NearbyStats(ctx context.Context, lat, lng float64) (*NearbyStats, error) {
	geoResults, err := s.rdb.GeoSearchLocation(ctx, helpersGeoKey,
		&redis.GeoSearchLocationQuery{
			GeoSearchQuery: redis.GeoSearchQuery{
				Longitude:  lng,
				Latitude:   lat,
				Radius:     pillRadiusKm,
				RadiusUnit: "km",
				Sort:       "ASC",
				Count:      50,
			},
			WithDist: true,
		},
	).Result()
	if err != nil {
		log.Warn().Err(err).Msg("[insights] GEOSEARCH failed — returning zero count")
		return &NearbyStats{NearbyCount: 0, AvgRating: 5.0, AvgEtaMin: 0}, nil
	}

	// Filter to only helpers with a fresh active marker (≤ 5 min stale).
	// Pipeline the EXISTS calls so up to 50 candidates resolve in one
	// Redis round-trip instead of N (audit D3-F2). LivePill polls every
	// 5s so this dropped from 50 RTT/poll to 1.
	var liveIDs []string
	distByID := make(map[string]float64)
	if len(geoResults) > 0 {
		pipe := s.rdb.Pipeline()
		existCmds := make([]*redis.IntCmd, len(geoResults))
		for i, r := range geoResults {
			existCmds[i] = pipe.Exists(ctx, fmt.Sprintf("helper:active:%s", r.Name))
		}
		if _, err := pipe.Exec(ctx); err != nil {
			// Pipeline error: fall back to including everything as live.
			// GEOSEARCH already filtered to within-radius; missing the
			// activity-marker check is preferable to returning 0 pros.
			log.Warn().Err(err).Msg("[insights] EXISTS pipeline failed — returning all GEOSEARCH hits")
			for _, r := range geoResults {
				liveIDs = append(liveIDs, r.Name)
				distByID[r.Name] = r.Dist
			}
		} else {
			for i, r := range geoResults {
				if existCmds[i].Val() == 1 {
					liveIDs = append(liveIDs, r.Name)
					distByID[r.Name] = r.Dist
				}
			}
		}
	}

	// Further filter to only helpers with is_available=true in database.
	availableIDs, err := s.repo.FilterAvailableHelpers(ctx, liveIDs)
	if err != nil {
		log.Warn().Err(err).Msg("[insights] FilterAvailableHelpers failed")
		availableIDs = liveIDs // fallback: use Redis-filtered list
	}

	// Rebuild distances array for available helpers only.
	var distances []float64
	for _, id := range availableIDs {
		distances = append(distances, distByID[id])
	}
	liveIDs = availableIDs

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
