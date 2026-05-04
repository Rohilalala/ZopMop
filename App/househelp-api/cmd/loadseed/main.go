// Loadtest seeder — inserts N customers + M helpers, mints HS256 JWTs against
// JWT_SECRET, and writes CSVs for k6 (id,phone,token).
package main

import (
	"context"
	"encoding/csv"
	"fmt"
	"math/rand"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	numCustomers = 1000
	numHelpers   = 100
	delhiLat     = 28.6139
	delhiLng     = 77.2090
	jitter       = 0.15
)

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		fmt.Fprintf(os.Stderr, "missing env %s\n", k)
		os.Exit(2)
	}
	return v
}

func mintJWT(secret, userID, role string, expiry time.Duration) (string, error) {
	now := time.Now()
	claims := jwt.MapClaims{
		"user_id":      userID,
		"role":         role,
		"is_suspended": false,
		"iss":          "househelp-api",
		"iat":          now.Unix(),
		"exp":          now.Add(expiry).Unix(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString([]byte(secret))
}

func main() {
	dbURL := mustEnv("DATABASE_URL")
	jwtSecret := mustEnv("JWT_SECRET")

	expiryArg := os.Getenv("LOADTEST_JWT_HOURS")
	expHours := 24
	if expiryArg != "" {
		fmt.Sscanf(expiryArg, "%d", &expHours)
	}
	expiry := time.Duration(expHours) * time.Hour

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		panic(err)
	}
	cfg.MaxConns = 10
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	// Wipe prior loadtest rows. Null out FK refs from app_config first so the
	// users delete doesn't trip foreign-key constraints.
	wipeStmts := []string{
		`UPDATE app_config SET updated_by = NULL WHERE updated_by IN (SELECT id FROM users WHERE phone LIKE '+91999%' OR phone LIKE '+91888%')`,
		`DELETE FROM bookings WHERE customer_id IN (SELECT id FROM users WHERE phone LIKE '+91999%' OR phone LIKE '+91888%') OR helper_id IN (SELECT id FROM users WHERE phone LIKE '+91999%' OR phone LIKE '+91888%')`,
		`DELETE FROM helpers WHERE id IN (SELECT id FROM users WHERE phone LIKE '+91888%')`,
		`DELETE FROM users WHERE phone LIKE '+91999%' OR phone LIKE '+91888%'`,
	}
	for _, s := range wipeStmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			panic(fmt.Errorf("wipe step %q: %w", s[:60], err))
		}
	}

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))

	custFile, _ := os.Create("loadtest/customers.csv")
	defer custFile.Close()
	custCSV := csv.NewWriter(custFile)
	custCSV.Write([]string{"id", "phone", "token"})

	helpFile, _ := os.Create("loadtest/helpers.csv")
	defer helpFile.Close()
	helpCSV := csv.NewWriter(helpFile)
	helpCSV.Write([]string{"id", "phone", "token", "lat", "lng"})

	// Customers.
	for i := 0; i < numCustomers; i++ {
		phone := fmt.Sprintf("+91999%07d", i)
		var id string
		err := pool.QueryRow(ctx,
			`INSERT INTO users (phone, name, role) VALUES ($1, $2, 'customer') RETURNING id`,
			phone, fmt.Sprintf("LoadCust%d", i),
		).Scan(&id)
		if err != nil {
			panic(fmt.Errorf("insert customer %d: %w", i, err))
		}
		tok, err := mintJWT(jwtSecret, id, "customer", expiry)
		if err != nil {
			panic(err)
		}
		custCSV.Write([]string{id, phone, tok})
	}
	custCSV.Flush()
	fmt.Printf("seeded %d customers\n", numCustomers)

	// Helpers (users row + helpers row, with PostGIS geography).
	for i := 0; i < numHelpers; i++ {
		phone := fmt.Sprintf("+91888%07d", i)
		lat := delhiLat + (rng.Float64()-0.5)*jitter
		lng := delhiLng + (rng.Float64()-0.5)*jitter
		var id string
		err := pool.QueryRow(ctx,
			`INSERT INTO users (phone, name, role) VALUES ($1, $2, 'pro') RETURNING id`,
			phone, fmt.Sprintf("LoadPro%d", i),
		).Scan(&id)
		if err != nil {
			panic(fmt.Errorf("insert helper user %d: %w", i, err))
		}
		_, err = pool.Exec(ctx,
			`INSERT INTO helpers (id, is_available, current_lat, current_lng, location, rating, total_jobs)
			 VALUES ($1, true, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, 4.7, 10)`,
			id, lat, lng, lng, lat,
		)
		if err != nil {
			panic(fmt.Errorf("insert helpers row %d: %w", i, err))
		}
		tok, err := mintJWT(jwtSecret, id, "pro", expiry)
		if err != nil {
			panic(err)
		}
		helpCSV.Write([]string{id, phone, tok, fmt.Sprintf("%.6f", lat), fmt.Sprintf("%.6f", lng)})
	}
	helpCSV.Flush()
	fmt.Printf("seeded %d helpers\n", numHelpers)

	fmt.Println("done. CSVs in loadtest/")
}
