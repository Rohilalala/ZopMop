// stresstest/seed — bulk-loads a stress-test population straight into PG +
// Redis, mints HS256 JWTs against $JWT_SECRET, and writes CSVs the k6 script
// reads. Distinct phone range from cmd/loadseed (+91997 customers, +91887
// helpers) and a "stress_" name prefix so cleanup.go can reverse the seed
// without touching real or loadseed data.
//
//go:build stress_seed
// +build stress_seed

package main

import (
	"context"
	"encoding/csv"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const (
	stressCustomers = 1000
	stressHelpers   = 100

	// Distinct from cmd/loadseed (+91999 / +91888) so the two seeders do not
	// fight over phone uniqueness and cleanup can target each cleanly.
	stressCustomerPhonePrefix = "+91997"
	stressHelperPhonePrefix   = "+91887"
	stressNamePrefix          = "stress_"

	// Geo anchor — Connaught Place, NCR. Tight jitter (~1km radius) keeps
	// every helper inside the matching engine's walking-ETA guard
	// (acceptMaxWalkingMinutes = 25) so accepts don't fail with ErrTooFarAway.
	anchorLat = 28.6139
	anchorLng = 77.2090
	jitter    = 0.01

	geoKey            = "helpers:locations"
	helperActiveKeyFn = "helper:active:%s"
	helperActiveTTL   = 5 * time.Minute

	defaultJWTKID    = "active"
	defaultJWTHours  = 24
	defaultCustomers = "loadtest/stress_customers.csv"
	defaultHelpers   = "loadtest/stress_helpers.csv"
)

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintf(os.Stderr, "stresstest/seed: missing env %s\n", k)
		os.Exit(2)
	}
	return v
}

func mintJWT(secret, kid, userID, role string, ttl time.Duration) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"user_id":      userID,
		"role":         role,
		"is_suspended": false,
		"iss":          "househelp-api",
		"iat":          now.Unix(),
		"exp":          now.Add(ttl).Unix(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	if kid != "" {
		tok.Header["kid"] = kid
	}
	return tok.SignedString([]byte(secret))
}

type seedFlags struct {
	customers     int
	helpers       int
	jwtHours      int
	customersOut  string
	helpersOut    string
	skipWipe      bool
}

func parseFlags() seedFlags {
	f := seedFlags{}
	flag.IntVar(&f.customers, "customers", stressCustomers, "number of stress-test customers to seed")
	flag.IntVar(&f.helpers, "helpers", stressHelpers, "number of stress-test helpers to seed")
	flag.IntVar(&f.jwtHours, "jwt-hours", defaultJWTHours, "JWT expiry, in hours")
	flag.StringVar(&f.customersOut, "customers-csv", defaultCustomers, "where to write the customer CSV")
	flag.StringVar(&f.helpersOut, "helpers-csv", defaultHelpers, "where to write the helper CSV")
	flag.BoolVar(&f.skipWipe, "skip-wipe", false, "do not wipe existing stress-test rows before seeding")
	flag.Parse()
	return f
}

