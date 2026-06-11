package booking

import (
	"context"
	"errors"
	"testing"

	_ "time/tzdata"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/adityarohilla/househelp-api/internal/analytics"
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/matching"
)

// DB-backed tests for the ASAP synchronous-assign path (spec §3.2, §5.5):
// CreateInstantBookingFromCart with a faked assigner. Reuses capFixture (same
// package) for the customer/address/service/locality world. Skipped without
// TEST_DATABASE_URL.

// fakeAssigner is an in-memory SyncAssigner: it returns a fixed result, or a
// fixed error, regardless of the booking. Records the last call for assertions.
type fakeAssigner struct {
	result     *matching.AssignResult
	err        error
	lastID     string
	lastExcl   string
	calledOnce bool
}

func (f *fakeAssigner) AssignOne(_ context.Context, bookingID, excludeProID string) (*matching.AssignResult, error) {
	f.lastID = bookingID
	f.lastExcl = excludeProID
	f.calledOnce = true
	return f.result, f.err
}

// asapService builds a real DB-backed booking Service over the fixture's pool,
// wired with the given fake assigner. The dispatch knobs (AsapEtaPadMin etc.)
// resolve through config_manager with defaults when unseeded. No maps/webhooks
// needed for the ASAP path.
func asapService(t *testing.T, f *capFixture, fa SyncAssigner) *Service {
	t.Helper()
	// CreateInstantBookingFromCart calls matching.TrackDemand on s.rdb, so the
	// Service needs a live redis client — miniredis keeps it in-process.
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	// config_manager over the test pool (+ miniredis cache): GetConfig falls
	// through to Postgres on a cache miss, so the seeded max-active row resolves.
	cfgSvc := config_manager.NewService(config_manager.NewRepository(f.pool), rdb)

	s := NewService(f.repo, f.pool, rdb, cfgSvc, nil)
	s.SetSyncAssigner(fa)
	// CreateInstantBookingFromCart calls s.analytics.Track unconditionally; a
	// nil analytics service panics, so wire a real (fire-and-forget) one over
	// the test pool.
	s.SetAnalytics(analytics.NewService(f.pool))

	// ASAP rows resolve to locality=NULL, so the fixture's locality-scoped
	// cleanup misses them and the later users delete would FK-fail. Delete them
	// by booker first (t.Cleanup is LIFO → this runs before f.cleanup).
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = f.pool.Exec(ctx,
			`DELETE FROM booking_services WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = ANY($1::uuid[]))`,
			f.userIDs)
		_, _ = f.pool.Exec(ctx, `DELETE FROM bookings WHERE customer_id = ANY($1::uuid[])`, f.userIDs)
	})
	return s
}

// asapCart is a single 30-minute service line in the fixture's category.
func asapCart(f *capFixture) []BookingServiceItem {
	return []BookingServiceItem{{ServiceID: f.serviceID, DurationMinutes: 30, PriceCents: 100}}
}

// seedPilotRosterPro adds one approved roster pro to PilotLocality so the
// no-pro path's earliest-slot lookup (which resolves the synthetic fixture
// address to PilotLocality) sees capacity > 0. Cleans the rows up afterwards so
// the shared PilotLocality roster is left as it was found.
func seedPilotRosterPro(t *testing.T, f *capFixture) {
	t.Helper()
	ctx := context.Background()
	id := f.addUser(t, "pro") // cleaned up by the fixture's user cleanup
	if _, err := f.pool.Exec(ctx,
		`INSERT INTO helpers (id, approval_status, locality) VALUES ($1, 'approved', $2)`,
		id, PilotLocality,
	); err != nil {
		t.Fatalf("seed PilotLocality pro: %v", err)
	}
	t.Cleanup(func() { _, _ = f.pool.Exec(ctx, `DELETE FROM helpers WHERE id = $1::uuid`, id) })
}

