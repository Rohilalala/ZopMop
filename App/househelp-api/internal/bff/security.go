package bff

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// AllowedAction is one row from sdui_allowed_actions.
type AllowedAction struct {
	Endpoint string   `json:"endpoint"`
	Methods  []string `json:"methods"`
}

// ActionWhitelist caches the allowed-action list in Redis with a fast in-process
// fallback. The list is admin-editable; mutations call Invalidate.
type ActionWhitelist struct {
	db    *pgxpool.Pool
	rdb   *redis.Client
	key   string
	ttl   time.Duration

	mu       sync.RWMutex
	loaded   time.Time
	cached   []AllowedAction
}

const actionWhitelistRedisKey = "sdui:action_whitelist"
const actionWhitelistTTL = 5 * time.Minute

// NewActionWhitelist wires the whitelist to its DB + Redis backers.
func NewActionWhitelist(db *pgxpool.Pool, rdb *redis.Client) *ActionWhitelist {
	return &ActionWhitelist{
		db:  db,
		rdb: rdb,
		key: actionWhitelistRedisKey,
		ttl: actionWhitelistTTL,
	}
}

// All returns the full whitelist, refreshing from Redis or DB as needed.
func (w *ActionWhitelist) All(ctx context.Context) ([]AllowedAction, error) {
	w.mu.RLock()
	if time.Since(w.loaded) < w.ttl && w.cached != nil {
		out := w.cached
		w.mu.RUnlock()
		return out, nil
	}
	w.mu.RUnlock()

	if list, err := w.loadFromRedis(ctx); err == nil && list != nil {
		w.store(list)
		return list, nil
	}

	list, err := w.loadFromDB(ctx)
	if err != nil {
		return nil, err
	}
	w.saveToRedis(ctx, list)
	w.store(list)
	return list, nil
}

// Allows reports whether the given endpoint+method pair is whitelisted.
func (w *ActionWhitelist) Allows(ctx context.Context, endpoint, method string) (bool, error) {
	list, err := w.All(ctx)
	if err != nil {
		return false, err
	}
	method = strings.ToUpper(method)
	for _, a := range list {
		if a.Endpoint == endpoint {
			for _, m := range a.Methods {
				if strings.ToUpper(m) == method {
					return true, nil
				}
			}
			return false, nil
		}
	}
	return false, nil
}

// Invalidate drops the Redis + in-process cache so the next All reloads from DB.
// Call after admin mutations to sdui_allowed_actions.
func (w *ActionWhitelist) Invalidate(ctx context.Context) {
	w.mu.Lock()
	w.cached = nil
	w.loaded = time.Time{}
	w.mu.Unlock()
	if err := w.rdb.Del(ctx, w.key).Err(); err != nil {
		log.Warn().Err(err).Msg("[sdui] failed to invalidate action whitelist redis key")
	}
}

func (w *ActionWhitelist) store(list []AllowedAction) {
	w.mu.Lock()
	w.cached = list
	w.loaded = time.Now()
	w.mu.Unlock()
}

func (w *ActionWhitelist) loadFromRedis(ctx context.Context) ([]AllowedAction, error) {
	v, err := w.rdb.Get(ctx, w.key).Result()
	if err != nil {
		return nil, err
	}
	var list []AllowedAction
	if err := json.Unmarshal([]byte(v), &list); err != nil {
		return nil, err
	}
	return list, nil
}

func (w *ActionWhitelist) saveToRedis(ctx context.Context, list []AllowedAction) {
	b, err := json.Marshal(list)
	if err != nil {
		return
	}
	if err := w.rdb.Set(ctx, w.key, b, w.ttl).Err(); err != nil {
		log.Warn().Err(err).Msg("[sdui] failed to write action whitelist to redis")
	}
}

func (w *ActionWhitelist) loadFromDB(ctx context.Context) ([]AllowedAction, error) {
	queryCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	rows, err := w.db.Query(queryCtx,
		`SELECT endpoint, methods FROM sdui_allowed_actions WHERE is_active = true`,
	)
	if err != nil {
		return nil, fmt.Errorf("load action whitelist: %w", err)
	}
	defer rows.Close()

	out := make([]AllowedAction, 0, 16)
	for rows.Next() {
		var a AllowedAction
		if err := rows.Scan(&a.Endpoint, &a.Methods); err != nil {
			return nil, fmt.Errorf("scan whitelist row: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
