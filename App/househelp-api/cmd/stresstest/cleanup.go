// stresstest/cleanup — destructive teardown for the stress-test seed. Deletes
// every row whose name starts with "stress_" plus the matching Redis state.
// Refuses to run without --confirm; intended to be invoked by scripts/stress.sh
// after the user explicitly approves.
//
//go:build stress_cleanup
// +build stress_cleanup

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const (
	stressNamePrefix  = "stress_"
	geoKey            = "helpers:locations"
	helperActiveKeyFn = "helper:active:%s"
)

func main() {
	var confirm bool
	var dryRun bool
	flag.BoolVar(&confirm, "confirm", false, "required — without this flag the command aborts without touching state")
	flag.BoolVar(&dryRun, "dry-run", false, "print counts that *would* be deleted, then exit (does not require --confirm)")
	flag.Parse()

	if !confirm && !dryRun {
		fmt.Fprintln(os.Stderr, "stresstest/cleanup: refusing to run without --confirm (or pass --dry-run for a preview)")
		os.Exit(2)
	}

	dbURL := mustEnv("DATABASE_URL")
	redisURL := mustEnv("REDIS_URL")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pool := mustPool(ctx, dbURL)
	defer pool.Close()
	rdb := mustRedis(ctx, redisURL)
	defer rdb.Close()

	if dryRun {
		printCounts(ctx, pool, rdb)
		fmt.Println("stresstest/cleanup: dry-run only, no rows deleted.")
		return
	}

	// Snapshot helper IDs before the SQL delete so we can clean Redis after.
	helperIDs := scanIDs(ctx, pool, `
		SELECT id::text FROM users WHERE name LIKE $1 AND role = 'pro'`,
		stressNamePrefix+"%")
	fmt.Printf("stresstest/cleanup: %d stress helpers found in PG\n", len(helperIDs))

	// Order matters — payments → bookings → helpers → users. Anything else
	// referencing users by FK should be added here as new modules ship.
	stmts := []struct {
		label string
		sql   string
	}{
		{"app_config audit FKs", `
			UPDATE app_config SET updated_by = NULL
			WHERE updated_by IN (SELECT id FROM users WHERE name LIKE $1)`},
		{"payments", `
			DELETE FROM payments WHERE booking_id IN (
				SELECT id FROM bookings WHERE customer_id IN (SELECT id FROM users WHERE name LIKE $1)
				   OR helper_id IN (SELECT id FROM users WHERE name LIKE $1)
			)`},
		{"bookings", `
			DELETE FROM bookings
			WHERE customer_id IN (SELECT id FROM users WHERE name LIKE $1)
			   OR helper_id  IN (SELECT id FROM users WHERE name LIKE $1)`},
		{"helpers", `
			DELETE FROM helpers
			WHERE id IN (SELECT id FROM users WHERE name LIKE $1)`},
		{"users", `DELETE FROM users WHERE name LIKE $1`},
	}
	for _, s := range stmts {
		tag, err := pool.Exec(ctx, s.sql, stressNamePrefix+"%")
		if err != nil {
			fmt.Fprintf(os.Stderr, "stresstest/cleanup: %s: %v\n", s.label, err)
			os.Exit(1)
		}
		fmt.Printf("stresstest/cleanup: %s — %d rows\n", s.label, tag.RowsAffected())
	}

	if len(helperIDs) > 0 {
		pipe := rdb.Pipeline()
		args := make([]any, 0, len(helperIDs))
		for _, id := range helperIDs {
			args = append(args, id)
		}
		pipe.ZRem(ctx, geoKey, args...)
		for _, id := range helperIDs {
			pipe.Del(ctx, fmt.Sprintf(helperActiveKeyFn, id))
		}
		if _, err := pipe.Exec(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "stresstest/cleanup: redis pipeline: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("stresstest/cleanup: redis — removed %d helpers from %s + %d active markers\n",
			len(helperIDs), geoKey, len(helperIDs))
	}

	fmt.Println("stresstest/cleanup: done.")
}

func printCounts(ctx context.Context, pool *pgxpool.Pool, rdb *redis.Client) {
	cust := scanInt(ctx, pool, `SELECT count(*) FROM users WHERE name LIKE $1 AND role = 'customer'`, stressNamePrefix+"%")
	pros := scanInt(ctx, pool, `SELECT count(*) FROM users WHERE name LIKE $1 AND role = 'pro'`, stressNamePrefix+"%")
	helpers := scanInt(ctx, pool, `
		SELECT count(*) FROM helpers h
		WHERE h.id IN (SELECT id FROM users WHERE name LIKE $1)`, stressNamePrefix+"%")
	bookings := scanInt(ctx, pool, `
		SELECT count(*) FROM bookings
		WHERE customer_id IN (SELECT id FROM users WHERE name LIKE $1)
		   OR helper_id  IN (SELECT id FROM users WHERE name LIKE $1)`, stressNamePrefix+"%")
	payments := scanInt(ctx, pool, `
		SELECT count(*) FROM payments
		WHERE booking_id IN (
			SELECT id FROM bookings
			WHERE customer_id IN (SELECT id FROM users WHERE name LIKE $1)
			   OR helper_id  IN (SELECT id FROM users WHERE name LIKE $1)
		)`, stressNamePrefix+"%")

	fmt.Printf("stresstest/cleanup: dry-run counts — customers=%d pros=%d helpers=%d bookings=%d payments=%d\n",
		cust, pros, helpers, bookings, payments)

	// Best-effort redis preview.
	helperIDs := scanIDs(ctx, pool, `SELECT id::text FROM users WHERE name LIKE $1 AND role = 'pro'`, stressNamePrefix+"%")
	geoCount := 0
	for _, id := range helperIDs {
		positions, err := rdb.GeoPos(ctx, geoKey, id).Result()
		if err == nil && len(positions) > 0 && positions[0] != nil {
			geoCount++
		}
	}
	fmt.Printf("stresstest/cleanup: dry-run redis — %d helpers present in %s\n", geoCount, geoKey)
}

func scanInt(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) int {
	var n int
	if err := pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/cleanup: %s: %v\n", short(q), err)
		return -1
	}
	return n
}

func scanIDs(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) []string {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/cleanup: %s: %v\n", short(q), err)
		return nil
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			out = append(out, id)
		}
	}
	return out
}

func short(s string) string {
	if len(s) > 60 {
		return s[:60] + "…"
	}
	return s
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintf(os.Stderr, "stresstest/cleanup: missing env %s\n", k)
		os.Exit(2)
	}
	return v
}

func mustPool(ctx context.Context, dbURL string) *pgxpool.Pool {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/cleanup: parse db url: %v\n", err)
		os.Exit(1)
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/cleanup: connect db: %v\n", err)
		os.Exit(1)
	}
	return pool
}

func mustRedis(ctx context.Context, redisURL string) *redis.Client {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/cleanup: parse redis url: %v\n", err)
		os.Exit(1)
	}
	c := redis.NewClient(opt)
	if err := c.Ping(ctx).Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/cleanup: ping redis: %v\n", err)
		os.Exit(1)
	}
	return c
}
