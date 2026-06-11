package matching

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// Redis key templates for legacy invite-set results.
//
//	match:b:<bookingID>         → JSON array of HelperMatch (read-only now)
//	match:h:<helperID>          → SET of bookingIDs the helper is invited to accept
const (
	matchBookingKeyFmt = "match:b:%s"
	matchHelperKeyFmt  = "match:h:%s"
)

// Engine owns the Redis invite-set surface read by the pro app (pending
// offers) and pruned by the booking service. The scoring/batch matching
// pipeline that previously lived here was retired by the unified JIT
// assigner (spec §9); only the invite-set readers/writers survive.
type Engine struct {
	db  *pgxpool.Pool
	rdb *redis.Client
}

// NewEngine creates a ready-to-use matching engine.
func NewEngine(db *pgxpool.Pool, rdb *redis.Client) *Engine {
	return &Engine{
		db:  db,
		rdb: rdb,
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

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
