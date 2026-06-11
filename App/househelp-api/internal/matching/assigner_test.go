package matching

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	// Embed the IANA tz database so time.LoadLocation("Asia/Kolkata") works on
	// any host (some CI runners have no system zoneinfo).
	_ "time/tzdata"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB-backed tests for the unified JIT assigner (spec §5). Each test runs in its
// own isolated single-locality world: its own pros, customer, booking, shift
// commitments + sessions. Asserts the set-based eligibility query (every gate),
// shift-end ordering, atomic assign under concurrency, and the nil-maps
// fail-open travel path.
//
// Skipped when TEST_DATABASE_URL is unset (mirrors capacity_test.go); point it
// at a Postgres with the full migration set (>= 132) applied.

var asgIST = func() *time.Location {
	l, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		panic(err)
	}
	return l
}()

var asgPhone int64 = time.Now().UnixNano() % 1_000_000_000

func asgUniquePhone() string {
	n := atomic.AddInt64(&asgPhone, 1)
	return "8" + padNum(n%10_000_000_000)
}

func padNum(n int64) string {
	s := []byte("0000000000")
	i := len(s) - 1
	for n > 0 && i >= 0 {
		s[i] = byte('0' + n%10)
		n /= 10
		i--
	}
	return string(s)
}

func asgTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// asgFixture is an isolated single-locality world for the assigner.
type asgFixture struct {
	t        *testing.T
	pool     *pgxpool.Pool
	asg      *Assigner
	locality string
	customer string

	userIDs   []string
	helperIDs []string
}

func newAsgFixture(t *testing.T) *asgFixture {
	t.Helper()
	pool := asgTestPool(t)
	f := &asgFixture{
		t:        t,
		pool:     pool,
		locality: "AsgLoc-" + uuid.NewString(),
	}
	// nil maps + nil rdb → travel falls open to TravelBufferMin; default config.
	f.asg = NewAssigner(pool, nil, nil, nil, nil, nil)
	f.customer = f.addUser("customer")
	t.Cleanup(f.cleanup)
	return f
}

func (f *asgFixture) addUser(role string) string {
	f.t.Helper()
	id := uuid.NewString()
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO users (id, phone, name, role) VALUES ($1, $2, $3, $4)`,
		id, asgUniquePhone(), "Asg "+role, role,
	); err != nil {
		f.t.Fatalf("insert user: %v", err)
	}
	f.userIDs = append(f.userIDs, id)
	return id
}

// addPro creates an approved helper in the fixture locality with an online shift
// session whose commitment ends `shiftEndsIn` from now. Returns the pro id.
func (f *asgFixture) addPro(shiftEndsIn time.Duration) string {
	return f.addProOpts(shiftEndsIn, f.locality, true)
}

// addProOpts is the configurable form: locality, and whether to open an online
// shift session ending shiftEndsIn from now.
func (f *asgFixture) addProOpts(shiftEndsIn time.Duration, locality string, online bool) string {
	f.t.Helper()
	ctx := context.Background()
	id := f.addUser("pro")
	if _, err := f.pool.Exec(ctx,
		`INSERT INTO helpers (id, approval_status, locality) VALUES ($1, 'approved', $2)`,
		id, locality,
	); err != nil {
		f.t.Fatalf("insert helper: %v", err)
	}
	f.helperIDs = append(f.helperIDs, id)
	if online {
		f.openShift(id, shiftEndsIn)
	}
	return id
}

// openShift commits a shift ending shiftEndsIn from now and opens an online
// session on it. The commitment end (shift_date + end_time, in IST) is what the
// runway gate reads.
func (f *asgFixture) openShift(proID string, shiftEndsIn time.Duration) {
	f.t.Helper()
	ctx := context.Background()
	end := time.Now().In(asgIST).Add(shiftEndsIn)
	start := end.Add(-6 * time.Hour) // arbitrary 6h shift window ending at `end`
	var commitID string
	if err := f.pool.QueryRow(ctx, `
		INSERT INTO shift_commitments (pro_id, shift_date, start_time, end_time, status)
		VALUES ($1, $2::date, $3::time, $4::time, 'active')
		RETURNING id::text
	`, proID, end.Format("2006-01-02"), start.Format("15:04:05"), end.Format("15:04:05")).Scan(&commitID); err != nil {
		f.t.Fatalf("insert shift_commitment: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO shift_sessions (commitment_id, pro_id, online_at)
		VALUES ($1::uuid, $2::uuid, now())
	`, commitID, proID); err != nil {
		f.t.Fatalf("insert shift_session: %v", err)
	}
}

