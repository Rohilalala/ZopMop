// Command sim drives the user-app API + database to produce realistic test
// data for CRM integrity validation. It is *not* a load tester — concurrency
// is bounded so the workload reads as plausible production traffic, not a
// stress wave.
//
// Three phases:
//   1. Sign up customers via the dev-OTP flow (POST /auth/send-otp + verify-otp).
//   2. Sign up helpers the same way and call /me/onboard-pro.
//   3. Place bookings on the first active service category for the first
//      `bookings` customers, then drive the lifecycle straight in the database
//      (matching engine bypass; the sim asserts the CRM cares about the *row*,
//      not the dispatch path).
//
// Counts are printed at the end. Errors are accumulated, not fatal, so a
// partial run still yields a usable integrity baseline.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Bengaluru anchor used for synthetic lat/lng. Helpers and bookings cluster
// around this point so the matching engine sees a usable density when the sim
// is rerun against a live API.
const anchorLat = 12.9716
const anchorLng = 77.5946

type cfg struct {
	apiURL     string
	dbURL      string
	users      int
	helpers    int
	bookings   int
	concurrency int
	seed       int64
	paceMs     int
	dbSeed     bool
}

func parseFlags() cfg {
	c := cfg{}
	flag.StringVar(&c.apiURL, "api-url", "http://localhost:8080", "user-app API base URL")
	flag.StringVar(&c.dbURL, "db-url", os.Getenv("DATABASE_URL"), "Postgres DSN (defaults to $DATABASE_URL)")
	flag.IntVar(&c.users, "users", 1000, "number of customers to sign up")
	flag.IntVar(&c.helpers, "helpers", 100, "number of helpers to onboard")
	flag.IntVar(&c.bookings, "bookings", 300, "number of bookings to place")
	flag.IntVar(&c.concurrency, "concurrency", 20, "max parallel HTTP calls per phase")
	flag.Int64Var(&c.seed, "seed", time.Now().UnixNano(), "RNG seed for phone generation")
	flag.IntVar(&c.paceMs, "pace-ms", 0, "min ms between requests per goroutine (rate-limit safety)")
	flag.BoolVar(&c.dbSeed, "db-seed", false, "skip HTTP signup; insert users/helpers/bookings directly via DB (bypasses rate limits)")
	flag.Parse()
	return c
}

// counters is the printable summary at the end of the run.
type counters struct {
	UsersCreated     atomic.Int64
	UsersFailed      atomic.Int64
	HelpersCreated   atomic.Int64
	HelpersFailed    atomic.Int64
	BookingsCreated  atomic.Int64
	BookingsFailed   atomic.Int64
	BookingsAccepted atomic.Int64
	BookingsCompleted atomic.Int64
}

type signedUpUser struct {
	Phone string
	Token string
	ID    string
}

func main() {
	c := parseFlags()
	if c.dbURL == "" {
		fmt.Fprintln(os.Stderr, "sim: DATABASE_URL not set and -db-url not provided")
		os.Exit(2)
	}

	rng := rand.New(rand.NewSource(c.seed))
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, c.dbURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sim: db connect failed: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Sanity check — sim runs against an unprotected dev API and would
	// pollute prod data if pointed at the wrong env. Refuse to run unless the
	// caller has set ALLOW_PROD_SIM=1 explicitly.
	if !canRun(c.apiURL) && os.Getenv("ALLOW_PROD_SIM") != "1" {
		fmt.Fprintf(os.Stderr, "sim: refusing to run against %s without ALLOW_PROD_SIM=1\n", c.apiURL)
		os.Exit(2)
	}

	cnt := &counters{}
	client := &http.Client{Timeout: 10 * time.Second}

	var customers []signedUpUser
	var bookingIDs []string

	if c.dbSeed {
		fmt.Printf("sim: db-seed mode — inserting %d users + %d helpers + %d bookings via DB\n", c.users, c.helpers, c.bookings)
		t0 := time.Now()
		customers = dbSeedUsers(ctx, pool, cnt, rng, c.users, false)
		dur1 := time.Since(t0)
		t1 := time.Now()
		_ = dbSeedUsers(ctx, pool, cnt, rng, c.helpers, true)
		dur2 := time.Since(t1)
		t2 := time.Now()
		bookingIDs = dbSeedBookings(ctx, pool, cnt, customers)
		dur3 := time.Since(t2)
		fmt.Printf("sim: db-seed timings — users=%s helpers=%s bookings=%s\n", dur1, dur2, dur3)
	} else {
		fmt.Printf("sim: phase 1 — signing up %d customers\n", c.users)
		customers = signUpBatch(ctx, c, client, cnt, rng, c.users, false)

		fmt.Printf("sim: phase 2 — onboarding %d helpers\n", c.helpers)
		helpers := signUpBatch(ctx, c, client, cnt, rng, c.helpers, true)
		_ = helpers // helpers exist in DB; sim picks one in phase 4 directly via DB

		fmt.Printf("sim: phase 3 — placing %d bookings\n", c.bookings)
		bookingIDs = placeBookings(ctx, c, client, pool, cnt, customers)
	}

	fmt.Printf("sim: phase 4 — driving lifecycle on %d bookings (DB-side)\n", len(bookingIDs))
	driveLifecycle(ctx, pool, cnt, bookingIDs)

	fmt.Println()
	fmt.Println("sim: ── final counts ────────────────────")
	fmt.Printf("  users    created=%d failed=%d\n", cnt.UsersCreated.Load(), cnt.UsersFailed.Load())
	fmt.Printf("  helpers  created=%d failed=%d\n", cnt.HelpersCreated.Load(), cnt.HelpersFailed.Load())
	fmt.Printf("  bookings created=%d failed=%d accepted=%d completed=%d\n",
		cnt.BookingsCreated.Load(), cnt.BookingsFailed.Load(),
		cnt.BookingsAccepted.Load(), cnt.BookingsCompleted.Load())
}

