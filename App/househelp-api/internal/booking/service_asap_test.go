package booking

import (
	"context"
	"errors"
	"testing"

	_ "time/tzdata"

	"github.com/alicebob/miniredis/v2"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"github.com/adityarohilla/househelp-api/internal/analytics"
	"github.com/adityarohilla/househelp-api/internal/config_manager"
	"github.com/adityarohilla/househelp-api/internal/matching"
	"github.com/adityarohilla/househelp-api/internal/payments"
	"github.com/adityarohilla/househelp-api/internal/wallet"
)

// testWalletAdapter mirrors cmd/api's bookingWalletAdapter: it adapts the real
// *wallet.Service (kind wallet.Kind, returns *ApplyResult) to the booking
// package's WalletDebiter interface (kind string, returns error).
type testWalletAdapter struct{ svc *wallet.Service }

func (a testWalletAdapter) DebitTx(ctx context.Context, tx pgx.Tx, userID string, amountPaise int64, kind string, bookingID *string, note string) error {
	_, err := a.svc.DebitTx(ctx, tx, userID, amountPaise, wallet.Kind(kind), bookingID, note)
	return err
}

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
	// Wallet + payments ledger over the test pool so the wallet (already-paid)
	// ASAP path — the only one that force-assigns synchronously — can debit and
	// dispatch. Direct/Cashfree defers to the cron and never reaches the assigner.
	s.SetWallet(testWalletAdapter{svc: wallet.NewService(wallet.NewRepository(f.pool))})
	s.SetPaymentsLedger(payments.NewLedger(f.pool))
	// Wire the wallet repo so the no-pro terminal path can refund a paid row.
	s.SetWalletRepo(wallet.NewRepository(f.pool))

	// ASAP rows resolve to locality=NULL, so the fixture's locality-scoped
	// cleanup misses them and the later users delete would FK-fail. Delete them
	// by booker first (t.Cleanup is LIFO → this runs before f.cleanup).
	t.Cleanup(func() { cleanASAPBookingsByBooker(f) })
	return s
}

// asapCart is a single 30-minute service line in the fixture's category.
func asapCart(f *capFixture) []BookingServiceItem {
	return []BookingServiceItem{{ServiceID: f.serviceID, DurationMinutes: 30, PriceCents: 100}}
}