// makeBooking inserts a pending booking scheduled at `at` for the fixture
// customer/locality with the given duration. Returns the booking id.
func (f *asgFixture) makeBooking(at time.Time, durationMin int) string {
	f.t.Helper()
	var id string
	if err := f.pool.QueryRow(context.Background(), `
		INSERT INTO bookings
		  (customer_id, status, address, lat, lng, amount_paise, total_duration_minutes,
		   scheduled_time, locality)
		VALUES ($1::uuid, 'pending', 'Test Addr', 28.45, 77.05, 10000, $2, $3, $4)
		RETURNING id::text
	`, f.customer, durationMin, at, f.locality).Scan(&id); err != nil {
		f.t.Fatalf("insert booking: %v", err)
	}
	return id
}

// loadFor returns the assignerBooking projection for a booking id.
func (f *asgFixture) loadFor(bookingID string) *assignerBooking {
	f.t.Helper()
	b, err := f.asg.loadAssignerBooking(context.Background(), bookingID)
	if err != nil {
		f.t.Fatalf("loadAssignerBooking: %v", err)
	}
	return b
}

// assignClashingJob inserts a booking in the given clash status for proID whose
// padded window overlaps `at`, so the clash gate excludes the pro. status must
// be one of the clash set ('accepted','in_progress','arrived') for the GiST
// partial index (migration 134) to cover the row.
func (f *asgFixture) assignClashingJob(proID, status string, at time.Time, durationMin int) {
	f.t.Helper()
	if _, err := f.pool.Exec(context.Background(), `
		INSERT INTO bookings
		  (customer_id, helper_id, status, address, lat, lng, amount_paise,
		   total_duration_minutes, scheduled_time, locality)
		VALUES ($1::uuid, $2::uuid, $3, 'Test Addr', 28.45, 77.05, 10000, $4, $5, $6)
	`, f.customer, proID, status, durationMin, at, f.locality); err != nil {
		f.t.Fatalf("insert clashing job: %v", err)
	}
}

func (f *asgFixture) cleanup() {
	ctx := context.Background()
	exec := func(sql string, args ...any) { _, _ = f.pool.Exec(ctx, sql, args...) }
	exec(`DELETE FROM event_outbox WHERE aggregate_id IN (SELECT id FROM bookings WHERE locality = $1)`, f.locality)
	exec(`DELETE FROM bookings WHERE locality = $1`, f.locality)
	if len(f.helperIDs) > 0 {
		exec(`DELETE FROM shift_sessions WHERE pro_id = ANY($1::uuid[])`, f.helperIDs)
		exec(`DELETE FROM shift_commitments WHERE pro_id = ANY($1::uuid[])`, f.helperIDs)
		exec(`DELETE FROM pro_leaves WHERE pro_id = ANY($1::uuid[])`, f.helperIDs)
		exec(`DELETE FROM pro_zone_assignments WHERE pro_id = ANY($1::uuid[])`, f.helperIDs)
		exec(`DELETE FROM helpers WHERE id = ANY($1::uuid[])`, f.helperIDs)
	}
	if len(f.userIDs) > 0 {
		exec(`DELETE FROM users WHERE id = ANY($1::uuid[])`, f.userIDs)
	}
}

func (f *asgFixture) eligibleIDs(bookingID, exclude string) []string {
	f.t.Helper()
	cands, err := f.asg.EligibleCandidates(context.Background(), f.loadFor(bookingID), exclude)
	if err != nil {
		f.t.Fatalf("EligibleCandidates: %v", err)
	}
	ids := make([]string, len(cands))
	for i, c := range cands {
		ids[i] = c.ID
	}
	return ids
}

