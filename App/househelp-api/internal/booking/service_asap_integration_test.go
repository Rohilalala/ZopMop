package booking

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"testing"
	"time"

	_ "time/tzdata"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/adityarohilla/househelp-api/internal/analytics"
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/googlemaps"
	"github.com/adityarohilla/househelp-api/internal/matching"
	"github.com/adityarohilla/househelp-api/internal/payments"
	"github.com/adityarohilla/househelp-api/internal/wallet"
)

// DB-backed integration test for plan Task 9 case (a): two concurrent ASAP
// creations contending for ONE eligible pro. Unlike service_asap_test.go (which
// fakes the assigner), this wires a REAL *matching.Assigner over the test pool
// so the race runs through the actual eligibility query + atomic claim. Exactly
// one creation confirms (Assigned=true); the other gets *ErrNoProsAvailable —
// the error the handler maps to HTTP 409 {code:"no_pros_available"}
// (handler.go: errors.As(err, &noProsErr) → StatusConflict). Skipped without
// TEST_DATABASE_URL.

// asapRealAssignerService builds a DB-backed booking Service wired with a real
// assigner whose maps + redis are live (miniredis), and returns the shared
// redis client so the test can seed the pro's GEO position and the walking-ETA
// cache. ASAP travel feasibility needs a *small* ETA: with no live position the
// assigner fails open to TravelBufferMin (15), and 15+AsapEtaPadMin(5)=20 >
// AsapMaxPromiseMin(15) would make even the lone pro infeasible for an ASAP
// booking. Seeding a 3-min cached ETA keeps the pro feasible deterministically
// without calling Google.
func asapRealAssignerService(t *testing.T, f *capFixture) (*Service, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	cfgSvc := config_manager.NewService(config_manager.NewRepository(f.pool), rdb)

	// Empty API key is fine: GetTravelMinutes checks the Redis cache first and
	// returns the cached value before it would build a live request.
	maps := googlemaps.NewClient("", rdb)
	asg := matching.NewAssigner(f.pool, rdb, nil, nil, maps, func(ctx context.Context) matching.DispatchConfig {
		return matching.LoadDispatchConfig(ctx, cfgSvc)
	})

	s := NewService(f.repo, f.pool, rdb, cfgSvc, nil)
	s.SetSyncAssigner(asg)
	s.SetAnalytics(analytics.NewService(f.pool))
	// Only the wallet (already-paid) rail force-assigns synchronously; direct/
	// Cashfree defers to the post-payment cron. Wire wallet + ledger so the race
	// runs over the rail that actually contends for the pro.
	s.SetWallet(testWalletAdapter{svc: wallet.NewService(wallet.NewRepository(f.pool))})
	s.SetPaymentsLedger(payments.NewLedger(f.pool))

	// ASAP rows resolve to locality=NULL → the fixture's locality-scoped cleanup
	// misses them; delete by booker first (t.Cleanup is LIFO → before f.cleanup).
	t.Cleanup(func() { cleanASAPBookingsByBooker(f) })
	return s, rdb
}

// onlineShiftPro opens a committed shift ending shiftEndsIn from now and an
// online session on it for proID, so the assigner's online + runway gates pass.
// Mirrors asgFixture.openShift (matching package) — replicated here because that
// helper is unexported in another package. Cleans up its own rows.
func onlineShiftPro(t *testing.T, f *capFixture, proID string, shiftEndsIn time.Duration) {
	t.Helper()
	ctx := context.Background()
	end := time.Now().In(istLoc).Add(shiftEndsIn)
	start := end.Add(-6 * time.Hour)
	var commitID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO shift_commitments (pro_id, shift_date, start_time, end_time, status)
		VALUES ($1::uuid, $2::date, $3::time, $4::time, 'active')
		RETURNING id::text
	`, proID, end.Format("2006-01-02"), start.Format("15:04:05"), end.Format("15:04:05")).Scan(&commitID); err != nil {
		t.Fatalf("insert shift_commitment: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO shift_sessions (commitment_id, pro_id, online_at)
		VALUES ($1::uuid, $2::uuid, now())
	`, commitID, proID); err != nil {
		t.Fatalf("insert shift_session: %v", err)
	}
	t.Cleanup(func() {
		_, _ = f.pool.Exec(ctx, `DELETE FROM shift_sessions WHERE pro_id = $1::uuid`, proID)
		_, _ = f.pool.Exec(ctx, `DELETE FROM shift_commitments WHERE pro_id = $1::uuid`, proID)
	})
}

// seedProTravel makes proID travel-feasible for an ASAP booking to the fixture
// address (28.45, 77.05): a live Redis GEO position plus a pre-cached 3-min
// walking ETA under the exact key GetTravelMinutes reads. The cache key uses the
// GEO-roundtripped origin coords (geohash storage is lossy) rounded to 4 dp, so
// we read the position back before building the key.
func seedProTravel(t *testing.T, rdb *redis.Client, proID string, destLat, destLng float64) {
	t.Helper()
	ctx := context.Background()
	if err := rdb.GeoAdd(ctx, "helpers:locations", &redis.GeoLocation{
		Name: proID, Latitude: destLat, Longitude: destLng,
	}).Err(); err != nil {
		t.Fatalf("geoadd pro: %v", err)
	}
	pos, err := rdb.GeoPos(ctx, "helpers:locations", proID).Result()
	if err != nil || len(pos) == 0 || pos[0] == nil {
		t.Fatalf("geopos readback: err=%v pos=%v", err, pos)
	}
	round4 := func(v float64) float64 { return math.Round(v*10000) / 10000 }
	key := fmt.Sprintf("gmaps:dt:%.4f:%.4f:%.4f:%.4f",
		round4(pos[0].Latitude), round4(pos[0].Longitude), round4(destLat), round4(destLng))
	if err := rdb.Set(ctx, key, 3, 5*time.Minute).Err(); err != nil {
		t.Fatalf("seed gmaps cache: %v", err)
	}
}

