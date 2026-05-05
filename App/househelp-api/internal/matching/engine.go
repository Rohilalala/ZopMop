package matching

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/googlemaps"
	mw "github.com/adityarohilla/househelp-api/internal/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// roundCoord rounds a lat/lng to 2 decimals (~1.1 km) for safe logging.
func roundCoord(x float64) float64 { return math.Round(x*100) / 100 }

// Eligibility rule is purely "≤ MaxWalkMinutes walking via Google Maps".
// No crow-fly radius gate. We pull the closest N pros from Postgres only as
// a soft volume bound so we do not hand a cartesian product to the Maps API.
const candidateFetchLimit = 50

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
//  1. Postgres fetch      — closest N is_available helpers via PostGIS, ordered by distance
//  2. Staleness check     — drops helpers whose Redis location TTL marker has expired
//  3. Walking-time gate   — Google Maps Distance Matrix; only ≤ MaxWalkMinutes pros survive
//  4. Score & rank        — multi-factor composite score via score.go
//  5. Store results       — writes matches to Redis for helpers to poll
//
// Only instant bookings flow through the Engine (via Batcher).
// Scheduled bookings are matched separately, closer to their scheduled_time.
type Engine struct {
	db        *pgxpool.Pool
	rdb       *redis.Client
	configSvc *config_manager.Service
	maps      *googlemaps.Client // required for instant booking (see SetMapsClient)
}

// NewEngine creates a ready-to-use matching engine.
func NewEngine(db *pgxpool.Pool, rdb *redis.Client, configSvc *config_manager.Service) *Engine {
	return &Engine{
		db:        db,
		rdb:       rdb,
		configSvc: configSvc,
	}
}

// getConfig fetches matching config from configSvc, falling back to hardcoded
// defaults if the fetch fails. Never caches on the Engine struct — callers
// get a fresh snapshot each time, avoiding concurrent read/write races.
func (e *Engine) getConfig(ctx context.Context) *config_manager.MatchingConfig {
	cfg, err := e.configSvc.GetMatchingConfig(ctx)
	if err != nil || cfg == nil {
		return defaultCfg()
	}
	return cfg
}

// ── Public API ────────────────────────────────────────────────────────────────

// FindBestHelpers is the synchronous entry-point used by the booking service
// when it needs an immediate result (e.g. admin dashboard, fallback path).
// For the normal flow, bookings go through the Batcher instead.
//
// The only eligibility rule is "the helper can walk to the customer in
// `MaxWalkMinutes` or less", evaluated by the Google Maps walking-time
// filter. There is no crow-fly radius gate. We return every eligible pro
// (no notification cap) so that as the chain expires/rejects, the booking
// can fall through to the next pro instead of dead-ending at a static top-N.
func (e *Engine) FindBestHelpers(ctx context.Context, lat, lng float64) ([]HelperMatch, error) {
	cfg := e.getConfig(ctx)

	candidates, err := e.fetchAndScoreCandidates(ctx, lat, lng)
	if err != nil {
		return nil, err
	}

	candidates = e.filterByWalkingTime(ctx, candidates, lat, lng, cfg.MaxWalkMinutes)
	RankCandidates(candidates)
	return ToHelperMatches(candidates, 0), nil
}

