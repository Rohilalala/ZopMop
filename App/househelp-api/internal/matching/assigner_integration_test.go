package matching

import (
	"context"
	"sync"
	"testing"
	"time"

	_ "time/tzdata"
)

// DB-backed integration tests for the unified assigner's two remaining race /
// lifecycle guarantees (plan Task 9, spec §12, §14.3). Case (a) — two concurrent
// ASAP creations vs one pro — lives in the booking package
// (service_asap_integration_test.go) because the 409 no_pros_available contract
// is a booking-Service concern; these two cover the assigner mechanics directly.
//
// Reuses asgFixture from assigner_test.go. Skipped when TEST_DATABASE_URL unset.

// ── (b) admin manual assign racing the assigner claim ───────────────────────

// An admin manual assign (a direct UPDATE that sets helper_id/status under the
// SAME `helper_id IS NULL AND status='pending'` claim guard the assigner uses —
// spec §14.3) racing the assigner's AssignOne for the same pending booking must
// leave EXACTLY ONE helper_id, never an overwrite. The claim guard is the whole
// safety mechanism: whichever writer commits first flips the row off the
// guard's predicate, so the other's guarded UPDATE matches zero rows.
//
// The two writers pick DIFFERENT pros (admin's vs the assigner's sole
// candidate), so an overwrite would be observable as the final helper_id
// flipping from one to the other. We assert the final helper_id is one of the
// two and that the booking is 'accepted' with a single winner.
func TestIntegration_AdminAssignRacesAssignerClaim(t *testing.T) {
	f := newAsgFixture(t)

	// The assigner's sole eligible candidate.
	assignerPro := f.addPro(3 * time.Hour)
	// A second approved pro the "admin" hand-picks. It need not be online/eligible
	// for the assigner — an admin assign bypasses eligibility — but it must exist
	// as an approved helper so the row is a legitimate assignment target.
	adminPro := f.addProOpts(3*time.Hour, f.locality, false)

	// 60 min out so the assigner's fail-open travel (15+5=20) comfortably fits.
	bk := f.makeBooking(time.Now().Add(60*time.Minute), 60)

	// adminAssign mimics a CRM manual assign on a still-pending row: the same
	// atomic claim guard the assigner's Assign uses. Returns true iff it won the
	// row (rows-affected = 1).
	adminAssign := func() bool {
		ct, err := f.pool.Exec(context.Background(), `
			UPDATE bookings
			SET    helper_id   = $2::uuid,
			       status      = 'accepted',
			       accepted_at = now(),
			       matched_at  = COALESCE(matched_at, now()),
			       updated_at  = now()
			WHERE  id = $1::uuid AND helper_id IS NULL AND status = 'pending'
		`, bk, adminPro)
		if err != nil {
			t.Errorf("admin assign UPDATE: %v", err)
			return false
		}
		return ct.RowsAffected() == 1
	}

	var (
		wg          sync.WaitGroup
		adminWon    bool
		assignerErr error
		assignerRes *AssignResult
	)
	wg.Add(2)
	go func() { defer wg.Done(); adminWon = adminAssign() }()
	go func() {
		defer wg.Done()
		assignerRes, assignerErr = f.asg.AssignOne(context.Background(), bk, "")
	}()
	wg.Wait()

	// Exactly one of the two writers may have claimed the row.
	assignerWon := assignerErr == nil
	if adminWon == assignerWon {
		t.Fatalf("expected exactly one winner: adminWon=%v assignerWon=%v (assignerErr=%v)",
			adminWon, assignerWon, assignerErr)
	}

	// Whichever lost must have reported the loss cleanly — the assigner via
	// ErrAlreadyClaimed (its guarded UPDATE matched no row), the admin via
	// rows-affected 0.
	if !assignerWon && assignerErr != ErrAlreadyClaimed {
		t.Fatalf("assigner lost but err=%v, want ErrAlreadyClaimed", assignerErr)
	}

	// The final row: a single helper_id, accepted, equal to the winner's pro and
	// never overwritten by the loser.
	var finalHelper, status string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT COALESCE(helper_id::text,''), status FROM bookings WHERE id = $1::uuid`, bk,
	).Scan(&finalHelper, &status); err != nil {
		t.Fatal(err)
	}
	if status != "accepted" {
		t.Fatalf("final status = %s, want accepted", status)
	}
	wantHelper := adminPro
	if assignerWon {
		wantHelper = assignerPro
		if assignerRes == nil || assignerRes.HelperID != assignerPro {
			t.Fatalf("assigner won but result helper = %v, want %s", assignerRes, assignerPro)
		}
	}
	if finalHelper != wantHelper {
		t.Fatalf("final helper_id = %s, want the winner %s (no-overwrite violated)", finalHelper, wantHelper)
	}
}

// ── (c) slot lifecycle: not-yet-due → due → assigned ────────────────────────

// A booking 50 minutes out is OUTSIDE the 30-min dispatch lead, so a tick must
// NOT claim it (it stays pending, unassigned). Advancing it into the lead window
// (scheduled_time = now()+29min) makes it due; the next tick claims and
// force-assigns it. This is the core JIT promise: a far booking is untouched
// until its lead window opens, fixing batch assignment's "handled the same
// whether created now or two days ago" flaw (spec §1, §12).
func TestIntegration_SlotLifecycle_DueThenAssigned(t *testing.T) {
	f := newAsgFixture(t)
	pro := f.addPro(3 * time.Hour)

	// T+50min: beyond the 30-min lead → not yet due.
	bk := f.makeBooking(time.Now().Add(50*time.Minute), 60)

	cron := NewAssignerCron(f.asg, nil)

	// Tick 1: nothing due for this booking. (RunOnce is global; assert via the
	// row, not the count, so concurrent foreign rows don't confuse us.)
	if _, _, err := cron.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce (pre-due): %v", err)
	}
	if helper, status := f.bookingState(bk); helper != "" || status != "pending" {
		t.Fatalf("before lead window: helper=%q status=%q, want \"\"/pending (claimed too early)", helper, status)
	}

	// Advance the booking into the lead window: 29 min out is < 30-min lead (due)
	// and far enough that fail-open travel (15+5=20) fits the 29-min runway.
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE bookings SET scheduled_time = now() + interval '29 minutes' WHERE id = $1::uuid`, bk,
	); err != nil {
		t.Fatalf("advance scheduled_time: %v", err)
	}

	// Tick 2: now due → claimed + force-assigned.
	if _, _, err := cron.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce (due): %v", err)
	}
	if helper, status := f.bookingState(bk); helper != pro || status != "accepted" {
		t.Fatalf("after lead window: helper=%q status=%q, want %s/accepted", helper, status, pro)
	}
}

// bookingState returns the booking's (helper_id, status) for lifecycle asserts.
func (f *asgFixture) bookingState(bookingID string) (helperID, status string) {
	f.t.Helper()
	if err := f.pool.QueryRow(context.Background(),
		`SELECT COALESCE(helper_id::text,''), status FROM bookings WHERE id = $1::uuid`, bookingID,
	).Scan(&helperID, &status); err != nil {
		f.t.Fatalf("bookingState: %v", err)
	}
	return helperID, status
}