// seedWalletBalance tops up the customer's wallet so the wallet (already-paid)
// ASAP path can debit and synchronously force-assign. Only the wallet rail
// reaches the assigner; direct/Cashfree defers to the post-payment cron.
func seedWalletBalance(t *testing.T, f *capFixture, paise int64) {
	t.Helper()
	w := wallet.NewService(wallet.NewRepository(f.pool))
	if _, err := w.Credit(context.Background(), f.customer, paise, wallet.KindAdjustment, nil, nil, "test seed"); err != nil {
		t.Fatalf("seed wallet balance: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = f.pool.Exec(ctx, `DELETE FROM wallet_transactions WHERE user_id = $1::uuid`, f.customer)
		_, _ = f.pool.Exec(ctx, `DELETE FROM wallets WHERE user_id = $1::uuid`, f.customer)
	})
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
	seedWalletBalance(t, f, 100000) // funds the wallet (already-paid) rail
	fa := &fakeAssigner{result: &matching.AssignResult{HelperID: f.helperIDs[0], HelperName: "Asha", EtaMin: 8}}
	s := asapService(t, f, fa)

	res, err := s.CreateInstantBookingFromCart(
		context.Background(), f.customer, f.addressID, f.slotID("10:00"), "", asapCart(f), "", "wallet",
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
	seedWalletBalance(t, f, 100000) // wallet rail reaches the assigner
	seedPilotRosterPro(t, f)        // PilotLocality capacity → non-nil earliest slot
	fa := &fakeAssigner{err: matching.ErrNoEligiblePro}
	s := asapService(t, f, fa)

	res, err := s.CreateInstantBookingFromCart(
		context.Background(), f.customer, f.addressID, f.slotID("10:00"), "", asapCart(f), "", "wallet",
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

// TestASAP_LegacyCashfreeDoesNotDispatchBeforePayment: the legacy single-service
// CreateBooking path (POST /bookings) with the default/direct payment source
// stamps payment_method='cashfree' (unpaid). A pro MUST NOT be force-assigned
// before the customer completes the Cashfree SDK sheet — otherwise an abandoned
// payment strands a dispatched pro. The result must be Assigned=false, the
// assigner must never be called, and the row must stay pending+cashfree so the
// 60s cron (ClaimDue, which keeps the payment gate) places it post-webhook.
func TestASAP_LegacyCashfreeDoesNotDispatchBeforePayment(t *testing.T) {
	f := newCapFixture(t, 1)
	// A live result would mean a dispatch — calledOnce must stay false anyway.
	fa := &fakeAssigner{result: &matching.AssignResult{HelperID: f.helperIDs[0], HelperName: "Asha", EtaMin: 8}}
	s := asapService(t, f, fa)

	res, err := s.CreateBooking(context.Background(), &CreateBookingRequest{
		ServiceCategoryID: f.serviceID,
		Address:           "Test Address, " + f.locality,
		Lat:               28.45,
		Lng:               77.05,
		PaymentSource:     "direct",
	}, f.customer)
	if err != nil {
		t.Fatalf("CreateBooking (direct): %v", err)
	}
	if res.Assigned {
		t.Fatal("res.Assigned = true, want false — unpaid Cashfree must not dispatch before payment")
	}
	if fa.calledOnce {
		t.Fatal("assigner was called for an unpaid Cashfree booking — a pro was dispatched before payment")
	}

	bk, ok := res.Booking.(*Booking)
	if !ok {
		t.Fatalf("res.Booking is %T, want *Booking", res.Booking)
	}
	var status string
	var paymentMethod, paymentStatus *string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status, payment_method, payment_status FROM bookings WHERE id = $1::uuid`,
		bk.ID,
	).Scan(&status, &paymentMethod, &paymentStatus); err != nil {
		t.Fatalf("load booking: %v", err)
	}
	if status != "pending" {
		t.Fatalf("booking status = %q, want pending (cron places it post-payment)", status)
	}
	if paymentMethod == nil || *paymentMethod != "cashfree" {
		t.Fatalf("payment_method = %v, want cashfree", paymentMethod)
	}
	if paymentStatus != nil && *paymentStatus == "paid" {
		t.Fatal("payment_status = paid before the webhook ran")
	}
}

// TestASAP_NilAssigner: an unconfigured assigner is treated as no-pro — the
// synchronous answer is honest (ErrNoProsAvailable) rather than a 500.
func TestASAP_NilAssigner(t *testing.T) {
	f := newCapFixture(t, 0) // no roster → earliest slot may be nil; that's fine
	seedWalletBalance(t, f, 100000)
	s := asapService(t, f, nil) // explicitly no assigner

	_, err := s.CreateInstantBookingFromCart(
		context.Background(), f.customer, f.addressID, f.slotID("10:00"), "", asapCart(f), "", "wallet",
	)
	var noPros *ErrNoProsAvailable
	if !errors.As(err, &noPros) {
		t.Fatalf("err = %v, want *ErrNoProsAvailable", err)
	}
}

// TestASAP_CartDirectDefersToPayment: the cart ASAP path (CreateInstantBookingFromCart)
// with payment_source='direct'/Cashfree must NOT force-assign before payment —
// mirrors the legacy CreateBooking gate. The result is Assigned=false, the
// assigner is never called, and the row stays pending with payment_method='cashfree'
// so the 60s cron (ClaimDue, payment-gated) places it once the webhook stamps paid.
func TestASAP_CartDirectDefersToPayment(t *testing.T) {
	f := newCapFixture(t, 1)
	fa := &fakeAssigner{result: &matching.AssignResult{HelperID: f.helperIDs[0], HelperName: "Asha", EtaMin: 8}}
	s := asapService(t, f, fa)

	res, err := s.CreateInstantBookingFromCart(
		context.Background(), f.customer, f.addressID, f.slotID("10:00"), "", asapCart(f), "", "direct",
	)
	if err != nil {
		t.Fatalf("CreateInstantBookingFromCart (direct): %v", err)
	}
	if res.Assigned {
		t.Fatal("res.Assigned = true, want false — unpaid Cashfree must not dispatch before payment")
	}
	if fa.calledOnce {
		t.Fatal("assigner was called for an unpaid Cashfree cart booking — a pro was dispatched before payment")
	}

	bk, ok := res.Booking.(*ScheduledBooking)
	if !ok {
		t.Fatalf("res.Booking is %T, want *ScheduledBooking", res.Booking)
	}
	var status string
	var paymentMethod, paymentStatus *string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status, payment_method, payment_status FROM bookings WHERE id = $1::uuid`,
		bk.ID,
	).Scan(&status, &paymentMethod, &paymentStatus); err != nil {
		t.Fatalf("load booking: %v", err)
	}
	if status != "pending" {
		t.Fatalf("booking status = %q, want pending (cron places it post-payment)", status)
	}
	if paymentMethod == nil || *paymentMethod != "cashfree" {
		t.Fatalf("payment_method = %v, want cashfree", paymentMethod)
	}
	if paymentStatus != nil && *paymentStatus == "paid" {
		t.Fatal("payment_status = paid before the webhook ran")
	}
}

// TestASAP_EmptySlotID: the real handler path (POST /bookings/instant) passes an
// EMPTY time_slot_id. The repo must NOT run the time_slots UUID lookup with "" —
// that throws 22P02 and 500s every in-app ASAP booking. With the wallet rail the
// booking is created (time_slot_id NULL) and force-assigned. Regression guard for
// the empty-string-into-UUID bug.
func TestASAP_EmptySlotID(t *testing.T) {
	f := newCapFixture(t, 1)
	seedWalletBalance(t, f, 100000)
	fa := &fakeAssigner{result: &matching.AssignResult{HelperID: f.helperIDs[0], HelperName: "Asha", EtaMin: 8}}
	s := asapService(t, f, fa)

	res, err := s.CreateInstantBookingFromCart(
		context.Background(), f.customer, f.addressID, "", "", asapCart(f), "", "wallet",
	)
	if err != nil {
		t.Fatalf("CreateInstantBookingFromCart (empty slot id): %v", err)
	}
	if !res.Assigned {
		t.Fatal("res.Assigned = false, want true for the empty-slot ASAP path")
	}
	bk, ok := res.Booking.(*ScheduledBooking)
	if !ok {
		t.Fatalf("res.Booking is %T, want *ScheduledBooking", res.Booking)
	}
	var timeSlotID *string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT time_slot_id::text FROM bookings WHERE id = $1::uuid`, bk.ID).Scan(&timeSlotID); err != nil {
		t.Fatalf("load booking time_slot_id: %v", err)
	}
	if timeSlotID != nil {
		t.Fatalf("time_slot_id = %v, want NULL for ASAP", *timeSlotID)
	}
}

// TestASAP_WalletAssignErrorRefunds: a non-terminal assigner error (a Maps/DB
// fault, not ErrNoEligiblePro) on the wallet rail must NOT leave the customer
// charged with a 500. The booking is debited before assignASAP runs; on the
// error the path cancels the row and refunds the wallet, returning the coherent
// *ErrNoProsAvailable instead of a bare error. Guards the charged-on-error
// window (spec §5.5 refund-path reuse).
func TestASAP_WalletAssignErrorRefunds(t *testing.T) {
	f := newCapFixture(t, 1)
	seedPilotRosterPro(t, f) // PilotLocality capacity → non-nil earliest slot
	seedWalletBalance(t, f, 100000)
	fa := &fakeAssigner{err: errors.New("maps: deadline exceeded")} // non-terminal
	s := asapService(t, f, fa)

	res, err := s.CreateInstantBookingFromCart(
		context.Background(), f.customer, f.addressID, f.slotID("10:00"), "", asapCart(f), "", "wallet",
	)
	if res != nil {
		t.Fatalf("expected nil result on assign error, got %+v", res)
	}
	var noPros *ErrNoProsAvailable
	if !errors.As(err, &noPros) {
		t.Fatalf("err = %v, want *ErrNoProsAvailable (not a bare 500)", err)
	}

	// The just-created row must be cancelled/no_pros_found.
	var status string
	var cancelledBy *string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT status, cancelled_by FROM bookings WHERE customer_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
		f.customer,
	).Scan(&status, &cancelledBy); err != nil {
		t.Fatalf("load created booking: %v", err)
	}
	if status != "cancelled" || cancelledBy == nil || *cancelledBy != "no_pros_found" {
		t.Fatalf("booking status=%q cancelled_by=%v, want cancelled/no_pros_found", status, cancelledBy)
	}

	// The wallet must be made whole: seeded 100000, debited the net, refunded it
	// → balance back to 100000.
	var balance int64
	if err := f.pool.QueryRow(context.Background(),
		`SELECT balance_paise FROM wallets WHERE user_id = $1::uuid`, f.customer).Scan(&balance); err != nil {
		t.Fatalf("load wallet balance: %v", err)
	}
	if balance != 100000 {
		t.Fatalf("wallet balance = %d, want 100000 (debit refunded)", balance)
	}
}