// GetHelperInvites returns the booking IDs a helper has been matched to.
// Helpers call this to discover which pending bookings they can accept.
// Capped at 100 entries — the set should never grow that large in practice
// (TTL prunes stale entries) but a runaway dispatch loop must not be able
// to drown the pro app in invites.
func (e *Engine) GetHelperInvites(ctx context.Context, helperID string) ([]string, error) {
	const maxInvites = 100
	key := fmt.Sprintf(matchHelperKeyFmt, helperID)
	members, err := e.rdb.SMembers(ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to read helper invites: %w", err)
	}
	if len(members) > maxInvites {
		members = members[:maxInvites]
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

// fetchAndScoreCandidates pulls the closest available helpers from Postgres,
// drops any whose live-location TTL marker has expired, and scores the
// survivors. There is no crow-fly radius gate — eligibility is decided
// downstream by the walking-time filter against the Google Maps API. The
// Postgres LIMIT exists only to bound how many helpers we hand to the Maps
// API per booking.
func (e *Engine) fetchAndScoreCandidates(ctx context.Context, lat, lng float64) ([]HelperCandidate, error) {
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
			COALESCE(active.cnt, 0)    AS active_bookings,
			ST_Y(h.location::geometry) AS cur_lat,
			ST_X(h.location::geometry) AS cur_lng,
			ST_Distance(
				h.location,
				ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
			) / 1000.0                 AS dist_km
		FROM helpers h
		LEFT JOIN (
			SELECT helper_id, COUNT(*) AS cnt
			FROM bookings
			WHERE status IN ('accepted', 'in_progress')
			GROUP BY helper_id
		) active ON active.helper_id = h.id
		WHERE h.is_available = true
		  AND h.location IS NOT NULL
		  AND COALESCE(h.rating, 5.0) >= $3
		ORDER BY h.location <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
		LIMIT $4
	`, lat, lng, minRating, candidateFetchLimit)
	if err != nil {
		return nil, fmt.Errorf("candidate fetch failed: %w", err)
	}
	defer rows.Close()

	var (
		candidates []HelperCandidate
		ids        []string
	)
	for rows.Next() {
		var c HelperCandidate
		if err := rows.Scan(&c.HelperID, &c.Rating, &c.TotalJobs, &c.ActiveBookings,
			&c.Lat, &c.Lng, &c.DistanceKm); err != nil {
			log.Warn().Err(err).Msg("[engine] failed to scan helper row")
			continue
		}
		ids = append(ids, c.HelperID)
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating helper rows: %w", err)
	}

	// Drop helpers whose Redis active-marker has expired (no location ping in
	// the last 5 minutes). This is the "currently online" gate.
	if len(ids) > 0 {
		aliveByID := make(map[string]bool, len(ids))
		pipe := e.rdb.Pipeline()
		cmds := make(map[string]*redis.IntCmd, len(ids))
		for _, id := range ids {
			cmds[id] = pipe.Exists(ctx, fmt.Sprintf("helper:active:%s", id))
		}
		if _, pipeErr := pipe.Exec(ctx); pipeErr != nil && !errors.Is(pipeErr, redis.Nil) {
			log.Warn().Err(pipeErr).Msg("[engine] pipelined helper:active EXISTS failed; treating all as alive")
			for _, id := range ids {
				aliveByID[id] = true
			}
		} else {
			for id, cmd := range cmds {
				aliveByID[id] = cmd.Val() > 0
			}
		}
		fresh := candidates[:0]
		for _, c := range candidates {
			if !aliveByID[c.HelperID] {
				log.Debug().Str("helper_id", c.HelperID).
					Msg("[engine] dropping stale helper — location TTL expired")
				continue
			}
			fresh = append(fresh, c)
		}
		candidates = fresh
	}

	for i := range candidates {
		ScoreCandidate(&candidates[i])
	}
	log.Debug().
		Float64("lat", roundCoord(lat)).Float64("lng", roundCoord(lng)).
		Int("candidates", len(candidates)).
		Msg("[engine] scored candidates")

	candidatesCount := len(candidates)
	mw.SafeGo("matching.update_supply_counter", func() {
		e.updateSupplyCounter(context.Background(), lat, lng, candidatesCount)
	})

	return candidates, nil
}

// storeMatchResults persists the match outcome to Redis so helpers can poll for
// invites, and increments match_attempts in Postgres.
func (e *Engine) storeMatchResults(ctx context.Context, bookingID string, matches []HelperMatch) error {
	if len(matches) == 0 {
		return nil
	}

	cfg := e.getConfig(ctx)

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
	mw.SafeGo("matching.increment_match_attempts", func() {
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
	})

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
	// Auto-cancel pending bookings whose dispatch window has expired without
	// any acceptance. We gate on `fire_at` (NOT created_at) so that scheduled
	// future bookings — which sit at status=pending for hours/days while
	// waiting for their fire_at to roll around — are NEVER auto-cancelled
	// here. Only bookings whose fire_at has passed are considered "stale";
	// the 2-minute grace gives the matcher a chance to land a helper.
	//
	// Filtering on fire_at IS NOT NULL skips legacy rows that pre-date the
	// stealth/scheduled split; those will never auto-cancel here either.
	if _, expErr := e.db.Exec(ctx, `
		UPDATE bookings
		   SET status = 'cancelled', updated_at = NOW(),
		       cancelled_at = NOW(), cancelled_by = 'system'
		 WHERE status   = 'pending'
		   AND fire_at IS NOT NULL
		   AND fire_at < NOW() - INTERVAL '2 minutes'
	`); expErr != nil {
		log.Warn().Err(expErr).Msg("[engine] failed to auto-cancel expired pending bookings")
	}

	// Same payment-state gate as the customer-facing list + scheduled
	// dispatcher. Cashfree-pending bookings only enter the candidate set
	// after the webhook flips payment_status='paid'. Wallet-pay (stamped
	// paid inline) and legacy/COD (NULL payment_method) continue to surface.
	rows, err := e.db.Query(ctx, `
		SELECT id, customer_id, lat::float8, lng::float8, COALESCE(hex_cell_id, '')
		FROM bookings
		WHERE status = 'pending'
		  AND (matched_at IS NULL OR matched_at < NOW() - INTERVAL '30 seconds')
		  AND match_attempts < 5
		  AND created_at > NOW() - INTERVAL '10 minutes'
		  AND (payment_method IS DISTINCT FROM 'cashfree' OR payment_status = 'paid')
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
// Instant booking is gated entirely by this client — passing nil disables
// instant matching outright, since the spec eligibility rule (≤ MaxWalkMinutes
// walking via Maps) cannot be evaluated without it.
func (e *Engine) SetMapsClient(c *googlemaps.Client) { e.maps = c }

// filterByWalkingTime is the sole eligibility gate. It calls Google Maps
// for every candidate (no top-N truncation) in parallel, drops anyone whose
// walking ETA exceeds the budget, AND drops anyone whose ETA is unknown
// (mins == 0 means API failure / ZERO_RESULTS / no key — fail-closed, since
// inviting an unverified pro violates the "≤ N min walk" guarantee).
//
// If the Maps client is nil, filtering is impossible and we return zero
// candidates so the booking is left unmatched and surfaces as no-pros-found
// instead of being routed to a pro who may be hours away.
func (e *Engine) filterByWalkingTime(
	ctx context.Context,
	candidates []HelperCandidate,
	destLat, destLng float64,
	maxWalkMinutes int,
) []HelperCandidate {
	if len(candidates) == 0 {
		return candidates
	}
	if e.maps == nil {
		log.Error().
			Msg("[engine] walking-time filter has no Maps client — refusing to match (set GOOGLE_MAPS_API_KEY)")
		return nil
	}

	type res struct {
		idx     int
		minutes int
	}
	ch := make(chan res, len(candidates))

	tCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	for i, c := range candidates {
		go func(i int, c HelperCandidate) {
			defer func() {
				if r := recover(); r != nil {
					log.Error().Interface("panic", r).
						Str("helper_id", c.HelperID).
						Msg("[engine] panic in walking time check — dropping candidate")
					ch <- res{i, 0}
				}
			}()
			mins, _ := e.maps.GetTravelMinutes(tCtx, c.Lat, c.Lng, destLat, destLng)
			ch <- res{i, mins}
		}(i, c)
	}

	minutesByIdx := make(map[int]int, len(candidates))
	for range candidates {
		r := <-ch
		minutesByIdx[r.idx] = r.minutes
	}

	filtered := make([]HelperCandidate, 0, len(candidates))
	for i := range candidates {
		mins := minutesByIdx[i]
		candidates[i].WalkingMinutes = mins
		switch {
		case mins == 0:
			log.Warn().
				Str("helper_id", candidates[i].HelperID).
				Float64("crow_km", candidates[i].DistanceKm).
				Msg("[engine] dropping candidate — Maps walking-time unknown (fail-closed)")
		case mins > maxWalkMinutes:
			log.Debug().
				Str("helper_id", candidates[i].HelperID).
				Int("walking_minutes", mins).
				Int("max_walk_minutes", maxWalkMinutes).
				Msg("[engine] helper filtered — walking time over budget")
		default:
			filtered = append(filtered, candidates[i])
		}
	}
	return filtered
}

// ── defaults ──────────────────────────────────────────────────────────────────

func defaultCfg() *config_manager.MatchingConfig {
	return &config_manager.MatchingConfig{
		MaxWalkMinutes:     25,
		TimeoutSeconds:     90,
		MaxHelpersNotified: 3,
	}
}
