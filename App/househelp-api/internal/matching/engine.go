package matching

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/googlemaps"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// Redis key templates for match results.
//
//	match:b:<bookingID>         → JSON array of HelperMatch; TTL = timeout_seconds
//	match:h:<helperID>          → SET of bookingIDs the helper is invited to accept
//	supply:cell:<cellID>        → float count of active helpers in this cell (used by demand ratio)
const (
	matchBookingKeyFmt = "match:b:%s"
	matchHelperKeyFmt  = "match:h:%s"
	supplyCellKeyFmt   = "supply:cell:%s"
)

// Engine handles the full matching pipeline:
//  1. Hex-cell pre-filter  — narrows the search area via Redis GEOSEARCH
//  2. Postgres enrich      — fetches availability, rating, active booking count
//  3. Staleness check      — drops helpers whose location TTL marker has expired
//  4. Score & rank         — multi-factor composite score via score.go
//  5. Store results        — writes matches to Redis for helpers to poll
//
// Only instant bookings flow through the Engine (via Batcher).
// Scheduled bookings are matched separately, closer to their scheduled_time.
type Engine struct {
	db        *pgxpool.Pool
	rdb       *redis.Client
	configSvc *config_manager.Service
	maps      *googlemaps.Client // optional; nil = skip walking-time filter

	// cfg is refreshed at the start of every batch window.
	cfg *config_manager.MatchingConfig
}