// TestASAP_Success: assigner places a pro → result carries the promise
// (EtaMin + AsapEtaPadMin) and helper name, and the booking row is NOT
// cancelled.
func TestASAP_Success(t *testing.T) {
	f := newCapFixture(t, 1)
	fa := &fakeAssigner{result: &matching.AssignResult{HelperID: f.helperIDs[0], HelperName: "Asha", EtaMin: 8}}
	s := asapService(t, f, fa)

	res, err := s.CreateInstantBookingFromCart(
		context.Background(), f.customer, f.addressID, f.slotID("10:00"), "", asapCart(f), "", "direct",
	)
	if err != nil {
		t.Fatalf("CreateInstantBookingFromCart: %v", err)
	}
	if !res.Assigned {
		t.Fatalf("res.Assigned = false, want true")
	}
	if res.HelperName != "Asha" {
		t.Fatalf("res.HelperName = %q, want Asha", res.HelperName)
	}
	// Promise = EtaMin(8) + AsapEtaPadMin(default 5) = 13.
	if res.PromiseETAMinutes != 13 {
		t.Fatalf("res.PromiseETAMinutes = %d, want 13", res.PromiseETAMinutes)
	}
	if !fa.calledOnce {
		t.Fatal("assigner was never called")
	}

	bk, ok := res.Booking.(*ScheduledBooking)
	if !ok {
		t.Fatalf("res.Booking is %T, want *ScheduledBooking", res.Booking)
	}
	// The just-created row must still be live (the assigner would set it to
	// accepted in prod; the fake doesn't touch the DB, so it stays pending —
	// the key assertion is that the ASAP path did NOT cancel it).
	var status string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status FROM bookings WHERE id = $1::uuid`, bk.ID).Scan(&status); err != nil {
		t.Fatalf("load booking status: %v", err)
	}
	if status == "cancelled" {
		t.Fatalf("booking %s was cancelled on the success path", bk.ID)
	}
}

// TestASAP_NoPro: assigner reports no eligible pro → ErrNoProsAvailable, the
// just-created booking row is cancelled/no_pros_found (spec §5.5), and an
// earliest slot is offered.
//
// The earliest-slot suggestion is computed against the resolved locality, which
// for the fixture's synthetic address falls back to PilotLocality — so we seed
// a PilotLocality roster pro (and clean it up) to guarantee a non-nil slot.
func TestASAP_NoPro(t *testing.T) {
	f := newCapFixture(t, 0)
	seedPilotRosterPro(t, f) // PilotLocality capacity → non-nil earliest slot
	fa := &fakeAssigner{err: matching.ErrNoEligiblePro}
	s := asapService(t, f, fa)

	res, err := s.CreateInstantBookingFromCart(
		context.Background(), f.customer, f.addressID, f.slotID("10:00"), "", asapCart(f), "", "direct",
	)
	if res != nil {
		t.Fatalf("expected nil result on no-pro, got %+v", res)
	}
	var noPros *ErrNoProsAvailable
	if !errors.As(err, &noPros) {
		t.Fatalf("err = %v, want *ErrNoProsAvailable", err)
	}
	if noPros.Earliest == nil {
		t.Fatal("expected a non-nil earliest_slot suggestion (roster has capacity)")
	}
	if noPros.Earliest.SlotID == "" || noPros.Earliest.ScheduledTime == "" {
		t.Fatalf("earliest_slot missing fields: %+v", noPros.Earliest)
	}

	// The booking row the ASAP path created must be cancelled/no_pros_found.
	// resolveLocality won't match the fixture's synthetic locality, so the row
	// carries locality=NULL — query by the (sole) booker instead.
	var status string
	var cancelledBy *string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status, cancelled_by FROM bookings
		 WHERE customer_id = $1::uuid
		 ORDER BY created_at DESC LIMIT 1`,
		f.customer,
	).Scan(&status, &cancelledBy); err != nil {
		t.Fatalf("load created booking: %v", err)
	}
	if status != "cancelled" {
		t.Fatalf("booking status = %q, want cancelled", status)
	}
	if cancelledBy == nil || *cancelledBy != "no_pros_found" {
		t.Fatalf("cancelled_by = %v, want no_pros_found", cancelledBy)
	}
}

// TestASAP_NilAssigner: an unconfigured assigner is treated as no-pro — the
// synchronous answer is honest (ErrNoProsAvailable) rather than a 500.
func TestASAP_NilAssigner(t *testing.T) {
	f := newCapFixture(t, 0)    // no roster → earliest slot may be nil; that's fine
	s := asapService(t, f, nil) // explicitly no assigner

	_, err := s.CreateInstantBookingFromCart(
		context.Background(), f.customer, f.addressID, f.slotID("10:00"), "", asapCart(f), "", "direct",
	)
	var noPros *ErrNoProsAvailable
	if !errors.As(err, &noPros) {
		t.Fatalf("err = %v, want *ErrNoProsAvailable", err)
	}
}
