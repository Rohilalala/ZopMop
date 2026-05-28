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
	// completed-unpaid booking from Bookings list" path).
	Chargeable PaymentChargeability = iota
	// BlockedAlreadyPaidOnline — bookings.payment_status='paid'.
	// Cashfree webhook or wallet path already settled this booking.
	// Caller maps to 409 ALREADY_PAID_ONLINE.
	BlockedAlreadyPaidOnline
	// BlockedAlreadyPaidCash — bookings.cash_collected_at IS NOT NULL.
	// Customer's ResolveCash already recorded the cash. Caller maps
	// to 409 ALREADY_PAID_CASH.
	BlockedAlreadyPaidCash
)

// DecideChargeable is the pure-function decision used by
// (*Handler).createCashfreeOrderForBooking before opening a new
// Cashfree order. paymentStatus + cashCollectedAt come from a single
// SELECT against bookings; nil means the column is NULL.
//
// Precedence: cash wins over online. If both flags were ever set
// (defensively, should never happen — backend writes guard against
// it), the cash path is the more specific failure mode (a pro
// physically holds the money) and should be surfaced.
func DecideChargeable(paymentStatus *string, cashCollectedAt *time.Time) PaymentChargeability {
	if cashCollectedAt != nil {
		return BlockedAlreadyPaidCash
	}
	if paymentStatus != nil && *paymentStatus == "paid" {
		return BlockedAlreadyPaidOnline
	}
	return Chargeable
}
