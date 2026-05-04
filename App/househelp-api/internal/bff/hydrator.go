package bff

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/semaphore"
	"golang.org/x/sync/singleflight"

	"github.com/adityarohilla/househelp-api/pkg/database"
)

// hydrationBudget bounds total time spent fetching all $ref sources for one
// page request. Per-source timeouts (from SourceDef.Timeout) sit inside this.
const hydrationBudget = 800 * time.Millisecond

// hydrationConcurrency caps the number of concurrent source fetches per
// request. Spec §13: per-request semaphore = 6.
const hydrationConcurrency = 6

// Hydrator owns the per-source/per-batch fetch pipeline: Redis L1 → singleflight
// → circuit breaker → SourceDef.Fetch (with per-source timeout). Process-wide
// state (singleflight, semaphore) is intentionally a single instance reused
// across requests so coalescing can span concurrent callers.
type Hydrator struct {
	reg           SourceRegistry
	batches       BatchRegistry
	circuit       *Circuit
	rdb           *redis.Client
	configVersion string

	sf  singleflight.Group
	sem *semaphore.Weighted
}

// NewHydrator builds a Hydrator with a fresh singleflight group and a shared
// concurrency semaphore. configVersion namespaces every Redis key so a config
// rollover can't serve stale values.
func NewHydrator(reg SourceRegistry, batches BatchRegistry, circuit *Circuit, rdb *redis.Client, configVersion string) *Hydrator {
	return &Hydrator{
		reg:           reg,
		batches:       batches,
		circuit:       circuit,
		rdb:           rdb,
		configVersion: configVersion,
		sem:           semaphore.NewWeighted(hydrationConcurrency),
	}
}

// Hydrate fetches every refKey under a global 800ms budget and returns a
// key→value map. Non-critical sources that fail (or are skipped due to budget
// exhaustion) join the missing list and are not in the map. Only critical
// failures and budget+ctx errors are returned via err.
func (h *Hydrator) Hydrate(ctx context.Context, rc RequestContext, refKeys []string) (map[string]any, []string, error) {
	keys := dedupeStrings(refKeys)

	// Classify into per-key and batched sources.
	var perKey []SourceDef
	batched := map[string][]string{} // batchName → keys
	for _, k := range keys {
		// i18n.* keys are routed through the i18n batch even if not registered
		// per-key in SourceRegistry.
		if IsI18nKey(k) {
			batched["i18n"] = append(batched["i18n"], k)
			continue
		}
		src, ok := h.reg[k]
		if !ok {
			// Unknown $ref keys are validator's job to reject; at runtime we
			// just skip — caller decides via $required/$default.
			continue
		}
		if src.Batch != "" {
			batched[src.Batch] = append(batched[src.Batch], k)
			continue
		}
		if src.Fetch != nil {
			perKey = append(perKey, src)
		}
	}

	// Global budget gate.
	hctx, cancel := context.WithTimeout(ctx, hydrationBudget)
	defer cancel()

	var (
		mu      sync.Mutex
		result  = make(map[string]any, len(keys))
		missing = make([]string, 0)
	)
	addResult := func(k string, v any) {
		mu.Lock()
		result[k] = v
		mu.Unlock()
	}
	addMissing := func(k string) {
		mu.Lock()
		missing = append(missing, k)
		mu.Unlock()
	}

	g, gctx := errgroup.WithContext(hctx)

	// Per-key sources.
	for _, src := range perKey {
		src := src
		g.Go(func() error {
			val, miss, critErr := h.fetchOne(gctx, rc, src)
			if critErr != nil {
				return critErr
			}
			if miss {
				addMissing(src.Key)
				return nil
			}
			addResult(src.Key, val)
			return nil
		})
	}

	// Batched sources.
	for batchName, batchKeys := range batched {
		batchName := batchName
		batchKeys := batchKeys
		g.Go(func() error {
			values, missList, critErr := h.fetchBatch(gctx, rc, batchName, batchKeys)
			if critErr != nil {
				return critErr
			}
			for k, v := range values {
				addResult(k, v)
			}
			for _, k := range missList {
				addMissing(k)
			}
			return nil
		})
	}

	if err := g.Wait(); err != nil {
		// Budget exhaustion or context cancellation isn't itself a critical
		// failure — non-critical work simply joined `missing`. Surface ctx err
		// only if the parent context (not the budget timer) was cancelled.
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			if ctx.Err() != nil {
				return result, missing, ctx.Err()
			}
			return result, missing, nil
		}
		return result, missing, err
	}

	return result, missing, nil
}

