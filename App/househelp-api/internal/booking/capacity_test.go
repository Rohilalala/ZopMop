package booking

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	// Embed the IANA tz database so time.LoadLocation("Asia/Kolkata") works on
	// any host (Windows test runners have no system zoneinfo).
	_ "time/tzdata"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB-backed tests for the slot-capacity gate. Capacity is live-derived
// (no counter): available(slot) = approved roster helpers in the locality
// − helpers on approved leave that date − committed bookings overlapping the
// slot window. All slot/booking math is anchored in Asia/Kolkata.
//
// Skipped when TEST_DATABASE_URL is unset (mirrors schema_invariants_test.go);
// point it at a Postgres with the full migration set applied.

var istLoc = func() *time.Location {
	l, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		panic(err)
	}
	return l
}()

// dayOffsetSeq hands each fixture a distinct future slot_date (days from now),
// so tests never collide on time_slots' UNIQUE(slot_date, start_time) and stay
// isolated from one another. The base is well beyond the ~14-day window the
// slot-seed migration pre-populates, so each fixture inserts its own slots on
// an otherwise-empty date. No hardcoded calendar dates.
var dayOffsetSeq int64 = 30

// phoneCounter seeds unique numeric phone numbers for fixture users.
var phoneCounter = time.Now().UnixNano() % 1_000_000_000

func uniquePhone() string {
	n := atomic.AddInt64(&phoneCounter, 1)
	return fmt.Sprintf("9%010d", n%10_000_000_000)
}

func capTestPool(t *testing.T) *pgxpool.Pool {
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

// capFixture is an isolated single-locality world: its own helpers, customer,
// address, service category, slot date, and time_slots rows.
type capFixture struct {
	t         *testing.T
	pool      *pgxpool.Pool
	repo      *Repository
	locality  string
	customer  string
	addressID string
	serviceID string
	dateStr   string

	userIDs    []string
	addressIDs []string
	helperIDs  []string
	slotIDs    []string
	slots      map[string]string // "HH:MM" -> time_slots.id
}

func newCapFixture(t *testing.T, nHelpers int) *capFixture {
	t.Helper()
	ctx := context.Background()
	pool := capTestPool(t)

	offset := atomic.AddInt64(&dayOffsetSeq, 1)
	day := time.Now().In(istLoc).AddDate(0, 0, int(offset))

	f := &capFixture{
		t:        t,
		pool:     pool,
		repo:     NewRepository(pool),
		locality: "TestLoc-" + uuid.NewString(),
		dateStr:  day.Format("2006-01-02"),
		slots:    map[string]string{},
	}

	// Service category (FK target for bookings.service_category_id and
	// booking_services.service_id).
	if err := pool.QueryRow(ctx,
		`INSERT INTO service_categories (name, base_price_cents) VALUES ($1, 10000) RETURNING id::text`,
		"TestSvc-"+f.locality,
	).Scan(&f.serviceID); err != nil {
		t.Fatalf("insert service_category: %v", err)
	}

	// Default customer + owned address. Tests that need distinct bookers
	// (the anti-double-tap guard blocks one customer from two pending bookings
	// of the same category within 2 min) call newCustomer for additional ones.
	f.customer, f.addressID = f.newCustomer()

	// Approved roster helpers in the locality.
	for i := 0; i < nHelpers; i++ {
		id := f.addUser(t, "pro")
		if _, err := pool.Exec(ctx,
			`INSERT INTO helpers (id, approval_status, locality) VALUES ($1, 'approved', $2)`,
			id, f.locality,
		); err != nil {
			t.Fatalf("insert helper: %v", err)
		}
		f.helperIDs = append(f.helperIDs, id)
	}

	t.Cleanup(f.cleanup)
	return f
}

// newCustomer creates a customer user with an owned address and returns both
// ids. Each booking in a "different customers" scenario uses its own.
func (f *capFixture) newCustomer() (string, string) {
	id := f.addUser(f.t, "customer")
	var addrID string
	if err := f.pool.QueryRow(context.Background(), `
		INSERT INTO user_addresses
		  (user_id, tag, title, flat_no, building_name, full_address, lat, lon)
		VALUES ($1, 'Home', 'Home', '1', 'Test Building', $2, 28.45, 77.05)
		RETURNING id::text`,
		id, "Test Address, "+f.locality,
	).Scan(&addrID); err != nil {
		f.t.Fatalf("insert user_address: %v", err)
	}
	f.addressIDs = append(f.addressIDs, addrID)
	return id, addrID
}

func (f *capFixture) addUser(t *testing.T, role string) string {
	t.Helper()
	id := uuid.NewString()
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO users (id, phone, name, role) VALUES ($1, $2, $3, $4)`,
		id, uniquePhone(), "Test "+role, role,
	); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	f.userIDs = append(f.userIDs, id)
	return id
}

// slotID lazily creates (and caches) a 30-minute time_slots row starting at
// hhmm on the fixture's date, returning its id.
func (f *capFixture) slotID(hhmm string) string {
	if id, ok := f.slots[hhmm]; ok {
		return id
	}
	end := f.instant(hhmm).Add(30 * time.Minute).Format("15:04")
	var id string
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO time_slots (slot_date, start_time, end_time) VALUES ($1, $2, $3) RETURNING id::text`,
		f.dateStr, hhmm, end,
	).Scan(&id); err != nil {
		f.t.Fatalf("insert time_slot %s: %v", hhmm, err)
	}
	f.slots[hhmm] = id
	f.slotIDs = append(f.slotIDs, id)
	return id
}