// NewEngine creates a ready-to-use matching engine.
func NewEngine(db *pgxpool.Pool, rdb *redis.Client, configSvc *config_manager.Service) *Engine {
	return &Engine{
		db:        db,
		rdb:       rdb,
		configSvc: configSvc,
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

// FindBestHelpers is the synchronous entry-point used by the booking service
// when it needs an immediate result (e.g. admin dashboard, fallback path).
// For the normal flow, bookings go through the Batcher instead.
//
// The function implements the two-phase search described in the stub:
//  1. Search within radius_km.
//  2. If no qualified helpers found, wait and retry with max_radius_km.
func (e *Engine) FindBestHelpers(ctx context.Context, lat, lng float64) ([]HelperMatch, error) {
	cfg, err := e.configSvc.GetMatchingConfig(ctx)
	if err != nil || cfg == nil {
		cfg = defaultCfg()
	}
	e.cfg = cfg

	candidates, err := e.fetchAndScoreCandidates(ctx, lat, lng)
	if err != nil {
		return nil, err
	}

	// Phase 2: expand radius if nothing found in the initial search.
	if len(candidates) == 0 && cfg.MaxRadiusKm > cfg.RadiusKm {
		log.Info().
			Float64("lat", lat).Float64("lng", lng).
			Float64("initial_radius_km", cfg.RadiusKm).
			Float64("expanded_radius_km", cfg.MaxRadiusKm).
			Msg("[engine] no helpers in initial radius — expanding")

		candidates, err = e.geoSearchCandidates(ctx, lat, lng, cfg.MaxRadiusKm, cfg)
		if err != nil {
			return nil, err
		}
	}

	RankCandidates(candidates)
	candidates = e.filterByWalkingTime(ctx, candidates, lat, lng)
	return ToHelperMatches(candidates, cfg.MaxHelpersNotified), nil
}

// GetHelperInvites returns the booking IDs a helper has been matched to.
// Helpers call this to discover which pending bookings they can accept.
func (e *Engine) GetHelperInvites(ctx context.Context, helperID string) ([]string, error) {
	key := fmt.Sprintf(matchHelperKeyFmt, helperID)
	members, err := e.rdb.SMembers(ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to read helper invites: %w", err)
	}
	return members, nil
}

// RemoveHelperInvites removes specific booking IDs from a helper's Redis invite set.
// Called by the booking service to prune stale invites when their underlying
// booking is no longer pending (cancelled, accepted by someone else, etc.).
func (e *Engine) RemoveHelperInvites(ctx context.Context, helperID string, bookingIDs []string) {
	if len(bookingIDs) == 0 {
		return
	}
	key := fmt.Sprintf(matchHelperKeyFmt, helperID)
	members := make([]interface{}, len(bookingIDs))
	for i, id := range bookingIDs {
		members[i] = id
	}
	if err := e.rdb.SRem(ctx, key, members...).Err(); err != nil {
		log.Warn().Err(err).Str("helper_id", helperID).
			Msg("[engine] failed to remove stale helper invites from Redis")
	}
}

// GetBookingMatches returns the helpers matched to a specific booking.
// Used by admin and for debugging.
func (e *Engine) GetBookingMatches(ctx context.Context, bookingID string) ([]HelperMatch, error) {
	key := fmt.Sprintf(matchBookingKeyFmt, bookingID)
	data, err := e.rdb.Get(ctx, key).Bytes()
	if err != nil {
		return nil, fmt.Errorf("no match data for booking %s: %w", bookingID, err)
	}
	var matches []HelperMatch
	if err := json.Unmarshal(data, &matches); err != nil {
		return nil, fmt.Errorf("corrupt match data for booking %s: %w", bookingID, err)
	}
	return matches, nil
}

// ClearMatchOnAccept removes match entries once a helper accepts, so other
// helpers stop seeing the booking as available.  Called by the booking service.
func (e *Engine) ClearMatchOnAccept(ctx context.Context, bookingID string, acceptedHelperID string) {
	bookingKey := fmt.Sprintf(matchBookingKeyFmt, bookingID)

	// Retrieve helper IDs that were matched to this booking.
	data, err := e.rdb.Get(ctx, bookingKey).Bytes()
	if err == nil {
		var matches []HelperMatch
		if json.Unmarshal(data, &matches) == nil {
			pipe := e.rdb.Pipeline()
			for _, m := range matches {
				helperKey := fmt.Sprintf(matchHelperKeyFmt, m.HelperID)
				pipe.SRem(ctx, helperKey, bookingID)
			}
			pipe.Del(ctx, bookingKey)
			if _, err := pipe.Exec(ctx); err != nil {
				log.Warn().Err(err).Str("booking_id", bookingID).
					Msg("[engine] failed to clear match keys on accept")
			}
		}
	}

	log.Info().
		Str("booking_id", bookingID).
		Str("helper_id", acceptedHelperID).
		Msg("[engine] match cleared — booking accepted")
}

// ── Internal pipeline ─────────────────────────────────────────────────────────

// fetchAndScoreCandidates runs the full pipeline for a single lat/lng:
// geo-search → postgres enrich → stale filter → score.
func (e *Engine) fetchAndScoreCandidates(ctx context.Context, lat, lng float64) ([]HelperCandidate, error) {
	cfg := e.cfg
	if cfg == nil {
		var err error
		cfg, err = e.configSvc.GetMatchingConfig(ctx)
		if err != nil || cfg == nil {
			cfg = defaultCfg()
		}
		e.cfg = cfg
	}
	return e.geoSearchCandidates(ctx, lat, lng, cfg.RadiusKm, cfg)
}

// geoSearchCandidates performs the three-stage pipeline for a given radius.
func (e *Engine) geoSearchCandidates(
	ctx context.Context,
	lat, lng, radiusKm float64,
	cfg *config_manager.MatchingConfig,
) ([]HelperCandidate, error) {
	// ── Stage 1: Redis GEOSEARCH ──────────────────────────────────────────────
	// Fetch up to 4× max helpers so Postgres filtering still leaves enough.
	fetchCount := cfg.MaxHelpersNotified * 4
	if fetchCount < 20 {
		fetchCount = 20
	}

	geoResults, err := e.rdb.GeoSearchLocation(ctx, "helpers:locations",
		&redis.GeoSearchLocationQuery{
			GeoSearchQuery: redis.GeoSearchQuery{
				Longitude:  lng,
				Latitude:   lat,
				Radius:     radiusKm,
				RadiusUnit: "km",
				Sort:       "ASC",
				Count:      fetchCount,
			},
			WithCoord: true,
			WithDist:  true,
		},
	).Result()
	if err != nil {
		return nil, fmt.Errorf("Redis GEOSEARCH failed: %w", err)
	}
	log.Debug().
		Float64("lat", lat).Float64("lng", lng).
		Float64("radius_km", radiusKm).
		Int("geo_results", len(geoResults)).
		Msg("[engine] GEOSEARCH result")
	if len(geoResults) == 0 {
		log.Warn().Float64("lat", lat).Float64("lng", lng).Float64("radius_km", radiusKm).
			Msg("[engine] no helpers in Redis geo index")
		return nil, nil
	}

	// Build helper ID list, distance map, and coordinate map.
	helperIDs := make([]string, len(geoResults))
	distByID := make(map[string]float64, len(geoResults))
	coordByID := make(map[string][2]float64, len(geoResults)) // [lat, lng]
	for i, r := range geoResults {
		helperIDs[i] = r.Name
		distByID[r.Name] = r.Dist // km, as returned by Redis
		coordByID[r.Name] = [2]float64{r.Latitude, r.Longitude}
	}

	// ── Stage 2: Postgres enrich + filter ────────────────────────────────────
	minRatingStr, _ := e.configSvc.GetConfig(ctx, config_manager.ConfigHelperMinRatingToAppear)
	minRating, _ := strconv.ParseFloat(minRatingStr, 64)
	if minRating <= 0 {
		minRating = 3.0
	}

	rows, err := e.db.Query(ctx, `
		SELECT
			h.id,
			COALESCE(h.rating, 5.0)    AS rating,
			COALESCE(h.total_jobs, 0)  AS total_jobs,
			COALESCE(active.cnt, 0)    AS active_bookings
		FROM helpers h
		LEFT JOIN (
			SELECT helper_id, COUNT(*) AS cnt
			FROM bookings
			WHERE status IN ('accepted', 'in_progress')
			GROUP BY helper_id
		) active ON active.helper_id = h.id
		WHERE h.id = ANY($1::uuid[])
		  AND h.is_available = true
		  AND COALESCE(h.rating, 5.0) >= $2
	`, helperIDs, minRating)
	if err != nil {
		return nil, fmt.Errorf("Postgres enrichment failed: %w", err)
	}
	defer rows.Close()

	// ── Stage 3: Stale location check + score ─────────────────────────────────
	// A helper whose TTL marker has expired was last seen > 5 minutes ago.
	// We drop them to avoid assigning a booking to someone who may have gone
	// offline.
	var candidates []HelperCandidate
	for rows.Next() {
		var c HelperCandidate
		if err := rows.Scan(&c.HelperID, &c.Rating, &c.TotalJobs, &c.ActiveBookings); err != nil {
			log.Warn().Err(err).Msg("[engine] failed to scan helper row")
			continue
		}

		// Check TTL marker (set by location service on every GPS ping).
		markerKey := fmt.Sprintf("helper:active:%s", c.HelperID)
		if exists, _ := e.rdb.Exists(ctx, markerKey).Result(); exists == 0 {
			log.Debug().Str("helper_id", c.HelperID).
				Msg("[engine] dropping stale helper — location TTL expired")
			continue
		}

		c.DistanceKm = distByID[c.HelperID]
		coord := coordByID[c.HelperID]
		c.Lat = coord[0]
		c.Lng = coord[1]
		ScoreCandidate(&c)
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating helper rows: %w", err)
	}
	log.Debug().Int("candidates_after_filter", len(candidates)).Msg("[engine] scored candidates")

	// Update per-cell supply counter for demand-ratio calculations.
	go e.updateSupplyCounter(context.Background(), lat, lng, len(candidates))

	return candidates, nil
}

// storeMatchResults persists the match outcome to Redis so helpers can poll for
// invites, and increments match_attempts in Postgres.
func (e *Engine) storeMatchResults(ctx context.Context, bookingID string, matches []HelperMatch) error {
	if len(matches) == 0 {
		return nil
	}

	cfg := e.cfg
	if cfg == nil {
		cfg = defaultCfg()
	}

	data, err := json.Marshal(matches)
	if err != nil {
		return fmt.Errorf("failed to marshal match results: %w", err)
	}

	ttl := time.Duration(cfg.TimeoutSeconds) * time.Second
	bookingKey := fmt.Sprintf(matchBookingKeyFmt, bookingID)

	pipe := e.rdb.Pipeline()

	// Store the ranked helper list for this booking.
	pipe.Set(ctx, bookingKey, data, ttl)

	// Add the booking ID to each helper's invite set.
	for _, m := range matches {
		helperKey := fmt.Sprintf(matchHelperKeyFmt, m.HelperID)
		pipe.SAdd(ctx, helperKey, bookingID)
		pipe.Expire(ctx, helperKey, ttl)
	}

	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("failed to write match results to Redis: %w", err)
	}

	// Increment match_attempts in Postgres (best-effort, non-blocking).
	go func() {
		uCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, dbErr := e.db.Exec(uCtx,
			`UPDATE bookings
			    SET match_attempts = match_attempts + 1,
			        matched_at     = NOW()
			  WHERE id = $1`,
			bookingID,
		)
		if dbErr != nil {
			log.Warn().Err(dbErr).Str("booking_id", bookingID).
				Msg("[engine] failed to update match_attempts")
		}
	}()

	log.Info().
		Str("booking_id", bookingID).
		Int("helpers_notified", len(matches)).
		Float64("top_score", matches[0].Score).
		Msg("[engine] match stored")

	return nil
}

// updateSupplyCounter writes the number of active helpers in a cell to Redis
// so SupplyDemandRatio can compute surge-pricing signals cheaply.
func (e *Engine) updateSupplyCounter(ctx context.Context, lat, lng float64, count int) {
	cellID := LatLngToCell(lat, lng)
	key := fmt.Sprintf(supplyCellKeyFmt, cellID)
	if err := e.rdb.Set(ctx, key, float64(count), 10*time.Minute).Err(); err != nil {
		log.Warn().Err(err).Str("cell_id", cellID).
			Msg("[engine] failed to update supply counter")
	}
}

// FetchPendingUnmatched returns pending bookings that still need matching.
// Used by the Batcher to retry bookings that weren't matched in a prior window
// (e.g. no helpers online yet) or that survived a server restart.
//
// As a side effect, pending bookings that have been attempted at least once and
// are older than 45 seconds are cancelled here.  This prevents stale bookings
// from generating fresh Redis invites long after the customer's 30-second
// search window has expired.
func (e *Engine) FetchPendingUnmatched(ctx context.Context) ([]BatchEntry, error) {
	// Auto-cancel pending bookings that have outlived the customer-facing timeout.
	// Condition: tried at least once (invites were sent) AND older than 45s.
	if _, expErr := e.db.Exec(ctx, `
		UPDATE bookings
		   SET status = 'cancelled', updated_at = NOW()
		 WHERE status = 'pending'
		   AND match_attempts > 0
		   AND created_at < NOW() - INTERVAL '45 seconds'
	`); expErr != nil {
		log.Warn().Err(expErr).Msg("[engine] failed to auto-cancel expired pending bookings")
	}

	rows, err := e.db.Query(ctx, `
		SELECT id, customer_id, lat::float8, lng::float8, COALESCE(hex_cell_id, '')
		FROM bookings
		WHERE status = 'pending'
		  AND (matched_at IS NULL OR matched_at < NOW() - INTERVAL '30 seconds')
		  AND match_attempts < 5
		  AND created_at > NOW() - INTERVAL '10 minutes'
		ORDER BY created_at ASC
		LIMIT 50
	`)
	if err != nil {
		return nil, fmt.Errorf("FetchPendingUnmatched query failed: %w", err)
	}
	defer rows.Close()

	var entries []BatchEntry
	for rows.Next() {
		var e BatchEntry
		if err := rows.Scan(&e.BookingID, &e.CustomerID, &e.Lat, &e.Lng, &e.CellID); err != nil {
			continue
		}
		e.EnqueuedAt = time.Now()
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// SetMapsClient attaches a Google Maps client for walking-time validation.
// Pass nil to disable the filter (default behaviour when no API key is set).
func (e *Engine) SetMapsClient(c *googlemaps.Client) { e.maps = c }

// filterByWalkingTime removes candidates whose walking travel time to the
// booking location exceeds 30 minutes.  It only checks the top 3 candidates
// (the rest are already unlikely to be assigned) and runs checks in parallel
// with a 5-second timeout so it never blocks the matching pipeline.
// Candidates with an unavailable result (API down, no key) are kept.
func (e *Engine) filterByWalkingTime(
	ctx context.Context,
	candidates []HelperCandidate,
	destLat, destLng float64,
) []HelperCandidate {
	if e.maps == nil || len(candidates) == 0 {
		return candidates
	}

	checkCount := len(candidates)
	if checkCount > 3 {
		checkCount = 3
	}
	toCheck := candidates[:checkCount]
	rest := candidates[checkCount:]

	type res struct {
		idx     int
		minutes int
	}
	ch := make(chan res, checkCount)

	tCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	for i, c := range toCheck {
		go func(i int, c HelperCandidate) {
			mins, _ := e.maps.GetTravelMinutes(tCtx, c.Lat, c.Lng, destLat, destLng)
			ch <- res{i, mins}
		}(i, c)
	}

	minutesByIdx := make(map[int]int, checkCount)
	for range toCheck {
		r := <-ch
		minutesByIdx[r.idx] = r.minutes
	}

	filtered := make([]HelperCandidate, 0, len(candidates))
	for i := range toCheck {
		mins := minutesByIdx[i]
		toCheck[i].WalkingMinutes = mins
		if mins == 0 || mins <= 30 {
			filtered = append(filtered, toCheck[i])
		} else {
			log.Debug().
				Str("helper_id", toCheck[i].HelperID).
				Int("walking_minutes", mins).
				Msg("[engine] helper filtered — walking time > 30 min")
		}
	}
	filtered = append(filtered, rest...)
	return filtered
}

// ── defaults ──────────────────────────────────────────────────────────────────

func defaultCfg() *config_manager.MatchingConfig {
	return &config_manager.MatchingConfig{
		RadiusKm:           5.0,
		MaxRadiusKm:        15.0,
		TimeoutSeconds:     90,
		MaxHelpersNotified: 3,
	}
}