func contains(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// ── eligibility gates (one case each) ───────────────────────────────────────

func TestAssigner_Eligibility_HappyPath(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addPro(3 * time.Hour)
	bk := f.makeBooking(time.Now().Add(20*time.Minute), 60)
	if ids := f.eligibleIDs(bk, ""); !contains(ids, pro) {
		t.Fatalf("happy-path pro should be eligible, got %v", ids)
	}
}

func TestAssigner_Eligibility_NotApproved(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addPro(3 * time.Hour)
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE helpers SET approval_status = 'pending' WHERE id = $1::uuid`, pro); err != nil {
		t.Fatal(err)
	}
	bk := f.makeBooking(time.Now().Add(20*time.Minute), 60)
	if ids := f.eligibleIDs(bk, ""); contains(ids, pro) {
		t.Fatalf("unapproved pro must be excluded, got %v", ids)
	}
}

func TestAssigner_Eligibility_BannedAccount(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addPro(3 * time.Hour)
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE users SET banned_at = now() WHERE id = $1::uuid`, pro); err != nil {
		t.Fatal(err)
	}
	bk := f.makeBooking(time.Now().Add(20*time.Minute), 60)
	if ids := f.eligibleIDs(bk, ""); contains(ids, pro) {
		t.Fatalf("banned pro must be excluded, got %v", ids)
	}
}