// instant returns the IST wall-clock instant for hhmm on the fixture's date.
func (f *capFixture) instant(hhmm string) time.Time {
	ts, err := time.ParseInLocation("2006-01-02 15:04", f.dateStr+" "+hhmm, istLoc)
	if err != nil {
		f.t.Fatalf("parse instant %s: %v", hhmm, err)
	}
	return ts
}

// book creates a scheduled booking for the slot at hhmm with the given
// duration, going through the real repo path (advisory lock + capacity gate
// when enforce is true).
func (f *capFixture) book(hhmm string, durationMin int, enforce bool) (*ScheduledBooking, error) {
	return f.bookAs(f.customer, f.addressID, hhmm, durationMin, enforce)
}

func (f *capFixture) bookAs(customerID, addressID, hhmm string, durationMin int, enforce bool) (*ScheduledBooking, error) {
	slotID := f.slotID(hhmm)
	sched := f.instant(hhmm).Format(time.RFC3339)
	items := []BookingServiceItem{{ServiceID: f.serviceID, DurationMinutes: durationMin, PriceCents: 100}}
	loc := f.locality
	return f.repo.CreateScheduledBooking(
		context.Background(), customerID, addressID, slotID,
		sched, items, 100, 0, nil,
		false, nil, &loc, enforce,
		defaultServiceCloseMin,
	)
}

func (f *capFixture) available(hhmm string) int {
	avail, err := f.repo.availableForSlot(context.Background(), f.pool, f.locality, f.slotID(hhmm), f.dateStr)
	if err != nil {
		f.t.Fatalf("availableForSlot %s: %v", hhmm, err)
	}
	return avail
}

func (f *capFixture) committed(hhmm string) int {
	n, err := f.repo.committedCountForSlot(context.Background(), f.pool, f.locality, f.slotID(hhmm))
	if err != nil {
		f.t.Fatalf("committedCountForSlot %s: %v", hhmm, err)
	}
	return n
}