// canRun is a paranoid gate: only allow localhost / .local / .internal /
// explicit private subnets. Anything else needs the env override.
func canRun(apiURL string) bool {
	u := apiURL
	for _, ok := range []string{"localhost", "127.0.0.1", ".local", ".internal", "://10.", "://192.168.", "://172."} {
		if contains(u, ok) {
			return true
		}
	}
	return false
}

func contains(s, sub string) bool { return bytes.Contains([]byte(s), []byte(sub)) }

// signUpBatch runs send-otp + verify-otp for `n` synthetic phones in parallel.
// asHelper additionally calls /me/onboard-pro after sign-up.
func signUpBatch(ctx context.Context, c cfg, client *http.Client, cnt *counters, rng *rand.Rand, n int, asHelper bool) []signedUpUser {
	out := make([]signedUpUser, 0, n)
	var mu sync.Mutex
	sem := make(chan struct{}, c.concurrency)
	var wg sync.WaitGroup

	// Pre-generate distinct phones from the seeded RNG so re-runs with the
	// same -seed produce the same population (handy when reproducing an
	// integrity bug).
	phones := uniquePhones(rng, n, asHelper)

	for i := 0; i < n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(phone string) {
			defer wg.Done()
			defer func() { <-sem }()

			if c.paceMs > 0 {
				time.Sleep(time.Duration(c.paceMs) * time.Millisecond)
			}
			u, err := signUp(ctx, c.apiURL, client, phone)
			if err != nil {
				if asHelper {
					cnt.HelpersFailed.Add(1)
				} else {
					cnt.UsersFailed.Add(1)
				}
				return
			}
			if asHelper {
				if err := onboardPro(ctx, c.apiURL, client, u.Token); err != nil {
					cnt.HelpersFailed.Add(1)
					return
				}
				cnt.HelpersCreated.Add(1)
			} else {
				cnt.UsersCreated.Add(1)
			}
			mu.Lock()
			out = append(out, u)
			mu.Unlock()
		}(phones[i])
	}
	wg.Wait()
	return out
}