func TestAssigner_Eligibility_OnLeave(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addPro(3 * time.Hour)
	at := time.Now().Add(20 * time.Minute)
	bk := f.makeBooking(at, 60)
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO pro_leaves (pro_id, date, status, source) VALUES ($1::uuid, $2::date, 'approved', 'admin')`,
		pro, at.In(asgIST).Format("2006-01-02")); err != nil {
		t.Fatal(err)
	}
	if ids := f.eligibleIDs(bk, ""); contains(ids, pro) {
		t.Fatalf("on-leave pro must be excluded, got %v", ids)
	}
}

func TestAssigner_Eligibility_Offline(t *testing.T) {
	f := newAsgFixture(t)
	// online=false → no open shift session → ineligible.
	pro := f.addProOpts(3*time.Hour, f.locality, false)
	bk := f.makeBooking(time.Now().Add(20*time.Minute), 60)
	if ids := f.eligibleIDs(bk, ""); contains(ids, pro) {
		t.Fatalf("offline pro must be excluded, got %v", ids)
	}
}

func TestAssigner_Eligibility_ClashOverlap(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addPro(3 * time.Hour)
	at := time.Now().Add(40 * time.Minute)
	// Existing accepted 60-min job starting 20 min before the new booking →
	// its padded window [start, start+60+15) overlaps the new window.
	f.assignClashingJob(pro, "accepted", at.Add(-20*time.Minute), 60)
	bk := f.makeBooking(at, 60)
	if ids := f.eligibleIDs(bk, ""); contains(ids, pro) {
		t.Fatalf("clashing pro must be excluded, got %v", ids)
	}
}

func TestAssigner_Eligibility_ClashArrived(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addPro(3 * time.Hour)
	at := time.Now().Add(40 * time.Minute)
	// A pro who has marked 'arrived' on an overlapping job must still clash
	// (spec §5.3: accepted/arrived/in-progress) — else the assigner double-books.
	f.assignClashingJob(pro, "arrived", at.Add(-20*time.Minute), 60)
	bk := f.makeBooking(at, 60)
	if ids := f.eligibleIDs(bk, ""); contains(ids, pro) {
		t.Fatalf("arrived-clash pro must be excluded, got %v", ids)
	}
}

func TestAssigner_Eligibility_ShiftRunwayTooShort(t *testing.T) {
	f := newAsgFixture(t)
	// Shift ends in 30 min; booking is 60 min + 15 pad = 75 min runway needed.
	pro := f.addPro(30 * time.Minute)
	bk := f.makeBooking(time.Now().Add(5*time.Minute), 60)
	if ids := f.eligibleIDs(bk, ""); contains(ids, pro) {
		t.Fatalf("short-runway pro must be excluded, got %v", ids)
	}
}

func TestAssigner_Eligibility_LocalityMismatch(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addProOpts(3*time.Hour, "SomeOtherLocality-"+uuid.NewString(), true)
	bk := f.makeBooking(time.Now().Add(20*time.Minute), 60)
	if ids := f.eligibleIDs(bk, ""); contains(ids, pro) {
		t.Fatalf("locality-mismatch pro must be excluded, got %v", ids)
	}
}

// ── ordering: soonest shift end first ───────────────────────────────────────

func TestAssigner_Ordering_SoonestShiftEndFirst(t *testing.T) {
	f := newAsgFixture(t)
	// late ends in 5h, soon ends in 2h; both have ample runway for a 30-min job.
	late := f.addPro(5 * time.Hour)
	soon := f.addPro(2 * time.Hour)
	bk := f.makeBooking(time.Now().Add(20*time.Minute), 30)

	ids := f.eligibleIDs(bk, "")
	if len(ids) < 2 {
		t.Fatalf("expected both pros eligible, got %v", ids)
	}
	// soon (earlier shift end) must rank before late.
	soonIdx, lateIdx := indexOf(ids, soon), indexOf(ids, late)
	if soonIdx < 0 || lateIdx < 0 || soonIdx > lateIdx {
		t.Fatalf("soonest-shift-end pro must rank first: soon=%d late=%d ids=%v", soonIdx, lateIdx, ids)
	}
}

func indexOf(ids []string, id string) int {
	for i, x := range ids {
		if x == id {
			return i
		}
	}
	return -1
}

// ── exclusion honored ───────────────────────────────────────────────────────

func TestAssigner_ExclusionHonored(t *testing.T) {
	f := newAsgFixture(t)
	excluded := f.addPro(3 * time.Hour)
	other := f.addPro(3 * time.Hour)
	bk := f.makeBooking(time.Now().Add(20*time.Minute), 60)

	ids := f.eligibleIDs(bk, excluded)
	if contains(ids, excluded) {
		t.Fatalf("excluded pro must not appear, got %v", ids)
	}
	if !contains(ids, other) {
		t.Fatalf("non-excluded pro should remain, got %v", ids)
	}
}

// ── nil maps → fail-open travel ─────────────────────────────────────────────

func TestAssigner_TravelFailOpen_NilMaps(t *testing.T) {
	f := newAsgFixture(t) // asg has nil maps + nil rdb
	pro := f.addPro(3 * time.Hour)
	// 60 min out: fail-open eta(15) + pad(5) = 20 <= 60 → feasible.
	bk := f.makeBooking(time.Now().Add(60*time.Minute), 60)
	b := f.loadFor(bk)
	cfg := f.asg.cfg(context.Background())

	eta, ok := f.asg.TravelFeasible(context.Background(),
		Candidate{ID: pro}, b, cfg)
	if !ok {
		t.Fatalf("nil-maps travel must fail open as feasible (eta=%d)", eta)
	}
	if eta != cfg.TravelBufferMin {
		t.Fatalf("fail-open eta = %d, want TravelBufferMin %d", eta, cfg.TravelBufferMin)
	}
}

func TestAssigner_TravelFailOpen_SlotTooSoonForBuffer(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addPro(3 * time.Hour)
	// Future slot only 10 min out: fail-open eta(15) + pad(5) = 20 > 10 → infeasible.
	bk := f.makeBooking(time.Now().Add(10*time.Minute), 30)
	b := f.loadFor(bk)
	cfg := f.asg.cfg(context.Background())
	if _, ok := f.asg.TravelFeasible(context.Background(), Candidate{ID: pro}, b, cfg); ok {
		t.Fatalf("eta+pad (20) exceeds 10 min until slot — must be infeasible")
	}
}

// ── AssignOne end-to-end + atomicity under concurrency ──────────────────────

func TestAssigner_AssignOne_NoEligible(t *testing.T) {
	f := newAsgFixture(t)
	// No pros at all.
	bk := f.makeBooking(time.Now().Add(20*time.Minute), 60)
	if _, err := f.asg.AssignOne(context.Background(), bk, ""); !errors.Is(err, ErrNoEligiblePro) {
		t.Fatalf("AssignOne with no pros: got %v, want ErrNoEligiblePro", err)
	}
}

func TestAssigner_AssignOne_Assigns(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addPro(3 * time.Hour)
	// 60 min out so the fail-open eta+pad (20) comfortably fits the window.
	bk := f.makeBooking(time.Now().Add(60*time.Minute), 60)

	res, err := f.asg.AssignOne(context.Background(), bk, "")
	if err != nil {
		t.Fatalf("AssignOne: %v", err)
	}
	if res.HelperID != pro {
		t.Fatalf("assigned %s, want %s", res.HelperID, pro)
	}
	var helperID, status string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT COALESCE(helper_id::text,''), status FROM bookings WHERE id = $1::uuid`, bk,
	).Scan(&helperID, &status); err != nil {
		t.Fatal(err)
	}
	if helperID != pro || status != "accepted" {
		t.Fatalf("booking row helper=%s status=%s, want %s/accepted", helperID, status, pro)
	}
	// Durable outbox row written.
	var outboxN int
	if err := f.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM event_outbox WHERE aggregate_id = $1::uuid AND event_type = 'booking.accepted'`, bk,
	).Scan(&outboxN); err != nil {
		t.Fatal(err)
	}
	if outboxN != 1 {
		t.Fatalf("booking.accepted outbox rows = %d, want 1", outboxN)
	}
}

// Two concurrent AssignOne for the SAME booking with one eligible pro: exactly
// one wins (the atomic UPDATE guard), the other reports already-claimed.
func TestAssigner_AssignOne_ConcurrentSingleWinner(t *testing.T) {
	f := newAsgFixture(t)
	f.addPro(3 * time.Hour)
	bk := f.makeBooking(time.Now().Add(60*time.Minute), 60)

	const n = 2
	var wg sync.WaitGroup
	results := make([]error, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(idx int) {
			defer wg.Done()
			_, results[idx] = f.asg.AssignOne(context.Background(), bk, "")
		}(i)
	}
	wg.Wait()

	var won, lost int
	for _, err := range results {
		switch {
		case err == nil:
			won++
		case errors.Is(err, ErrAlreadyClaimed) || errors.Is(err, ErrNoEligiblePro):
			lost++
		default:
			t.Fatalf("unexpected AssignOne error: %v", err)
		}
	}
	if won != 1 {
		t.Fatalf("concurrent assign: %d winners, want exactly 1 (lost=%d)", won, lost)
	}
	// The booking ends up assigned to exactly one helper.
	var assigned int
	if err := f.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM bookings WHERE id = $1::uuid AND helper_id IS NOT NULL AND status='accepted'`, bk,
	).Scan(&assigned); err != nil {
		t.Fatal(err)
	}
	if assigned != 1 {
		t.Fatalf("booking assigned count = %d, want 1", assigned)
	}
}