func (f *capFixture) cleanup() {
	ctx := context.Background()
	exec := func(sql string, args ...any) { _, _ = f.pool.Exec(ctx, sql, args...) }
	exec(`DELETE FROM booking_services WHERE booking_id IN (SELECT id FROM bookings WHERE locality = $1)`, f.locality)
	exec(`DELETE FROM bookings WHERE locality = $1`, f.locality)
	if len(f.helperIDs) > 0 {
		exec(`DELETE FROM pro_leaves WHERE pro_id = ANY($1::uuid[])`, f.helperIDs)
		exec(`DELETE FROM helpers WHERE id = ANY($1::uuid[])`, f.helperIDs)
	}
	if len(f.addressIDs) > 0 {
		exec(`DELETE FROM user_addresses WHERE id = ANY($1::uuid[])`, f.addressIDs)
	}
	if len(f.slotIDs) > 0 {
		exec(`DELETE FROM time_slots WHERE id = ANY($1::uuid[])`, f.slotIDs)
	}
	exec(`DELETE FROM service_categories WHERE id = $1::uuid`, f.serviceID)
	if len(f.userIDs) > 0 {
		exec(`DELETE FROM users WHERE id = ANY($1::uuid[])`, f.userIDs)
	}
}

// Test A/B/C: two approved helpers, two 09:00 bookings fill the slot, the
// third customer cannot book 09:00.
func TestSlotCapacity_ThirdBookingBlocked(t *testing.T) {
	f := newCapFixture(t, 2)
	cA, aA := f.newCustomer()
	cB, aB := f.newCustomer()
	cC, aC := f.newCustomer()

	if got := f.available("09:00"); got != 2 {
		t.Fatalf("initial availability = %d, want 2", got)
	}
	if _, err := f.bookAs(cA, aA, "09:00", 30, true); err != nil {
		t.Fatalf("customer A booking (09:00) failed: %v", err)
	}
	if _, err := f.bookAs(cB, aB, "09:00", 30, true); err != nil {
		t.Fatalf("customer B booking (09:00) failed: %v", err)
	}
	if got := f.available("09:00"); got != 0 {
		t.Fatalf("availability after 2 bookings = %d, want 0", got)
	}
	if _, err := f.bookAs(cC, aC, "09:00", 30, true); !errors.Is(err, ErrSlotUnavailable) {
		t.Fatalf("customer C booking (09:00): got err=%v, want ErrSlotUnavailable", err)
	}
}