func main() {
	f := parseFlags()
	dbURL := mustEnv("DATABASE_URL")
	jwtSecret := mustEnv("JWT_SECRET")
	redisURL := mustEnv("REDIS_URL")
	kid := os.Getenv("JWT_SECRET_ID")
	if kid == "" {
		kid = defaultJWTKID
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	pool := mustPool(ctx, dbURL)
	defer pool.Close()
	rdb := mustRedis(ctx, redisURL)
	defer rdb.Close()

	if !f.skipWipe {
		if err := wipeStress(ctx, pool, rdb); err != nil {
			fmt.Fprintf(os.Stderr, "stresstest/seed: wipe failed: %v\n", err)
			os.Exit(1)
		}
	}

	if err := os.MkdirAll(filepath.Dir(f.customersOut), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: mkdir customers csv: %v\n", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Dir(f.helpersOut), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: mkdir helpers csv: %v\n", err)
		os.Exit(1)
	}

	custFile, err := os.Create(f.customersOut)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: create customers csv: %v\n", err)
		os.Exit(1)
	}
	defer custFile.Close()
	custCSV := csv.NewWriter(custFile)
	_ = custCSV.Write([]string{"id", "phone", "token"})

	helpFile, err := os.Create(f.helpersOut)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: create helpers csv: %v\n", err)
		os.Exit(1)
	}
	defer helpFile.Close()
	helpCSV := csv.NewWriter(helpFile)
	_ = helpCSV.Write([]string{"id", "phone", "token", "lat", "lng"})

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	jwtTTL := time.Duration(f.jwtHours) * time.Hour

	var custOK, custFail atomic.Int64
	t0 := time.Now()
	for i := 0; i < f.customers; i++ {
		phone := fmt.Sprintf("%s%07d", stressCustomerPhonePrefix, i)
		name := fmt.Sprintf("%scust_%d", stressNamePrefix, i)
		var id string
		err := pool.QueryRow(ctx, `
			INSERT INTO users (phone, name, role)
			VALUES ($1, $2, 'customer')
			RETURNING id::text
		`, phone, name).Scan(&id)
		if err != nil {
			custFail.Add(1)
			fmt.Fprintf(os.Stderr, "stresstest/seed: customer insert %d: %v\n", i, err)
			continue
		}
		tok, err := mintJWT(jwtSecret, kid, id, "customer", jwtTTL)
		if err != nil {
			custFail.Add(1)
			continue
		}
		_ = custCSV.Write([]string{id, phone, tok})
		custOK.Add(1)
	}
	custCSV.Flush()
	if err := custCSV.Error(); err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: customers csv flush: %v\n", err)
	}
	fmt.Printf("stresstest/seed: customers ok=%d fail=%d in %s → %s\n",
		custOK.Load(), custFail.Load(), time.Since(t0).Round(time.Millisecond), f.customersOut)

	var helpOK, helpFail atomic.Int64
	t1 := time.Now()
	pipe := rdb.Pipeline()
	for i := 0; i < f.helpers; i++ {
		phone := fmt.Sprintf("%s%07d", stressHelperPhonePrefix, i)
		name := fmt.Sprintf("%spro_%d", stressNamePrefix, i)
		lat := anchorLat + (rng.Float64()-0.5)*jitter
		lng := anchorLng + (rng.Float64()-0.5)*jitter

		var id string
		err := pool.QueryRow(ctx, `
			INSERT INTO users (phone, name, role)
			VALUES ($1, $2, 'pro')
			RETURNING id::text
		`, phone, name).Scan(&id)
		if err != nil {
			helpFail.Add(1)
			fmt.Fprintf(os.Stderr, "stresstest/seed: helper user insert %d: %v\n", i, err)
			continue
		}

		_, err = pool.Exec(ctx, `
			INSERT INTO helpers (
				id, is_available, current_lat, current_lng, location,
				rating, total_jobs, approval_status, services, availability, address
			)
			VALUES (
				$1::uuid, true, $2::float8, $3::float8,
				ST_SetSRID(ST_MakePoint($3::float8, $2::float8), 4326)::geography,
				4.7, 25,
				'approved', ARRAY['cleaning']::text[], ARRAY['morning','afternoon']::text[],
				'Stress test address'
			)
		`, id, lat, lng)
		if err != nil {
			helpFail.Add(1)
			fmt.Fprintf(os.Stderr, "stresstest/seed: helpers row insert %d: %v\n", i, err)
			continue
		}

		tok, err := mintJWT(jwtSecret, kid, id, "pro", jwtTTL)
		if err != nil {
			helpFail.Add(1)
			continue
		}

		// Mirror what location.Service.UpdateHelperLocation does so the matching
		// engine sees these helpers as live the moment seeding finishes.
		pipe.GeoAdd(ctx, geoKey, &redis.GeoLocation{
			Name:      id,
			Longitude: lng,
			Latitude:  lat,
		})
		pipe.Set(ctx, fmt.Sprintf(helperActiveKeyFn, id), "1", helperActiveTTL)

		_ = helpCSV.Write([]string{id, phone, tok,
			fmt.Sprintf("%.6f", lat), fmt.Sprintf("%.6f", lng)})
		helpOK.Add(1)
	}
	helpCSV.Flush()
	if err := helpCSV.Error(); err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: helpers csv flush: %v\n", err)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: redis pipeline exec: %v\n", err)
	}
	fmt.Printf("stresstest/seed: helpers ok=%d fail=%d in %s → %s\n",
		helpOK.Load(), helpFail.Load(), time.Since(t1).Round(time.Millisecond), f.helpersOut)

	fmt.Println("stresstest/seed: done.")
}

