package payments

import "time"

// PaymentChargeability is the decision returned by DecideChargeable —
// whether a Cashfree order may be opened against the supplied booking
// payment state. Pure-function decision so the truth table is testable
// without a DB or a gateway harness; the handler reads the SQL row
// then delegates.
//
// Phase 1 closes a double-charge window where the Cart used to launch
// Cashfree at booking time AND the Phase 1 end-of-service flow can
// launch it again at service end. The cart's pre-payment is being
// removed (frontend cleanup, separate commit), but this API-level
// guard makes the double-charge IMPOSSIBLE regardless of what any
// frontend does. Also covers: (a) a settle-an-unpaid-booking call
// landing AFTER ResolveCash, (b) any future surface that opens
// Cashfree orders.
type PaymentChargeability int

const (
	// Chargeable — no resolved payment exists; the order may proceed.
	// This includes unpaid bookings (the legitimate "settle a stranded
	// completed-unpaid booking from Bookings list" path) and prior
	// failed attempts (user retry is legit).
	Chargeable PaymentChargeability = iota
	// BlockedAlreadyPaidOnline — bookings.payment_status='paid'.
	// Cashfree webhook or wallet path already settled this booking.
	// Caller maps to 409 ALREADY_PAID_ONLINE.
	BlockedAlreadyPaidOnline
	// BlockedAlreadyPaidCash — bookings.cash_collected_at IS NOT NULL.
	// Customer's ResolveCash already recorded the cash. Caller maps
	// to 409 ALREADY_PAID_CASH.
	BlockedAlreadyPaidCash
	// BlockedRefunded — bookings.payment_status='refunded'. The
	// transaction was deliberately unwound (dispute, post-pay
	// cancellation, Step 3 cash-conflict auto-refund, an admin
	// correction). Re-collection through the self-service flow is the
	// WRONG channel — it must route through admin/CRM. Caller maps to
	// 409 BOOKING_REFUNDED with copy that names the right next step.
	BlockedRefunded
)

// DecideChargeable is the pure-function decision used by
// (*Handler).createCashfreeOrderForBooking before opening a new
// Cashfree order. paymentStatus + cashCollectedAt come from a single
// SELECT against bookings; nil means the column is NULL.
//
// Precedence:
//   1. cash_collected_at wins over everything else — a pro physically
//      holds the money. Most specific failure mode.
//   2. payment_status='paid' — settled via gateway or wallet.
//   3. payment_status='refunded' — admin reconciliation only.
//   4. otherwise (NULL / pending / failed) — Chargeable.
//
// The two block ordering (cash before paid) is defensive: if both flags
// were ever set (shouldn't happen — backend writes guard against it),
// cash is the more specific failure to surface.
func DecideChargeable(paymentStatus *string, cashCollectedAt *time.Time) PaymentChargeability {
	if cashCollectedAt != nil {
		return BlockedAlreadyPaidCash
	}
	if paymentStatus != nil {
		switch *paymentStatus {
		case "paid":
			return BlockedAlreadyPaidOnline
		case "refunded":
			return BlockedRefunded
		}
	}
	return Chargeable
}