// TestIntegration_ConcurrentASAP_OnePro_OneWins: two distinct customers fire
// CreateInstantBookingFromCart at the same instant with a single eligible online
// pro. The real assigner places the pro for exactly one of them; the other's
// synchronous attempt finds no free pro and returns *ErrNoProsAvailable (HTTP
// 409 no_pros_available). The losing booking row is cancelled/no_pros_found.
func TestIntegration_ConcurrentASAP_OnePro_OneWins(t *testing.T) {
	f := newCapFixture(t, 0) // we add the eligible pro ourselves (with a shift)
	s, rdb := asapRealAssignerService(t, f)

	// One approved, online, locality-matching pro. ASAP bookings resolve to
	// locality=NULL, which EligibleCandidates treats as "any pro", so the
	// fixture locality is sufficient.
	pro := f.addUser(t, "pro")
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO helpers (id, approval_status, locality) VALUES ($1, 'approved', $2)`,
		pro, f.locality); err != nil {
		t.Fatalf("insert helper: %v", err)
	}
	t.Cleanup(func() { _, _ = f.pool.Exec(context.Background(), `DELETE FROM helpers WHERE id = $1::uuid`, pro) })
	onlineShiftPro(t, f, pro, 4*time.Hour)
	seedProTravel(t, rdb, pro, 28.45, 77.05) // fixture address coords

	// Two distinct customers (the anti-double-tap guard blocks one customer from
	// two pending bookings of the same category), each with their own address.
	cA, aA := f.newCustomer()
	cB, aB := f.newCustomer()

	// Fund both wallets: the wallet rail is the only one that force-assigns
	// synchronously (direct defers to the cron), so the race runs over wallet.
	w := wallet.NewService(wallet.NewRepository(f.pool))
	for _, c := range []string{cA, cB} {
		if _, err := w.Credit(context.Background(), c, 100000, wallet.KindAdjustment, nil, nil, "test seed"); err != nil {
			t.Fatalf("seed wallet balance: %v", err)
		}
	}

	// Pre-create the slot row so the two goroutines hit the cache, not a racing
	// INSERT on time_slots' UNIQUE(slot_date, start_time).
	slotID := f.slotID("10:00")

	type outcome struct {
		res *ASAPResult
		err error
	}
	run := func(customerID, addressID string) outcome {
		res, err := s.CreateInstantBookingFromCart(
			context.Background(), customerID, addressID, slotID, "",
			[]BookingServiceItem{{ServiceID: f.serviceID, DurationMinutes: 30, PriceCents: 100}},
			"", "wallet",
		)
		return outcome{res, err}
	}

	var (
		wg       sync.WaitGroup
		outcomes [2]outcome
	)
	wg.Add(2)
	go func() { defer wg.Done(); outcomes[0] = run(cA, aA) }()
	go func() { defer wg.Done(); outcomes[1] = run(cB, aB) }()
	wg.Wait()

	var assigned, noPros int
	var assignedHelper string
	for _, o := range outcomes {
		switch {
		case o.err == nil && o.res != nil && o.res.Assigned:
			assigned++
			assignedHelper = o.res.HelperName
		case o.err != nil:
			var np *ErrNoProsAvailable
			if !errors.As(o.err, &np) {
				t.Fatalf("non-winner err = %v, want *ErrNoProsAvailable (→ 409 no_pros_available)", o.err)
			}
			noPros++
		default:
			t.Fatalf("unexpected outcome: res=%+v err=%v", o.res, o.err)
		}
	}
	if assigned != 1 || noPros != 1 {
		t.Fatalf("concurrent ASAP: assigned=%d no_pros=%d, want exactly 1/1", assigned, noPros)
	}
	if assignedHelper == "" {
		t.Fatalf("winning result missing helper name")
	}

	// DB ground truth: the pro is assigned to exactly one accepted booking across
	// the two customers; the other booking is cancelled/no_pros_found.
	var acceptedForPro int
	if err := f.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM bookings
		   WHERE helper_id = $1::uuid AND status = 'accepted'
		     AND customer_id = ANY($2::uuid[])`,
		pro, []string{cA, cB},
	).Scan(&acceptedForPro); err != nil {
		t.Fatal(err)
	}
	if acceptedForPro != 1 {
		t.Fatalf("pro accepted bookings = %d, want exactly 1 (double-book or no-assign)", acceptedForPro)
	}

	var cancelledNoPro int
	if err := f.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM bookings
		   WHERE status = 'cancelled' AND cancelled_by = 'no_pros_found'
		     AND customer_id = ANY($1::uuid[])`,
		[]string{cA, cB},
	).Scan(&cancelledNoPro); err != nil {
		t.Fatal(err)
	}
	if cancelledNoPro != 1 {
		t.Fatalf("no_pros_found cancellations = %d, want exactly 1", cancelledNoPro)
	}
}
