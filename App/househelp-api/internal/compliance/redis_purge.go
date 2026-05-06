package compliance

import (
	"context"
	"fmt"

	"github.com/rs/zerolog/log"
)

const (
	// helpersGeoKey is the Redis sorted set used by the matching engine
	// for nearby-helper lookup (`ZADD helpers:locations <member>
	// <score>`, where the score encodes the geohash of the lat/lng).
	// Mirror of internal/location/service.go:helpersLocationKey — kept
	// in sync intentionally; making the constant exported there would
	// pull a dependency from compliance into location, so we duplicate
	// the literal and rely on the tight, explicit comment on each
	// side.
	helpersGeoKey = "helpers:locations"

	// helperActiveMarkerPrefix is the Redis key prefix for the
	// "helper currently online" marker (5-min TTL set by
	// location.UpdateHelperLocation). Same kept-in-sync rationale as
	// helpersGeoKey.
	helperActiveMarkerPrefix = "helper:active:"
)

// PurgeHelperLocationFromRedis removes the deleted helper's residue
// from the live operational cache:
//
//   - ZREM helpers:locations <helperID>     (matching-engine GEO set)
//   - DEL  helper:active:<helperID>         (online-marker key)
//
// Audit C-8 / F2D-1 chunk 13. The Postgres helpers row is dropped by
// SoftDeleteUser (chunk 1), but Redis is not transactional with
// Postgres — the GEO entry survives the row drop. Without this hook
// the deleted helper's UUID + last-known lat/lng persist in Redis
// indefinitely (the GEO set has no TTL; only the active-marker key
// decays after 5 minutes).
//
// Errors are logged and swallowed. Redis being unreachable must NOT
// block user deletion: stale residue in a live cache is a much
// smaller compliance issue than refusing to delete an account because
// the cache is down. The retention here is bounded — the next
// matching engine pass that fails to find a Postgres row for the
// helper will treat the GEO entry as orphaned, and the marker key
// expires within 5 minutes anyway.
//
// No-op when the compliance Service was constructed without a Redis
// client (e.g. retention-worker binary). Returns true when a purge
// was actually attempted (regardless of whether it succeeded), false
// when skipped.
func (s *Service) PurgeHelperLocationFromRedis(ctx context.Context, helperID string) bool {
	if s.rdb == nil {
		return false
	}
	if err := s.rdb.ZRem(ctx, helpersGeoKey, helperID).Err(); err != nil {
		log.Warn().Err(err).Str("helper_id", helperID).Msg("[compliance] ZREM helpers:locations failed; continuing user deletion")
	}
	if err := s.rdb.Del(ctx, fmt.Sprintf("%s%s", helperActiveMarkerPrefix, helperID)).Err(); err != nil {
		log.Warn().Err(err).Str("helper_id", helperID).Msg("[compliance] DEL helper:active marker failed; continuing user deletion")
	}
	return true
}
