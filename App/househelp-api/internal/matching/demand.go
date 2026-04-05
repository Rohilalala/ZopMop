package matching

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

const (
	// demandKeyPrefix is the Redis sorted-set key for today's live demand heatmap.
	// Format: demand:heatmap:YYYY-MM-DD
	// Each member is a hex cell ID; the score is the number of booking requests.
	demandKeyPrefix = "demand:heatmap:"

	// demandTTL — heatmap data is kept for 7 days so week-over-week patterns
	// remain available without bloating Redis.
	demandTTL = 7 * 24 * time.Hour
)

// TrackDemand increments the request counter for the cell that contains (lat, lng).
// Called once per new booking creation.  Non-blocking: Redis errors are logged
// but never returned so they cannot fail the booking flow.
func TrackDemand(ctx context.Context, rdb *redis.Client, lat, lng float64) {
	cellID := LatLngToCell(lat, lng)
	key := demandKey(time.Now())

	pipe := rdb.Pipeline()
	pipe.ZIncrBy(ctx, key, 1, cellID)
	pipe.Expire(ctx, key, demandTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		log.Warn().Err(err).
			Str("cell_id", cellID).
			Msg("[demand] failed to track request")
	}
}

// GetHeatmap returns today's demand heatmap sorted by request count (highest first).
// Each entry includes the cell ID, request count, and the geographic centre of
// the cell so clients can render it on a map without knowing the grid geometry.
func GetHeatmap(ctx context.Context, rdb *redis.Client) ([]DemandCell, error) {
	key := demandKey(time.Now())

	// ZRevRangeWithScores returns members sorted high→low.
	results, err := rdb.ZRevRangeWithScores(ctx, key, 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to read demand heatmap: %w", err)
	}

	cells := make([]DemandCell, 0, len(results))
	for _, z := range results {
		cellID, ok := z.Member.(string)
		if !ok {
			continue
		}
		cLat, cLng, err := CellCenter(cellID)
		if err != nil {
			continue
		}
		cells = append(cells, DemandCell{
			CellID:    cellID,
			Count:     z.Score,
			CenterLat: cLat,
			CenterLng: cLng,
		})
	}
	return cells, nil
}

// SupplyDemandRatio returns the ratio of available helpers to demand requests
// for a given cell, to drive dynamic surge pricing decisions.
// ratio > 1 → surplus helpers (no surge); ratio < 0.5 → possible surge.
func SupplyDemandRatio(ctx context.Context, rdb *redis.Client, cellID string) float64 {
	key := demandKey(time.Now())

	// Demand: booking requests in this cell today.
	demandScore, err := rdb.ZScore(ctx, key, cellID).Result()
	if err != nil || demandScore == 0 {
		return 1.0 // no demand → neutral ratio
	}

	// Supply: count helpers whose live location marker is in this cell's neighbours.
	// We use the active-marker keys "helper:active:<id>" as a proxy.
	// A full supply count would require iterating geo members; for now we use
	// a lightweight heuristic from a per-cell supply counter updated by the
	// location service on each helper location write.
	supplyKey := fmt.Sprintf("supply:cell:%s", cellID)
	supplyCount, err := rdb.Get(ctx, supplyKey).Float64()
	if err != nil {
		supplyCount = 1 // assume at least one helper if unknown
	}

	return supplyCount / demandScore
}

// ── helpers ───────────────────────────────────────────────────────────────────

func demandKey(t time.Time) string {
	return demandKeyPrefix + t.UTC().Format("2006-01-02")
}