func uniquePhones(rng *rand.Rand, n int, helperBucket bool) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, n)
	prefix := "+919" // user bucket
	if helperBucket {
		prefix = "+918" // helper bucket — non-overlapping with users
	}
	for len(out) < n {
		// 9 random digits, padded.
		p := fmt.Sprintf("%s%09d", prefix, rng.Intn(1_000_000_000))
		if _, dup := seen[p]; dup {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out
}

func signUp(ctx context.Context, base string, client *http.Client, phone string) (signedUpUser, error) {
	type sendOTPResp struct {
		Message   string `json:"message"`
		IsNewUser bool   `json:"is_new_user"`
		OTP       string `json:"otp"`
	}
	type verifyOTPResp struct {
		Token string `json:"token"`
		User  struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	var sent sendOTPResp
	if err := postJSON(ctx, client, base+"/api/v1/auth/send-otp", "", map[string]any{"phone": phone}, &sent); err != nil {
		return signedUpUser{}, fmt.Errorf("send-otp: %w", err)
	}
	if sent.OTP == "" {
		return signedUpUser{}, fmt.Errorf("server did not return dev OTP — is APP_ENV=development?")
	}
	var v verifyOTPResp
	if err := postJSON(ctx, client, base+"/api/v1/auth/verify-otp", "", map[string]any{
		"phone":                       phone,
		"code":                        sent.OTP,
		"has_accepted_privacy_policy": true,
	}, &v); err != nil {
		return signedUpUser{}, fmt.Errorf("verify-otp: %w", err)
	}
	return signedUpUser{Phone: phone, Token: v.Token, ID: v.User.ID}, nil
}

func onboardPro(ctx context.Context, base string, client *http.Client, token string) error {
	body := map[string]any{
		"lat":          anchorLat + (randJitter() * 0.05),
		"lng":          anchorLng + (randJitter() * 0.05),
		"services":     []string{"cleaning"},
		"availability": []string{"morning", "afternoon"},
		"address":      "Sim address, Bengaluru",
	}
	return postJSON(ctx, client, base+"/api/v1/me/onboard-pro", token, body, nil)
}

// placeBookings places one booking per customer up to len(customers). Each
// booking uses a random lat/lng around the Bengaluru anchor and the first
// active service_category found in the DB.
func placeBookings(ctx context.Context, c cfg, client *http.Client, pool *pgxpool.Pool, cnt *counters, customers []signedUpUser) []string {
	var categoryID string
	if err := pool.QueryRow(ctx,
		`SELECT id::text FROM service_categories WHERE is_active = TRUE ORDER BY created_at LIMIT 1`,
	).Scan(&categoryID); err != nil {
		fmt.Fprintf(os.Stderr, "sim: no active service_category found: %v\n", err)
		return nil
	}

	target := c.bookings
	if target > len(customers) {
		target = len(customers)
	}

	ids := make([]string, 0, target)
	var mu sync.Mutex
	sem := make(chan struct{}, c.concurrency)
	var wg sync.WaitGroup

	for i := 0; i < target; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(u signedUpUser) {
			defer wg.Done()
			defer func() { <-sem }()
			id, err := placeOneBooking(ctx, c.apiURL, client, u.Token, categoryID)
			if err != nil {
				cnt.BookingsFailed.Add(1)
				return
			}
			cnt.BookingsCreated.Add(1)
			mu.Lock()
			ids = append(ids, id)
			mu.Unlock()
		}(customers[i])
	}
	wg.Wait()
	return ids
}

func placeOneBooking(ctx context.Context, base string, client *http.Client, token, categoryID string) (string, error) {
	type resp struct {
		ID string `json:"id"`
	}
	body := map[string]any{
		"service_category_id": categoryID,
		"address":             "Sim address, Bengaluru",
		"lat":                 anchorLat + (randJitter() * 0.05),
		"lng":                 anchorLng + (randJitter() * 0.05),
	}
	var r resp
	if err := postJSON(ctx, client, base+"/api/v1/bookings/", token, body, &r); err != nil {
		return "", err
	}
	return r.ID, nil
}

// driveLifecycle promotes pending bookings through accepted → completed by
// writing directly to the DB. The matching engine and helper-side acceptance
// flow are bypassed because reproducing them in-sim would require Redis state
// + JWT-as-helper + invite acceptance, which is out of scope here.
//
// Picks a random approved helper for each booking. If no approved helpers
// exist (sim was run with -helpers=0), falls back to leaving them pending.
func driveLifecycle(ctx context.Context, pool *pgxpool.Pool, cnt *counters, bookingIDs []string) {
	helperIDs := []string{}
	rows, err := pool.Query(ctx,
		`SELECT id::text FROM helpers WHERE approval_status IN ('pending','approved')`,
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sim: load helpers failed: %v\n", err)
		return
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			helperIDs = append(helperIDs, id)
		}
	}
	rows.Close()
	if len(helperIDs) == 0 {
		fmt.Fprintln(os.Stderr, "sim: no helpers in DB — skipping lifecycle drive")
		return
	}

	for _, bid := range bookingIDs {
		hid := helperIDs[rand.Intn(len(helperIDs))]
		// accepted
		if _, err := pool.Exec(ctx, `
			UPDATE bookings
			SET status = 'accepted', helper_id = $2::uuid, accepted_at = now()
			WHERE id = $1::uuid AND status = 'pending'
		`, bid, hid); err == nil {
			cnt.BookingsAccepted.Add(1)
		}
		// completed (60% of the wave; the rest stay accepted to give the
		// integrity check non-trivial status diversity).
		if rand.Intn(100) < 60 {
			if _, err := pool.Exec(ctx, `
				UPDATE bookings
				SET status = 'completed', started_at = now() - interval '30 min', completed_at = now()
				WHERE id = $1::uuid AND status = 'accepted'
			`, bid); err == nil {
				cnt.BookingsCompleted.Add(1)
			}
		}
	}
}

