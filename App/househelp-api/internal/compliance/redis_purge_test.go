package compliance

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// newTestRedis spins up an in-process miniredis bound to the test
// lifecycle. Returns a real *redis.Client pointing at it. Caller can
// keep the *miniredis.Miniredis around to inspect state.
func newTestRedis(t *testing.T) (*redis.Client, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb, mr
}

// seedHelperGeoEntry primes both the GEO sorted set and the active
// marker for a helper, so PurgeHelperLocationFromRedis has something
// to remove. Mirrors the production write path in
// internal/location/service.go (UpdateHelperLocation).
func seedHelperGeoEntry(t *testing.T, rdb *redis.Client, helperID string, lat, lng float64) {
	t.Helper()
	ctx := context.Background()
	if err := rdb.GeoAdd(ctx, helpersGeoKey, &redis.GeoLocation{
		Name:      helperID,
		Latitude:  lat,
		Longitude: lng,
	}).Err(); err != nil {
		t.Fatalf("seed GEO: %v", err)
	}
	if err := rdb.Set(ctx, helperActiveMarkerPrefix+helperID, "1", 5*time.Minute).Err(); err != nil {
		t.Fatalf("seed active marker: %v", err)
	}
}

func TestPurgeHelperLocationFromRedis_RemovesGeoEntry(t *testing.T) {
	t.Parallel()
	rdb, _ := newTestRedis(t)
	svc := NewService(nil, nil)
	svc.SetRedis(rdb)

	helperID := "11111111-1111-1111-1111-111111111111"
	seedHelperGeoEntry(t, rdb, helperID, 12.97, 77.59)

	// Sanity: ZSCORE is non-nil before purge.
	if _, err := rdb.ZScore(context.Background(), helpersGeoKey, helperID).Result(); err != nil {
		t.Fatalf("pre-purge ZSCORE failed: %v", err)
	}

	if !svc.PurgeHelperLocationFromRedis(context.Background(), helperID) {
		t.Fatalf("expected attempted=true (Redis was wired)")
	}

	// Post-purge: ZSCORE returns redis.Nil for a removed member.
	_, err := rdb.ZScore(context.Background(), helpersGeoKey, helperID).Result()
	if !errors.Is(err, redis.Nil) {
		t.Fatalf("ZSCORE after purge: got err=%v, want redis.Nil", err)
	}
}

func TestPurgeHelperLocationFromRedis_RemovesActiveMarker(t *testing.T) {
	t.Parallel()
	rdb, mr := newTestRedis(t)
	svc := NewService(nil, nil)
	svc.SetRedis(rdb)

	helperID := "22222222-2222-2222-2222-222222222222"
	seedHelperGeoEntry(t, rdb, helperID, 12.97, 77.59)

	markerKey := helperActiveMarkerPrefix + helperID
	if !mr.Exists(markerKey) {
		t.Fatalf("seed: marker key missing")
	}

	svc.PurgeHelperLocationFromRedis(context.Background(), helperID)

	if mr.Exists(markerKey) {
		t.Fatalf("active marker key still present after purge")
	}
}

func TestPurgeHelperLocationFromRedis_NoOpWhenRedisUnset(t *testing.T) {
	t.Parallel()
	// Service constructed without Redis (e.g. retention-worker
	// binary, or an earlier-chunk binary that hasn't been migrated).
	// Purge must skip cleanly without a nil-deref.
	svc := NewService(nil, nil)
	if svc.PurgeHelperLocationFromRedis(context.Background(), "irrelevant") {
		t.Fatalf("expected attempted=false when Redis is unset")
	}
}

func TestPurgeHelperLocationFromRedis_HandlesRedisError(t *testing.T) {
	t.Parallel()
	rdb, mr := newTestRedis(t)
	svc := NewService(nil, nil)
	svc.SetRedis(rdb)

	helperID := "33333333-3333-3333-3333-333333333333"
	// Kill miniredis before the purge runs. SETNX/ZREM will error
	// out — we want to confirm the function logs and returns
	// without propagating the error (Redis outage must not block
	// user deletion).
	mr.Close()

	// Should not panic, should return true (attempted), even though
	// Redis ops will error internally and be logged.
	if !svc.PurgeHelperLocationFromRedis(context.Background(), helperID) {
		t.Fatalf("expected attempted=true even with broken Redis")
	}
}
