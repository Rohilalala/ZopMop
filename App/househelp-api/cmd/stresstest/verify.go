// stresstest/verify — post-run integrity checker. Reads counts and
// invariants out of PG + Redis, compares them to what the seed planted plus
// what the k6 run is expected to have produced, and emits a JSON report on
// stdout. Non-zero exit when any check fails so CI can gate on the report.
//
//go:build stress_verify
// +build stress_verify

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const (
	stressNamePrefix          = "stress_"
	stressCustomerPhonePrefix = "+91997"
	stressHelperPhonePrefix   = "+91887"
	geoKey                    = "helpers:locations"
	helperActiveKeyFn         = "helper:active:%s"
)

// Check is one row in the JSON report.
type Check struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Got     any    `json:"got"`
	Want    any    `json:"want,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

type Report struct {
	StartedAt time.Time `json:"started_at"`
	Checks    []Check   `json:"checks"`
	Summary   struct {
		Total  int `json:"total"`
		Passed int `json:"passed"`
		Failed int `json:"failed"`
	} `json:"summary"`
}

func main() {
	var expectedCustomers, expectedHelpers int
	var minBookings int
	var output string
	flag.IntVar(&expectedCustomers, "expected-customers", 1000, "expected number of stress_ customers")
	flag.IntVar(&expectedHelpers, "expected-helpers", 100, "expected number of stress_ helpers")
	flag.IntVar(&minBookings, "min-bookings", 1, "fail if fewer than this many stress bookings exist")
	flag.StringVar(&output, "out", "", "optional path to write the JSON report to (also printed to stdout)")
	flag.Parse()

	dbURL := mustEnv("DATABASE_URL")
	redisURL := mustEnv("REDIS_URL")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool := mustPool(ctx, dbURL)
	defer pool.Close()
	rdb := mustRedis(ctx, redisURL)
	defer rdb.Close()

	r := Report{StartedAt: time.Now()}

	// 1. Customer count.
	custCount := scanInt(ctx, pool,
		`SELECT count(*) FROM users WHERE name LIKE $1 AND role = 'customer'`,
		stressNamePrefix+"%")
	r.add(Check{
		Name: "customer_count",
		OK:   custCount == expectedCustomers,
		Got:  custCount, Want: expectedCustomers,
	})

	// 2. Helper user-row count.
	helpUserCount := scanInt(ctx, pool,
		`SELECT count(*) FROM users WHERE name LIKE $1 AND role = 'pro'`,
		stressNamePrefix+"%")
	r.add(Check{
		Name: "helper_user_count",
		OK:   helpUserCount == expectedHelpers,
		Got:  helpUserCount, Want: expectedHelpers,
	})

	// 3. Helpers row count + approval / availability invariants.
	helpRowCount := scanInt(ctx, pool, `
		SELECT count(*) FROM helpers h
		JOIN users u ON u.id = h.id
		WHERE u.name LIKE $1`,
		stressNamePrefix+"%")
	r.add(Check{
		Name: "helper_row_count",
		OK:   helpRowCount == expectedHelpers,
		Got:  helpRowCount, Want: expectedHelpers,
	})

	helpApproved := scanInt(ctx, pool, `
		SELECT count(*) FROM helpers h
		JOIN users u ON u.id = h.id
		WHERE u.name LIKE $1 AND h.approval_status = 'approved' AND h.is_available = true`,
		stressNamePrefix+"%")
	r.add(Check{
		Name: "helpers_approved_and_available",
		OK:   helpApproved == helpRowCount,
		Got:  helpApproved, Want: helpRowCount,
		Detail: "every seeded helper must be approved + is_available=true so the matching engine considers them",
	})

	// 4. Phone-prefix sanity — guard against a prior seeder colliding into
	// the stress_ namespace.
	custPrefixed := scanInt(ctx, pool,
		`SELECT count(*) FROM users WHERE name LIKE $1 AND role = 'customer' AND phone LIKE $2`,
		stressNamePrefix+"%", stressCustomerPhonePrefix+"%")
	r.add(Check{
		Name: "customer_phone_prefix_match",
		OK:   custPrefixed == custCount,
		Got:  custPrefixed, Want: custCount,
	})
	helpPrefixed := scanInt(ctx, pool,
		`SELECT count(*) FROM users WHERE name LIKE $1 AND role = 'pro' AND phone LIKE $2`,
		stressNamePrefix+"%", stressHelperPhonePrefix+"%")
	r.add(Check{
		Name: "helper_phone_prefix_match",
		OK:   helpPrefixed == helpUserCount,
		Got:  helpPrefixed, Want: helpUserCount,
	})

	// 5. Redis GEO membership — every helper must be in helpers:locations
	// with a paired helper:active:<id> marker.
	helperIDs := scanIDs(ctx, pool, `
		SELECT u.id::text FROM users u
		JOIN helpers h ON h.id = u.id
		WHERE u.name LIKE $1`, stressNamePrefix+"%")
	missingGeo, missingActive := 0, 0
	for _, id := range helperIDs {
		positions, err := rdb.GeoPos(ctx, geoKey, id).Result()
		if err != nil || len(positions) == 0 || positions[0] == nil {
			missingGeo++
			continue
		}
		exists, err := rdb.Exists(ctx, fmt.Sprintf(helperActiveKeyFn, id)).Result()
		if err != nil || exists == 0 {
			missingActive++
		}
	}
	r.add(Check{
		Name: "helpers_in_redis_geo",
		OK:   missingGeo == 0,
		Got:  len(helperIDs) - missingGeo, Want: len(helperIDs),
		Detail: fmt.Sprintf("missing GEO entries: %d", missingGeo),
	})
	// helper:active markers can legitimately expire (5 min TTL). Treat as a
	// soft check — only fail when *every* marker is missing.
	r.add(Check{
		Name: "helper_active_markers",
		OK:   len(helperIDs) == 0 || missingActive < len(helperIDs),
		Got:  len(helperIDs) - missingActive, Want: len(helperIDs),
		Detail: "soft check — markers TTL out after 5 min; fails only if every marker is gone",
	})

	// 6. Bookings created during the run, indexed via the stress_ namespace.
	bookings := scanInt(ctx, pool, `
		SELECT count(*) FROM bookings b
		WHERE b.customer_id IN (SELECT id FROM users WHERE name LIKE $1)`,
		stressNamePrefix+"%")
	r.add(Check{
		Name: "stress_bookings_count",
		OK:   bookings >= minBookings,
		Got:  bookings, Want: fmt.Sprintf(">=%d", minBookings),
	})

	// 7. Status distribution — every booking row must carry one of the legal
	// statuses (the CHECK constraint enforces this; we still surface it in
	// the report for visibility).
	type statusCount struct {
		Status string `json:"status"`
		N      int    `json:"n"`
	}
	rows, err := pool.Query(ctx, `
		SELECT status, count(*) FROM bookings
		WHERE customer_id IN (SELECT id FROM users WHERE name LIKE $1)
		GROUP BY status ORDER BY status`, stressNamePrefix+"%")
	dist := []statusCount{}
	if err == nil {
		for rows.Next() {
			var sc statusCount
			if err := rows.Scan(&sc.Status, &sc.N); err == nil {
				dist = append(dist, sc)
			}
		}
		rows.Close()
	}
	r.add(Check{
		Name: "booking_status_distribution",
		OK:   true,
		Got:  dist,
		Detail: "informational — review for unexpected concentration in 'pending' or 'cancelled'",
	})

	// 8. Orphan helper IDs — bookings whose helper_id no longer exists in
	// users (the seed deletes itself before re-seeding; if k6 raced with
	// cleanup we'd see orphans here).
	orphans := scanInt(ctx, pool, `
		SELECT count(*) FROM bookings b
		WHERE b.helper_id IS NOT NULL
		  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = b.helper_id)
		  AND b.customer_id IN (SELECT id FROM users WHERE name LIKE $1)`,
		stressNamePrefix+"%")
	r.add(Check{
		Name: "no_orphan_helper_refs",
		OK:   orphans == 0,
		Got:  orphans, Want: 0,
	})

	// 9. Duplicate-bookings invariant — the dedup trigger should have
	// rejected within-hour duplicates, so for any (customer, category) pair
	// we should see at most one non-cancelled row in the last hour.
	dupes := scanInt(ctx, pool, `
		SELECT count(*) FROM (
			SELECT customer_id, service_category_id, count(*) c
			FROM bookings
			WHERE status <> 'cancelled'
			  AND created_at >= now() - interval '1 hour'
			  AND customer_id IN (SELECT id FROM users WHERE name LIKE $1)
			GROUP BY customer_id, service_category_id
			HAVING count(*) > 1
		) x`, stressNamePrefix+"%")
	r.add(Check{
		Name: "no_within_hour_duplicate_bookings",
		OK:   dupes == 0,
		Got:  dupes, Want: 0,
		Detail: "guards against the trigger fn_bookings_reject_dup_within_hour silently failing under load",
	})

	// 10. Helper-side invariant — accepted/in-progress bookings must have a
	// helper_id assigned.
	missingHelper := scanInt(ctx, pool, `
		SELECT count(*) FROM bookings
		WHERE status IN ('accepted','in_progress','completed')
		  AND helper_id IS NULL
		  AND customer_id IN (SELECT id FROM users WHERE name LIKE $1)`,
		stressNamePrefix+"%")
	r.add(Check{
		Name: "post_pending_bookings_have_helper",
		OK:   missingHelper == 0,
		Got:  missingHelper, Want: 0,
	})

	r.Summary.Total = len(r.Checks)
	for _, c := range r.Checks {
		if c.OK {
			r.Summary.Passed++
		} else {
			r.Summary.Failed++
		}
	}

	buf, _ := json.MarshalIndent(r, "", "  ")
	fmt.Println(string(buf))
	if output != "" {
		if err := os.WriteFile(output, buf, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "stresstest/verify: write report: %v\n", err)
		}
	}
	if r.Summary.Failed > 0 {
		os.Exit(1)
	}
}

func (r *Report) add(c Check) { r.Checks = append(r.Checks, c) }

func scanInt(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) int {
	var n int
	if err := pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/verify: %s: %v\n", short(q), err)
		return -1
	}
	return n
}

func scanIDs(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) []string {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/verify: %s: %v\n", short(q), err)
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
		fmt.Fprintf(os.Stderr, "stresstest/verify: missing env %s\n", k)
		os.Exit(2)
	}
	return v
}

func mustPool(ctx context.Context, dbURL string) *pgxpool.Pool {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/verify: parse db url: %v\n", err)
		os.Exit(1)
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/verify: connect db: %v\n", err)
		os.Exit(1)
	}
	return pool
}

func mustRedis(ctx context.Context, redisURL string) *redis.Client {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/verify: parse redis url: %v\n", err)
		os.Exit(1)
	}
	c := redis.NewClient(opt)
	if err := c.Ping(ctx).Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stresstest/verify: ping redis: %v\n", err)
		os.Exit(1)
	}
	return c
}