// fetchOne resolves a single per-key source. Returns (value, missing, criticalErr).
// missing=true means a non-critical fetch failed and the key should be added
// to the missing list. criticalErr is non-nil only when src.Critical is true
// and the fetch (or breaker) errored.
func (h *Hydrator) fetchOne(ctx context.Context, rc RequestContext, src SourceDef) (any, bool, error) {
	// Cache key suffix: per-user for user-scoped, per-zone otherwise.
	suffix := h.suffixFor(rc, src.UserScoped)
	cacheKey := fmt.Sprintf("hydra:v%s:%s:%s", h.configVersion, src.Key, suffix)

	// L1: Redis lookup. A miss or any redis error falls through to fetch; we
	// don't fail the request on cache problems.
	if v, ok := h.cacheGet(ctx, cacheKey); ok {
		LogSourceFetch(src.Key, 0, true, nil)
		return v, false, nil
	}

	start := time.Now()

	// Singleflight at the cache-key level: identical concurrent requests share
	// one upstream fetch + breaker call.
	v, err, _ := h.sf.Do(cacheKey, func() (any, error) {
		// Per-request semaphore — bounds concurrency across all goroutines in
		// this hydration cycle. If the budget is already blown, Acquire returns
		// ctx.Err() and we fall through to error handling below.
		if err := h.sem.Acquire(ctx, 1); err != nil {
			return nil, err
		}
		defer h.sem.Release(1)

		// Bail fast if the global budget has already expired between submit
		// and acquire.
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		breaker := h.circuit.Get(src.Key)
		val, bErr := breaker.Execute(func() (any, error) {
			fctx, fcancel := context.WithTimeout(ctx, src.Timeout)
			defer fcancel()
			return src.Fetch(fctx, rc)
		})
		if bErr != nil {
			return nil, bErr
		}
		// Write-through to Redis. TTL = src.TTL. JSON-encode so we can store
		// arbitrary value shapes.
		h.cacheSet(ctx, cacheKey, val, src.TTL)
		return val, nil
	})

	latency := time.Since(start)

	if err != nil {
		LogSourceFetch(src.Key, latency, false, err)
		if src.Critical {
			return nil, false, fmt.Errorf("critical source %s: %w", src.Key, err)
		}
		return nil, true, nil
	}

	LogSourceFetch(src.Key, latency, false, nil)
	return v, false, nil
}