// wipeStress deletes the prior stress run's rows + Redis state. Idempotent —
// safe to call when nothing has been seeded yet. Customer / helper rows are
// matched by the stress_ name prefix to avoid collateral damage if the phone
// ranges ever overlap with another seeder.
func wipeStress(ctx context.Context, pool *pgxpool.Pool, rdb *redis.Client) error {
	// Snapshot helper IDs first so we can pull them out of Redis before the
	// users delete cascades through helpers.
	rows, err := pool.Query(ctx, `
		SELECT id::text FROM users
		WHERE name LIKE $1 AND role = 'pro'
	`, stressNamePrefix+"%")
	if err != nil {
		return fmt.Errorf("snapshot helper ids: %w", err)
	}
	var helperIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			helperIDs = append(helperIDs, id)
		}
	}
	rows.Close()

	stmts := []string{
		// Cancel FK escapes from app_config audit trail.
		`UPDATE app_config SET updated_by = NULL
		   WHERE updated_by IN (SELECT id FROM users WHERE name LIKE '` + stressNamePrefix + `%')`,
		// Bookings + payments first — they reference users on both sides.
		`DELETE FROM payments WHERE booking_id IN (
			SELECT id FROM bookings WHERE customer_id IN (SELECT id FROM users WHERE name LIKE '` + stressNamePrefix + `%')
			   OR helper_id IN (SELECT id FROM users WHERE name LIKE '` + stressNamePrefix + `%')
		)`,
		`DELETE FROM bookings
		   WHERE customer_id IN (SELECT id FROM users WHERE name LIKE '` + stressNamePrefix + `%')
		      OR helper_id  IN (SELECT id FROM users WHERE name LIKE '` + stressNamePrefix + `%')`,
		`DELETE FROM helpers
		   WHERE id IN (SELECT id FROM users WHERE name LIKE '` + stressNamePrefix + `%')`,
		`DELETE FROM users WHERE name LIKE '` + stressNamePrefix + `%'`,
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			return fmt.Errorf("wipe stmt %q: %w", short(s), err)
		}
	}

	if len(helperIDs) > 0 {
		pipe := rdb.Pipeline()
		// ZREM helpers from the geo set.
		args := make([]any, 0, len(helperIDs))
		for _, id := range helperIDs {
			args = append(args, id)
		}
		pipe.ZRem(ctx, geoKey, args...)
		for _, id := range helperIDs {
			pipe.Del(ctx, fmt.Sprintf(helperActiveKeyFn, id))
		}
		if _, err := pipe.Exec(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "stresstest/seed: wipe redis: %v\n", err)
		}
	}
	return nil
}

func short(s string) string {
	if len(s) > 60 {
		return s[:60] + "…"
	}
	return s
}

func mustPool(ctx context.Context, dbURL string) *pgxpool.Pool {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: parse db url: %v\n", err)
		os.Exit(1)
	}
	cfg.MaxConns = 16
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: connect db: %v\n", err)
		os.Exit(1)
	}
	return pool
}

func mustRedis(ctx context.Context, redisURL string) *redis.Client {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: parse redis url: %v\n", err)
		os.Exit(1)
	}
	c := redis.NewClient(opt)
	if err := c.Ping(ctx).Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/seed: ping redis: %v\n", err)
		os.Exit(1)
	}
	return c
}