// ── HTTP plumbing ────────────────────────────────────────────────────────

func postJSON(ctx context.Context, client *http.Client, url, bearer string, body any, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("http %d: %s", resp.StatusCode, string(respBody))
	}
	if out != nil {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("decode response: %w (body=%s)", err, string(respBody))
		}
	}
	return nil
}

func randJitter() float64 { return rand.Float64()*2 - 1 }

// ── DB-side seeding (rate-limit bypass) ─────────────────────────────────────

// dbSeedUsers inserts users + (optionally) helpers rows directly via SQL.
// Used to populate realistic CRM-test data without OTP rate-limit friction.
func dbSeedUsers(ctx context.Context, pool *pgxpool.Pool, cnt *counters, rng *rand.Rand, n int, asHelper bool) []signedUpUser {
	out := make([]signedUpUser, 0, n)
	phones := uniquePhones(rng, n, asHelper)
	for _, phone := range phones {
		role := "customer"
		if asHelper {
			role = "pro"
		}
		var id string
		err := pool.QueryRow(ctx, `
			INSERT INTO users (id, phone, role, created_at)
			VALUES (gen_random_uuid(), $1, $2, now())
			RETURNING id::text
		`, phone, role).Scan(&id)
		if err != nil {
			if asHelper {
				cnt.HelpersFailed.Add(1)
			} else {
				cnt.UsersFailed.Add(1)
			}
			continue
		}
		if asHelper {
			lat := anchorLat + (rng.Float64()*2-1)*0.05
			lng := anchorLng + (rng.Float64()*2-1)*0.05
			_, herr := pool.Exec(ctx, `
				INSERT INTO helpers (id, is_available, current_lat, current_lng, location, rating, total_jobs, approval_status, services, availability, address)
				VALUES ($1::uuid, true, $2::float8, $3::float8,
				        ST_SetSRID(ST_MakePoint($3::float8, $2::float8), 4326)::geography,
				        4.0 + random(), (random()*200)::int,
				        'approved', ARRAY['cleaning']::text[], ARRAY['morning','afternoon']::text[], 'Sim address')
			`, id, lat, lng)
			if herr != nil {
				cnt.HelpersFailed.Add(1)
				fmt.Fprintf(os.Stderr, "sim: helpers insert err: %v\n", herr)
				continue
			}
			cnt.HelpersCreated.Add(1)
		} else {
			cnt.UsersCreated.Add(1)
		}
		out = append(out, signedUpUser{Phone: phone, ID: id})
	}
	return out
}

// dbSeedBookings inserts pending bookings for the supplied customer slice. Picks
// the first active service_category. Skips silently if none exist.
func dbSeedBookings(ctx context.Context, pool *pgxpool.Pool, cnt *counters, customers []signedUpUser) []string {
	var categoryID string
	if err := pool.QueryRow(ctx,
		`SELECT id::text FROM service_categories WHERE is_active = TRUE ORDER BY created_at LIMIT 1`,
	).Scan(&categoryID); err != nil {
		fmt.Fprintf(os.Stderr, "sim: no active service_category for db-seed bookings: %v\n", err)
		return nil
	}
	out := make([]string, 0, len(customers))
	for _, u := range customers {
		lat := anchorLat + randJitter()*0.05
		lng := anchorLng + randJitter()*0.05
		var bid string
		err := pool.QueryRow(ctx, `
			INSERT INTO bookings (id, customer_id, service_category_id, status, address, lat, lng, amount_paise, created_at)
			VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'pending', 'Sim address', $3, $4, 49900, now())
			RETURNING id::text
		`, u.ID, categoryID, lat, lng).Scan(&bid)
		if err != nil {
			cnt.BookingsFailed.Add(1)
			continue
		}
		// Mirror booking.service.recordPaymentIntent — db-seed bypasses the
		// HTTP layer, so we have to write the ledger row ourselves or every
		// db-seeded booking shows as "missing payment" in the integrity report.
		if _, perr := pool.Exec(ctx, `
			INSERT INTO payments (booking_id, user_id, amount_paise, gateway, gateway_status)
			VALUES ($1::uuid, $2::uuid, 49900, 'cod', 'pending')
		`, bid, u.ID); perr != nil {
			fmt.Fprintf(os.Stderr, "sim: payment insert for %s failed: %v\n", bid, perr)
		}
		cnt.BookingsCreated.Add(1)
		out = append(out, bid)
	}
	return out
}