// fetchBatch resolves all keys in a batch via a single BatchDef.Fetch call,
// coalesced via singleflight at the batch level. Cached results are written
// per-key so individual misses can be filled later without re-running the
// whole batch.
func (h *Hydrator) fetchBatch(ctx context.Context, rc RequestContext, batchName string, keys []string) (map[string]any, []string, error) {
	bd, ok := h.batches[batchName]
	if !ok {
		// Unknown batch — treat all its keys as missing rather than erroring.
		return nil, keys, nil
	}

	values := make(map[string]any, len(keys))
	pending := make([]string, 0, len(keys))

	// L1 lookup per key first — anything in Redis we don't need to refetch.
	for _, k := range keys {
		// User-scoped flag for batch-derived keys is taken from the per-key
		// SourceDef when present (registry can declare "insights.*" with
		// UserScoped=false); falls back to false if absent.
		userScoped := false
		if src, ok := h.reg[k]; ok {
			userScoped = src.UserScoped
		}
		suffix := h.suffixFor(rc, userScoped)
		cacheKey := fmt.Sprintf("hydra:v%s:%s:%s", h.configVersion, k, suffix)
		if v, hit := h.cacheGet(ctx, cacheKey); hit {
			values[k] = v
			LogSourceFetch(k, 0, true, nil)
			continue
		}
		pending = append(pending, k)
	}
	if len(pending) == 0 {
		return values, nil, nil
	}

	// Stable batch singleflight key: union of pending keys, sorted.
	sortedPending := append([]string(nil), pending...)
	sort.Strings(sortedPending)
	suffix := strings.Join(sortedPending, ",")
	sfKey := fmt.Sprintf("batch:v%s:%s:%s", h.configVersion, batchName, suffix)

	start := time.Now()

	raw, err, _ := h.sf.Do(sfKey, func() (any, error) {
		if err := h.sem.Acquire(ctx, 1); err != nil {
			return nil, err
		}
		defer h.sem.Release(1)

		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		// One breaker per batch — independent of per-key breakers.
		breaker := h.circuit.Get("batch:" + batchName)
		out, bErr := breaker.Execute(func() (any, error) {
			// Use the longest per-source timeout among pending keys; falls back
			// to 400ms if none registered.
			timeout := 400 * time.Millisecond
			for _, k := range pending {
				if src, ok := h.reg[k]; ok && src.Timeout > timeout {
					timeout = src.Timeout
				}
			}
			fctx, fcancel := context.WithTimeout(ctx, timeout)
			defer fcancel()
			return bd.Fetch(fctx, rc, pending)
		})
		if bErr != nil {
			return nil, bErr
		}
		return out, nil
	})

	latency := time.Since(start)

	if err != nil {
		LogSourceFetch("batch:"+batchName, latency, false, err)
		// Determine criticality: batch fails the page only if any pending key
		// is registered as Critical.
		anyCritical := false
		for _, k := range pending {
			if src, ok := h.reg[k]; ok && src.Critical {
				anyCritical = true
				break
			}
		}
		if anyCritical {
			return values, nil, fmt.Errorf("critical batch %s: %w", batchName, err)
		}
		return values, pending, nil
	}

	out, ok := raw.(map[string]any)
	if !ok {
		LogSourceFetch("batch:"+batchName, latency, false, fmt.Errorf("batch %s: bad return type", batchName))
		return values, pending, nil
	}

	// Cache and merge per-key results.
	missing := make([]string, 0)
	for _, k := range pending {
		v, ok := out[k]
		if !ok || v == nil {
			missing = append(missing, k)
			continue
		}
		values[k] = v

		userScoped := false
		ttl := 30 * time.Second
		if src, srcOk := h.reg[k]; srcOk {
			userScoped = src.UserScoped
			if src.TTL > 0 {
				ttl = src.TTL
			}
		}
		suffix := h.suffixFor(rc, userScoped)
		cacheKey := fmt.Sprintf("hydra:v%s:%s:%s", h.configVersion, k, suffix)
		h.cacheSet(ctx, cacheKey, v, ttl)
	}

	LogSourceFetch("batch:"+batchName, latency, false, nil)
	return values, missing, nil
}

// suffixFor returns the per-source cache-key suffix: user-scoped sources
// partition by user_id; global sources partition by lat/lon zone (≈1km grid).
func (h *Hydrator) suffixFor(rc RequestContext, userScoped bool) string {
	if userScoped {
		if rc.UserID == "" {
			return "guest"
		}
		return rc.UserID
	}
	return roundZone(rc.Lat, rc.Lon)
}

// cacheGet reads + JSON-decodes a single hydra cache entry. Treats any error
// (including key-miss) as a miss and never propagates. A real Redis failure
// (not redis.Nil) is logged at warn level so operators can see when the L1 is
// degraded; the request still proceeds via the underlying source fetch.
func (h *Hydrator) cacheGet(ctx context.Context, key string) (any, bool) {
	if h.rdb == nil {
		return nil, false
	}
	v, err := h.rdb.Get(ctx, key).Bytes()
	if err != nil {
		if database.IsRedisDown(err) {
			log.Warn().Err(err).Str("key", key).Msg("hydra cache GET failed; falling through to source")
		}
		return nil, false
	}
	var out any
	if err := json.Unmarshal(v, &out); err != nil {
		return nil, false
	}
	return out, true
}

// cacheSet writes a JSON-encoded value with TTL. Errors are swallowed (best
// effort) — a write failure should never fail the request.
func (h *Hydrator) cacheSet(ctx context.Context, key string, value any, ttl time.Duration) {
	if h.rdb == nil || ttl <= 0 {
		return
	}
	b, err := json.Marshal(value)
	if err != nil {
		return
	}
	_ = h.rdb.Set(ctx, key, b, ttl).Err()
}

// roundZone collapses a (lat, lon) into a stable bucket label rounded to two
// decimal places (~1km on either axis). Used to share global-source caches
// across nearby callers.
func roundZone(lat, lon float64) string {
	return fmt.Sprintf("zone-%.2f-%.2f", lat, lon)
}

// dedupeStrings returns a stable-order copy of in with duplicates removed.
func dedupeStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}
