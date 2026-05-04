package database

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// IsCacheMiss reports whether err is a benign Redis key-miss (redis.Nil).
// Callers should silently treat this as "not cached" and fall through to source.
func IsCacheMiss(err error) bool {
	return errors.Is(err, redis.Nil)
}

// IsRedisDown reports whether err represents a real Redis failure
// (connection refused, timeout, broken pipe, etc.) rather than a benign miss.
// Callers should log this at warn level and fall through to a degraded path
// rather than aborting the request.
func IsRedisDown(err error) bool {
	return err != nil && !errors.Is(err, redis.Nil)
}

// NewRedisClient creates and validates a Redis client connection.
// PoolSize 10, ping with 5s timeout.
func NewRedisClient(ctx context.Context, redisURL string) (*redis.Client, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse Redis URL: %w", err)
	}

	opt.PoolSize = 10
	opt.MinIdleConns = 3
	opt.ReadTimeout = 3 * time.Second
	opt.WriteTimeout = 3 * time.Second
	opt.DialTimeout = 5 * time.Second

	client := redis.NewClient(opt)

	// Ping with 5s timeout.
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := client.Ping(pingCtx).Err(); err != nil {
		if closeErr := client.Close(); closeErr != nil {
			log.Error().Err(closeErr).Msg("failed to close Redis client after ping failure")
		}
		return nil, fmt.Errorf("failed to ping Redis: %w", err)
	}

	log.Info().
		Int("pool_size", opt.PoolSize).
		Msg("Redis connection established")

	return client, nil
}