// ── ClaimDue window ─────────────────────────────────────────────────────────

func TestAssigner_ClaimDue_RespectsLead(t *testing.T) {
	f := newAsgFixture(t)
	// Booking far in the future (beyond lead 30 min) must NOT be claimed; a due
	// one (within lead) must be. Use distinct localities-free bookings; ClaimDue
	// is global, so assert by id membership across a few claims.
	farBk := f.makeBooking(time.Now().Add(2*time.Hour), 60)    // not due
	dueBk := f.makeBooking(time.Now().Add(10*time.Minute), 60) // due (within 30-min lead)

	// ClaimDue is global (ordered by scheduled_time ASC). Drain a bounded number
	// of rows; only mutate ids this fixture owns so the test never disturbs
	// foreign rows. Stop once we've seen our due booking.
	mine := map[string]bool{farBk: true, dueBk: true}
	claimedMine := map[string]bool{}
	for i := 0; i < 200 && !claimedMine[dueBk]; i++ {
		id, ok, err := f.asg.ClaimDue(context.Background())
		if err != nil {
			t.Fatalf("ClaimDue: %v", err)
		}
		if !ok {
			break
		}
		if !mine[id] {
			continue // foreign due row — already stamped matched_at, leave it
		}
		claimedMine[id] = true
		_, _ = f.pool.Exec(context.Background(),
			`UPDATE bookings SET status='cancelled' WHERE id=$1::uuid`, id)
	}
	if !claimedMine[dueBk] {
		t.Fatalf("due booking %s was not claimed", dueBk)
	}
	if claimedMine[farBk] {
		t.Fatalf("far-future booking %s must not be claimed yet", farBk)
	}
}