// Cancelling one of the two 09:00 bookings reopens the slot.
func TestSlotCapacity_CancelReopensSlot(t *testing.T) {
	f := newCapFixture(t, 2)
	cA, aA := f.newCustomer()
	cB, aB := f.newCustomer()
	cC, aC := f.newCustomer()

	a, err := f.bookAs(cA, aA, "09:00", 30, true)
	if err != nil {
		t.Fatalf("customer A booking failed: %v", err)
	}
	if _, err := f.bookAs(cB, aB, "09:00", 30, true); err != nil {
		t.Fatalf("customer B booking failed: %v", err)
	}
	if got := f.available("09:00"); got != 0 {
		t.Fatalf("availability when full = %d, want 0", got)
	}

	// Cancel A → it drops out of the committed set, freeing capacity.
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE bookings SET status = 'cancelled' WHERE id = $1::uuid`, a.ID); err != nil {
		t.Fatalf("cancel booking A: %v", err)
	}

	if got := f.available("09:00"); got != 1 {
		t.Fatalf("availability after cancel = %d, want 1", got)
	}
	if _, err := f.bookAs(cC, aC, "09:00", 30, true); err != nil {
		t.Fatalf("customer C re-booking 09:00 after cancel failed: %v", err)
	}
}

// Concurrent bookings for the last remaining seat: exactly one succeeds, the
// other gets ErrSlotUnavailable (the advisory lock serialises the re-count).
func TestSlotCapacity_ConcurrentLastSlot(t *testing.T) {
	f := newCapFixture(t, 1) // single helper → one seat at 09:00

	f.slotID("09:00") // pre-create the slot so the goroutines hit the cache

	const n = 2
	var wg sync.WaitGroup
	errs := make([]error, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(idx int) {
			defer wg.Done()
			_, errs[idx] = f.book("09:00", 30, true)
		}(i)
	}
	wg.Wait()

	var ok, full int
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrSlotUnavailable):
			full++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if ok != 1 || full != 1 {
		t.Fatalf("concurrent last-slot: got %d success / %d slot_full, want 1/1", ok, full)
	}
}

// Two bookings in DIFFERENT but time-overlapping slots draw on the same single
// helper: a 60-min job at 09:00 (09:00–10:00) and a 60-min job at 09:30
// (09:30–10:30) collide over 09:30–10:00. With one roster helper, exactly one
// may win. The two slots have different ids, so a lock keyed on the slot id
// lets both bookings past the gate concurrently (each re-counts before the
// other's insert is visible) and double-books the helper. Guards the
// (locality, date) lock domain, which serialises across overlapping slots.
func TestSlotCapacity_ConcurrentOverlappingSlots(t *testing.T) {
	f := newCapFixture(t, 1) // single helper → one seat across the overlap

	cA, aA := f.newCustomer()
	cB, aB := f.newCustomer()

	// Pre-create both slots so the goroutines hit the cache. slotID mutates a
	// shared map; creating the rows up front keeps the concurrent section
	// race-free (matches TestSlotCapacity_ConcurrentLastSlot).
	f.slotID("09:00")
	f.slotID("09:30")

	var wg sync.WaitGroup
	errs := make([]error, 2)
	wg.Add(2)
	go func() { defer wg.Done(); _, errs[0] = f.bookAs(cA, aA, "09:00", 60, true) }()
	go func() { defer wg.Done(); _, errs[1] = f.bookAs(cB, aB, "09:30", 60, true) }()
	wg.Wait()

	var ok, full int
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrSlotUnavailable):
			full++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if ok != 1 || full != 1 {
		t.Fatalf("concurrent overlapping slots: got %d success / %d slot_full, want 1/1 "+
			"(a per-slot lock lets both overlapping bookings double-book the one helper)", ok, full)
	}
}

// An approved full-day leave for one roster helper reduces capacity by one.
func TestSlotCapacity_ApprovedLeaveReducesCapacity(t *testing.T) {
	f := newCapFixture(t, 2)

	if got := f.available("09:00"); got != 2 {
		t.Fatalf("availability without leave = %d, want 2", got)
	}

	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO pro_leaves (pro_id, date, status, source) VALUES ($1::uuid, $2::date, 'approved', 'admin')`,
		f.helperIDs[0], f.dateStr); err != nil {
		t.Fatalf("insert approved leave: %v", err)
	}

	if got := f.available("09:00"); got != 1 {
		t.Fatalf("availability with one helper on leave = %d, want 1", got)
	}
}

// A 60-minute job at 09:00 spans 09:00–10:00, so it also occupies 09:30 and
// blocks it when it takes the last helper. A 30-minute job at 09:00 does not.
func TestSlotCapacity_LongJobBlocksNextSlot(t *testing.T) {
	t.Run("60-minute job blocks 09:30", func(t *testing.T) {
		f := newCapFixture(t, 1)
		if got := f.available("09:30"); got != 1 {
			t.Fatalf("09:30 availability before booking = %d, want 1", got)
		}
		if _, err := f.book("09:00", 60, true); err != nil {
			t.Fatalf("60-min booking at 09:00 failed: %v", err)
		}
		if got := f.committed("09:30"); got != 1 {
			t.Fatalf("committed overlapping 09:30 = %d, want 1", got)
		}
		if got := f.available("09:30"); got != 0 {
			t.Fatalf("09:30 availability after 60-min job = %d, want 0 (blocked)", got)
		}
	})

	t.Run("30-minute job does not block 09:30", func(t *testing.T) {
		f := newCapFixture(t, 1)
		if _, err := f.book("09:00", 30, true); err != nil {
			t.Fatalf("30-min booking at 09:00 failed: %v", err)
		}
		if got := f.committed("09:30"); got != 0 {
			t.Fatalf("committed overlapping 09:30 = %d, want 0 (no overlap)", got)
		}
		if got := f.available("09:30"); got != 1 {
			t.Fatalf("09:30 availability after 30-min job = %d, want 1 (still open)", got)
		}
	})
}
