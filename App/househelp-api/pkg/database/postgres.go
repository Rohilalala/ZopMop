package database

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// PostgresPoolConfig controls pgx connection pool behavior.
type PostgresPoolConfig struct {
	MinConns          int32
	MaxConns          int32
	MaxConnLifetime   time.Duration
	MaxConnIdleTime   time.Duration
	HealthCheckPeriod time.Duration
}

// NewPostgresPool creates and validates a PostgreSQL connection pool.
func NewPostgresPool(ctx context.Context, databaseURL string, poolCfg PostgresPoolConfig) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse database URL: %w", err)
	}

	if poolCfg.MaxConns <= 0 {
		poolCfg.MaxConns = 80
	}
	if poolCfg.MinConns < 0 {
		poolCfg.MinConns = 20
	}
	if poolCfg.MinConns > poolCfg.MaxConns {
		poolCfg.MinConns = poolCfg.MaxConns
	}
	if poolCfg.MaxConnLifetime <= 0 {
		poolCfg.MaxConnLifetime = 20 * time.Minute
	}
	if poolCfg.MaxConnIdleTime <= 0 {
		poolCfg.MaxConnIdleTime = 5 * time.Minute
	}
	if poolCfg.HealthCheckPeriod <= 0 {
		poolCfg.HealthCheckPeriod = 1 * time.Minute
	}

	config.MaxConns = poolCfg.MaxConns
	config.MinConns = poolCfg.MinConns
	config.MaxConnLifetime = poolCfg.MaxConnLifetime
	config.MaxConnIdleTime = poolCfg.MaxConnIdleTime
	config.HealthCheckPeriod = poolCfg.HealthCheckPeriod
	config.ConnConfig.ConnectTimeout = 5 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("failed to create connection pool: %w", err)
	}

	// Ping with 5s timeout.
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping PostgreSQL: %w", err)
	}

	// Best-effort observability extension enablement.
	// Non-fatal: managed environments may not grant extension privileges.
	obsCtx, obsCancel := context.WithTimeout(ctx, 3*time.Second)
	defer obsCancel()
	if _, err := pool.Exec(obsCtx, `CREATE EXTENSION IF NOT EXISTS pg_stat_statements`); err != nil {
		log.Warn().Err(err).Msg("could not ensure pg_stat_statements extension")
	}

	log.Info().
		Int32("max_conns", config.MaxConns).
		Int32("min_conns", config.MinConns).
		Dur("max_conn_lifetime", config.MaxConnLifetime).
		Dur("max_conn_idle_time", config.MaxConnIdleTime).
		Dur("health_check_period", config.HealthCheckPeriod).
		Msg("PostgreSQL connection pool established")

	return pool, nil
}

// PoolStats returns runtime connection pool metrics for observability.
func PoolStats(pool *pgxpool.Pool) map[string]string {
	if pool == nil {
		return map[string]string{}
	}
	stats := pool.Stat()
	return map[string]string{
		"acquired_conns":         strconv.FormatInt(int64(stats.AcquiredConns()), 10),
		"idle_conns":             strconv.FormatInt(int64(stats.IdleConns()), 10),
		"max_conns":              strconv.FormatInt(int64(stats.MaxConns()), 10),
		"total_conns":            strconv.FormatInt(int64(stats.TotalConns()), 10),
		"new_conns_count":        strconv.FormatInt(stats.NewConnsCount(), 10),
		"acquire_count":          strconv.FormatInt(stats.AcquireCount(), 10),
		"empty_acquire_count":    strconv.FormatInt(stats.EmptyAcquireCount(), 10),
		"canceled_acquire_count": strconv.FormatInt(stats.CanceledAcquireCount(), 10),
		"constructing_conns":     strconv.FormatInt(int64(stats.ConstructingConns()), 10),
	}
}
